"use client";

/**
 * 划词工具栏的「辅助会话」入口（与「询问」并列）。
 *
 * 选区信息的权威读取在 assistant-ui 的 SelectionToolbarPrimitive 内部，且未从
 * 包根导出；工具栏能显示就说明 Root 已校验过「选区落在单条消息内」，且 Root
 * 的 onMouseDown 已 preventDefault（点击不会清掉选区）。因此这里在点击瞬间
 * 直接读 window.getSelection()，足够拿到文本与来源消息 id。
 *
 * 副屏内不再提供本入口（SideChatScope 命中即隐藏），避免套娃。
 */

import { useAuiState } from "@assistant-ui/react";
import { MessageCirclePlusIcon } from "lucide-react";
import { useRef, type FC } from "react";
import { toast } from "@/components/ui/toast";
import { piSessionIdForThread } from "@/lib/pi/pi-thread-adapter";
import { startAuxiliarySession } from "@/lib/side-chat/launch";
import { useSideChatScope } from "@/lib/side-chat/scope";
import { cn } from "@/lib/utils";

function selectedText(): string {
  try {
    return window.getSelection()?.toString().trim() ?? "";
  } catch {
    return "";
  }
}

/** 选区锚点最近的 assistant-ui 消息节点 id（[data-message-id]） */
function selectedMessageId(): string | undefined {
  try {
    const node = window.getSelection()?.anchorNode;
    const el =
      node instanceof HTMLElement ? node : (node?.parentElement ?? null);
    return el?.closest("[data-message-id]")?.getAttribute("data-message-id") ?? undefined;
  } catch {
    return undefined;
  }
}

function captureSelection(): { text: string; messageId?: string } | null {
  const text = selectedText();
  if (!text) return null;
  const messageId = selectedMessageId();
  return { text, ...(messageId ? { messageId } : {}) };
}

export const SelectionToolbarAuxiliary: FC<{ className?: string }> = ({
  className,
}) => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const sideChatScope = useSideChatScope();
  // mousedown 时先抓一份：Root 会 preventDefault 保住选区，但平台/输入法
  // 差异下 click 时 getSelection() 可能已经塌陷，抓到的快照作为权威值。
  const capturedRef = useRef<{ text: string; messageId?: string } | null>(null);
  if (sideChatScope) return null;

  const handleClick = () => {
    const selection = capturedRef.current ?? captureSelection();
    capturedRef.current = null;
    if (!selection) return;
    const parentSessionId = threadId
      ? piSessionIdForThread(threadId)
      : undefined;
    // 先清选区再发请求：工具栏随 selectionchange 收起，异步创建不依赖它
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* 选区 API 不可用时忽略 */
    }
    if (!parentSessionId) {
      toast.message({
        title: "先发送一条消息",
        description: "辅助会话需要挂在一个已建立的会话上",
      });
      return;
    }
    void startAuxiliarySession({
      parentSessionId,
      quote: selection,
    });
  };

  return (
    <button
      type="button"
      data-slot="selection-toolbar-auxiliary"
      onMouseDown={() => {
        capturedRef.current = captureSelection();
      }}
      onClick={handleClick}
      className={cn(
        "text-popover-foreground hover:bg-accent flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors",
        className,
      )}
    >
      <MessageCirclePlusIcon className="size-3.5" />
      辅助会话
    </button>
  );
};
