"use client";

import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { PiModelPicker } from "@/components/agent-thread/model-picker";
import { ThreadNavButtons } from "@/components/agent-thread/thread-nav-buttons";
import { cn } from "@/lib/utils";
import { isMacPlatform, isDesktop } from "@/lib/desktop-env";
import { WindowControls } from "@/components/window-controls";
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
import { Panel2Icon } from "../icons/panel2-icons";

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
const PanelToggleButton: FC<{ onToggle: () => void; shown: boolean }> = ({
  onToggle,
  shown,
}) => {
  const t = useT();
  const { runningCount } = usePanelActivity();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useThreadTodos(threadId ?? undefined);
  const hasUnfinishedPlan = snap.tasks.some(
    (t) => t.status !== "deleted" && t.status !== "completed",
  );
  const badge = runningCount > 0 || hasUnfinishedPlan;

  return (
    <TooltipIconButton
      variant="ghost"
      size="icon"
      tooltip={t("chat.header.expandPanel")}
      side="bottom"
      onClick={onToggle}
      aria-hidden={!shown}
      tabIndex={shown ? undefined : -1}
      className={cn(
        "relative size-8 shrink-0 transition-opacity duration-150",
        shown ? "pointer-events-auto" : "pointer-events-none opacity-0",
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

/** 面板开关槽：与左侧「侧栏展开槽」完全镜像——面板开合时槽位宽度
 *  0↔32 与面板动画同节拍（300ms + 同一条 cubic-bezier）收放，按钮本体
 *  只做 150ms 快速淡出/淡入、不做位移；槽位收起时用负 margin 抵消 Header
 *  的 gap，终端按钮随之滑到聊天列右缘（面板展开后它就在"原展开按钮"
 *  那一格），和侧栏展开时标题被推开的观感一致。
 *  @param contained 面板在显示（含动画途中）：槽位收成 0 */
const PanelToggleSlot: FC<{
  onToggle: () => void;
  shown: boolean;
  contained: boolean;
}> = ({ onToggle, shown, contained }) => (
  <div
    inert={contained}
    aria-hidden={contained}
    className={cn(
      "overflow-hidden transition-[width,margin] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
      contained ? "-ml-1 w-0" : "w-8",
    )}
  >
    <PanelToggleButton onToggle={onToggle} shown={shown} />
  </div>
);

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

export const Header: FC<{
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenMobileSidebar: () => void;
  /** 是否在 Header 露出面板展开按钮：宽屏 = 面板视觉上完全收没
   *  （收起动画播完），窄屏浮层 = 面板关闭；由 base 计算好传入 */
  showPanelToggle?: boolean;
  onTogglePanel: () => void;
  /** 面板作为右列（含开合动画）：窗口控件浮层常驻在 Header，占位收没，
   *  让终端按钮随面板动画滑到聊天列右缘 */
  windowControlsCollapsed?: boolean;
  /** 面板当前在显示（含开合动画途中）：右侧「面板开关槽」随之收没，
   *  终端按钮停在聊天列右缘（原展开按钮那一格）——与左侧侧栏展开槽镜像 */
  panelShown?: boolean;
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
  sidebarCollapsed,
  onToggleSidebar,
  onOpenMobileSidebar,
  showPanelToggle = false,
  onTogglePanel,
  windowControlsCollapsed = false,
  panelShown = false,
  variant = "session",
  pageDivided = false,
  searchOpen = false,
}) => {
  const t = useT();
  const pageMode = variant === "page";
  // 桌面端自绘 titlebar：拖拽区所有桌面端生效；红绿灯让位仅 macOS（Windows 隐藏系统
  // 标题栏后由 WindowControls 接管，网页端无窗口 chrome）
  const desktop = isDesktop();
  const mac = desktop && isMacPlatform();
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
  // 尚无消息（标题未生成）时 More 按钮整体不显示，而非禁用
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
  return (
    <header
      data-drag-region={desktop ? "deep" : undefined}
      className={cn(
        // 左 padding 随折叠变化（macOS 红绿灯让位），与折叠按钮槽同节拍过渡，
        // 标题被连续挤开而不是瞬间跳位；时长/缓动必须与侧栏 width 收拢
        // 完全一致（300ms + 同一曲线），否则槽位先收没、侧栏按钮后到位，
        // 中间出现"按钮凭空消失"的空窗
        "flex h-12 shrink-0 items-center gap-2 transition-[padding] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
        // 下边框：会话有内容时与正文分开（新对话顶栏空着，一条横线反而把
        // 空页劈成两截）；整页视图缺省不画，pageDivided 由页面按需声明
        // （资料库的注入式工具条要求一条分割线）。
        // 注意不能反过来写「条件真 → border-none」：那会让新对话/未声明的
        // 整页视图有线、会话/资料库反而没线（fb0a8aa 引入的反转）。
        (!pageMode && !isEmptyThread) || (pageMode && pageDivided)
          ? "border-b border-border/60"
          : undefined,
        "pr-4",
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
      {/* 折叠按钮槽：常驻挂载（展开时 inert 防聚焦），宽度 0↔104 与侧栏
          width 收拢同节拍（300ms + 同曲线）把标题等内容往右挤开；w-0 时负
          margin 抵消 header 的 gap-2，<md display:none 完全不占位。
          按钮本体不做位移动画——展开时按钮会被侧栏推着右移再裁掉，观感
          像闪到右边；只做 150ms 快速淡出（感知即"直接消失"），槽位空收
          由宽度过渡承担排版平滑。折叠态槽内是 [后退][前进][Show sidebar]：
          侧边栏收起后导航按钮在主区 Header 顶栏顶上（mac 红绿灯让位由
          md:pl-24 承接），展开后随槽位收没（侧边栏 header 里有同一对） */}
      <div
        inert={!sidebarCollapsed}
        aria-hidden={!sidebarCollapsed}
        className={cn(
          "overflow-hidden transition-[width,margin] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] max-md:hidden",
          sidebarCollapsed ? "w-26" : "-ml-2 w-0",
        )}
      >
        <div className="flex items-center gap-1">
          <ThreadNavButtons />
          <TooltipIconButton
            variant="ghost"
            size="icon"
            tooltip={t("chat.header.expandSidebar")}
            side="bottom"
            onClick={onToggleSidebar}
            className={cn(
              "size-8 transition-opacity duration-150",
              !sidebarCollapsed && "pointer-events-none opacity-0",
            )}
          >
            <Panel2Icon className="size-4" />
          </TooltipIconButton>
        </div>
      </div>
      
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
      {/* 整页视图不属于任何会话：标题/徽章/重命名/面板开关都让位给页面自身；
          空会话（新对话）同样不显示标题——顶栏留着干净，等有消息了再出现 */}
      {pageMode || isEmptyThread || searchOpen ? null : <ThreadTitle />}
      {/* 所选工作区目录 + git 分支 tag（未选目录时不显示），位于「更多」按钮左侧 */}
      {!pageMode && !isEmptyThread && !searchOpen && <WorkspaceBadge />}
      {/* 会话工作模式切换（编码/工作/设计）已挪到新对话欢迎页的问候语上方：
          新对话没有标题可看，顶栏空着一片，模式放在"开聊之前"更顺手。
          有消息之后本页不再有它的入口（需要时再定放哪） */}
      {/* 标题右侧「更多」菜单 + 重命名任务 dialog（空会话不渲染） */}
      {pageMode || isEmptyThread || searchOpen ? null : (
        <>
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
      )}
      {/* 顶部右侧按钮簇（终端 + 快速查看 + 面板开关）：全部走 Header 流内，和左侧
          「侧栏展开槽」同一套开合手法——槽位宽度随面板动画收放，按钮本体
          只淡出淡入、不做位移。面板展开后槽位收没，终端按钮就停在聊天列
          右缘（分割线旁，即原「展开面板」按钮那一格）；面板收起时槽位
          重新展开，按钮簇恢复 [终端] [快速查看] [面板]。
          全局搜索是独立页（面板已按页闸收起）：这组会话级按钮一并隐藏，
          与自动化/资料库页一致，搜索输入可以铺到右缘。 */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {pageMode || searchOpen ? null : (
          <>
            <TerminalToggleButton />
            <QuickViewToggleButton />
            <PanelToggleSlot
              onToggle={onTogglePanel}
              shown={showPanelToggle}
              contained={panelShown}
            />
          </>
        )}
      </div>
      {/* 窗口控制浮层常驻（面板顶栏只留同槽占位）；面板作为右列时占位
          100px 与 gap 一起 300ms 收没，终端按钮随面板动画滑到聊天列右缘。
          right=16 = 卡片 pr-4（浮层固定 top 0） */}
      <WindowControls right={16} collapsed={windowControlsCollapsed} />
    </header>
  );
};