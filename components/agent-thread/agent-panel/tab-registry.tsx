"use client";

import type { FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  ActivityIcon,
  FileCodeIcon,
  GlobeIcon,
  ListTodoIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { usePanelActivity } from "@/lib/panel-activity";
import { useThreadTodos } from "@/lib/pi-todo";
import type { PanelTab, PanelTabType } from "@/lib/panel-tabs";
import { ActivityView } from "./activity-view";
import { PlanSection } from "./plan-section";
import { FilesSection } from "./files-section";
import { TerminalSection } from "./terminal-section";
import { BrowserView } from "./browser-view";

/**
 * 标签类型注册表:标题/图标/视图组件的单一事实源,
 * tab-bar 的 "+" 菜单与空态卡片网格都从这里派生。
 */
export const PANEL_TAB_TYPES: readonly PanelTabType[] = [
  "activity",
  "plan",
  "review",
  "terminal",
  "browser",
];

export const TAB_META: Record<
  PanelTabType,
  { label: string; description: string; icon: FC<{ className?: string }> }
> = {
  activity: {
    label: "活动",
    description: "计划、文件变更与终端的汇总动态",
    icon: ActivityIcon,
  },
  plan: {
    label: "计划",
    description: "agent 任务清单与进度",
    icon: ListTodoIcon,
  },
  review: {
    label: "审查",
    description: "文件变更与行级 diff",
    icon: FileCodeIcon,
  },
  terminal: {
    label: "终端",
    description: "bash 命令与输出流水",
    icon: SquareTerminalIcon,
  },
  browser: {
    label: "浏览器",
    description: "打开网页或本地预览",
    icon: GlobeIcon,
  },
};

export function tabTitle(tab: PanelTab): string {
  return tab.title ?? TAB_META[tab.type].label;
}

/** 独立标签的空态占位(与活动标签的空态观感一致) */
const TabEmpty: FC<{ icon: FC<{ className?: string }>; text: string }> = ({
  icon: Icon,
  text,
}) => (
  <div className="text-muted-foreground/60 flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs">
    <Icon className="size-6" />
    <p>{text}</p>
  </div>
);

const PlanTab: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useThreadTodos(threadId ?? undefined);
  const hasPlan = snap.tasks.some((t) => t.status !== "deleted");
  if (!hasPlan)
    return <TabEmpty icon={ListTodoIcon} text="agent 建立任务清单后,进度会显示在这里" />;
  return (
    <div className="h-full overflow-y-auto p-3">
      <PlanSection />
    </div>
  );
};

const ReviewTab: FC = () => {
  const { files } = usePanelActivity();
  if (files.length === 0)
    return <TabEmpty icon={FileCodeIcon} text="agent 改动文件后,这里会列出可展开的 diff" />;
  return (
    <div className="h-full overflow-y-auto p-3">
      <FilesSection groups={files} />
    </div>
  );
};

const TerminalTab: FC = () => {
  const { terminal } = usePanelActivity();
  if (terminal.length === 0)
    return <TabEmpty icon={SquareTerminalIcon} text="agent 执行命令后,输出会汇总到这里" />;
  return (
    <div className="h-full overflow-y-auto p-3">
      <TerminalSection entries={terminal} />
    </div>
  );
};

/** 按标签类型路由到视图;外层以 tab.id 作 key 重挂载,组件内状态即标签私有 */
export const TabContentView: FC<{ tab: PanelTab }> = ({ tab }) => {
  switch (tab.type) {
    case "activity":
      return <ActivityView />;
    case "plan":
      return <PlanTab />;
    case "review":
      return <ReviewTab />;
    case "terminal":
      return <TerminalTab />;
    case "browser":
      return <BrowserView tab={tab} />;
    default:
      return null;
  }
};
