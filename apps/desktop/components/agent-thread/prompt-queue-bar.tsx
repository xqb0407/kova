"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useAISDKChat } from "@assistant-ui/ai-sdk";
import {
  cancelQueueItem,
  pauseQueue,
  promoteQueueItem,
  refreshQueueSnapshot,
  resumeQueue,
  setQueueSyncListener,
  steerQueueItem,
  useQueueSnapshot,
  type RegisteredMessage,
} from "@/lib/pi-queue";
import { piSessionRegistry } from "@/lib/pi-thread-adapter";
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
 * prompt 排队条（composer 上方，ChatGPT 式）：忙线程发出的消息在 sidecar
 * 排队，这里以「幽灵输入框」卡片逐条展示（渲染完全由 data-queue-state 快照
 * 驱动，sidecar 重启后经 get_queue_state 从 session 回放恢复）。每项操作：
 *  - 并入当前回复：注入活跃轮（agent.steer），不中止不排队
 *  - 立即发送：中止当前轮、该项插队马上执行
 *  - 编辑：取消排队项并回填输入框，改完重新发送即重新排队
 *  - 删除：取消排队项
 * 顶部暂停/恢复开关只停派发不清队列；恢复时若线程空闲，队首由前端重发
 * （sidecar 经 queue_resume 弹出交还）。
 * 消息数组同步规则见 pi-queue.ts 头注（remove=排队确认摘除 / reveal=派发或
 * 并入收尾回填；两个方向都「无变化不赋值」，防渲染↔同步死循环）。
 */
export const PromptQueueBar: FC = () => {
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
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

  // 同步监听 + 快照拉取：线程挂载/刷新恢复时向 sidecar 拉一次快照（sidecar
  // 内存为空会从 session 回放采纳），此后由 data-queue-state 广播增量对齐
  useEffect(() => {
    setQueueSyncListener((reg, kind) => syncRef.current(reg, kind));
    if (threadId) {
      void refreshQueueSnapshot(threadId, piSessionRegistry.get(threadId));
    }
    return () => setQueueSyncListener(null);
  }, [threadId]);

  if (!threadId || snapshot.items.length === 0) return null;

  const sessionId = piSessionRegistry.get(threadId);

  const togglePaused = async () => {
    setBusy(true);
    try {
      if (snapshot.paused) {
        const resend = await resumeQueue(threadId, sessionId);
        // 线程空闲时 sidecar 弹出队首交回：按文本重发（正常发送路径）
        if (resend && aui && !aui.thread.getState().isRunning) {
          aui.composer.setText(resend.text);
          aui.composer.send();
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
