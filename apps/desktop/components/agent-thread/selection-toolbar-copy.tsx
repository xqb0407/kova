"use client";

/**
 * 划词工具栏的「复制」入口（与「辅助会话」并列）。
 *
 * 取词方式与辅助会话一致：Root 的 onMouseDown 已 preventDefault（点击不会
 * 清掉选区），但平台/输入法差异下 click 时 getSelection() 可能已经塌陷，
 * 所以在 mousedown 先抓一份快照作为权威值。
 *
 * 复制后清掉选区：工具栏随 selectionchange 收起，结果用 toast 反馈
 * （气泡消失后仍能看到确认）。
 */

import { CopyIcon, NotebookPenIcon } from "lucide-react";
import { useRef, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/remote";
import {
  piSessionCwdMap,
  piSessionIdForThread,
  piSessionProjectMap,
} from "@/lib/pi/pi-thread-adapter";
import { saveNoteFromText } from "@/lib/workspace/library-save-note";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { cn } from "@/lib/utils";

function selectedText(): string {
  try {
    return window.getSelection()?.toString().trim() ?? "";
  } catch {
    return "";
  }
}

export const SelectionToolbarCopy: FC<{ className?: string }> = ({
  className,
}) => {
  const capturedRef = useRef<string | null>(null);

  const handleClick = () => {
    const text = capturedRef.current ?? selectedText();
    capturedRef.current = null;
    if (!text) return;
    // 先清选区再写剪贴板：工具栏随 selectionchange 收起，异步复制不依赖它
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* 选区 API 不可用时忽略 */
    }
    void copyText(text).then((ok) => {
      if (ok) toast.success("已复制");
      else toast.error("复制失败");
    });
  };

  return (
    <button
      type="button"
      data-slot="selection-toolbar-copy"
      onMouseDown={() => {
        capturedRef.current = selectedText();
      }}
      onClick={handleClick}
      className={cn(
        "text-popover-foreground hover:bg-accent flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors",
        className,
      )}
    >
      <CopyIcon className="size-3.5" />
      复制
    </button>
  );
};

/** 划词工具栏的「存为笔记」：与复制共用选区快照口径，保存到来源项目目录 */
export const SelectionToolbarSaveNote: FC<{ className?: string }> = ({
  className,
}) => {
  const capturedRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const cwd = useWorkspace();
  const threadId = useAuiState((s) => s.threads.mainThreadId);

  const handleClick = () => {
    const text = capturedRef.current ?? selectedText();
    capturedRef.current = null;
    if (!text || saving) return;
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* 选区 API 不可用时忽略 */
    }
    // 点击时再查 map：新会话的摘要可能晚于组件首次渲染到达
    const sessionId = threadId ? piSessionIdForThread(threadId) : undefined;
    const noteCwd =
      (sessionId ? piSessionCwdMap.get(sessionId) : undefined) ?? cwd;
    const noteProjectCwd = sessionId
      ? piSessionProjectMap.get(sessionId)
      : undefined;
    setSaving(true);
    void saveNoteFromText({
      text,
      cwd: noteCwd,
      projectCwd: noteProjectCwd,
      sessionId,
    }).finally(() => setSaving(false));
  };

  return (
    <button
      type="button"
      data-slot="selection-toolbar-save-note"
      disabled={saving}
      onMouseDown={() => {
        capturedRef.current = selectedText();
      }}
      onClick={handleClick}
      className={cn(
        "text-popover-foreground hover:bg-accent flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors disabled:opacity-50",
        className,
      )}
    >
      <NotebookPenIcon className="size-3.5" />
      存为笔记
    </button>
  );
};
