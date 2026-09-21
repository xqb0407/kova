"use client";

import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { PiModelPicker } from "@/components/agent-thread/model-picker";
import { cn } from "@/lib/utils";
import { isMacPlatform, isTauri } from "@/lib/tauri";
import { WindowControls } from "@/components/window-controls";
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
import { AppModeSwitch } from "./app-mode-switch";
import { usePanelActivity } from "@/lib/panels/panel-activity";
import { useThreadTodos } from "@/lib/pi/pi-todo";
import { useGitStatus } from "@/lib/git/git-status";
import { useAppMode } from "@/lib/pi/app-mode";
import { pathBasename, useWorkspace } from "@/lib/workspace/workspace-store";
import { openPanelTab } from "@/lib/panels/panel-tabs";
import { prefsSessionIdFor } from "@/lib/pi/pi-thread-adapter";
import { FolderOpenIcon, GitBranchIcon } from "lucide-react";
import { useState, type FC } from "react";

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
      {/* {!collapsed && (
        <span className="text-foreground/90 truncate">搞个锤子</span>
      )} */}
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
    <span
      // header 是 deep 拖拽区，普通文本的 mousedown 会被 preventDefault
      // 拿去做窗口拖动，选区无法开始；"false" 让 Tauri 的事件路径遍历在
      // 这棵子树截停（drag.js isDragRegion），恢复常规文字选中
      data-tauri-drag-region="false"
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

/** Header 只在面板完全收没后提供展开按钮（展开态的收起入口在面板顶栏）；
 *  角标提示:有在途工具或未完成任务才亮。空会话（尚无消息）不渲染 */
const PanelToggleButton: FC<{ onToggle: () => void }> = ({ onToggle }) => {
  const { runningCount } = usePanelActivity();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const isEmptyThread = useAuiState((s) => s.thread.messages.length === 0);
  const snap = useThreadTodos(threadId ?? undefined);
  const hasUnfinishedPlan = snap.tasks.some(
    (t) => t.status !== "deleted" && t.status !== "completed",
  );
  const badge = runningCount > 0 || hasUnfinishedPlan;

  if (isEmptyThread) return null;

  return (
    <TooltipIconButton
      variant="ghost"
      size="icon"
      tooltip="展开 Agent 面板"
      side="bottom"
      onClick={onToggle}
      className="relative size-8 shrink-0"
    >
      <PanelRightOpenIcon className="size-4" />
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
 *  分支 tag 仅在该目录是 git 仓库、状态已加载且全局模式为编码时出现
 *  （复用 git-status 缓存，不重复拉取；工作模式下 Git 管理整体隐藏）。
 *  纯展示，不做交互 —— 切换 workspace/分支仍走 composer 的胶囊入口 */
const WorkspaceBadge: FC = () => {
  const workspace = useWorkspace();
  const { status } = useGitStatus(workspace);
  const appMode = useAppMode();
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
  variant = "session",
}) => {
  const pageMode = variant === "page";
  // 桌面端自绘 titlebar：拖拽区所有桌面端生效；红绿灯让位仅 macOS（Windows 隐藏系统
  // 标题栏后由 WindowControls 接管，网页端无窗口 chrome）
  const desktop = isTauri();
  const mac = desktop && isMacPlatform();
  const winControls = desktop && !mac;
  // 重命名任务：菜单入口 + dialog 开合；全新未落库会话 rename 会抛错，禁用入口
  const aui = useAui();
  const [renameOpen, setRenameOpen] = useState(false);
  const mainThread = useAuiState((s) => {
    const id = s.threads.mainThreadId;
    return s.threads.threadItems.find((t) => t.id === id);
  });
  const canRename = mainThread != null && mainThread.status !== "new";
  // 尚无消息（标题未生成）时 More 按钮整体不显示，而非禁用
  const isEmptyThread = useAuiState((s) => s.thread.messages.length === 0);
  // 链路追踪：当前线程的 sidecar 会话 id（registry 未登记时无轨迹可看，入口禁用）
  const traceSessionId = mainThread
    ? prefsSessionIdFor(mainThread.id)
    : undefined;
  const openTrace = () => {
    if (!traceSessionId) return;
    openPanelTab("trace", { sessionId: traceSessionId });
    // 面板开合是 Base 的本地态，经事件请求展开（与 composer「Git 图谱」同款）
    window.dispatchEvent(new Event("agent-panel:open"));
  };
  return (
    <header
      data-tauri-drag-region={desktop ? "deep" : undefined}
      className={cn(
        // 左 padding 随折叠变化（macOS 红绿灯让位），与折叠按钮槽同节拍过渡，
        // 标题被连续挤开而不是瞬间跳位；时长/缓动必须与侧栏 width 收拢
        // 完全一致（300ms + 同一曲线），否则槽位先收没、侧栏按钮后到位，
        // 中间出现"按钮凭空消失"的空窗
        "flex h-12 shrink-0 items-center gap-2 transition-[padding] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
        !pageMode && "border-b-[0.5]",
        // Windows 三键贴窗口右上角，去掉右 padding；停靠态三键在面板顶栏、
        // 其余环境保持 pr-4
        winControls && !docked ? "pr-0" : "pr-4",
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
      
      {/* 整页视图不属于任何会话：标题/徽章/重命名/面板开关都让位给页面自身 */}
      {pageMode ? null : <ThreadTitle />}
      {/* 所选工作区目录 + git 分支 tag（未选目录时不显示），位于「更多」按钮左侧 */}
      {!pageMode && !isEmptyThread && <WorkspaceBadge />}
      {/* 全局工作模式切换（编码/工作）：应用级开关，常驻可见——设置→通用里是同一事实源 */}
      {!pageMode && <AppModeSwitch />}
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
            currentTitle={mainThread?.title ?? ""}
            // store client 的 rename 声明是 void，运行时返回 Promise（可等待、可捕获失败）
            onRename={(t) =>
              aui.threads.item("main").rename(t) as unknown as Promise<void>
            }
          />
        </>
      )}
      {/* Agent 面板开关：面板完全收没才出现（展开时收起入口在面板顶栏），
          有在途活动则亮角标。按钮槽常驻挂载，宽度+透明度 200ms 过渡
          （对齐左侧栏折叠按钮槽）：收起动画播完按钮"长出来"、展开时
          平滑收进槽里，不再生硬地瞬间弹出/消失；隐藏时 inert 防聚焦误点 */}
      <div className="ml-auto flex shrink-0 items-center">
        <div
          inert={pageMode || !showPanelToggle}
          aria-hidden={pageMode || !showPanelToggle}
          className={cn(
            "overflow-hidden transition-[width,opacity] duration-200",
            pageMode || !showPanelToggle ? "w-0 opacity-0" : "w-8",
          )}
        >
          <PanelToggleButton onToggle={onTogglePanel} />
        </div>
      </div>
      {/* 窗口控制固定在窗口右上角；停靠态右缘是面板，由面板顶栏接管渲染 */}
      {docked ? null : <WindowControls />}
    </header>
  );
};