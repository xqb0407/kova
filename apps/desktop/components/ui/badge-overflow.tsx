"use client";

import type { ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import { Badge, badgeVariants } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];

/**
 * 徽标溢出组：超过 max 个时只展示前 max 个，余量折叠为「+N」徽标，
 * 悬浮整组以 tooltip 形式展示被折叠的徽标。适用于组件/标签摘要行。
 */
export function BadgeOverflow({
  items,
  max = 2,
  variant = "secondary",
  className,
  itemClassName,
}: {
  items: ReactNode[];
  /** 直接展示的最大数量，余量折叠进「+N」 */
  max?: number;
  variant?: BadgeVariant;
  className?: string;
  itemClassName?: string;
}) {
  if (items.length === 0) return null;

  const renderBadge = (node: ReactNode, key: string) => (
    <Badge key={key} variant={variant} className={itemClassName}>
      {node}
    </Badge>
  );
  const visible = items.slice(0, max).map((it, i) => renderBadge(it, `v-${i}`));
  const hidden = items.slice(max);
  const row = cn("flex flex-wrap items-center gap-1.5", className);

  if (hidden.length === 0) {
    return <div className={row}>{visible}</div>;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<div className={row} />}>
          {visible}
          {renderBadge(`+${hidden.length}`, "overflow")}
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="border bg-popover text-popover-foreground **:data-[slot=tooltip-arrow]:hidden"
        >
          <div className="flex flex-wrap gap-1.5">
            {hidden.map((it, i) => renderBadge(it, `h-${i}`))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
