"use client";

import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import {
  requestNavBack,
  requestNavForward,
  useThreadNavCanBack,
  useThreadNavCanForward,
} from "@/lib/pi/pi-thread-nav-history";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FC } from "react";

/** 主区导航的前进/后退按钮对（浏览器式）：历史栈见 pi-thread-nav-history。
 *  侧边栏 header（展开态）与主区 Header 折叠按钮槽（折叠态）共用；无历史
 *  可退/可进或导航执行中禁用（置灰不隐藏） */
export const ThreadNavButtons: FC<{ className?: string }> = ({ className }) => {
  const canBack = useThreadNavCanBack();
  const canForward = useThreadNavCanForward();
  return (
    <div className={cn("flex shrink-0 items-center gap-1", className)}>
      <TooltipIconButton
        variant="ghost"
        size="icon"
        tooltip="后退"
        side="bottom"
        disabled={!canBack}
        onClick={() => requestNavBack()}
        className="size-8"
      >
        <ArrowLeftIcon className="size-4" />
        <span className="sr-only">后退</span>
      </TooltipIconButton>
      <TooltipIconButton
        variant="ghost"
        size="icon"
        tooltip="前进"
        side="bottom"
        disabled={!canForward}
        onClick={() => requestNavForward()}
        className="size-8"
      >
        <ArrowRightIcon className="size-4" />
        <span className="sr-only">前进</span>
      </TooltipIconButton>
    </div>
  );
};
