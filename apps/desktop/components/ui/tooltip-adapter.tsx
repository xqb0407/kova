"use client";

import { useState } from "react";
import {
  Tooltip as TooltipPrimitive,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./tooltip";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  delayDuration?: number;
  sideOffset?: number;
  forceOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
}

/**
 * Adapter component that wraps the original tooltip components
 * to provide the API expected by Fluid Functionalism's InputCopy
 */
export function Tooltip({
  content,
  children,
  delayDuration = 500,
  sideOffset = 4,
  forceOpen,
  onOpenChange,
  side = "top",
}: TooltipProps) {
  const [open, setOpen] = useState(false);

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    onOpenChange?.(newOpen);
  };

  return (
    <TooltipProvider delay={delayDuration}>
      <TooltipPrimitive
        open={forceOpen !== undefined ? forceOpen : open}
        onOpenChange={handleOpenChange}
      >
        {/* children 本身就是原生按钮（InputCopy 的复制按钮）：触发器降级成
            span 包裹，否则 button 套 button 会报 hydration 错误；
            block w-full 保持按钮通栏的原布局，焦点/悬停由 base-ui 冒泡监听 */}
        <TooltipTrigger
          render={<span data-slot="tooltip-trigger" className="block w-full" />}
        >
          {children}
        </TooltipTrigger>
        <TooltipContent side={side} sideOffset={sideOffset}>
          {content}
        </TooltipContent>
      </TooltipPrimitive>
    </TooltipProvider>
  );
}