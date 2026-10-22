"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type TooltipIconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tooltip?: string;
  side?: "top" | "right" | "bottom" | "left";
  variant?: string;
  size?: string;
  children?: ReactNode;
};

export function TooltipIconButton({
  tooltip,
  side,
  // 这两个是历史调用点的视觉参数；本组件只有一种图标按钮外观，解构掉避免
  // 作为非法 DOM 属性 spread 到 <button>（React 会告警）
  variant: _variant,
  size: _size,
  className,
  children,
  ...props
}: TooltipIconButtonProps) {
  void _variant;
  void _size;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={tooltip}
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-muted disabled:opacity-50",
              className,
            )}
            {...props}
          >
            {children}
          </button>
        }
      />
      <TooltipContent side={side}>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}
