"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useAISDKChat } from "@assistant-ui/ai-sdk";
import {
  cancelQueueItem,
  dropQueuedEntry,
  getQueueSnapshot,
  pauseQueue,
  promoteQueueItem,
  refreshQueueSnapshot,
  resumeQueue,
  setQueueSyncListener,
  steerQueueItem,
  useQueueSnapshot,
  type RegisteredMessage,
} from "@/lib/pi/pi-queue";
import { piSessionRegistry } from "@/lib/pi/pi-thread-adapter";
import { findRunningTurn } from "@/lib/pi/pi-running";
import {
  MergeIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type FC } from "react";
import { cn } from "cn";

/**
 * prompt 排队条（composer 上方，ChatGPT 式）+ 刷新接力泵。忙线程发出的消息在
 * sidecar 排队，这里以「幽灵输入框」卡片逐条展示（渲染完全由 data-queue-state
 * 快照驱动，sidecar 重启后经 get_queue_state 从 session 回放恢复）。每项操作：
 *  - 并入当前回复：注入活跃轮（agent.steer），不中止不排队
 *  - 立即发送：中止当前轮、该项插队马上执行
 *  - 编辑：取消排队项并回填输入框，改完重新发送即重新排队
 *  - 删除：取消排队项
 * 顶部暂停/恢复开关只停派发不清队列；恢复时若线程空闲，队首弹出后由前端按
 * 文本重发（走正常发送路径，附件不保留；弹出的旧登记经 dropQueuedEntry 静默
 * 销毁防双气泡），运行中恢复仅解除暂停态、由链节接管。
 * 消息数组同步规则见 pi-queue.ts 头注（remove=排队确认摘除 / reveal=派发或
 * 并入收尾回填；两个方向都「无变化不赋值」，防渲染↔同步死循环）。
 *
 * 刷新接力泵：页面刷新后前端流全部死亡——排队项的派发 chunk 与快照广播失去
 * 附着点（链节在 sidecar 盲派发、前端镜像滞留旧条目）。挂载与每轮运行结束
 * （isRunning 下降沿）时对齐快照，线程空闲且队列非空则：
 *  - sidecar 有在跑轮（链节盲派发）：findRunningTurn 补 resumable 登记后
 *    resumeStream 重挂接续，盲轮转直播；
 *  - 无在跑轮：queue_resume 弹出队首（仅无链节时弹出）按文本重发；返回 null
 *    = 链节仍在、即将自驱派发，稍候再探测一次在跑轮补挂。
 */
export const PromptQueueBar: FC = () => {
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const snapshot = useQueueSnapshot(threadId);
  const chat = useAISDKChat();
  const [busy, setBusy] = useState(false);

  // 消息数组同步：经 syncRef 间接调用（effect 只随线程重跑，不被流式渲染
  // 期间不稳定的 helpers 身份反复触发）。两个方向都幂等且「无变化不赋值」。
  const syncRef = useRef<(reg: RegisteredMessage, kind: "remove" | "reveal") => void>(
    () => {},
  );
  syncRef.current = (reg, kind) => {
    if (!chat || reg.threadId !== threadId) return;
    const msgs = chat.messages;
    const idx = msgs.findIndex((m) => m.id === reg.messageId);
    let next = msgs;
    if (kind === "remove") {
      if (idx !== -1) next = msgs.filter((m) => m.id !== reg.messageId);
    } else if (idx === -1 && reg.message) {
      // reveal：登记的乐观消息在数组里（正常派发回填），重建消息（刷新后）
      // 与丢失登记的回填走这里
      next = [...msgs, reg.message];
    }
    if (next !== msgs) chat.setMessages(next);
  };

  // 接力泵（见头注）：pumpingRef 防重入（内含 await 链与定时探测）。
  // 弹出重发路径先 dropQueuedEntry 再对齐快照——顺序反了 reveal 会回填旧气泡。
  const pumpRef = useRef<() => Promise<void>>(async () => {});
  const pumpingRef = useRef(false);
  pumpRef.current = async () => {
    if (!aui || !threadId || pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      const sessionId = piSessionRegistry.get(threadId);
      await refreshQueueSnapshot(threadId, sessionId);
      if (getQueueSnapshot(threadId).items.length === 0) return;
      if (aui.thread.getState().isRunning) return;
      // 链节盲派发的在跑轮：补登记后重挂接续
      const turn = sessionId ? await findRunningTurn(sessionId) : null;
      if (turn?.requestId) {
        await chat?.resumeStream();
        return;
      }
      const head = getQueueSnapshot(threadId).items[0];
      const resend = await resumeQueue(threadId, sessionId);
      if (resend) {
        // 弹出成功（无链节路径）：销毁旧登记防双气泡，按文本正常重发
        if (head) dropQueuedEntry(head.reqId);
        await refreshQueueSnapshot(threadId, sessionId);
        aui.composer.setText(resend.text);
        aui.composer.send();
        return;
      }
      // 链节仍在：resumeThread 已唤醒/即将自驱派发，稍候探测一次补挂
      await new Promise((resolve) => setTimeout(resolve, 400));
      const lateTurn = sessionId ? await findRunningTurn(sessionId) : null;
      if (lateTurn?.requestId) await chat?.resumeStream();
    } catch {
      // 通道异常：下一次下降沿/挂载再试
    } finally {
      pumpingRef.current = false;
    }
  };

  const sessionId = piSessionRegistry.get(threadId);

  const togglePaused = async () => {
    setBusy(true);
    try {
      if (snapshot.paused) {
        if (aui.thread.getState().isRunning) {
          // 运行中恢复：仅解除暂停态，链节接管派发（sidecar 对忙线程不弹出）
          await resumeQueue(threadId, sessionId);
          void refreshQueueSnapshot(threadId, sessionId);
        } else {
          // 空闲恢复：泵全程接管（弹出队首 + 销登记 + 重发 + 快照对齐）
          void pumpRef.current();
        }
      } else {
        await pauseQueue(threadId, sessionId);
      }
    } catch {
      // 通道异常：快照下一次广播对齐
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // 已开跑等拒绝：忽略（快照下一次广播对齐）
    } finally {
      setBusy(false);
    }
  };

  // 同步监听 + 挂载接力：线程挂载/刷新恢复时拉一次快照并泵一次（对齐镜像 +
  // 接续派发），此后由 data-queue-state 广播增量对齐
  useEffect(() => {
    setQueueSyncListener((reg, kind) => syncRef.current(reg, kind));
    if (!threadId) return () => setQueueSyncListener(null);
    void pumpRef.current();
    return () => setQueueSyncListener(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // 每轮运行结束（isRunning 下降沿）接力：链节在上一轮流收尾后派发下一项，
  // 其 chunk 对刷新后的前端不可见——趁 status 回落空闲的时机检查队列剩余项
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) void pumpRef.current();
    wasRunningRef.current = isRunning;
  }, [isRunning]);

  if (!threadId || snapshot.items.length === 0) return null;

  return (
    <div
      className="mb-2 flex flex-col gap-1.5"
      data-slot="aui-prompt-queue-bar"
    >
      <div className="text-muted-foreground/70 flex items-center justify-between pl-3.5 pr-1 text-[11px] leading-none">
        <span className="tabular-nums">
          {snapshot.paused ? "队列已暂停 · " : ""}
          {snapshot.items.length} 条排队
        </span>
        <QueueIconButton
          label={snapshot.paused ? "恢复派发" : "暂停派发"}
          disabled={busy}
          onClick={() => void togglePaused()}
        >
          {snapshot.paused ? (
            <PlayIcon className="size-3" />
          ) : (
            <PauseIcon className="size-3" />
          )}
        </QueueIconButton>
      </div>
      {snapshot.items.map((item, index) => (
        <div
          key={item.reqId}
          className="group border-border/50 dark:border-muted-foreground/10 flex items-center gap-2 rounded-(--composer-radius) border bg-(--composer-bg) py-2 pr-1.5 pl-3.5 animate-in fade-in slide-in-from-bottom-1 duration-200"
        >
          <span
            className="w-3 shrink-0 text-center text-[11px] leading-none text-muted-foreground/50 tabular-nums"
            aria-label={`排队第 ${index + 1} 位`}
          >
            {index + 1}
          </span>
          <span
            className="text-foreground/70 min-w-0 flex-1 truncate text-sm"
            title={item.text}
          >
            {item.text}
          </span>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
            <QueueIconButton
              label="并入当前回复（不中止不排队）"
              disabled={busy}
              onClick={() => void act(() => steerQueueItem(item.reqId))}
            >
              <MergeIcon className="size-3.5" />
            </QueueIconButton>
            <QueueIconButton
              label="立即发送（中止当前回复）"
              disabled={busy}
              onClick={() => void act(() => promoteQueueItem(item.reqId))}
            >
              <ZapIcon className="size-3.5" />
            </QueueIconButton>
            <QueueIconButton
              label="编辑（取回输入框）"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await cancelQueueItem(item.reqId);
                  aui.composer.setText(item.text);
                })
              }
            >
              <PencilIcon className="size-3.5" />
            </QueueIconButton>
            <QueueIconButton
              label="删除"
              disabled={busy}
              className="hover:text-destructive"
              onClick={() => void act(() => cancelQueueItem(item.reqId))}
            >
              <XIcon className="size-3.5" />
            </QueueIconButton>
          </div>
        </div>
      ))}
    </div>
  );
};

const QueueIconButton: FC<{
  label: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, disabled, className, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
    className={cn(
      "text-muted-foreground/80 hover:text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted-foreground/10 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
  >
    {children}
  </button>
);
