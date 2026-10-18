"use client";

import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { PiModelPicker } from "@/components/agent-thread/model-picker";
import { cn } from "@/lib/utils";
import { isMacPlatform, isDesktop } from "@/lib/desktop-env";
import { WindowControls, CLUSTER_W } from "@/components/window-controls";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RenameTaskDialog } from "@/components/agent-thread/rename-task-dialog";
import { TerminalToggleButton } from "@/components/agent-thread/terminal-dock";
import { usePanelActivity } from "@/lib/panels/panel-activity";
import { useThreadTodos } from "@/lib/pi/pi-todo";
import { useThreadTitle } from "@/lib/pi/pi-thread-titles";
import { useGitStatus } from "@/lib/git/git-status";
import { useCurrentAppMode } from "@/lib/pi/pi-session-app-mode";
import { pathBasename, useWorkspace } from "@/lib/workspace/workspace-store";
import { openPanelTab } from "@/lib/panels/panel-tabs";
import { piSessionIdForThread } from "@/lib/pi/pi-thread-adapter";
import { FolderOpenIcon, GitBranchIcon } from "lucide-react";
import { useEffect, useState, type FC } from "react";
import { createPortal } from "react-dom";

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
        alt="Kova"
        className="size-5 shrink-0 dark:hue-rotate-180 dark:invert"
      />
      {!collapsed && (
        <span className="text-foreground/90 truncate">扣瓦</span>
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

/** 标题旁「更多」菜单：重命名任务 + 链路追踪；全新未落库会话（status new）禁用重命名，
 *  尚无 sidecar 会话 id（registry 未登记）时禁用链路追踪 */
const HeaderMoreMenu: FC<{
  canRename: boolean;
  onRename: () => void;
  canOpenTrace: boolean;
  onOpenTrace: () => void;
}> = ({ canRename, onRename, canOpenTrace, onOpenTrace }) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="更多操作"
            className="size-8 shrink-0"
          />
        }
      >
        <MoreHorizontalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={6} className="min-w-40">
        <DropdownMenuItem disabled={!canRename} onClick={onRename}>
          <PencilIcon className="size-4" />
          重命名任务
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canOpenTrace} onClick={onOpenTrace}>
          <WaypointsIcon className="size-4" />
          链路追踪
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** 面板开关按钮的固定钉位：与 WindowControls 同款 portal + fixed，脱离
 *  会随聊天列收窄而整体左移的 Header 流——用户要的"原地淡出/淡入、不移动"
 *  本质上要求按钮不参与 Header 的重排。右侧偏移对齐它原本在 Header 右缘的
 *  槽位：卡片右缘 8（main p-2）+ 把手 8（w-2）+ pr-4 16 = 24；Windows/Linux
 *  下 Header 右缘还要挤出窗口三键占位（CLUSTER_W + gap-2 8），再左让一份 */
const PANEL_TOGGLE_TOP = 8;
const PANEL_TOGGLE_RIGHT = 24;
const PANEL_TOGGLE_RIGHT_WITH_WINCONTROLS = PANEL_TOGGLE_RIGHT + 8 + CLUSTER_W;
/** 终端开关收起态的钉位：面板开关**左侧**相邻槽位（按钮簇观感：
 *  … [终端] [面板]）。面板开关的展开/收起只是淡出淡入、槽位始终占着，
 *  终端按钮不跟着挪位——两个按钮各自固定偏移，谁也不做另一个的参照物。
 *  面板停靠为右列后不用这个槽位（改由 Header 流内贴聊天列右缘，见下方
 *  TerminalToggleSlot/Header 的 panelDocked 分支）。
 *  gap-2 = 与 Header 内相邻按钮的间距（size-8 + 8 = 36） */
const TERMINAL_TOGGLE_RIGHT = PANEL_TOGGLE_RIGHT + 36;
const TERMINAL_TOGGLE_RIGHT_WITH_WINCONTROLS =
  PANEL_TOGGLE_RIGHT_WITH_WINCONTROLS + 36;

/** Header 面板开关按钮：有在途活动才亮角标。portal 到 body、fixed 钉在
 *  窗口右上角（见上），可见性交给 150ms transition-opacity：展开时原地
 *  淡出（不再随聊天列收窄左移），收起落位时原地渐显。z-40：盖住主区内容
 *  与面板卡片，但仍在 dialog/设置页（z-50）之下。
 *  空会话也常驻：新对话页上「终端 + 面板」两个按钮成对出现（只留一个
 *  终端按钮观感很突兀），点开由 base 的空会话旁路放行。 */
const PanelToggleButton: FC<{ onToggle: () => void; shown: boolean }> = ({
  onToggle,
  shown,
}) => {
  const { runningCount } = usePanelActivity();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useThreadTodos(threadId ?? undefined);
  const hasUnfinishedPlan = snap.tasks.some(
    (t) => t.status !== "deleted" && t.status !== "completed",
  );
  const badge = runningCount > 0 || hasUnfinishedPlan;
  // portal 只在 document 就绪后挂（首帧无按钮，本就要等判环境）
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed z-40 flex h-12 items-center"
      style={{
        top: PANEL_TOGGLE_TOP,
        right:
          isDesktop() && !isMacPlatform()
            ? PANEL_TOGGLE_RIGHT_WITH_WINCONTROLS
            : PANEL_TOGGLE_RIGHT,
      }}
    >
      <TooltipIconButton
        variant="ghost"
        size="icon"
        tooltip="展开 Agent 面板"
        side="bottom"
        onClick={onToggle}
        aria-hidden={!shown}
        tabIndex={shown ? undefined : -1}
        className={cn(
          "relative size-8 shrink-0 transition-opacity duration-150",
          shown ? "pointer-events-auto" : "pointer-events-none opacity-0",
        )}
      >
        <PanelRightOpenIcon className="size-4" />
        {badge ? (
          <span
            aria-hidden="true"
            className="bg-primary absolute top-1 right-1 size-1.5 animate-pulse rounded-full"
          />
        ) : null}
      </TooltipIconButton>
    </div>,
    document.body,
  );
};

/** 终端开关的收起态钉位（面板未停靠 / 窄屏浮层）：portal + fixed 钉在面板
 *  开关左侧那一格，不随聊天列收窄移动。panelDocked 时淡出，改由 Header
 *  流内那枚贴在聊天列右缘（两种状态都在"聊天列右上角"，只是锚点不同）。
 *  空会话照常渲染：终端是全局工具，新对话里开壳看目录是常态 */
const TerminalToggleSlot: FC<{ hidden: boolean }> = ({ hidden }) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return createPortal(
    <div
      inert={hidden}
      className={cn(
        "pointer-events-none fixed z-40 flex h-12 items-center transition-opacity duration-150",
        hidden && "opacity-0",
      )}
      style={{
        top: PANEL_TOGGLE_TOP,
        right:
          isDesktop() && !isMacPlatform()
            ? TERMINAL_TOGGLE_RIGHT_WITH_WINCONTROLS
            : TERMINAL_TOGGLE_RIGHT,
      }}
    >
      <TerminalToggleButton className="pointer-events-auto" />
    </div>,
    document.body,
  );
};

/** 标题旁的工作区/分支 tag 胶囊（样式对齐 composer 的 WorkspacePill）：
 *  未选择文件夹（workspace 为 null）时整体不渲染；
 *  分支 tag 仅在该目录是 git 仓库、状态已加载且本会话工作模式为编码时出现
 *  （复用 git-status 缓存，不重复拉取；工作模式下 Git 管理整体隐藏）。
 *  纯展示，不做交互 —— 切换 workspace/分支仍走 composer 的胶囊入口 */
const WorkspaceBadge: FC = () => {
  const workspace = useWorkspace();
  const { status } = useGitStatus(workspace);
  const appMode = useCurrentAppMode();
  if (!workspace) return null;

  return (
    <div className="flex min-w-0 shrink items-center gap-1.5 max-md:hidden">
      <span
        className="bg-muted text-muted-foreground inline-flex h-6 min-w-0 max-w-[12rem] items-center gap-1 rounded-full px-2 text-sm"
        title={workspace}
      >
        <FolderOpenIcon className="size-3 shrink-0" />
        <span className="truncate">{pathBasename(workspace)}</span>
      </span>
      {appMode === "code" && status ? (
        <span
          className="bg-muted text-muted-foreground inline-flex h-6 shrink-0 max-w-[12rem] items-center gap-1 rounded-full px-2 text-sm"
          title={`${status.branch}${status.dirty > 0 ? ` · ${status.dirty} 个未提交变更` : ""}`}
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
  /** 面板停靠为右列（宽屏且视觉上未收没）：此时窗口右缘是面板而非聊天列，
   *  Windows/Linux 自绘窗口控件改由面板顶栏承载，Header 不再渲染 */
  docked?: boolean;
  /** 面板停靠态（含展开动画途中）：聊天列右缘此时是两列分割线，
   *  终端开关从 fixed 槽位切到 Header 流内贴右缘（红框位置） */
  panelDocked?: boolean;
  /** session = 聊天会话顶栏（默认）；page = 整页管理视图（自动化/计划等）的
   *  纯窗口边框条：隐藏会话专属元素（标题/徽章/重命名/面板开关）且无分隔线，
   *  页面身份由视图自身的大标题承载 */
  variant?: "session" | "page";
}> = ({
  sidebarCollapsed,
  onToggleSidebar,
  onOpenMobileSidebar,
  showPanelToggle = false,
  onTogglePanel,
  docked = false,
  panelDocked = false,
  variant = "session",
}) => {
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
  const openTrace = () => {
    if (!traceSessionId) return;
    openPanelTab("loop", { sessionId: traceSessionId });
    // 面板开合是 Base 的本地态，经事件请求展开（与 composer「Git 图谱」同款）
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
        // 下边框只在「有会话内容」时画：新对话顶栏空着，一条横线反而把空页
        // 劈成两截；有消息（标题已显示）时恢复，与正文分开
        !pageMode && !isEmptyThread && "border-b-[0.5]",
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
      {/* 折叠按钮槽：常驻挂载（展开时 inert 防聚焦），宽度 0↔32 与侧栏
          width 收拢同节拍（300ms + 同曲线）把标题等内容往右挤开；w-0 时负
          margin 抵消 header 的 gap-2，<md display:none 完全不占位。
          按钮本体不做位移动画——展开时按钮会被侧栏推着右移再裁掉，观感
          像闪到右边；只做 150ms 快速淡出（感知即"直接消失"），槽位空收
          由宽度过渡承担排版平滑 */}
      <div
        inert={!sidebarCollapsed}
        aria-hidden={!sidebarCollapsed}
        className={cn(
          "overflow-hidden transition-[width,margin] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] max-md:hidden",
          sidebarCollapsed ? "w-8" : "-ml-2 w-0",
        )}
      >
        <TooltipIconButton
          variant="ghost"
          size="icon"
          tooltip="Show sidebar"
          side="bottom"
          onClick={onToggleSidebar}
          className={cn(
            "size-8 transition-opacity duration-150",
            !sidebarCollapsed && "pointer-events-none opacity-0",
          )}
        >
          <PanelLeftIcon className="size-4" />
        </TooltipIconButton>
      </div>
      
      {/* 整页视图不属于任何会话：标题/徽章/重命名/面板开关都让位给页面自身；
          空会话（新对话）同样不显示标题——顶栏留着干净，等有消息了再出现 */}
      {pageMode || isEmptyThread ? null : <ThreadTitle />}
      {/* 所选工作区目录 + git 分支 tag（未选目录时不显示），位于「更多」按钮左侧 */}
      {!pageMode && !isEmptyThread && <WorkspaceBadge />}
      {/* 会话工作模式切换（编码/工作/设计）已挪到新对话欢迎页的问候语上方：
          新对话没有标题可看，顶栏空着一片，模式放在"开聊之前"更顺手。
          有消息之后本页不再有它的入口（需要时再定放哪） */}
      {/* 标题右侧「更多」菜单 + 重命名任务 dialog（空会话不渲染） */}
      {pageMode || isEmptyThread ? null : (
        <>
          <HeaderMoreMenu
            canRename={canRename}
            onRename={() => setRenameOpen(true)}
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
      {/* Agent 面板开关锚点：按钮本体已 portal 到 body 的 fixed 层（见
          PanelToggleButton），此处只留 ml-auto 把头部右侧内容顶到右缘。
          按钮脱离 Header 流后才不会随聊天列收窄左移——这是"原地淡出/
          淡入、不移动"的前提 */}
      <div className="ml-auto flex shrink-0 items-center">
        {pageMode ? null : (
          <>
            {/* 终端开关：贴在聊天列右上角。
                - 面板停靠为右列（panelDocked，含展开动画途中）：聊天列右缘
                  就是两列分割线，按钮走 Header 流内贴右缘——即原来「打开
                  面板」按钮站的那一格（实报位置）。
                - 面板收起/窄屏浮层：聊天列右缘 = 窗口右缘，改由 fixed 槽位
                  承接（与面板开关成对，且不随聊天列收窄移动）。
                流内这枚常驻挂载、只切换可见性：面板一开一合不会造成另一块
                重新挂载的闪动，两枚是同一时刻交叉淡入淡出 */}
            <div
              inert={!panelDocked}
              className={cn(
                "flex items-center transition-opacity duration-150",
                !panelDocked && "pointer-events-none opacity-0",
              )}
            >
              <TerminalToggleButton className="-mr-2" />
            </div>
            <TerminalToggleSlot hidden={panelDocked} />
            <PanelToggleButton onToggle={onTogglePanel} shown={showPanelToggle} />
          </>
        )}
      </div>
      {/* 窗口控制钉在聊天顶栏行右缘；停靠态右缘是面板，由面板顶栏接管渲染。
          顶栏在主区 p-2（8px）内的卡片里，不再贴窗口顶缘：top=8；
          right=24 = 卡片边距 8 + pr-4 16（与占位槽像素级重合） */}
      {docked ? null : <WindowControls top={8} right={24} />}
    </header>
  );
};