"use client";

import { useRef, type ReactNode } from "react";
import { motion } from "framer-motion";
import {
  useFluidHover,
  FluidHoverRegisterContext,
  type UseFluidHoverOptions,
} from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import { cn } from "@/lib/utils";

/**
 * 悬浮高亮作用域容器：把 useFluidHover 的 activeIndex 状态关在本组件内部。
 *
 * 为什么存在：列表若直接在自己组件里调 useFluidHover，鼠标每划过一行都会
 * setActiveIndex → 整个列表组件重渲染 → 每一行（各自带十几个订阅 hook）跟着
 * 重渲染，长列表悬浮切换肉眼可见地卡。改成把行列表作为 children 传进来：
 * children 元素由父级渲染、引用稳定，activeIndex 变化只让本 Scope 重渲染
 * （画高亮 + 透传 registerItem），children 被 React 按引用相等整棵跳过。
 * 行经 FluidHoverRegisterContext / FluidHoverRow 拿到 registerItem 注册自己，
 * 不需要父级因悬浮而重渲染。
 *
 * 容器形态与既有列表一致：motion.div + layoutRoot（TreeRow 的 layout 滑移
 * 依赖它）、`relative flex flex-col gap-0.5` 的槽位布局、高亮 rounded-md。
 */
export const FluidHoverScope: React.FC<{
  options?: UseFluidHoverOptions;
  className?: string;
  children: ReactNode;
}> = ({ options, className, children }) => {
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover<HTMLDivElement>(listRef, options);
  return (
    <motion.div
      ref={listRef}
      layoutRoot
      // 让位标记：嵌在外层列表里时，外层不对本区域做最近邻兜底（见
      // use-fluid-hover 的 DEFER_SELECTOR），高亮归本作用域自己管
      data-fluid-hover-defer=""
      className={cn("relative flex flex-col gap-0.5", className)}
      {...hover.handlers}
    >
      <FluidHoverHighlight hover={hover} className="rounded-md" />
      <FluidHoverRegisterContext.Provider value={hover.registerItem}>
        {children}
      </FluidHoverRegisterContext.Provider>
    </motion.div>
  );
};
