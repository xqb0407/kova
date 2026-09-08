"use client";

import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { ModelSelector } from "@/components/assistant-ui/elements/model-selector.aui";
import { docsModelOptions } from "@/components/docs/assistant/docs-model-options";
import { DEFAULT_MODEL_ID } from "@/lib/model";
import { cn } from "@/lib/utils";
import { useAuiState } from "@assistant-ui/react";
import { MenuIcon, PanelLeftIcon, ShareIcon } from "lucide-react";
import Image from "next/image";
import icon from "@/public/favicon/icon.svg";
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
        src={icon}
        alt="logo"
        className="size-5 shrink-0 dark:hue-rotate-180 dark:invert"
      />
      {!collapsed && (
        <span className="text-foreground/90 truncate">搞个锤子</span>
      )}
    </div>
  );
};

const models = docsModelOptions();

const ModelPicker: FC = () => {
  return (
    <ModelSelector
      models={models}
      defaultValue={DEFAULT_MODEL_ID}
      variant="ghost"
      size="sm"
      className="h-7 rounded-full"
    />
  );
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
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-4">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 md:hidden"
        onClick={onOpenMobileSidebar}
      >
        <MenuIcon className="size-4" />
        <span className="sr-only">Toggle menu</span>
      </Button>
      <TooltipIconButton
        variant="ghost"
        size="icon"
        tooltip={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        side="bottom"
        onClick={onToggleSidebar}
        className="hidden size-8 md:flex"
      >
        <PanelLeftIcon className="size-4" />
      </TooltipIconButton>
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
    </header>
  );
};