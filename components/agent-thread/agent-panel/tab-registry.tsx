"use client";

import { useRef, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  ActivityIcon,
  FileCodeIcon,
  FileTextIcon,
  GitBranchIcon,
  GlobeIcon,
  ListTodoIcon,
  Loader2Icon,
  SquareTerminalIcon,
} from "lucide-react";
import { usePanelActivity } from "@/lib/panel-activity";
import { useThreadTodos } from "@/lib/pi-todo";
import { useWorkspace } from "@/lib/workspace-store";
import { useGitStatus } from "@/lib/git-status";
import type { PanelTab, PanelTabType } from "@/lib/panel-tabs";
import { ActivityView } from "./activity-view";
import { PlanSection } from "./plan-section";
import { FilesSection } from "./files-section";
import { GitReview } from "./git-files";
import { GitView } from "./git-view";
import { TerminalSection } from "./terminal-section";
import { BrowserView } from "./browser-view";
import { FileTab } from "./file-view";
import { TabEmpty } from "./tab-empty";

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
  "git",
];

/** 可打开的标签类型:git 标签仅在工作目录是 git 仓库时出现(静默降级,不报错) */
export function useVisiblePanelTabTypes(): PanelTabType[] {
  const workspace = useWorkspace();
  const { status } = useGitStatus(workspace);
  if (status) return [...PANEL_TAB_TYPES];
  return PANEL_TAB_TYPES.filter((t) => t !== "git");
}

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
  file: {
    label: "文件",
    description: "读取结果回看",
    icon: FileTextIcon,
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
  git: {
    label: "Git",
    description: "暂存、提交与分支",
    icon: GitBranchIcon,
  },
};

export function tabTitle(tab: PanelTab): string {
  return tab.title ?? TAB_META[tab.type].label;
}

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

const ReviewTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  // 数据源切换(git 集成 M1):workspace 是 git 仓库 → 真 `git diff HEAD`
  // (bash/编辑器造成的改动同样可见);非仓库或 git 缺失 → 回退旧的
  // 工具流水派生视图,网页端行为不变。
  // tab.checkpoint = 检查点卡片「审查」定向打开：cwd 取检查点自身的,
  // diff 显示"本回合改动 vs 运行前快照",而非整个工作区。
  const workspace = useWorkspace();
  const { status } = useGitStatus(workspace);
  const { files } = usePanelActivity();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cwd = tab.checkpoint ? (tab.cwd ?? workspace) : workspace;
  // tab.focus = 工具行「编辑/写入」定位进来的文件路径（git 视图按仓库
  // 相对路径匹配，派生视图按完整路径匹配）
  if (cwd && status)
    return <GitReview cwd={cwd} checkpoint={tab.checkpoint} focusPath={tab.focus} />;
  if (files.length === 0)
    return <TabEmpty icon={FileCodeIcon} text="agent 改动文件后,这里会列出可展开的 diff" />;
  // 滚动容器自身不带内边距，p-3 放进随内容滚动的内层：
  // 容器带 pt 时那 12px 会永远隔在吸顶头与滚动口上沿之间（见 git-view 同款注释）
  return (
    <div ref={scrollerRef} className="h-full overflow-y-auto">
      <div className="p-3">
        <FilesSection
          groups={files}
          focusPath={tab.focus}
          scrollRoot={scrollerRef}
        />
      </div>
    </div>
  );
};

const GitTab: FC = () => {
  const workspace = useWorkspace();
  const { status, loading } = useGitStatus(workspace);
  // 切换 workspace 后 B 的 status 首拉在途:先展示加载态,
  // 避免闪一句"不是 git 仓库"再切过来(观感像没跟随切换)
  if (workspace && loading && !status)
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-1.5 text-xs">
        <Loader2Icon className="size-3.5 animate-spin" />
        读取 Git 状态…
      </div>
    );
  if (!workspace || !status)
    return (
      <TabEmpty
        icon={GitBranchIcon}
        text="当前工作目录不是 git 仓库,或系统未安装 git"
      />
    );
  return <GitView cwd={workspace} />;
};

const TerminalTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  const { terminal } = usePanelActivity();
  const scrollerRef = useRef<HTMLDivElement>(null);
  if (terminal.length === 0)
    return <TabEmpty icon={SquareTerminalIcon} text="agent 执行命令后,输出会汇总到这里" />;
  // 内边距放内层，理由同 ReviewTab（吸顶间隙）
  return (
    <div ref={scrollerRef} className="h-full overflow-y-auto">
      <div className="p-3">
        <TerminalSection
          entries={terminal}
          focusToolCallId={tab.focus}
          scrollRoot={scrollerRef}
        />
      </div>
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
      return <ReviewTab tab={tab} />;
    case "file":
      return <FileTab tab={tab} />;
    case "terminal":
      return <TerminalTab tab={tab} />;
    case "git":
      return <GitTab />;
    case "browser":
      return <BrowserView tab={tab} />;
    default:
      return null;
  }
};
