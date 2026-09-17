"use client";

import { useAuiState } from "@assistant-ui/react";
import { useAISDKChat } from "@assistant-ui/ai-sdk";
import {
  cancelQueuedPrompt,
  promoteQueuedPrompt,
  updateQueuedPrompt,
  useThreadQueue,
  type QueuedPrompt,
} from "@/lib/pi-queue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PencilIcon, XIcon, ZapIcon } from "lucide-react";
import { useState, type FC } from "react";
import { cn } from "cn";

/**
 * prompt 排队条（composer 上方）：上一轮未结束时发出的消息在 sidecar 排队，
 * 这里逐条展示并支持 修改 / 删除 / 立即发送（插队）。
 * 数据来自 pi-queue store（sidecar data-queue chunk 的镜像）；
 * 线程内的用户消息经 useAISDKChat().setMessages 同步增删改。
 */
export const PromptQueueBar: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const queue = useThreadQueue(threadId);
  const chat = useAISDKChat();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!threadId || queue.length === 0) return null;

  const syncEditMessage = (entry: QueuedPrompt, text: string) => {
    if (!entry.messageId || !chat) return;
    chat.setMessages((msgs) =>
      msgs.map((m) =>
        m.id === entry.messageId
          ? { ...m, parts: [{ type: "text", text }] }
          : m,
      ),
    );
  };

  const syncRemoveMessage = (entry: QueuedPrompt) => {
    if (!entry.messageId || !chat) return;
    chat.setMessages((msgs) => msgs.filter((m) => m.id !== entry.messageId));
  };

  const startEdit = (entry: QueuedPrompt) => {
    setEditingId(entry.requestId);
    setDraft(entry.text);
  };

  const confirmEdit = async (entry: QueuedPrompt) => {
    const text = draft.trim();
    if (!text || text === entry.text) {
      setEditingId(null);
      return;
    }
    setBusyId(entry.requestId);
    try {
      await updateQueuedPrompt(entry.requestId, text);
      syncEditMessage(entry, text);
      setEditingId(null);
    } catch {
      // 已开跑等拒绝：保持编辑态，让用户感知（文本未变化即无副作用）
    } finally {
      setBusyId(null);
    }
  };

  const promote = async (entry: QueuedPrompt) => {
    setBusyId(entry.requestId);
    try {
      // sidecar：中止当前 turn 并把该项提到队首；开跑时 data-queue active
      // 会把它从排队条移除，线程内消息保持不动
      await promoteQueuedPrompt(entry.requestId);
    } catch {
      // 已开跑等拒绝：忽略
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
    <div className="mb-1 flex flex-col gap-1" data-slot="aui-prompt-queue-bar">
      <div className="text-muted-foreground px-1 text-xs">
        排队中 · 共 {queue.length} 条
      </div>
      {queue.map((entry) => (
        <div
          key={entry.requestId}
          className="border-border/60 dark:border-muted-foreground/15 flex items-center gap-2 rounded-lg border px-2 py-1.5"
        >
          {editingId === entry.requestId ? (
            <>
              <Input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && draft.trim()) void confirmEdit(entry);
                  if (e.key === "Escape") setEditingId(null);
                }}
                className="h-7 text-sm"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-xs"
                disabled={busyId === entry.requestId || !draft.trim()}
                onClick={() => void confirmEdit(entry)}
              >
                保存
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 px-2 text-xs"
                onClick={() => setEditingId(null)}
              >
                取消
              </Button>
            </>
          ) : (
            <>
              <span className="bg-muted-foreground/15 text-muted-foreground shrink-0 rounded-full px-1.5 text-xs leading-4 tabular-nums">
                {entry.position}
              </span>
              <span
                className="text-foreground/80 min-w-0 flex-1 truncate text-sm"
                title={entry.text}
              >
                {entry.text}
              </span>
              <div className="flex shrink-0 items-center gap-0.5">
                <QueueIconButton
                  label="立即发送（中止当前回复）"
                  disabled={busyId === entry.requestId}
                  onClick={() => void promote(entry)}
                >
                  <ZapIcon className="size-3.5" />
                </QueueIconButton>
                <QueueIconButton
                  label="修改"
                  disabled={busyId === entry.requestId}
                  onClick={() => startEdit(entry)}
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
            </>
          )}
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
      "text-muted-foreground hover:text-foreground inline-flex size-6 items-center justify-center rounded-md transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
  >
    {children}
  </button>
);
