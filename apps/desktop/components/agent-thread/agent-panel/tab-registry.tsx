"use client";

import { useMemo, useRef, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  ActivityIcon,
  BotIcon,
  FileCodeIcon,
  FileTextIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GlobeIcon,
  ImageIcon,
  ListTodoIcon,
  Loader2Icon,
  LayoutPanelTopIcon,
  MessageCircleIcon,
  PackageIcon,
  SquareTerminalIcon,
  WaypointsIcon,
} from "lucide-react";
import { usePanelActivity } from "@/lib/panels/panel-activity";
import { useThreadTodos } from "@/lib/pi/pi-todo";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { useIsRemoteWorkspace } from "@/lib/workspace/remote-projects";
import { useGitStatus } from "@/lib/git/git-status";
import { useCurrentAppMode } from "@/lib/pi/pi-session-app-mode";
import { useIsAskMode } from "@/lib/pi/pi-session-mode";
import { isDesktop } from "@/lib/desktop-env";
import type { PanelTab, PanelTabType } from "@/lib/panels/panel-tabs";
import { ActivityView } from "./activity-view";
import { PlanSection } from "./plan-section";
import { FilesSection } from "./files-section";
import { GitReview } from "./git-files";
import { GitView } from "./git-view";
import { ShellTab } from "./shell-tab";
import { FileTab } from "./file-view";
import { FileTreeTab } from "./file-tree-tab";
import { SubagentTab } from "./subagent-tab";
import { LoopTab } from "./loop-tab";
import { ArtifactsTab } from "./artifacts-tab";
import { PluginPanelHost } from "./plugin-panel-host";
import { SideChatTab } from "./side-chat-tab";
import { ZoomableImage } from "./image-viewer";
import { TabEmpty } from "./tab-empty";
import { blobUrlFor } from "@/lib/pi/image-blob-url";

/**
 * 标签类型注册表:标题/图标/视图组件的单一事实源,
 * tab-bar 的 "+" 菜单与空态卡片网格都从这里派生。
 */
export const PANEL_TAB_TYPES: readonly PanelTabType[] = [
  "activity",
  "plan",
  "review",
  "artifacts",
  "explorer",
  "shell",
  "browser",
  "git",
];

/**
 * 可打开的标签类型:git 标签仅在工作目录是 git 仓库且本会话工作模式为编码时出现
 * (静默降级,不报错;工作模式下 Git 管理整体隐藏,见顶栏模式切换器);
 * 文件树与真终端标签仅桌面端(web 端无本地 FS / 无 PTY,数据源整个不存在)。
 * 远程项目的文件树暂不支持（远端目录口径与本地不一致,入口整体收掉）,
 * 与 docs/remote-ssh-projects.md 的「远程隐藏本地面板」一致。
 */
export function useVisiblePanelTabTypes(): PanelTabType[] {
  const workspace = useWorkspace();
  const { status } = useGitStatus(workspace);
  const appMode = useCurrentAppMode();
  // 问答档是只读的：终端和 Git 面板在这里没有可回滚的对象，显隐与 code 档的
  // Git 隐藏同源（同一个"这一档不碰工程"的判断）
  const ask = useIsAskMode();
  const remote = useIsRemoteWorkspace(workspace);
  return PANEL_TAB_TYPES.filter((t) => {
    if (t === "explorer") return isDesktop() && !remote;
    if (t === "shell") return isDesktop() && !ask;
    if (t === "git") return appMode === "code" && !!status && !ask;
    return true;
  });
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
  artifacts: {
    label: "产物",
    description: "会话生成的网页、文档等交付文件，随时重新打开预览",
    icon: PackageIcon,
  },
  file: {
    label: "文件",
    description: "读取结果回看",
    icon: FileTextIcon,
  },
  image: {
    label: "图片",
    description: "用户消息里的图片预览（点击消息图片唤起）",
    icon: ImageIcon,
  },
  explorer: {
    label: "文件树",
    description: "浏览当前工作目录（无工作区时为会话任务目录），点击实时预览",
    icon: FolderTreeIcon,
  },
  shell: {
    label: "终端",
    description: "PowerShell / bash 交互式会话（可多开，一标签一会话）",
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
  subagent: {
    label: "子智能体",
    description: "Task 委派的运行过程",
    icon: BotIcon,
  },
  loop: {
    label: "链路追踪",
    description: "按时间线看 span 瀑布、耗时与回放，也可切到迭代视图",
    icon: WaypointsIcon,
  },
  plugin: {
    label: "插件面板",
    description: "已安装插件贡献的界面（实际标题为面板声明名）",
    icon: LayoutPanelTopIcon,
  },
  "side-chat": {
    label: "辅助会话",
    description: "划词派生出的隐藏子会话，与主会话并排提问",
    icon: MessageCircleIcon,
  },
};

export function tabTitle(tab: PanelTab): string {
  if (tab.type === "side-chat") {
    return tab.ordinal ? `辅助会话 ${tab.ordinal}` : "辅助会话";
  }
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
  const { status, loading, missing } = useGitStatus(workspace);
  // 目录没了和"不是仓库"分开说：后者是正常选择，前者需要用户处理
  if (missing === "cwd")
    return (
      <TabEmpty
        icon={GitBranchIcon}
        text="会话绑定的工作目录不存在（可能已被移动或删除）"
      />
    );
  if (missing === "workspace")
    return (
      <TabEmpty
        icon={GitBranchIcon}
        text="当前 workspace 目录不存在，请重新选择目录"
      />
    );
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

/** 图片标签：用户消息里的图片在本面板内预览（与文件标签共用同一看图器）。
 *  data URL 先转 Blob URL 再挂到 img 上：base64 不驻留 DOM（同消息流口径） */
const ImageTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  const src = useMemo(() => (tab.url ? blobUrlFor(tab.url) : null), [tab.url]);
  if (!src)
    return <TabEmpty icon={ImageIcon} text="图片不可用（会话中未保留该图片）" />;
  return <ZoomableImage src={src} alt={tab.title ?? "图片"} />;
};

/** 按标签类型路由到视图;外层以 tab.id 作 key 重挂载,组件内状态即标签私有 */
export const TabContentView: FC<{ tab: PanelTab }> = ({ tab }) => {
  switch (tab.type) {
    case "activity":
      // bash 工具行定位进活动页的终端小节（展开+滚动到位）
      return <ActivityView focusToolCallId={tab.focus} />;
    case "plan":
      return <PlanTab />;
    case "review":
      return <ReviewTab tab={tab} />;
    case "artifacts":
      return <ArtifactsTab />;
    case "file":
      return <FileTab tab={tab} />;
    case "image":
      // 消息图片点击唤起（同类型复用，不改动标签集合）
      return <ImageTab tab={tab} />;
    case "explorer":
      return <FileTreeTab />;
    case "shell":
      // 一个标签 = 一个会话（tab.sessionId 绑定 lib/shell store 里的会话）
      return <ShellTab tab={tab} />;
    case "git":
      return <GitTab />;
    case "browser":
      // 浏览器不在本注册表渲染：面板层有常驻的浏览器 pane（agent-panel/index.tsx
      // 直接挂 BrowserView，切标签只隐藏不卸载，保住 <webview> 的页面状态）。
      // 这里留空不返回内容——从别的路径渲染会挂出第二个 webview 争抢 guest。
      return null;
    case "subagent":
      // 一个委派一个 tab（delegationId 绑定 lib/subagent-runs store 条目）
      return <SubagentTab tab={tab} />;
    case "loop":
      // 链路追踪：瀑布/迭代双视图，tab.sessionId 绑定 sidecar 会话（header「更多」唤起）
      return <LoopTab tab={tab} />;
    case "plugin":
      // UI 插件面板：blob iframe + kova-ui-plugin/1 桥（tab.pluginId/panelId 定位）
      return <PluginPanelHost tab={tab} />;
    case "side-chat":
      // 划词辅助会话：嵌套 runtime + 独立 composer（tab.parentSessionId/childSessionId）
      return <SideChatTab tab={tab} />;
    default:
      return null;
  }
};
