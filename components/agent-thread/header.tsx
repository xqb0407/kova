"use client";

import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { PiModelPicker } from "@/components/agent-thread/model-picker";
import { cn } from "@/lib/utils";
import { isMacPlatform, isTauri } from "@/lib/tauri";
import { WindowControls } from "@/components/window-controls";
import { useAuiState } from "@assistant-ui/react";
import { MenuIcon, PanelLeftIcon, ShareIcon } from "lucide-react";
import Image from "next/image";
import logo from "@/public/favicon/logo.svg";
import { Button } from "@/components/ui/button";
import type { FC } from "react";

export const Logo: FC<{ collapsed?: boolean }> = ({ collapsed = false }) => {
  return (
    <div
      className={cn(
        "flex items-center text-sm font-medium",
        collapsed ? "size-8 shrink-0 justify-center" : "min-w-0 gap-2 px-2",
      )}
    >
      <Image
        src={logo}
        alt="logo"
        className="size-5 shrink-0 dark:hue-rotate-180 dark:invert"
      />
      {!collapsed && (
        <span className="text-foreground/90 truncate">搞个锤子</span>
      )}
    </div>
  );
};

const ModelPicker: FC = () => {
  return <PiModelPicker />;
};

const ThreadTitle: FC = () => {
  const title = useAuiState(
    (s) =>
      s.threads.threadItems.find((t) => t.id === s.threads.mainThreadId)?.title,
  );

  return (
    <span className="min-w-0 truncate text-sm font-medium">
      {title ?? "New Chat"}
    </span>
  );
};

export const Header: FC<{
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenMobileSidebar: () => void;
}> = ({ sidebarCollapsed, onToggleSidebar, onOpenMobileSidebar }) => {
  // 桌面端自绘 titlebar：拖拽区所有桌面端生效；红绿灯让位仅 macOS（Windows 隐藏系统
  // 标题栏后由 WindowControls 接管，网页端无窗口 chrome）
  const desktop = isTauri();
  const mac = desktop && isMacPlatform();
  const winControls = desktop && !mac;
  return (
    <header
      data-tauri-drag-region={desktop ? "deep" : undefined}
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 border-b",
        // Windows 三键贴窗口右上角，去掉右 padding；其余环境保持 pr-4
        winControls ? "pr-0" : "pr-4",
        sidebarCollapsed && mac ? "md:pl-24" : "pl-4",
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 md:hidden"
        onClick={onOpenMobileSidebar}
      >
        <MenuIcon className="size-4" />
        <span className="sr-only">Toggle menu</span>
      </Button>
      {/* 侧边栏展开时其顶栏已有折叠按钮，这里仅在折叠后显示 */}
      {sidebarCollapsed && (
        <TooltipIconButton
          variant="ghost"
          size="icon"
          tooltip="Show sidebar"
          side="bottom"
          onClick={onToggleSidebar}
          className="hidden size-8 md:flex"
        >
          <PanelLeftIcon className="size-4" />
        </TooltipIconButton>
      )}
      <ThreadTitle />
      <TooltipIconButton
        variant="ghost"
        size="icon"
        tooltip="Share"
        side="bottom"
        disabled
        className="ml-auto size-8"
      >
        <ShareIcon className="size-4" />
      </TooltipIconButton>
      {/* 窗口控制固定在窗口右上角（主 Header 右缘即窗口右缘）；仅 Windows/Linux 渲染 */}
      <WindowControls />
    </header>
  );
};