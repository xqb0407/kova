"use client";

import { useRef, type FC, type ReactNode } from "react";
import { useRegisterFluidHoverItem } from "@/hooks/use-fluid-hover";
import { cn } from "@/lib/utils";

/** 与 useFluidHover 的 registerItem 同签名。 */
export type FluidHoverRegisterItem = (
  index: number,
  element: HTMLElement | null,
) => void;

/**
 * 把自己的 div 注册进所在 fluid hover 作用域（见 use-fluid-hover）：
 * 高亮块滑向的 rect 就是这个 div 的盒子，子元素照常渲染。用于按钮等
 * 不便直接拿 ref 的行——包一层不改变 flex 列布局（子级 w-full 撑满）。
 * 自带 relative：行是定位元素且晚于高亮渲染，压在高亮之上（选中行的
 * 自绘底色也因此盖过高亮），与列表行的层级约定一致。
 */
export const FluidHoverRow: FC<{
  registerItem: FluidHoverRegisterItem;
  index: number;
  className?: string;
  children: ReactNode;
}> = ({ registerItem, index, className, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useRegisterFluidHoverItem(registerItem, index, ref);
  return (
    <div ref={ref} className={cn("relative", className)}>
      {children}
    </div>
  );
};
