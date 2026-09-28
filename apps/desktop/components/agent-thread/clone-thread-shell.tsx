"use client";

import {
  ThreadList,
  ThreadListItems,
  ThreadListRoot,
  ProjectListItems,
  useThreadListGroups,
} from "@/components/assistant-ui/elements/thread-list.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isRemoteMode } from "@/lib/remote";
import { isMacPlatform, isTauri } from "@/lib/tauri";
import { clearLastThread } from "@/lib/pi/pi-last-thread";
import { clearWorkspace } from "@/lib/workspace/workspace-store";
import {
  formatShortcutParts,
  matchesShortcut,
  useShortcuts,
} from "@/lib/shortcuts";
import { useFluidHover } from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import { FluidHoverRow } from "@/components/fluid-hover-row";
import { Logo } from "./header";
import { ThreadListPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import {
  ChartColumnIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  FolderOpenIcon,
  ListTodoIcon,
  MenuIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  SearchIcon,
  ZapIcon,
  PlugIcon,
  PlusIcon,
  SettingsIcon,
  FolderCode,
  FileCheckCornerIcon,
  Maximize2Icon,
  Minimize2Icon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Kbd, KbdGroup } from "../ui/kbd";

/** 侧边栏宽度拖拽调节的持久化键（存 px 整数；无值 = 默认 16.25rem 栏宽，
 *  rem 基准跟随全局字号缩放，拖过之后按用户选定的 px 固定）与上下限 */
const RAIL_WIDTH_KEY = "ui.sidebar-width";
const RAIL_MIN_WIDTH = 180;
const RAIL_MAX_WIDTH = 420;

type CloneThreadShellProps = {
  children: ReactNode;
  railClassName?: string | undefined;
  collapsed?: boolean | undefined;
  onCollapsedChange?: ((value: boolean) => void) | undefined;
  mobileSidebarOpen?: boolean | undefined;
  onMobileSidebarOpenChange?: ((value: boolean) => void) | undefined;
  /** 受控菜单选中项：由外壳宿主据此切换主区视图（如 "automation"） */
  activeMenu?: string | undefined;
  onActiveMenuChange?: ((value: string) => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
  headerContent?: ReactNode | undefined;
  sheetTitle?: ReactNode | undefined;
};

export const CloneThreadShell: FC<CloneThreadShellProps> = ({
  children,
  railClassName,
  collapsed,
  onCollapsedChange,
  mobileSidebarOpen,
  onMobileSidebarOpenChange,
  activeMenu,
  onActiveMenuChange,
  onOpenSettings,
  headerContent,
  sheetTitle,
}) => {
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  const [internalMobileOpen, setInternalMobileOpen] = useState(false);
  // 「新对话」是常驻入口而非可选中项，不参与高亮；初始无选中。
  // 受控时（宿主按选中项切换主区视图）内部不再持有，见 collapsed 同款模式。
  const [internalActiveMenu, setInternalActiveMenu] = useState<string>("");
  const menuControlled = activeMenu !== undefined;
  const currentMenu = activeMenu ?? internalActiveMenu;
  const setActiveMenu = (value: string) => {
    if (!menuControlled) setInternalActiveMenu(value);
    onActiveMenuChange?.(value);
  };
  const [activeTab, setActiveTab] = useState<string>("tasks");
  // 项目分组的展开状态提升到 shell：「展开全部/收起全部」按钮与列表共用
  const [projOpenDirs, setProjOpenDirs] = useState<Set<string>>(
    () => new Set(),
  );
  const { projectGroups } = useThreadListGroups();
  const allProjectsExpanded =
    projectGroups.length > 0 &&
    projectGroups.every((g) => projOpenDirs.has(g.cwd));
  const toggleAllProjects = () =>
    setProjOpenDirs(
      allProjectsExpanded
        ? new Set()
        : new Set(projectGroups.map((g) => g.cwd)),
    );
  // 顶部固定菜单与「设置」按钮：与列表同款的 fluid hover。各自独立作用域
  // （与列表容器 padding 不同，高亮不跨容器滑动，进出时淡入淡出）。
  const menuListRef = useRef<HTMLDivElement>(null);
  const menuHover = useFluidHover(menuListRef);
  const settingsRef = useRef<HTMLDivElement>(null);
  // 底部操作栏恒为横向并排（设置 + 使用统计图标），拾取轴向用 "x"。
  // 默认的 "y" 只按纵轴判包含，并排两个按钮的 rect 在纵轴上同时"包含"
  // 指针，后注册的使用统计图标会抢走设置的高亮
  const settingsHover = useFluidHover(settingsRef, { axis: "x" });
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuHover = useFluidHover(mobileMenuRef);
  const mobileSettingsRef = useRef<HTMLDivElement>(null);
  const mobileSettingsHover = useFluidHover(mobileSettingsRef);

  const [searchOpen, setSearchOpen] = useState(false);
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const aui = useAui();

  // 全局快捷键：绑定来自「设置 → 快捷键」，改动即时生效
  const { toggleSearch, newThread } = useShortcuts();
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (matchesShortcut(event, toggleSearch)) {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [toggleSearch]);

  // 新对话：与侧边栏「新对话」按钮同走 aui.threads 开新会话
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (matchesShortcut(event, newThread)) {
        event.preventDefault();
        setActiveMenu("");
        // 动作驱动清"最近打开的会话"指针：刷新后不回旧会话（2026-09-22 修复）
        clearLastThread();
        // 新对话一律从"未选择目录"开始（与侧栏/命令面板入口同语义）
        clearWorkspace();
        void aui.threads.switchToNewThread();
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [aui, newThread]);

  const handleMenuClick = (item: (typeof menuItems)[number]) => {
    // 「新对话」是常驻入口：点击即取消其他菜单项的选中态。本 onClick 与外层
    // ThreadListPrimitive.New 的框架切换是合成关系、两者都会跑；这里动作驱动
    // 清"最近打开的会话"指针，刷新后不再回旧会话（2026-09-22 修复）
    if (item.isNew) {
      setActiveMenu("");
      clearLastThread();
      // 新对话一律从"未选择目录"开始（与侧栏/快捷键入口同语义）
      clearWorkspace();
      return;
    }
    // 搜索入口在顶栏折叠按钮左侧（走命令面板），菜单项只保留视图切换
    setActiveMenu(item.id);
    // 菜单项切换的是主区页面：移动端抽屉里点完收起，让视图可见
    setMobileOpen(false);
  };

  // A controlled value means the caller renders the chrome that drives it, so
  // the shell omits its own toggle / trigger and forwards changes instead.
  const collapsedControlled = collapsed !== undefined;
  const mobileControlled = mobileSidebarOpen !== undefined;

  const mobileOpen = mobileSidebarOpen ?? internalMobileOpen;
  const sidebarCollapsed = collapsed ?? internalCollapsed;

  const setSidebarCollapsed = (value: boolean) => {
    if (!collapsedControlled) setInternalCollapsed(value);
    onCollapsedChange?.(value);
  };

  // —— 侧边栏宽度拖拽调节 ——
  // railW=null 时三处宽度类都走 var 的 fallback（rem 基准，未拖过 = 原样）。
  // 拖拽全程绕过 React：每帧 rAF 只往 aside 内联写一个 --rail-w（aside 类宽
  // 与内层/列表三处同源，浏览器联动跟宽；React 只在 state 变化时才写 style，
  // 拖拽中 railW 不变不会覆盖内联值）。卡顿主因是旧实现每帧 setState 把整棵
  // 会话树重渲染一遍；逐帧重排与拖右侧 panel/缩放窗口同量级。宽度过渡临时
  // 置 0、悬停线加粗用 classList 直挂，松手一并交还类/状态。
  const asideRef = useRef<HTMLElement>(null);
  const railLineRef = useRef<HTMLDivElement>(null);
  const [railW, setRailW] = useState<number | null>(null);
  const railDragRef = useRef<{
    startX: number;
    lastX: number;
    startW: number;
    frame: number | null;
  } | null>(null);
  useEffect(() => {
    const n = Number(window.localStorage.getItem(RAIL_WIDTH_KEY));
    if (Number.isFinite(n) && n >= RAIL_MIN_WIDTH && n <= RAIL_MAX_WIDTH)
      setRailW(n);
  }, []);
  const railClamp = (n: number) =>
    Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(n)));
  const railApplyFrame = () => {
    const drag = railDragRef.current;
    const aside = asideRef.current;
    if (!drag || !aside) return;
    drag.frame = null;
    aside.style.setProperty(
      "--rail-w",
      `${railClamp(drag.startW + drag.lastX - drag.startX)}px`,
    );
  };
  const onRailHandleDown = (event: PointerEvent<HTMLDivElement>) => {
    const aside = asideRef.current;
    if (!aside) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startW = aside.offsetWidth;
    railDragRef.current = {
      startX: event.clientX,
      lastX: event.clientX,
      startW,
      frame: null,
    };
    aside.style.transitionDuration = "0s";
    // 钉住当前渲染宽为内联变量起点（未拖过时类宽走 rem fallback，与测量
    // 值一致），此后每帧只更新这一个变量，三处栏宽联动实时跟手
    aside.style.setProperty("--rail-w", `${startW}px`);
    railLineRef.current?.classList.add("w-0.5", "opacity-100");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const onRailHandleMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = railDragRef.current;
    if (!drag) return;
    drag.lastX = event.clientX;
    if (drag.frame === null) drag.frame = requestAnimationFrame(railApplyFrame);
  };
  const onRailHandleUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = railDragRef.current;
    railDragRef.current = null;
    if (!drag) return;
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    const aside = asideRef.current;
    const finalW = railClamp(drag.startW + drag.lastX - drag.startX);
    // 变量钉回最终值（与最后一帧一致，防 canceled 帧残留旧值），恢复过渡
    // ——此刻类宽==内联变量==最终值，恢复过渡不会触发收起动画；随后
    // setRailW 提交的 style 写同一值，React 接管无闪跳
    if (aside) {
      aside.style.setProperty("--rail-w", `${finalW}px`);
      aside.style.transitionDuration = "";
    }
    railLineRef.current?.classList.remove("w-0.5", "opacity-100");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
    setRailW(finalW);
    try {
      window.localStorage.setItem(RAIL_WIDTH_KEY, String(finalW));
    } catch {}
  };
  const onRailHandleDoubleClick = () => {
    asideRef.current?.style.removeProperty("--rail-w");
    setRailW(null);
    try {
      window.localStorage.removeItem(RAIL_WIDTH_KEY);
    } catch {}
  };
  const setMobileOpen = (open: boolean) => {
    if (!mobileControlled) setInternalMobileOpen(open);
    onMobileSidebarOpenChange?.(open);
  };

  const isNavigationClick = (target: EventTarget | null) =>
    target instanceof Element &&
    !!target.closest(
      '[data-slot="aui_thread-list-item-trigger"], [data-slot="aui_thread-list-new"]',
    );

  const closeMobileSidebarAfterNavigation = (
    event: MouseEvent<HTMLDivElement>,
  ) => {
    if (!isNavigationClick(event.target)) return;
    setMobileOpen(false);
    // 会话行/新对话是对话区元素：点回对话时清掉页面选中（如自动化）
    setActiveMenu("");
  };

  // 桌面侧：同样的委托挂在线列表面板（tasks 与 projects 两个 tab 共用），
  // 管理页占住主区时点任意会话即切回对话
  const clearMenuAfterNavigation = (event: MouseEvent<HTMLDivElement>) => {
    if (isNavigationClick(event.target)) setActiveMenu("");
  };

  const menuItems = [
    {
      id: "new",
      label: "新对话",
      icon: PlusIcon,
      isNew: true,
      // 与「设置 → 快捷键」的新对话绑定同源，改绑后键帽即时同步
      kbd: (
        <KbdGroup>
          {formatShortcutParts(newThread, isMacPlatform()).map((part, i) => (
            <Kbd key={`${part}-${i}`}>{part}</Kbd>
          ))}
        </KbdGroup>
      ),
    },
    {
      id: "automation",
      label: "自动化",
      icon: ZapIcon,
    },
    { id: "connector", label: "插件市场", icon: PlugIcon },
    { id: "files", label: "我的文件", icon: FolderOpenIcon },
  ];

  return (
    // bg-background
    <div className="relative flex h-full w-full overflow-hidden">
      <aside
        ref={asideRef}
        style={
          railW === null ? undefined : ({ "--rail-w": `${railW}px` } as CSSProperties)
        }
        className={cn(
          // 折叠动画 = aside 宽度（推挤主区）+ 内层整列 transform（内容平移
          // 出屏）。内层固定栏宽不参与重排：会话再多，行布局在动画期间完全
          // 静止，只有 aside 的盒宽和合成器上的 transform 在动。
          // 拖拽进行中：内联 --rail-w 逐帧驱动本类宽（三处同源联动），
          // 过渡临时置 0，松手交还 React/类，见 onRailHandleDown/Up
          "bg-muted/55 relative hidden h-full shrink-0 flex-col overflow-hidden border-r md:flex",
          "transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          railClassName,
          sidebarCollapsed ? "w-0" : "w-[var(--rail-w,16.25rem)]",
        )}
      >
        <div
          className={cn(
            "flex h-full w-[var(--rail-w,16.25rem)] shrink-0 flex-col",
            "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
            sidebarCollapsed ? "-translate-x-full" : "translate-x-0",
          )}
        >
        {/* header */}
        <div
          data-tauri-drag-region={isTauri() ? "deep" : undefined}
          className={cn(
            "flex h-16 shrink-0 items-center overflow-hidden px-2 gap-2",
            // macOS：内容靠右（左上为悬浮红绿灯位）；Windows/网页：Logo 靠左、操作靠右
            isMacPlatform() ? "justify-end" : "justify-start",
          )}
        >
          {!collapsedControlled && (
            <TooltipIconButton
              variant="ghost"
              size="icon"
              tooltip={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              side="right"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="size-8"
            >
              <PanelLeftIcon className="size-4" />
            </TooltipIconButton>
          )}
          {(() => {
            // 搜索入口紧挨折叠按钮左侧（折叠按钮经 headerContent 传入）。
            // 折叠时内容随整列平移出屏，无需卸载；mac 侧的红绿灯避让
            // （ml-18）由组内第一个元素（搜索）承接
            const searchButton = (
              <TooltipIconButton
                variant="ghost"
                size="icon"
                tooltip="搜索对话"
                side="bottom"
                onClick={() => setSearchOpen(true)}
                className={cn("size-8", isMacPlatform() && "ml-18")}
              >
                <SearchIcon className="size-4" />
              </TooltipIconButton>
            );
            const inner =
              headerContent !== undefined
                ? headerContent
                : !sidebarCollapsed && (
                    <span className="ml-2 truncate text-sm font-medium">
                      Chats
                    </span>
                  );
            if (isMacPlatform())
              return (
                <>
                  {searchButton}
                  {inner}
                </>
              );
            // Windows/网页：Logo 靠左，搜索与折叠按钮靠右（窗口控制在主 Header 右上角）
            return (
              <>
                {!sidebarCollapsed && <Logo />}
                <div className="ml-auto flex items-center gap-1">
                  {searchButton}
                  {inner}
                </div>
              </>
            );
          })()}
        </div>

        {/* 固定的四个菜单项 */}
        <div className="shrink-0 px-2 pt-0">
          <div
            ref={menuListRef}
            className="relative flex flex-col gap-0.5"
            {...menuHover.handlers}
          >
            <FluidHoverHighlight hover={menuHover} className="rounded-md" />
            {menuItems.map((item, index) => {
              const Icon = item.icon;
              const button = (
                <Button
                  variant="ghost"
                  className={cn(
                    // hover 反馈交给 FluidHoverHighlight：压掉 ghost 变体
                    // 自带的 hover 底色，避免与高亮叠加
                    "h-8 w-full text-sm justify-between gap-2 rounded-md px-2.5  font-normal hover:bg-transparent dark:hover:bg-transparent",
                    !item.isNew && currentMenu === item.id && "bg-selected",
                  )}
                  onClick={() => handleMenuClick(item)}
                  aria-label={item.label}
                >
                  <div className="flex items-center gap-1 shrink-0">
                    <Icon className="size-4 shrink-0" />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </div>
                  {item.kbd}
                </Button>
              );

              return (
                <FluidHoverRow
                  key={item.id}
                  registerItem={menuHover.registerItem}
                  index={index}
                >
                  {item.isNew ? (
                    <ThreadListPrimitive.New asChild>
                      {button}
                    </ThreadListPrimitive.New>
                  ) : (
                    button
                  )}
                </FluidHoverRow>
              );
            })}
          </div>
        </div>

        {/* Tabs 胶囊分段器（左对齐）+ 项目 tab 的展开全部按钮 */}
        <div className="flex w-full shrink-0 items-center justify-between gap-2 px-3 pt-2">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="group-data-horizontal/tabs:h-8 h-8 rounded-full p-[3px]">
                <TabsTrigger
                  value="tasks"
                  className="flex-none gap-1.5 rounded-full px-3 py-0 text-xs"
                >
                  <FileCheckCornerIcon className="size-3.5 shrink-0" />
                  任务
                </TabsTrigger>
                <TabsTrigger
                  value="projects"
                  className="flex-none gap-1.5 rounded-full px-3 py-0 text-xs"
                >
                  <FolderCode className="size-3.5 shrink-0" />
                  项目
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {activeTab === "projects" && projectGroups.length > 0 && (
              <TooltipIconButton
                variant="ghost"
                tooltip={allProjectsExpanded ? "收起全部" : "展开全部"}
                className="text-muted-foreground hover:text-foreground h-7 gap-1 rounded-full px-2.5 text-xs"
                onClick={toggleAllProjects}
              >
                {allProjectsExpanded ? (
                  <Minimize2Icon className="size-3.5" />
                ) : (
                  <Maximize2Icon className="size-3.5" />
                )}
              </TooltipIconButton>
            )}
        </div>

        <ThreadListRoot
          onClick={clearMenuAfterNavigation}
          className={cn(
            // min-h-0：flex-1 子项默认 min-height:auto，列表内容长时会撑高
            // 整个 aside 列、把上方 tabs 行顶上去——溢出滚动必须锁在本容器内。
            // 恒为整栏宽：折叠动画期间列表不参与重排（外层整列 transform 出屏）
            "relative min-h-0 w-[var(--rail-w,16.25rem)] flex-1 overflow-y-auto p-3",
          )}
        >
          {activeTab === "tasks" && hasThreads && (
            <ThreadListItems aria-hidden={sidebarCollapsed} inert={sidebarCollapsed} />
          )}
          {activeTab === "projects" && (
            <ProjectListItems
              openDirs={projOpenDirs}
              onOpenDirsChange={setProjOpenDirs}
            />
          )}
        </ThreadListRoot>

        {/* 底部固定的设置按钮（远程模式下隐藏：模型/技能/远程配置均为桌面专属）。
            使用统计入口在设置按钮旁：activeMenu 驱动主区视图切换（与自动化页
            同机制），再次点击返回聊天，fluid hover 注册为 index 1 */}
        {!isRemoteMode() && (
          <div
            ref={settingsRef}
            className="relative flex shrink-0 items-center gap-0.5 p-2"
            {...settingsHover.handlers}
          >
            <FluidHoverHighlight hover={settingsHover} className="rounded-md" />
            <FluidHoverRow
              registerItem={settingsHover.registerItem}
              index={0}
              className="min-w-0 flex-1"
            >
              <Button
                variant="ghost"
                className="h-8 w-full justify-start gap-2 rounded-md px-2.5 text-sm font-normal hover:bg-transparent dark:hover:bg-transparent"
                onClick={() => onOpenSettings?.()}
              >
                <SettingsIcon className="size-4 shrink-0" />
                <span className="whitespace-nowrap">设置</span>
              </Button>
            </FluidHoverRow>
            <FluidHoverRow registerItem={settingsHover.registerItem} index={1}>
              <Button
                variant="ghost"
                size="icon"
                aria-label="使用统计"
                title="使用统计"
                className={cn(
                  "shrink-0 font-normal hover:bg-transparent dark:hover:bg-transparent",
                  currentMenu === "usage" && "bg-selected",
                )}
                onClick={() => setActiveMenu(currentMenu === "usage" ? "" : "usage")}
              >
                <ChartColumnIcon className="size-4 shrink-0" />
              </Button>
            </FluidHoverRow>
          </div>
        )}
        </div>
        {/* 侧边栏宽度拖拽把手：贴 aside 右缘，随 aside 折叠被 overflow 裁掉
            （收起态自然消失）；双击复位默认宽。细线样式与右侧 panel 的
            ResizableHandle 完全同款：常驻隐藏、悬停/拖动时 2px 浮现高亮
            （foreground 提色），两端各 2rem 渐隐。拖动中细线加粗/可见由
            pointerdown 时 classList 临时挂上、松手摘掉（零重渲染） */}
        <div
          role="separator"
          aria-orientation="vertical"
          title="拖动调整侧边栏宽度，双击复位"
          onPointerDown={onRailHandleDown}
          onPointerMove={onRailHandleMove}
          onPointerUp={onRailHandleUp}
          onPointerCancel={onRailHandleUp}
          onDoubleClick={onRailHandleDoubleClick}
          className="group/handle [&:hover>div]:bg-foreground/25 [&:active>div]:bg-foreground/45 absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none"
        >
          <div
            ref={railLineRef}
            className="bg-border/50 pointer-events-none absolute inset-y-0 right-0 w-px opacity-0 transition-[background-color,width,opacity] [-webkit-mask-image:linear-gradient(to_bottom,transparent,#000_2rem,#000_calc(100%-2rem),transparent)] [mask-image:linear-gradient(to_bottom,transparent,#000_2rem,#000_calc(100%-2rem),transparent)] group-hover/handle:w-0.5 group-hover/handle:opacity-100 group-active/handle:w-0.5 group-active/handle:opacity-100"
          />
        </div>
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        {!mobileControlled && (
          <div className="absolute top-2 left-2 z-20 md:hidden">
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="bg-background/70 size-8"
                >
                  <MenuIcon className="size-4" />
                  <span className="sr-only">Open chat history</span>
                </Button>
              }
            />
          </div>
        )}
        <SheetContent side="left" className="flex flex-col p-0">
          <SheetTitle className="flex h-12 shrink-0 items-center px-4 text-sm font-medium">
            {sheetTitle ?? "Chats"}
          </SheetTitle>

          {/* 移动端的四个菜单 */}
          <div className="shrink-0 px-4 pt-2">
            <div
              ref={mobileMenuRef}
              className="relative flex flex-col gap-0.5"
              {...mobileMenuHover.handlers}
            >
              <FluidHoverHighlight
                hover={mobileMenuHover}
                className="rounded-md"
              />
              {menuItems.map((item, index) => {
                const Icon = item.icon;
                const button = (
                  <Button
                    variant="ghost"
                    className={cn(
                      "h-8 w-full justify-start gap-2 rounded-md px-2.5 text-sm font-normal hover:bg-transparent dark:hover:bg-transparent",
                      !item.isNew && currentMenu === item.id && "bg-selected",
                    )}
                    onClick={() => handleMenuClick(item)}
                    aria-label={item.label}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </Button>
                );

                return (
                  <FluidHoverRow
                    key={item.id}
                    registerItem={mobileMenuHover.registerItem}
                    index={index}
                  >
                    {item.isNew ? (
                      <ThreadListPrimitive.New asChild>
                        {button}
                      </ThreadListPrimitive.New>
                    ) : (
                      button
                    )}
                  </FluidHoverRow>
                );
              })}
            </div>
          </div>

          {/* 移动端 Tabs 胶囊分段器（左对齐）+ 项目 tab 的展开全部按钮 */}
          <div className="flex w-full shrink-0 items-center justify-between gap-2 px-4 pt-2">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="group-data-horizontal/tabs:h-8 h-8 rounded-full p-[3px]">
                <TabsTrigger
                  value="tasks"
                  className="flex-none gap-1.5 rounded-full px-3 py-0 text-xs"
                >
                  <ListTodoIcon className="size-3.5 shrink-0" />
                  任务
                </TabsTrigger>
                <TabsTrigger
                  value="projects"
                  className="flex-none gap-1.5 rounded-full px-3 py-0 text-xs"
                >
                  <FolderIcon className="size-3.5 shrink-0" />
                  项目
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {activeTab === "projects" && projectGroups.length > 0 && (
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground h-7 gap-1 rounded-full px-2.5 text-xs"
                onClick={toggleAllProjects}
              >
                {allProjectsExpanded ? (
                  <ChevronsDownUpIcon className="size-3.5" />
                ) : (
                  <ChevronsUpDownIcon className="size-3.5" />
                )}
                {allProjectsExpanded ? "收起全部" : "展开全部"}
              </Button>
            )}
          </div>

          <div
            className="relative flex-1 overflow-y-auto p-3"
            onClick={closeMobileSidebarAfterNavigation}
          >
            {activeTab === "tasks" && <ThreadList />}
            {activeTab === "projects" && (
              <ThreadListRoot className="relative flex-1 overflow-y-auto p-3">
                <ProjectListItems
                  openDirs={projOpenDirs}
                  onOpenDirsChange={setProjOpenDirs}
                />
              </ThreadListRoot>
            )}
          </div>

          {/* 移动端底部固定的设置按钮（远程模式下隐藏） */}
          {!isRemoteMode() && (
            <div
              ref={mobileSettingsRef}
              className="relative shrink-0 border-t p-4"
              {...mobileSettingsHover.handlers}
            >
              <FluidHoverHighlight
                hover={mobileSettingsHover}
                className="rounded-md"
              />
              <FluidHoverRow
                registerItem={mobileSettingsHover.registerItem}
                index={0}
              >
                <Button
                  variant="ghost"
                  className="h-8 w-full justify-start gap-2 rounded-md px-2.5 text-sm font-normal hover:bg-transparent dark:hover:bg-transparent"
                  onClick={() => {
                    setMobileOpen(false);
                    onOpenSettings?.();
                  }}
                >
                  <SettingsIcon className="size-4 shrink-0" />
                  <span className="whitespace-nowrap">设置</span>
                </Button>
              </FluidHoverRow>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <CommandDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        className="max-w-[30dvw]!"
      >
        <Command className="w-full">
          <CommandInput placeholder="搜索对话..." />
          <CommandList>
            <CommandEmpty>没有找到结果</CommandEmpty>
            <CommandGroup heading="操作">
              <ThreadListPrimitive.New asChild>
                <CommandItem
                  value="action:new-thread"
                  keywords={["新对话"]}
                  onSelect={() => {
                    setSearchOpen(false);
                    setActiveMenu("");
                    // 同左栏菜单入口：动作驱动清指针（外层 New 负责开新会话）
                    clearLastThread();
                    clearWorkspace();
                  }}
                >
                  <PlusIcon className="size-4" />
                  <span>新对话</span>
                </CommandItem>
              </ThreadListPrimitive.New>
            </CommandGroup>
            {hasThreads && (
              <CommandGroup heading="对话">
                {threadIds.map((id) => {
                  const item = threadItems.find((t) => t.id === id);
                  const title = item?.title ?? "新对话";
                  return (
                    <CommandItem
                      key={id}
                      // cmdk 用 value 做选中/去重定位；不显式传会从文字（标题）推导，
                      // 标题重复时两条高亮同一个。id 唯一，标题放 keywords 保搜索命中
                      value={id}
                      keywords={[title]}
                      onSelect={() => {
                        aui.threads.switchToThread(id);
                        setSearchOpen(false);
                        setActiveMenu("");
                      }}
                    >
                      <MessageSquareIcon className="size-4 shrink-0" />
                      <span className="truncate">{title}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>

      <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
};
