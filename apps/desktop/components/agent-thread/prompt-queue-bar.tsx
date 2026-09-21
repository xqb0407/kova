"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useAISDKChat } from "@assistant-ui/ai-sdk";
import {
  cancelQueueItem,
  dropQueuedEntry,
  getQueueSnapshot,
  popQueueHead,
  promoteQueueItem,
  refreshQueueSnapshot,
  setQueueSyncListener,
  steerQueueItem,
  useQueueSnapshot,
  useSteeredQueueItems,
  type RegisteredMessage,
} from "@/lib/pi/pi-queue";
import { piSessionRegistry } from "@/lib/pi/pi-thread-adapter";
import { findRunningTurn } from "@/lib/pi/pi-running";
import { CheckIcon, MergeIcon, XIcon, ZapIcon } from "lucide-react";
import { useEffect, useRef, useState, type FC } from "react";
import { cn } from "cn";

/**
 * prompt 排队条（composer 上方）——队列 v3，全部操作只有三个：
 *  - 并入当前回复（steer）：注入活跃轮，不中止本轮；条目转入「已并入当前回复」
 *    徽标区，宿主轮流收尾时气泡回填、徽标消失
 *  - 立即发送（promote）：中止当前轮、该项插队马上执行
 *  - 删除（cancel）：取消排队项
 * 渲染完全由 data-queue-state 快照驱动（sidecar 是唯一事实源）；排队中的消息
 * 保持在消息数组外（pi-queue 的 remove/reveal 信号同步，见其头注）。
 *
 * 刷新接力泵：页面刷新后前端流全部死亡，sidecar 的链节派发对前端不可见。
 * 挂载与每轮运行结束（isRunning 下降沿）时探测：
 *  - sidecar 有在跑轮（链节盲派发）：findRunningTurn 补 resumable 登记后
 *    resumeStream 重挂接续；
 *  - 线程空闲且队列非空（sidecar 重启后无链节）：queue_pop 弹出队首（sidecar
 *    守卫 isTurnBusy + hasPromptChain，有链节时返回 null 绝不误弹），销毁旧
 *    登记防双气泡，按文本走正常发送路径重发。
 */
export const PromptQueueBar: FC = () => {
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const snapshot = useQueueSnapshot(threadId);
  const steered = useSteeredQueueItems(threadId);
  const chat = useAISDKChat();
  const [busy, setBusy] = useState(false);

  // 消息数组同步：经 syncRef 间接调用（effect 只随线程重跑，不被流式渲染
  // 期间不稳定的 helpers 身份反复触发）。两个方向都幂等且「无变化不赋值」，
  // 防渲染↔同步死循环。
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
      next = [...msgs, reg.message];
    }
    if (next !== msgs) chat.setMessages(next);
  };

  // 接力泵（见头注）：pumpingRef 防重入（内含 await 链）。弹出重发路径先
  // dropQueuedEntry 销毁旧登记——不销毁的话派发快照会把旧气泡回填成双份。
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
      // 无链节（sidecar 重启/队列孤儿）：弹出队首按文本重发
      const popped = await popQueueHead(threadId, sessionId);
      if (!popped) return;
      dropQueuedEntry(popped.reqId);
      await refreshQueueSnapshot(threadId, sessionId);
      aui.composer.setText(popped.text);
      aui.composer.send();
    } catch {
      // 通道异常：下一次下降沿/挂载再试
    } finally {
      pumpingRef.current = false;
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
  // 其 chunk 对刷新后的前端不可见——趁 status 回落空闲的时机补挂/续发
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) void pumpRef.current();
    wasRunningRef.current = isRunning;
  }, [isRunning]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // 无活跃轮可并入等拒绝：忽略（快照下一次广播对齐）
    } finally {
      setBusy(false);
    }
  };

  if (!threadId || (snapshot.items.length === 0 && steered.length === 0)) {
    return null;
  }

  return (
    <div
      className="mb-2 flex flex-col gap-1.5"
      data-slot="aui-prompt-queue-bar"
    >
      {/* 已并入当前回复：只读徽标，宿主轮流收尾后随气泡回填自动消失 */}
      {steered.map((item) => (
        <div
          key={item.reqId}
          className="border-border/50 dark:border-muted-foreground/10 flex items-center gap-2 rounded-(--composer-radius) border bg-(--composer-bg) py-2 pr-3.5 pl-3.5"
          data-slot="aui-queue-steered"
        >
          <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
          <span className="text-foreground/70 min-w-0 flex-1 truncate text-sm">
            {item.text}
          </span>
          <span className="text-muted-foreground/70 shrink-0 text-[11px] leading-none">
            已并入当前回复
          </span>
        </div>
      ))}
      {snapshot.items.length > 0 && (
        <div className="text-muted-foreground/70 pl-3.5 text-[11px] leading-none tabular-nums">
          {snapshot.items.length} 条排队
        </div>
      )}
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
              label="并入当前回复（不中止本轮）"
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
