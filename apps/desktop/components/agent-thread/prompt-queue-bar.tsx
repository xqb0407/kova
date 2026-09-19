"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useAISDKChat } from "@assistant-ui/ai-sdk";
import {
  cancelQueuedPrompt,
  promoteQueuedPrompt,
  setQueueActivationListener,
  steerQueuedPrompt,
  unregisterQueuedPrompt,
  useThreadQueue,
  type QueuedPrompt,
} from "@/lib/pi-queue";
import { MergeIcon, PencilIcon, XIcon, ZapIcon } from "lucide-react";
import { useEffect, useState, type FC } from "react";
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
 * 数据来自 pi-queue store（sidecar data-queue chunk 的镜像）。
 */
export const PromptQueueBar: FC = () => {
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const queue = useThreadQueue(threadId);
  const chat = useAISDKChat();
  const [busyId, setBusyId] = useState<string | null>(null);

  // 排队项激活（开跑）时把对应用户气泡移到列表末尾：先发消息、后出回复的
  // 场景下，乐观追加会让消息排在回复前面——激活即开启新一轮，应排在
  // 被中止/已完成的上一轮回复之后
  useEffect(() => {
    setQueueActivationListener((entry) => {
      if (!chat || !entry.messageId) return;
      chat.setMessages((msgs) => {
        const idx = msgs.findIndex((m) => m.id === entry.messageId);
        if (idx === -1 || idx === msgs.length - 1) return msgs;
        const copy = [...msgs];
        const [moved] = copy.splice(idx, 1);
        copy.push(moved);
        return copy;
      });
    });
    return () => setQueueActivationListener(null);
  }, [chat]);

  if (!threadId || queue.length === 0) return null;

  const syncRemoveMessage = (entry: QueuedPrompt) => {
    if (!entry.messageId || !chat) return;
    chat.setMessages((msgs) => msgs.filter((m) => m.id !== entry.messageId));
  };

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
      // sidecar：中止当前 turn 并把该项提到队首；开跑时 data-queue active
      // 会把它从排队条移除，线程内消息保持不动。
      // 本地镜像同步摘除（不等 active chunk）：promote 语义 = 上一轮被结束、
      // 本条消息立即回到消息列表成为新一轮对话；并移到列表末尾——排在被
      // 中止的上一轮残缺回复之后（回复先于本消息开始，阅读顺序在后）
      await promoteQueuedPrompt(entry.requestId);
      unregisterQueuedPrompt(entry.requestId, threadId);
      if (chat && entry.messageId) {
        chat.setMessages((msgs) => {
          const idx = msgs.findIndex((m) => m.id === entry.messageId);
          if (idx === -1 || idx === msgs.length - 1) return msgs;
          const copy = [...msgs];
          const [moved] = copy.splice(idx, 1);
          copy.push(moved);
          return copy;
        });
      }
    } catch {
      // 已开跑等拒绝：忽略
    } finally {
      setBusyId(null);
    }
  };

  /** 编辑（取回输入框）：取消排队项并回填 composer，改完重新发送即重新排队 */
  const backfillToComposer = async (entry: QueuedPrompt) => {
    setBusyId(entry.requestId);
    try {
      await cancelQueuedPrompt(entry.requestId);
      syncRemoveMessage(entry);
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
      syncRemoveMessage(entry);
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
