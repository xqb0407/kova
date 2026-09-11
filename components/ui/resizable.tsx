"use client";

import type { FC } from "react";
import {
  Group,
  Panel,
  Separator,
  type GroupProps,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels";
import { cn } from "@/lib/utils";

/**
 * react-resizable-panels v4 的薄封装（对齐 shadcn/ui 的 resizable 命名习惯）。
 * v4 导出的原语叫 Group/Panel/Separator；这里转名为 Resizable* 便于阅读。
 * 注意：Panel/Separator 必须作为 Group 的直接子元素。
 */

const ResizablePanelGroup: FC<GroupProps> = ({
  className,
  orientation = "horizontal",
  ...props
}) => (
  <Group
    data-slot="resizable-panel-group"
    orientation={orientation}
    className={cn(
      "flex h-full w-full",
      orientation === "vertical" && "flex-col",
      className,
    )}
    {...props}
  />
);
ResizablePanelGroup.displayName = "ResizablePanelGroup";

const ResizablePanel: FC<PanelProps> = (props) => (
  <Panel data-slot="resizable-panel" {...props} />
);
ResizablePanel.displayName = "ResizablePanel";

/**
 * 拖拽把手：本体 6px 宽（保证命中区），中心画 1px 细线，hover/拖动时高亮。
 * data-separator 是库加在根元素上的属性，用于挂 hover/active 样式。
 */
const ResizableHandle: FC<SeparatorProps> = ({ className, ...props }) => (
  <Separator
    data-slot="resizable-handle"
    className={cn(
      "relative flex w-1.5 shrink-0 items-center justify-center outline-none",
      // 悬停/拖动（含键盘 focus）时细线加粗高亮
      "[&:hover>div]:bg-foreground/25 [&:active>div]:bg-foreground/45 [&:focus-visible>div]:bg-foreground/45",
      className,
    )}
    {...props}
  >
    <div className="bg-border/50 pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-[background-color,width] hover:w-0.5" />
  </Separator>
);
ResizableHandle.displayName = "ResizableHandle";

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
