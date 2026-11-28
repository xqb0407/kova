"use client";

import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { PiModelPicker } from "@/components/agent-thread/model-picker";
import { cn } from "@/lib/utils";
import { isMacPlatform, isDesktop } from "@/lib/desktop-env";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  ArrowRightLeftIcon,
  MenuIcon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  PanelRightOpenIcon,
  PencilIcon,
  ShareIcon,
  WaypointsIcon,
} from "lucide-react";
import Image from "next/image";
import logo from "@/public/favicon/icon.png";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RenameTaskDialog } from "@/components/agent-thread/rename-task-dialog";
import { openHandoffDialog } from "@/components/agent-thread/handoff-dialog";
import { TerminalToggleButton } from "@/components/agent-thread/terminal-toggle-button";
import { QuickViewToggleButton } from "@/components/agent-thread/quick-view-popover";
import { usePanelActivity } from "@/lib/panels/panel-activity";
import { useThreadTodos } from "@/lib/pi/pi-todo";
import { useThreadTitle } from "@/lib/pi/pi-thread-titles";
import { useGitStatus } from "@/lib/git/git-status";
import { useCurrentAppMode } from "@/lib/pi/pi-session-app-mode";
import {
  pathBasename,
  useWorkspace,
  useWorkspaceProjectId,
} from "@/lib/workspace/workspace-store";
import { useProjectLabel } from "@/lib/projects/project-display-name";
import { useProjectEntityLabel } from "@/lib/pi/pi-projects";
import { openPanelTab } from "@/lib/panels/panel-tabs";
import { piSessionIdForThread } from "@/lib/pi/pi-thread-adapter";
import { enterShareMode } from "@/lib/share/share-store";
import { GitBranchIcon } from "lucide-react";
import { ProjectFolderOpenIcon } from "@/components/icons/project-folder-icons";
import { useState, type FC } from "react";
import { openExternal } from "@/lib/external-link";
import { FEEDBACK_ISSUES_URL } from "@/lib/feedback";
import GithubMono from "@lobehub/icons/es/Github/components/Mono";
import { useT } from "@/lib/i18n";
import { PanelIcon } from "../icons/panel-icons";

export const Logo: FC<{ collapsed?: boolean }> = ({ collapsed = false }) => {
  const t = useT();
  return (
    <div
      className={cn(
        "flex items-center text-sm font-medium",
        collapsed ? "size-8 shrink-0 justify-center" : "min-w-0 gap-2 px-2",
      )}
    >
      <Image
        src={logo}
        alt="Kova"
        className="size-5 shrink-0"
      />
      {!collapsed && (
        <span className="text-foreground/90 truncate">{t("chat.header.brand")}</span>
      )}
    </div>
  );
};

const ModelPicker: FC = () => {
  return <PiModelPicker />;
};

const ThreadTitle: FC = () => {
  const mainThread = useAuiState((s) =>
    s.threads.threadItems.find((t) => t.id === s.threads.mainThreadId),
  );
  // 智能标题/改名只在 wire 上回流到本地表（列表快照的 title 要整表 reload
  // 才刷新），实时表优先，取不到再回落快照
  const liveTitle = useThreadTitle(mainThread?.remoteId);
  const title = liveTitle ?? mainThread?.title;

  return (
    <span
      // header 是 deep 拖拽区，普通文本的 mousedown 会被 preventDefault
      // 拿去做窗口拖动，选区无法开始；"false" 让 桌面壳的事件路径遍历在
      // 这棵子树截停（drag.js isDragRegion），恢复常规文字选中
      data-drag-region="false"
      className="min-w-0 truncate text-sm font-medium"
    >
      {title ?? "New Chat"}
    </span>
  );
};

/** 标题旁「更多」菜单：重命名任务 + 交接至新对话 + 链路追踪；全新未落库会话
 *  （status new）禁用重命名，尚无 sidecar 会话 id（registry 未登记）时禁用
 *  链路追踪；回复进行中禁用交接（sidecar 也会拒绝忙会话）。 */
const HeaderMoreMenu: FC<{
  canRename: boolean;
  onRename: () => void;
  canHandoff: boolean;
  onHandoff: () => void;
  canOpenTrace: boolean;
  onOpenTrace: () => void;
}> = ({ canRename, onRename, canHandoff, onHandoff, canOpenTrace, onOpenTrace }) => {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("chat.message.moreActions")}
            className="size-8 shrink-0"
          />
        }
      >
        <MoreHorizontalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={6} className="min-w-40">
        <DropdownMenuItem disabled={!canRename} onClick={onRename}>
          <PencilIcon className="size-4" />
          {t("chat.header.renameTask")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canHandoff} onClick={onHandoff}>
          <ArrowRightLeftIcon className="size-4" />
          {t("chat.handoff.action")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canOpenTrace} onClick={onOpenTrace}>
          <WaypointsIcon className="size-4" />
          {t("chat.header.trace")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => enterShareMode()}>
          <ShareIcon className="size-4" />
          {t("chat.header.shareChat")}
        </DropdownMenuItem>
        {/* 会话操作与全局反馈之间分一条线：GitHub Issues 不属于当前会话 */}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openExternal(FEEDBACK_ISSUES_URL)}>
          <GithubMono className="size-4" />
          {t("chat.header.githubIssues")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Header 面板开关按钮：有在途活动才亮角标。
 *  形态对齐**侧边栏的折叠/展开按钮**（实报"不像侧边栏的折叠按钮"）：
 *  按钮本体不做位移动画，只做 150ms 快速淡出/淡入；开合过程的"腾位/收位"
 *  交给外层槽位的宽度过渡（300ms + 与面板开合同一条曲线），按钮被槽位
 *  裁切——和 Header 左侧那个侧栏展开槽完全镜像。
 *  空会话也常驻：新对话页上「终端 + 面板」两个按钮成对出现（只留一个
 *  终端按钮观感很突兀），点开由 base 的空会话旁路放行。 */
const PanelToggleButton: FC<{ onToggle: () => void; open: boolean }> = ({
  onToggle,
  open,
}) => {
  const t = useT();
  const { runningCount } = usePanelActivity();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useThreadTodos(threadId ?? undefined);
  const hasUnfinishedPlan = snap.tasks.some(
    (t) => t.status !== "deleted" && t.status !== "completed",
  );
  const badge = runningCount > 0 || hasUnfinishedPlan;

  // 常驻右上角：开合状态只切换提示与高亮，不做位移动画/淡出——
  // 「不管收不收起，开关都在同一个角」是这套布局的约定
  return (
    <TooltipIconButton
      variant="ghost"
      size="icon"
      tooltip={open ? t("chat.header.collapsePanel") : t("chat.header.expandPanel")}
      side="bottom"
      aria-pressed={open}
      onClick={onToggle}
      className={cn(
        "relative size-7 shrink-0",
        open && "bg-selected text-foreground",
      )}
    >
      <PanelIcon className="size-4" />
      {badge ? (
        <span
          aria-hidden="true"
          className="bg-primary absolute top-1 right-1 size-1.5 animate-pulse rounded-full"
        />
      ) : null}
    </TooltipIconButton>
  );
};

/** 标题旁的工作区/分支 tag 胶囊（样式对齐 composer 的 WorkspacePill）：
 *  未选择文件夹（workspace 为 null）时整体不渲染；
 *  分支 tag 仅在该目录是 git 仓库、状态已加载且本会话工作模式为编码时出现
 *  （复用 git-status 缓存，不重复拉取；工作模式下 Git 管理整体隐藏）。
 *  纯展示，不做交互 —— 切换 workspace/分支仍走 composer 的胶囊入口 */
const WorkspaceBadge: FC = () => {
  const t = useT();
  const workspace = useWorkspace();
  const workspaceLabel = useProjectLabel(workspace);
  const entityLabel = useProjectEntityLabel(useWorkspaceProjectId());
  const { status } = useGitStatus(workspace);
  const appMode = useCurrentAppMode();
  if (!workspace) return null;

  return (
    <div className="flex min-w-0 shrink items-center gap-1.5 max-md:hidden">
      <span
        className="bg-muted text-muted-foreground inline-flex h-6 min-w-0 max-w-[12rem] items-center gap-1 rounded-full px-2 text-sm"
        title={workspace}
      >
        <ProjectFolderOpenIcon className="size-3 shrink-0" />
        <span className="truncate">
          {entityLabel ?? workspaceLabel ?? pathBasename(workspace)}
        </span>
      </span>
      {appMode === "code" && status ? (
        <span
          className="bg-muted text-muted-foreground inline-flex h-6 shrink-0 max-w-[12rem] items-center gap-1 rounded-full px-2 text-sm"
          title={`${status.branch}${status.dirty > 0 ? ` · ${t("chat.composer.uncommittedChanges", { count: status.dirty })}` : ""}`}
        >
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate">{status.branch}</span>
          {status.dirty > 0 ? (
            <span className="bg-muted-foreground/15 rounded-full px-1 tabular-nums text-xs">
              {status.dirty}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
};

/**
 * 会话信息簇（标题 + 工作区/分支徽章 + 「更多」菜单 + 重命名 dialog）：
 * 桌面端渲染在壳层顶部 chrome 条上（不再在内容区里叠一条 header），
 * 移动端由 Header 的内嵌顶栏承载。空会话（新对话）整体不渲染。
 */
export const SessionHeaderInfo: FC = () => {
  // 重命名任务：菜单入口 + dialog 开合；全新未落库会话 rename 会抛错，禁用入口
  const aui = useAui();
  const [renameOpen, setRenameOpen] = useState(false);
  const mainThread = useAuiState((s) => {
    const id = s.threads.mainThreadId;
    return s.threads.threadItems.find((t) => t.id === id);
  });
  const canRename = mainThread != null && mainThread.status !== "new";
  // 重命名 dialog 的预填标题同样取实时表（与 ThreadTitle 同一口径）
  const liveMainTitle = useThreadTitle(mainThread?.remoteId);
  const mainTitle = liveMainTitle ?? mainThread?.title;
  // 尚无消息（标题未生成）时整个信息簇不显示
  const isEmptyThread = useAuiState((s) => s.thread.messages.length === 0);
  // 链路追踪：当前线程的 sidecar 会话 id（无法解析出会话时无轨迹可看，入口禁用）
  const traceSessionId = mainThread
    ? piSessionIdForThread(mainThread.id)
    : undefined;
  // 交接要跑一次摘要请求，回复进行中 sidecar 会拒绝；入口直接置灰
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const canHandoff = !!traceSessionId && !isRunning;
  const openTrace = () => {
    if (!traceSessionId) return;
    openPanelTab("loop", { sessionId: traceSessionId });
    // 面板开合是 Base 的本地态，经事件请求展开（与右侧面板开关同款）
    window.dispatchEvent(new Event("agent-panel:open"));
  };

  if (isEmptyThread) return null;
  return (
    <>
      <ThreadTitle />
      {/* 所选工作区目录 + git 分支 tag（未选目录时不显示） */}
      <WorkspaceBadge />
      <HeaderMoreMenu
        canRename={canRename}
        onRename={() => setRenameOpen(true)}
        canHandoff={canHandoff}
        onHandoff={() => {
          if (traceSessionId) openHandoffDialog(traceSessionId);
        }}
        canOpenTrace={!!traceSessionId}
        onOpenTrace={openTrace}
      />
      <RenameTaskDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        currentTitle={mainTitle ?? ""}
        // store client 的 rename 声明是 void，运行时返回 Promise（可等待、可捕获失败）
        onRename={(t) =>
          aui.threads.item("main").rename(t) as unknown as Promise<void>
        }
      />
    </>
  );
};

/**
 * 会话右侧按钮簇（终端 / 快速查看 / 面板开关）：桌面端挂在壳层 chrome 条
 * 右端（与窗口三键相邻），移动端挂在 Header 内嵌顶栏。
 * 面板展开后「面板开关」槽位收没，终端按钮就停在窗口右缘附近的同一格。
 */
export const HeaderActions: FC<{
  onTogglePanel: () => void;
  /** 面板当前是否展开（开关常驻右上角，仅切换提示/高亮） */
  panelOpen?: boolean;
}> = ({ onTogglePanel, panelOpen = false }) => (
  <div className="flex shrink-0 items-center gap-0.5">
    <TerminalToggleButton />
    <QuickViewToggleButton />
    <PanelToggleButton onToggle={onTogglePanel} open={panelOpen} />
  </div>
);

export const Header: FC<{
  onOpenMobileSidebar: () => void;
  onTogglePanel: () => void;
  /** 面板当前是否展开：右上角开关常驻，仅切换提示/高亮 */
  panelOpen?: boolean;
  /** session = 聊天会话顶栏（默认）；page = 整页管理视图（自动化/计划等）的
   *  纯窗口边框条：隐藏会话专属元素（标题/徽章/重命名/面板开关）且无分隔线，
   *  页面身份由视图自身的大标题承载 */
  variant?: "session" | "page";
  /** page 模式下要不要压一条下边框（资料库：注入的工具条与内容之间要分割线；
   *  其余整页视图保持无边框） */
  pageDivided?: boolean;
  /** 搜索打开时 Header 让出中间区域给搜索输入（与其他页共用同一根顶栏） */
  searchOpen?: boolean;
}> = ({
  onOpenMobileSidebar,
  onTogglePanel,
  panelOpen = false,
  variant = "session",
  pageDivided = false,
  searchOpen = false,
}) => {
  const pageMode = variant === "page";
  // 桌面端自绘 titlebar：拖拽区所有桌面端生效；红绿灯让位仅 macOS（Windows 隐藏系统
  // 标题栏后由 WindowControls 接管，网页端无窗口 chrome）
  const desktop = isDesktop();
  const mac = desktop && isMacPlatform();
  // 尚无消息（标题未生成）时标题簇不显示
  const isEmptyThread = useAuiState((s) => s.thread.messages.length === 0);
  return (
    <header
      data-drag-region={desktop ? "deep" : undefined}
      className={cn(
        // 导航/侧栏开关已上移到主工具栏（IDEA 布局）：本顶栏只承载会话级
        // 内容，左缘固定让位即可
        "flex h-12 shrink-0 items-center gap-2 pl-4",
        // 下边框：会话有内容时与正文分开（新对话顶栏空着，一条横线反而把
        // 空页劈成两截）；整页视图缺省不画，pageDivided 由页面按需声明
        // （资料库的注入式工具条要求一条分割线）。
        // 注意不能反过来写「条件真 → border-none」：那会让新对话/未声明的
        // 整页视图有线、会话/资料库反而没线（fb0a8aa 引入的反转）。
        (!pageMode && !isEmptyThread) || (pageMode && pageDivided)
          ? "border-b border-border/50"
          : undefined,
        "pr-4",
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

      {/* 整页视图的页面工具条槽位：页面视图（资料库）经 portal 把自己的
          工具条注入这里——应用的窗口边框条与页面自己的工具条并成一层，
          不再出现两条 48px 叠着、上面那条全空的情况（page 模式下本行除了
          折叠槽本来就没有内容）。槽位是 flex-1 空 div，没人注入时零影响 */}
      {pageMode && (
        <div
          data-slot="page-header-actions"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1",
            // 搜索打开时保留槽位挂载（资料库的 portal 不能断），只隐藏内容
            searchOpen && "hidden",
          )}
        />
      )}
      {/* 搜索输入槽位：搜索页与资料库/自动化共用这一根 Header，搜索输入
          嵌在折叠槽之后，折叠态的导航/展开按钮位置完全一致 */}
      {searchOpen ? (
        <div
          data-slot="search-header-slot"
          className="flex min-w-0 flex-1 items-center"
        />
      ) : null}
      {/* Windows 自绘三键浮在窗口右上；搜索页的右侧按钮簇已隐藏（与整页视图
          同款），搜索输入需要让出 100px，否则清空按钮/输入尾部会被窗口三键盖住 */}
      {searchOpen && desktop && !mac ? (
        <div aria-hidden className="h-12 w-[100px] shrink-0" />
      ) : null}
      {/* 会话信息簇：整页视图不属于任何会话，全部让位给页面自身；
          空会话/搜索页同样不显示 */}
      {pageMode || searchOpen ? null : <SessionHeaderInfo />}
      {/* 右侧按钮簇（终端 + 快速查看 + 面板开关）：全局搜索是独立页（面板
          已按页闸收起），这一组会话级按钮一并隐藏，搜索输入可以铺到右缘 */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {pageMode || searchOpen ? null : (
          <HeaderActions
            onTogglePanel={onTogglePanel}
            panelOpen={panelOpen}
          />
        )}
      </div>
      {/* 窗口三键已上移到主工具栏（IDEA 布局）：本顶栏不再挂 WindowControls，
          拖拽/关闭等窗口操作统一走顶部那一条 */}
    </header>
  );
};