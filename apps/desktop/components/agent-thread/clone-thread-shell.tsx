"use client";

import {
  ThreadList,
  ThreadListItems,
  ThreadListRoot,
} from "@/components/assistant-ui/elements/thread-list.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { ThreadNavButtons } from "@/components/agent-thread/thread-nav-buttons";
import { MoveSessionDialogHost } from "@/components/agent-thread/move-session-dialog";
import { ElasticRailHandle } from "@/components/agent-thread/elastic-rail-handle";
import { Button } from "@/components/ui/button";
import dynamicImport from "next/dynamic";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { isRemoteMode } from "@/lib/remote";
import { isMacPlatform, isDesktop } from "@/lib/desktop-env";
import { clearLastThread } from "@/lib/pi/pi-last-thread";
import { clearWorkspace } from "@/lib/workspace/workspace-store";
import {
  finishNavApply,
  syncNavCurrent,
  useThreadNavState,
} from "@/lib/pi/pi-thread-nav-history";
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
  LibraryIcon,
  MenuIcon,
  MonitorSmartphoneIcon,
  PanelLeftIcon,
  SearchIcon,
  ZapIcon,
  PlugIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Kbd, KbdGroup } from "../ui/kbd";
import { useT } from "@/lib/i18n";

// 搜索视图懒加载：它带行组件全家桶 + 一批 lucide 图标，不该进首屏 chunk
//（仓库既有范式同 SettingsPage）。首次 ⌘K 会多一次 chunk 拉取。
const GlobalSearchView = dynamicImport(
  () =>
    import("@/components/search/global-search-view").then(
      (m) => m.GlobalSearchView,
    ),
  { ssr: false },
);

/** 侧边栏宽度拖拽调节的持久化键（存 px 整数；无值 = 默认 16.25rem 栏宽，
 *  rem 基准跟随全局字号缩放，拖过之后按用户选定的 px 固定）与上下限 */
const RAIL_WIDTH_KEY = "ui.sidebar-width";
const RAIL_MIN_WIDTH = 260;
const RAIL_MAX_WIDTH = 420;

type CloneThreadShellProps = {
  children: ReactNode;
  railClassName?: string | undefined;
  collapsed?: boolean | undefined;
  onCollapsedChange?: ((value: boolean) => void) | undefined;
  /** 全局搜索受控开合：宿主 Header 需要把输入行嵌进同一根顶栏 */
  searchOpen?: boolean | undefined;
  onSearchOpenChange?: ((value: boolean) => void) | undefined;
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
  searchOpen: controlledSearchOpen,
  onSearchOpenChange,
  mobileSidebarOpen,
  onMobileSidebarOpenChange,
  activeMenu,
  onActiveMenuChange,
  onOpenSettings,
  headerContent,
  sheetTitle,
}) => {
  const t = useT();
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
  // 红绿灯避让只在 macOS 桌面端（Electron）成立：isMacPlatform() 只看 UA，
  // 网页在 mac 浏览器里打开时同样为 true，但无窗口 chrome，必须走 Logo 分支
  // （与 base.tsx 的 mac 同口径）
  const macDesktop = isDesktop() && isMacPlatform();
  // 项目分组的展开状态提升到 shell：分区头的「展开全部/收起全部」按钮与
  // 列表共用；移动会话成功后据此自动展开目标组
  const [projOpenDirs, setProjOpenDirs] = useState<Set<string>>(
    () => new Set(),
  );
  // 会话移动成功：把目标目录的组展开。展开状态提升在 shell 层，与
  // 「展开全部」按钮共用
  useEffect(() => {
    const onMoved = (event: Event) => {
      const cwd = (event as CustomEvent<{ cwd?: string }>).detail?.cwd;
      if (!cwd) return;
      setProjOpenDirs((prev) =>
        prev.has(cwd) ? prev : new Set(prev).add(cwd),
      );
    };
    window.addEventListener("pi:session-moved", onMoved as EventListener);
    return () =>
      window.removeEventListener("pi:session-moved", onMoved as EventListener);
  }, []);
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

  const [internalSearchOpen, setInternalSearchOpen] = useState(false);
  const searchControlled = controlledSearchOpen !== undefined;
  const searchOpen = controlledSearchOpen ?? internalSearchOpen;
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;
  const setSearchOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(searchOpenRef.current) : next;
    if (!searchControlled) setInternalSearchOpen(value);
    onSearchOpenChange?.(value);
  };
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const aui = useAui();

  // 导航历史（浏览器式前进/后退，见 pi-thread-nav-history）：记录与执行都
  // 收在本组件——它是唯一同时持有 useAui 与受控 currentMenu 的单例宿主
  // （桌面 aside 与移动抽屉共用一次挂载，tracker 不会双份入栈）
  const navThreadId = useAuiState((s) => s.threads.mainThreadId);
  const navState = useThreadNavState();
  useEffect(() => {
    if (!navThreadId) return;
    syncNavCurrent({ threadId: navThreadId, menu: currentMenu });
  }, [navThreadId, currentMenu]);
  useEffect(() => {
    const pending = navState.pending;
    if (!navState.applying || !pending) return;
    // menu 同步先落；会话异步后落，成功由 tracker 的 id 追平上报解除
    // applying，失败（会话已删等）就地复位——目标条目放弃，栈不回滚
    setActiveMenu(pending.menu);
    if (pending.threadId === navThreadId) return;
    if (!threadIds.includes(pending.threadId)) {
      // 已删会话：switchToThread 对不在列表的 id 不抛错，而是拉空快照、
      // 被 RemoteThreadList 收编成幽灵「新对话」行（见 pi-client-base
      // deleteThread 注释）——直接放弃该条目，不切换
      finishNavApply();
      return;
    }
    try {
      Promise.resolve(aui.threads.switchToThread(pending.threadId)).catch(() =>
        finishNavApply(),
      );
    } catch {
      finishNavApply();
    }
    // 只随导航请求触发；setActiveMenu/aui/navThreadId 取当次渲染闭包值
  }, [navState.applySeq]);

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
    // 搜索是覆盖在主区之上的独立一页：任何侧栏导航都先退出搜索，否则覆盖层
    // 会一直盖住目标页（点了「自动化」看着还停在搜索页）
    setSearchOpen(false);
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

  // 侧栏点会话 / 外部通知回焦 / 分叉打开等都会推移 mainThreadId：搜索页随
  // 会话切换一起退场（搜索自己点结果时 openHit 已先关，重复关闭无副作用）
  useEffect(() => {
    if (!searchOpen) return;
    setSearchOpen(false);
  }, [currentMenu, navThreadId]);

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
  // railW=null 时 aside/内容列走 var 的 fallback（rem 基准，未拖过 = 原样）。
  // 具体拖拽/弹簧/键盘/可见性都在 ElasticRailHandle 里；这里只负责已提交
  // 宽度的 React 状态与 localStorage。把手在 aside 外层、主区左缘，16px
  // 命中带跨在边框上，且不会压到侧栏右缘的 8px padding 按钮。
  const asideRef = useRef<HTMLElement>(null);
  // 内层内容列：宽度跟随把手逐帧变化（ElasticRailHandle 每帧写 width）。
  // 会话行里的 MarqueeTitle 在 is-resizing 期间直接跳过测量，松手后由
  // rail-resize-end 统一补测，因此跟手不会触发逐行「读布局 + setState」。
  const railInnerRef = useRef<HTMLDivElement>(null);
  const [railW, setRailW] = useState<number | null>(null);
  const railPanelId = useId();
  useEffect(() => {
    const n = Number(window.localStorage.getItem(RAIL_WIDTH_KEY));
    // 旧版本允许拖到 180px：恢复时按新下限钳制，而不是丢弃用户偏好
    if (Number.isFinite(n) && n > 0) {
      setRailW(
        Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(n))),
      );
    }
  }, []);
  const commitRailWidth = (width: number) => {
    const next = Math.min(
      RAIL_MAX_WIDTH,
      Math.max(RAIL_MIN_WIDTH, Math.round(width)),
    );
    setRailW(next);
    try {
      window.localStorage.setItem(RAIL_WIDTH_KEY, String(next));
    } catch {}
  };
  const resetRailWidth = () => {
    asideRef.current?.style.removeProperty("--rail-w");
    asideRef.current?.style.removeProperty("width");
    asideRef.current?.style.removeProperty("transition-duration");
    asideRef.current?.style.removeProperty("will-change");
    railInnerRef.current?.style.removeProperty("width");
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
      label: t("chat.sidebar.newChat"),
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
      label: t("chat.sidebar.automation"),
      icon: ZapIcon,
    },
    { id: "connector", label: t("chat.sidebar.connector"), icon: PlugIcon },
    { id: "files", label: t("chat.sidebar.library"), icon: LibraryIcon },
    // 远程网页端不显示本入口：它自己就是远程会话，管理远程/IM 是桌面端的事
    ...(isRemoteMode()
      ? []
      : [{ id: "remote", label: t("chat.sidebar.remote"), icon: MonitorSmartphoneIcon }]),
  ];

  return (
    // bg-background
    <div className="relative flex h-full w-full overflow-hidden">
      <aside
        ref={asideRef}
        id={railPanelId}
        aria-label={t("chat.sidebar.aria")}
        data-wallpaper-surface="rail"
        style={
          railW === null ? undefined : ({ "--rail-w": `${railW}px` } as CSSProperties)
        }
        className={cn(
          // 折叠动画 = aside 宽度（推挤主区）+ 内层整列 transform（内容平移
          // 出屏）。内层固定栏宽不参与重排：会话再多，行布局在动画期间完全
          // 静止，只有 aside 的盒宽和合成器上的 transform 在动。
          // 拖动中的可见宽度由 ElasticRailHandle 直接写内联 width；松手
          // 弹簧落定后提交 railW，再把内联值交还给类/变量以便折叠动画。
          "bg-muted/55 relative hidden h-full shrink-0 flex-col overflow-hidden border-r md:flex",
          "transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          railClassName,
          sidebarCollapsed ? "w-0" : "w-[var(--rail-w,18.25rem)]",
        )}
      >
        <div
          ref={railInnerRef}
          className={cn(
            "flex h-full w-[var(--rail-w,18.25rem)] shrink-0 flex-col",
            "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
            sidebarCollapsed ? "-translate-x-full" : "translate-x-0",
          )}
        >
        {/* header */}
        <div
          data-drag-region={isDesktop() ? "deep" : undefined}
          className={cn(
            "flex h-15 shrink-0 items-center overflow-hidden px-2 gap-2",
            // macOS 桌面端：内容靠右（左上为悬浮红绿灯位）；Windows/网页：Logo 靠左、操作靠右
            macDesktop ? "justify-end" : "justify-start",
          )}
        >
          {!collapsedControlled && (
            <TooltipIconButton
              variant="ghost"
              size="icon"
              tooltip={sidebarCollapsed ? t("chat.sidebar.expand") : t("chat.sidebar.collapse")}
              side="right"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="size-8"
            >
              <PanelLeftIcon className="size-4" />
            </TooltipIconButton>
          )}
          {(() => {
            // 导航（后退/前进）与搜索入口在折叠按钮左侧（折叠按钮经
            // headerContent 传入）。折叠时内容随整列平移出屏，无需卸载；
            // mac 桌面端的红绿灯避让（ml-18）由组内第一个元素（后退）承接
            const navButtons = (
              <ThreadNavButtons className={cn(macDesktop && "ml-18")} />
            );
            const searchButton = (
              <TooltipIconButton
                variant="ghost"
                size="icon"
                tooltip={t("chat.sidebar.search")}
                side="bottom"
                onClick={() => setSearchOpen(true)}
                className="size-8"
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
            if (macDesktop)
              return (
                <>
                  {navButtons}
                  {searchButton}
                  {inner}
                </>
              );
            // Windows/网页：Logo 靠左，导航与搜索、折叠按钮靠右（窗口控制在主 Header 右上角）
            return (
              <>
                {!sidebarCollapsed && <Logo />}
                <div className="ml-auto flex items-center gap-1">
                  {navButtons}
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
                    "h-8 w-full text-sm justify-between gap-2 rounded-md px-2.5  font-medium hover:bg-transparent dark:hover:bg-transparent group",
                    !item.isNew && !searchOpen && currentMenu === item.id && "bg-selected",
                  )}
                  onClick={() => handleMenuClick(item)}
                  aria-label={item.label}
                >
                  <div className="flex items-center gap-1 shrink-0">
                    <Icon className="size-4 shrink-0" />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </div>
                 <div className="hidden group-hover:block">
                   {item.kbd}
                 </div>
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

        <ThreadListRoot
          onClick={clearMenuAfterNavigation}
          className={cn(
            // min-h-0：flex-1 子项默认 min-height:auto，列表内容长时会撑高
            // 整个 aside 列、把上方菜单顶出去——溢出滚动必须锁在本容器内。
            // 恒为整栏宽：折叠动画期间列表不参与重排（外层整列 transform 出屏）
            // w-full 跟随内层（内层才是宽度所有者）：拖拽期间内层宽度被冻结，
            // 列表就不会逐帧重排，行内 ResizeObserver 也不再每帧回调
            "relative min-h-0 w-full flex-1 overflow-y-auto p-3",
          )}
        >
          <ThreadListItems
            aria-hidden={sidebarCollapsed}
            inert={sidebarCollapsed}
            openDirs={projOpenDirs}
            onOpenDirsChange={setProjOpenDirs}
          />
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
                className="h-8 w-full cursor-pointer justify-start gap-2 rounded-md px-2.5 text-sm font-normal hover:bg-transparent dark:hover:bg-transparent"
                onClick={() => {
                  setSearchOpen(false);
                  onOpenSettings?.();
                }}
              >
                <SettingsIcon className="size-4 shrink-0" />
                <span className="whitespace-nowrap">{t("chat.sidebar.settings")}</span>
              </Button>
            </FluidHoverRow>
            <FluidHoverRow registerItem={settingsHover.registerItem} index={1}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("chat.sidebar.usageStats")}
                title={t("chat.sidebar.usageStats")}
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
                      !item.isNew && !searchOpen && currentMenu === item.id && "bg-selected",
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

          <div
            className="relative flex-1 overflow-y-auto p-3"
            onClick={closeMobileSidebarAfterNavigation}
          >
            <ThreadList
              openDirs={projOpenDirs}
              onOpenDirsChange={setProjOpenDirs}
            />
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
                    setSearchOpen(false);
                    setMobileOpen(false);
                    onOpenSettings?.();
                  }}
                >
                  <SettingsIcon className="size-4 shrink-0" />
                  <span className="whitespace-nowrap">{t("chat.sidebar.settings")}</span>
                </Button>
              </FluidHoverRow>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* 移动会话对话框全局挂载一次：行菜单把请求投进模块级 store */}
      <MoveSessionDialogHost />

      {/* 全局搜索（⌘K / 侧边栏搜索按钮）：右侧主区**覆盖层**。
          children 必须保持挂载——早先实现是"用搜索视图替换 children"，
          替换会让主区里的 ResizablePanelGroup 卸载重挂；重挂时的初始尺寸
          会被 onResize 的"拖拽兜底"（!collapsed && !panelShown &&
          size>=MIN ⇒ 想展开）误判成用户手势，把用户关掉的面板重新打开
          （自动化页按 Esc 关搜索即复现）。覆盖层方案零卸载、零 resize 事件，
          侧栏仍在覆盖区之外保持可点。 */}
      <div className="relative min-w-0 flex-1">
        <div className="relative h-full w-full overflow-hidden">
          {children}
          {searchOpen ? (
            // 从 Main Header 下方开始：搜索页沿用与资料库/自动化一致的
            // Header（含折叠态导航与展开侧栏按钮），不再自己造一条顶栏
            <div className="absolute inset-x-0 top-12 bottom-0 z-40 flex bg-background">
              <GlobalSearchView
                open
                onOpenChange={setSearchOpen}
                onNewThread={() => {
                  setSearchOpen(false);
                  setActiveMenu("");
                  // 同左栏菜单入口：动作驱动清指针；新对话从"未选择目录"开始
                  clearLastThread();
                  clearWorkspace();
                  void aui.threads.switchToNewThread();
                }}
              />
            </div>
          ) : null}
        </div>
        {!sidebarCollapsed && (
          <ElasticRailHandle
            asideRef={asideRef}
            innerRef={railInnerRef}
            minWidth={RAIL_MIN_WIDTH}
            maxWidth={RAIL_MAX_WIDTH}
            controlsId={railPanelId}
            onCommit={commitRailWidth}
            onReset={resetRailWidth}
          />
        )}
      </div>
    </div>
  );
};
