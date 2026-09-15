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
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PencilIcon,
  ShareIcon,
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
import { usePanelActivity } from "@/lib/panel-activity";
import { useThreadTodos } from "@/lib/pi-todo";
import { useGitStatus } from "@/lib/git-status";
import { pathBasename, useWorkspace } from "@/lib/workspace-store";
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

/** 标题旁「更多」菜单：目前仅"重命名任务"；全新未落库会话（status new）禁用 */
const HeaderMoreMenu: FC<{
  canRename: boolean;
  onRename: () => void;
}> = ({ canRename, onRename }) => {
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** 面板收起时的角标提示:有在途工具或未完成任务才亮。
 *  空会话（尚无消息）且面板已收起时不渲染；面板展开时仍显示以便收起
 *  （空会话也可能被 composer 的 Git 图谱等入口展开） */
const PanelToggleButton: FC<{
  panelOpen: boolean;
  onToggle: () => void;
}> = ({ panelOpen, onToggle }) => {
  const { runningCount } = usePanelActivity();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const isEmptyThread = useAuiState((s) => s.thread.messages.length === 0);
  const snap = useThreadTodos(threadId ?? undefined);
  const hasUnfinishedPlan = snap.tasks.some(
    (t) => t.status !== "deleted" && t.status !== "completed",
  );
  const badge = !panelOpen && (runningCount > 0 || hasUnfinishedPlan);

  if (isEmptyThread && !panelOpen) return null;

  return (
    <TooltipIconButton
      variant="ghost"
      size="icon"
      tooltip={panelOpen ? "收起 Agent 面板" : "展开 Agent 面板"}
      side="bottom"
      onClick={onToggle}
      className="relative size-8 shrink-0"
    >
      {panelOpen ? (
        <PanelRightCloseIcon className="size-4" />
      ) : (
        <PanelRightOpenIcon className="size-4" />
      )}
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
 *  分支 tag 仅在该目录是 git 仓库且状态已加载时出现（复用 git-status 缓存，不重复拉取）。
 *  纯展示，不做交互 —— 切换 workspace/分支仍走 composer 的胶囊入口 */
const WorkspaceBadge: FC = () => {
  const workspace = useWorkspace();
  const { status } = useGitStatus(workspace);
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
      {status ? (
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
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** session = 聊天会话顶栏（默认）；page = 整页管理视图（自动化/计划等）的
   *  纯窗口边框条：隐藏会话专属元素（标题/徽章/重命名/面板开关）且无分隔线，
   *  页面身份由视图自身的大标题承载 */
  variant?: "session" | "page";
}> = ({
  sidebarCollapsed,
  onToggleSidebar,
  onOpenMobileSidebar,
  panelOpen,
  onTogglePanel,
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
  return (
    <header
      data-tauri-drag-region={desktop ? "deep" : undefined}
      className={cn(
        // 左 padding 随折叠变化（macOS 红绿灯让位），与折叠按钮槽同节拍过渡，
        // 标题被连续挤开而不是瞬间跳位
        "flex h-12 shrink-0 items-center gap-2 transition-[padding] duration-200",
        !pageMode && "border-b-[0.5]",
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
      {/* 折叠按钮槽：常驻挂载（展开时 inert 防聚焦），宽度 0↔32 用 200ms
          过渡，和侧栏 width 收拢同节拍把标题等内容往右挤开；w-0 时负 margin
          抵消 header 的 gap-2，<md display:none 完全不占位 */}
      <div
        inert={!sidebarCollapsed}
        aria-hidden={!sidebarCollapsed}
        className={cn(
          "overflow-hidden transition-[width,margin] duration-200 max-md:hidden",
          sidebarCollapsed ? "w-8" : "-ml-2 w-0",
        )}
      >
        <TooltipIconButton
          variant="ghost"
          size="icon"
          tooltip="Show sidebar"
          side="bottom"
          onClick={onToggleSidebar}
          className="size-8"
        >
          <PanelLeftIcon className="size-4" />
        </TooltipIconButton>
      </div>
      
      {/* 整页视图不属于任何会话：标题/徽章/重命名/面板开关都让位给页面自身 */}
      {pageMode ? null : <ThreadTitle />}
      {/* 所选工作区目录 + git 分支 tag（未选目录时不显示），位于「更多」按钮左侧 */}
      {!pageMode && !isEmptyThread && <WorkspaceBadge />}
      {/* 标题右侧「更多」菜单 + 重命名任务 dialog（空会话不渲染） */}
      {pageMode || isEmptyThread ? null : (
        <>
          <HeaderMoreMenu
            canRename={canRename}
            onRename={() => setRenameOpen(true)}
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
      {/* Agent 面板开关：贴右缘（Share 左侧），收起时有活动则亮角标 */}
      <div className="ml-auto flex shrink-0 items-center">
        {pageMode ? null : (
          <PanelToggleButton panelOpen={panelOpen} onToggle={onTogglePanel} />
        )}
      </div>
      {/* 窗口控制固定在窗口右上角（主 Header 右缘即窗口右缘）；仅 Windows/Linux 渲染 */}
      <WindowControls />
    </header>
  );
};