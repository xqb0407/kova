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

import { CopyIcon } from "lucide-react";
import { useRef, type FC } from "react";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/remote";
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
