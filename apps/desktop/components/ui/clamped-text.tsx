"use client";

/**
 * 截断文本 + 悬浮补全全文。
 *
 * 只在真的截断时才挂 tooltip：没截断还弹一层浮层是噪音。而 CSS 截断本身不告诉
 * 我们有没有截断，所以实测 scroll 尺寸与可视尺寸之差，并在元素尺寸变化时
 * （拖窗口宽度、切卡片/列表视图）重算——两行 clamp 看高度，单行省略看宽度。
 */
import { useEffect, useRef, useState, type FC } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export const ClampedText: FC<{
  text: string;
  /** 1 = 单行省略号；2/3 = 对应行数 line-clamp */
  lines: 1 | 2 | 3;
  className?: string;
}> = ({ text, lines, className }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setClipped(
        lines === 1
          ? el.scrollWidth > el.clientWidth + 1
          : el.scrollHeight > el.clientHeight + 1,
      );
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, lines]);

  // 两行时绝不能同时挂 block：line-clamp 靠 display:-webkit-box 才能画省略号，
  // 而 .block 在生成的样式表里排在 .line-clamp-2 之后，会把它覆盖成 display:block
  // （tailwind-merge 不认为 display 与 line-clamp 冲突，两个都会留在 class 上）。
  // 覆盖后只剩 overflow:hidden，于是文字剪在半行上且没有省略号。
  // 单行用的 truncate 不含 display，仍需要 block 才能拿到宽度。
  const node = (
    <span
      ref={ref}
      // 类名必须字面量：写成 `line-clamp-${lines}` 模板串 Tailwind 扫不到，
      // 样式不生成，clamp 静默失效（文本直接溢出被容器硬裁）
      className={cn(
        lines === 1 ? "block truncate" : lines === 2 ? "line-clamp-2" : "line-clamp-3",
        className,
      )}
    >
      {text}
    </span>
  );

  if (!clipped) return node;
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger render={node} />
        {/* 长段落用 popover 底色而不是默认的反色小块，读长句更省力 */}
        <TooltipContent
          side="top"
          className="border bg-popover text-popover-foreground block max-w-md text-left leading-5"
        >
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
