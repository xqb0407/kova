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
        <TooltipTrigger>{children}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={sideOffset}>
          {content}
        </TooltipContent>
      </TooltipPrimitive>
    </TooltipProvider>
  );
}