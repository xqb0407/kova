"use client";

import type { FC } from "react";
import { SquareTerminalIcon } from "lucide-react";
import { isDesktop } from "@/lib/desktop-env";
import { toggleTerminalDock, useTerminalDockOpen } from "@/lib/terminal/dock";
import { useIsAskMode } from "@/lib/pi/pi-session-mode";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { cn } from "@/lib/utils";

/**
 * 终端坞开关按钮（Header 右上角按钮簇 / 面板顶栏两处共用，随面板停靠
 * 交接——与窗口控件的交接规则一致）：只订阅开合位，拖高时不会逐帧重渲染。
 * 坞展开时按钮点亮（aria-pressed + 底色，VSCode 同款，一眼看出终端在开着——
 * 收起态坞不会露出任何痕迹）。
 * 显隐与面板终端标签同源：仅桌面端、且问答档不露（那一档不碰工程）。
 *
 * 从 terminal-dock.tsx 拆出：Header 只需要这个按钮，不应把整个坞 +
 * ShellViewport/xterm 样式的模块图拖进首屏。
 */
export const TerminalToggleButton: FC<{ className?: string }> = ({
  className,
}) => {
  const open = useTerminalDockOpen();
  const ask = useIsAskMode();
  if (!isDesktop() || ask) return null;
  return (
    <TooltipIconButton
      variant="ghost"
      size="icon"
      tooltip={open ? "收起终端面板" : "打开终端面板"}
      side="bottom"
      aria-pressed={open}
      onClick={() => toggleTerminalDock()}
      className={cn(
        "size-8 shrink-0",
        open && "bg-muted text-foreground",
        className,
      )}
    >
      <SquareTerminalIcon className="size-4" />
    </TooltipIconButton>
  );
};
