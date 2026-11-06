"use client";

import { lazy, Suspense, type ComponentProps, type FC } from "react";
import { Loader2Icon, PanelRightCloseIcon } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useTerminalDock } from "@/lib/terminal/dock";

/**
 * 重面板/终端坞的懒加载边界。
 *
 * 从 base.tsx 拆出来有两个目的：
 * - PanelSkeleton 能拿到 onCollapse（next/dynamic 的 loading 回调拿不到 props），
 *   面板首开 chunk 慢/失败时仍有收起入口；Header 在 panelShown 后已隐藏面板
 *   开关，没有这个按钮用户会被困在面板里。
 * - 动态 import/React.lazy 的边界独立成模块，降低 base.tsx 热更时旧 JSX
 *   引用（曾出现 `TerminalDock is not defined`）的概率。
 */
const AgentPanelLazy = lazy(() =>
  import("./agent-panel").then((m) => ({ default: m.AgentPanel })),
);
const TerminalDockLazy = lazy(() =>
  import("./terminal-dock").then((m) => ({ default: m.TerminalDock })),
);

const PanelSkeleton: FC<{ onCollapse?: () => void; flush?: boolean }> = ({
  onCollapse,
  flush = false,
}) => (
  <div
    className={
      flush
        ? "bg-background flex h-full min-w-0 flex-col overflow-hidden rounded-r-lg border-y border-r border-border/60"
        : "bg-background border-border/60 flex h-full min-w-0 flex-col overflow-hidden rounded-lg border"
    }
  >
    <div className="border-border/80 flex h-12 shrink-0 items-center gap-2 border-b pl-4">
      {onCollapse ? (
        <TooltipIconButton
          variant="ghost"
          size="icon"
          tooltip="收起 Agent 面板"
          side="bottom"
          onClick={onCollapse}
          className="size-8 shrink-0"
        >
          <PanelRightCloseIcon className="size-4" />
        </TooltipIconButton>
      ) : null}
      <Loader2Icon className="text-muted-foreground size-4 animate-spin" />
    </div>
    <div className="flex flex-1 items-center justify-center">
      <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
    </div>
  </div>
);

type AgentPanelProps = ComponentProps<typeof AgentPanelLazy>;

export const AgentPanelSlot: FC<AgentPanelProps> = (props) => (
  <Suspense
    fallback={
      <PanelSkeleton onCollapse={props.onCollapse} flush={props.flush} />
    }
  >
    <AgentPanelLazy {...props} />
  </Suspense>
);

export const TerminalDockGate: FC = () => {
  const { open, tabs } = useTerminalDock();
  if (!open && tabs.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <TerminalDockLazy />
    </Suspense>
  );
};
