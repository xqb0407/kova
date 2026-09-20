"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useAISDKChat } from "@assistant-ui/ai-sdk";
import {
  cancelQueuedPrompt,
  peekThreadQueue,
  promoteQueuedPrompt,
  setQueueSyncListener,
  steerQueuedPrompt,
  useThreadQueue,
  type QueuedPrompt,
} from "@/lib/pi-queue";
import { MergeIcon, PencilIcon, XIcon, ZapIcon } from "lucide-react";
import { useEffect, useRef, useState, type FC } from "react";
import { cn } from "cn";

/**
 * prompt 排队条（composer 上方，ChatGPT 式）：上一轮未结束时发出的消息在
 * sidecar 排队，这里以「幽灵输入框」卡片逐条展示——与 composer 同款圆角/
 * 背景/边框但更安静：行首小序号、文字一行截断降调，操作按钮悬停才出现。
 * 每项四个操作（悬停浮现）：
 *  - 并入当前轮：注入活跃轮，不中止不排队（queue_steer → steered 退化收尾）
 *  - 立即发送：中止当前轮、该项插队（queue_promote）
 *  - 编辑：取回输入框——取消排队项（线程内消息一并移除）并回填 composer，
 *    改完重新发送即重新排队
 *  - 删除：取消排队项（queue_cancel，线程内消息一并移除）
 * 数据来自 pi-queue store（sidecar data-queue chunk 的镜像）；
 * 消息数组的摘除/回填同步见 pi-queue.ts 头注。
 */
export const PromptQueueBar: FC = () => {
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const queue = useThreadQueue(threadId);
  const chat = useAISDKChat();
  const [busyId, setBusyId] = useState<string | null>(null);

  /**
   * 消息数组同步（经 syncRef 间接调用，见下方 effect）。两个方向都必须「无变化
   * 时不赋值」：Chat 的 messages setter 即使内容相同也会拷贝新数组并通知全部
   * 订阅者，无条件赋值会形成 渲染→同步→通知→渲染 的死循环（UI 卡死）。
   * - remove：排队确认时把 user 消息从数组摘除
   * - reveal：激活开跑 / 未开跑被取消收尾时，消息不在数组才追加到末尾。
   *   不做「移到末尾」——回复内容可能已经追加在其后（流式写入/历史装载），
   *   再移动会把 user 气泡排到自己的回复之后，并诱发 AI SDK 对回复消息的
   *   pushMessage 重复项循环（ExternalStore duplicate id 警告刷屏）
   */
  const syncRef = useRef<(entry: QueuedPrompt, mode: "remove" | "reveal") => void>(
    () => {},
  );
  syncRef.current = (entry, mode) => {
    if (!chat || !entry.messageId || entry.threadId !== threadId) return;
    const msgs = chat.messages;
    const idx = msgs.findIndex((m) => m.id === entry.messageId);
    let next = msgs;
    if (mode === "remove") {
      if (idx !== -1) next = msgs.filter((m) => m.id !== entry.messageId);
    } else if (idx === -1 && entry.message) {
      // 回填注册时暂存的原始消息（含附件/引用 metadata）
      next = [...msgs, entry.message];
    }
    if (next !== msgs) chat.setMessages(next);
  };

  // 消息同步监听 + 对账：监听只作用于当前线程的 chat；线程切走期间发生的
  // 摘除事件会错过，重挂载时对「排队未开跑」条目补齐摘除。
  // 已开跑（active）条目对账时不再补追加：激活瞬间的 onReveal 已经回填过；
  // 若期间发生过历史装载（消息换成 sidecar 侧 id），再按乐观 id 追加会与
  // 历史副本构成兄弟节点 → 消息上出现 2/2 分支选择器。开跑消息的显示由
  // 激活回填或历史转录兜底，对账不插手。
  useEffect(() => {
    setQueueSyncListener({
      onQueued: (entry) => syncRef.current(entry, "remove"),
      onReveal: (entry) => syncRef.current(entry, "reveal"),
    });
    if (threadId) {
      for (const entry of peekThreadQueue(threadId)) {
        if (!entry.active) syncRef.current(entry, "remove");
      }
    }
    return () => setQueueSyncListener(null);
  }, [threadId]);

  if (!threadId || queue.length === 0) return null;

  /** 并入当前轮：注入活跃轮（不中止不排队）；chip 随该项流 finish 自动移除，
   *  线程内用户消息保留（线性转录） */
  const steerIntoActive = async (entry: QueuedPrompt) => {
    setBusyId(entry.requestId);
    try {
      await steerQueuedPrompt(entry.requestId);
    } catch {
      // 无活跃轮/已开跑等拒绝：忽略（chip 保留）
    } finally {
      setBusyId(null);
    }
  };

  const promote = async (entry: QueuedPrompt) => {
    setBusyId(entry.requestId);
    try {
      // sidecar：中止当前 turn 并把该项提到队首。本地不做摘除/回填——上一轮
      // 收尾期间仍有流式写入，此刻动消息数组会被写入的重复项顶乱顺序；排队条
      // 摘除与消息回填统一等 data-queue(active)（sidecar 保证它在上一轮流完整
      // 收尾之后发出，见 pi-queue.ts applyQueueChunk）
      await promoteQueuedPrompt(entry.requestId);
    } catch {
      // 已开跑等拒绝：忽略（active 分支已处理，或 chip 保留）
    } finally {
      setBusyId(null);
    }
  };

  /** 编辑（取回输入框）：取消排队项并回填 composer，改完重新发送即重新排队 */
  const backfillToComposer = async (entry: QueuedPrompt) => {
    setBusyId(entry.requestId);
    try {
      await cancelQueuedPrompt(entry.requestId);
      aui.composer.setText(entry.text);
    } catch {
      // 已开跑等拒绝：消息继续执行，不回填
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (entry: QueuedPrompt) => {
    setBusyId(entry.requestId);
    try {
      await cancelQueuedPrompt(entry.requestId);
    } catch {
      // 已开跑等拒绝：消息继续执行，不移除
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="mb-2 flex flex-col gap-1.5"
      data-slot="aui-prompt-queue-bar"
    >
      {queue.map((entry) => (
        <div
          key={entry.requestId}
          className="group border-border/50 dark:border-muted-foreground/10 flex items-center gap-2 rounded-(--composer-radius) border bg-(--composer-bg) py-2 pr-1.5 pl-3.5 animate-in fade-in slide-in-from-bottom-1 duration-200"
        >
          <span
            className="w-3 shrink-0 text-center text-[11px] leading-none text-muted-foreground/50 tabular-nums"
            aria-label={`排队第 ${entry.position} 位`}
          >
            {entry.position}
          </span>
          <span
            className="text-foreground/70 min-w-0 flex-1 truncate text-sm"
            title={entry.text}
          >
            {entry.text}
          </span>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
            <QueueIconButton
              label="并入当前回复（不中止不排队）"
              disabled={busyId === entry.requestId}
              onClick={() => void steerIntoActive(entry)}
            >
              <MergeIcon className="size-3.5" />
            </QueueIconButton>
            <QueueIconButton
              label="立即发送（中止当前回复）"
              disabled={busyId === entry.requestId}
              onClick={() => void promote(entry)}
            >
              <ZapIcon className="size-3.5" />
            </QueueIconButton>
            <QueueIconButton
              label="编辑（取回输入框）"
              disabled={busyId === entry.requestId}
              onClick={() => void backfillToComposer(entry)}
            >
              <PencilIcon className="size-3.5" />
            </QueueIconButton>
            <QueueIconButton
              label="删除"
              disabled={busyId === entry.requestId}
              className="hover:text-destructive"
              onClick={() => void remove(entry)}
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
