"use client";

import {
  ThreadList,
  ThreadListItems,
  ThreadListRoot,
} from "@/components/assistant-ui/elements/thread-list.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { ThreadNavButtons } from "@/components/agent-thread/thread-nav-buttons";
import { MoveSessionDialogHost } from "@/components/agent-thread/move-session-dialog";
import { HandoffDialogHost } from "@/components/agent-thread/handoff-dialog";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ui/error-boundary";
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
import { projectGroupKey } from "@/lib/pi/pi-projects";
import { restoreLastUsedWorkspace } from "@/lib/workspace/last-used";
import {
  finishNavApply,
  syncNavCurrent,
  useThreadNavState,
} from "@/lib/pi/pi-thread-nav-history";
import { matchesShortcut, useShortcuts } from "@/lib/shortcuts";
import { useFluidHover } from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import { FluidHoverRow } from "@/components/fluid-hover-row";
import { NavRail } from "@/components/shell/nav-rail";
import { Logo } from "./header";
import { HubSidebar } from "@/components/shell/hub-sidebar";
import { DataSidebar } from "@/components/shell/data-sidebar";
import { ElasticRailHandle } from "@/components/agent-thread/elastic-rail-handle";
import { WindowControls } from "@/components/window-controls";
import type {
  ManageTab as MarketplaceManageTab,
  MarketplaceSection,
} from "@/components/marketplace/marketplace-view";
import type { KnowledgeBase } from "@/lib/workspace/knowledge-bases";
import { motion } from "framer-motion";
import { ThreadListPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import {
  BlocksIcon,
  ChartColumnIcon,
  HouseIcon,
  MenuIcon,
  MonitorSmartphoneIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePen,
  ZapIcon,
} from "lucide-react";
import { inboxBadgeCount, useInboxCounts } from "@/lib/inbox/inbox-store";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type FC,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useT } from "@/lib/i18n";
import { LibraryIcon } from "../icons/library-icons";
import { Panel2Icon } from "../icons/panel2-icons";
import { InboxIcon } from "../icons/inbox-icons";

// 搜索视图懒加载：它带行组件全家桶 + 一批 lucide 图标，不该进首屏 chunk
//（仓库既有范式同 SettingsPage）。首次 ⌘K 会多一次 chunk 拉取。
const GlobalSearchView = dynamicImport(
  () =>
    import("@/components/search/global-search-view").then(
      (m) => m.GlobalSearchView,
    ),
  { ssr: false },
);

/**
 * 壳层几何（参考 feat/layout-refactor 的「小浣熊式布局」，轻量移植）：
 * - 整窗 `--shell-veil` 灰底；顶部 44px chrome 条（红绿灯让位 + 导航 + 搜索 +
 *   折叠按钮，整条是拖拽区）；其下是 图标栏(56px) + 内容浮层。
 * - 内容浮层 = 侧边栏（白）+ 主区（白），距窗右/底内缩 8px 露灰边，
 *   右缘 24px 圆角；侧栏与主区同底色（bg-background），分割线只有一条
 *   border-r——侧栏颜色与对话背景一致。
 * - 侧栏全局共用：无论图标栏切到哪个分区（首页/收件箱/能力中心/数据/定时
 *   任务/远程/统计），侧栏始终是「新对话 + 会话列表（置顶/项目/任务）」；
 *   图标栏只切换主区页面。再点当前分区图标 = 收合/展开侧栏（IDEA 工具窗
 *   按钮语义），chrome 条上的折叠按钮等价。
 * - 折叠：aside 宽度收拢 + 内层平移（沿用原有 300ms 曲线）。
 */

type CloneThreadShellProps = {
  children: ReactNode;
  railClassName?: string | undefined;
  collapsed?: boolean | undefined;
  onCollapsedChange?: ((value: boolean) => void) | undefined;
  /** 全局搜索受控开合：搜索按钮在 chrome 条 */
  searchOpen?: boolean | undefined;
  onSearchOpenChange?: ((value: boolean) => void) | undefined;
  mobileSidebarOpen?: boolean | undefined;
  onMobileSidebarOpenChange?: ((value: boolean) => void) | undefined;
  /** 受控一级分区（图标栏 id，同 activeMenu 语义）：宿主据此切换主区视图 */
  activeMenu?: string | undefined;
  onActiveMenuChange?: ((value: string) => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
  sheetTitle?: ReactNode | undefined;
  /** 能力中心分段的受控语义（侧边栏子导航 ↔ 主区 MarketplaceView 同源） */
  hubSection?: MarketplaceSection | undefined;
  onHubSectionChange?: ((section: MarketplaceSection) => void) | undefined;
  /** 侧边栏「管理」分段 → 宿主把主区直落到对应管理分段 */
  onOpenHubManage?: ((tab: MarketplaceManageTab) => void) | undefined;
  /** 数据分区：知识库清单由主区 LibraryView 上报（base 中转），纯受控 */
  libraryKbs?: KnowledgeBase[] | null;
  /** 当前选中空间（null = 一级页「全部文档」） */
  libraryActiveKbId?: string | null;
  onLibrarySelect?: ((kbId: string | null) => void) | undefined;
  /** chrome 条会话信息簇（标题/工作区徽章/更多）：桌面端聊天视图由 base 注入，
   *  内容区不再叠一条会话 header */
  headerInfo?: ReactNode | undefined;
  /** chrome 条右上按钮簇（终端/快速查看/面板开关）：聊天视图由 base 注入 */
  actions?: ReactNode | undefined;
};

/** 分区是否配了侧栏内容（其余分区侧栏整体收起，主区浮层全圆角占满） */
function sectionHasSidebar(id: string): boolean {
  return (
    id === "" ||
    id === "inbox" ||
    id === "automation" ||
    id === "connector" ||
    id === "files"
  );
}

/** 侧边栏宽度拖拽调节的持久化键（存 px 整数；无值 = 默认 18.25rem 栏宽，
 *  rem 基准跟随全局字号缩放，拖过之后按用户选定的 px 固定）与上下限 */
const RAIL_WIDTH_KEY = "ui.sidebar-width";
const RAIL_MIN_WIDTH = 260;
const RAIL_MAX_WIDTH = 420;

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
  sheetTitle,
  hubSection,
  onHubSectionChange,
  onOpenHubManage,
  libraryKbs,
  libraryActiveKbId,
  onLibrarySelect,
  headerInfo,
  actions,
}) => {
  const t = useT();
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  const [internalMobileOpen, setInternalMobileOpen] = useState(false);
  // 受控时（宿主按选中项切换主区视图）内部不持有，见 collapsed 同款模式。
  // 图标栏分区 id 与 activeMenu 同空间（"" = 首页/聊天）。
  const [internalActiveMenu, setInternalActiveMenu] = useState<string>("");
  const menuControlled = activeMenu !== undefined;
  const currentMenu = activeMenu ?? internalActiveMenu;
  const setActiveMenu = (value: string) => {
    if (!menuControlled) setInternalActiveMenu(value);
    onActiveMenuChange?.(value);
  };
  // 红绿灯避让只在 macOS 桌面端（Electron）成立：isMacPlatform() 只看 UA，
  // 网页在 mac 浏览器里打开时同样为 true，但无窗口 chrome，不必让位
  const desktop = isDesktop();
  const macDesktop = desktop && isMacPlatform();
  // 项目分组的展开状态提升到 shell：分区头的「展开全部/收起全部」按钮与
  // 列表共用；移动会话成功后据此自动展开目标组
  const [projOpenDirs, setProjOpenDirs] = useState<Set<string>>(
    () => new Set(),
  );
  // 会话移动成功：把目标目录的组展开。展开状态提升在 shell 层，与
  // 「展开全部」按钮共用
  useEffect(() => {
    const onMoved = (event: Event) => {
      const detail = (
        event as CustomEvent<{ cwd?: string; projectId?: string }>
      ).detail;
      if (!detail?.cwd) return;
      const key = projectGroupKey(detail.projectId, detail.cwd);
      setProjOpenDirs((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    };
    window.addEventListener("pi:session-moved", onMoved as EventListener);
    return () =>
      window.removeEventListener("pi:session-moved", onMoved as EventListener);
  }, []);
  // 侧栏的「新对话」常驻入口：与列表同款的 fluid hover（单行独立作用域）
  const newChatRef = useRef<HTMLDivElement>(null);
  const newChatHover = useFluidHover(newChatRef);
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

  // 新对话：与侧栏「新对话」按钮同走 aui.threads 开新会话
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (matchesShortcut(event, newThread)) {
        event.preventDefault();
        setActiveMenu("");
        // 动作驱动清"最近打开的会话"指针：刷新后不回旧会话（2026-09-22 修复）
        clearLastThread();
        // 新对话沿用最近选择的项目空间（没有/已失效则留空；与侧栏/命令面板同语义）
        void restoreLastUsedWorkspace().catch(() => {});
        void aui.threads.switchToNewThread();
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [aui, newThread]);

  // 图标栏一级分区切换：任何导航都先退出搜索（覆盖层不随主区卸载）。
  // 再点当前分区图标不做任何事——侧栏（会话列表）全局常驻，不该因为
  // 重复点击而消失；收合只由 chrome 条的折叠按钮承担
  const handleRailSelect = (id: string) => {
    setSearchOpen(false);
    if (id === currentMenu) return;
    setActiveMenu(id);
  };

  // 侧栏点会话 / 外部通知回焦 / 分叉打开等都会推移 mainThreadId：搜索页随
  // 会话切换一起退场
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
  // 宽度的 React 状态与 localStorage。把手挂在与 aside 相邻的 0 宽锚点上
  // （横跨分界线，不被任何 overflow-hidden 裁剪）。
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

  const inboxCounts = useInboxCounts();
  const inboxBadge = inboxBadgeCount(inboxCounts);

  // 移动端抽屉（<md 无图标栏）沿用一维菜单：分区项 + 底部设置/统计
  const mobileMenuItems: {
    id: string;
    label: string;
    icon: ComponentType<{ className?: string }>;
    isNew?: boolean;
  }[] = [
    {
      id: "new",
      label: t("chat.sidebar.newChat"),
      icon: SquarePen,
      isNew: true,
    },
    { id: "", label: t("chat.sidebar.home"), icon: HouseIcon },
    {
      id: "inbox",
      label: t("inbox.sidebar"),
      icon: InboxIcon,
    },
    { id: "connector", label: t("chat.sidebar.hub"), icon: BlocksIcon },
    { id: "files", label: t("chat.sidebar.data"), icon: LibraryIcon },
    { id: "automation", label: t("chat.sidebar.schedule"), icon: ZapIcon },
    // 远程网页端不显示本入口：它自己就是远程会话，管理远程/IM 是桌面端的事
    ...(isRemoteMode()
      ? []
      : [{ id: "remote", label: t("chat.sidebar.remote"), icon: MonitorSmartphoneIcon }]),
  ];

  const handleMobileMenuClick = (item: (typeof mobileMenuItems)[number]) => {
    // 搜索是覆盖在主区之上的独立一页：任何侧栏导航都先退出搜索，否则覆盖层
    // 会一直盖住目标页（点了「自动化」看着还停在搜索页）
    setSearchOpen(false);
    // 「新对话」是常驻入口：点击即取消其他菜单项的选中态。本 onClick 与外层
    // ThreadListPrimitive.New 的框架切换是合成关系、两者都会跑；这里动作驱动
    // 清"最近打开的会话"指针，刷新后不再回旧会话（2026-09-22 修复）
    if (item.isNew) {
      setActiveMenu("");
      clearLastThread();
      void restoreLastUsedWorkspace().catch(() => {});
      return;
    }
    setActiveMenu(item.id);
    // 菜单项切换的是主区页面：移动端抽屉里点完收起，让视图可见
    setMobileOpen(false);
  };

  // 侧栏的新对话按钮。本 onClick 与外层
  // ThreadListPrimitive.New 的框架切换是合成关系、两者都会跑：动作驱动清
  // "最近打开的会话"指针（刷新后不回旧会话）并沿用最近项目空间
  const newChatButton = (
    <Button
      variant="ghost"
      className={cn(
        // hover 反馈交给 FluidHoverHighlight：压掉 ghost 变体自带的 hover 底色
        "h-9 w-full text-sm justify-between gap-2 rounded-lg px-3 font-medium hover:bg-transparent dark:hover:bg-transparent group",
      )}
      aria-label={t("chat.sidebar.newChat")}
      onClick={() => {
        clearLastThread();
        void restoreLastUsedWorkspace().catch(() => {});
      }}
    >
      <div className="flex shrink-0 items-center gap-2.5">
        <PlusIcon className="size-4 shrink-0" />
        <span className="whitespace-nowrap">{t("chat.sidebar.newChat")}</span>
      </div>
    </Button>
  );

  // 二级侧边栏的显隐：收件箱 / 远程 / 使用统计等分区没有侧栏内容，侧栏
  // 整体收起（宽度 0，与手动折叠同一条动画曲线），主区浮层全圆角占满——
  // 参考实现同款行为：不是每个分区都配侧栏。手动折叠状态只在有内容的分区生效
  const sidebarShown = sectionHasSidebar(currentMenu) && !sidebarCollapsed;

  return (
    // 整窗灰底（--shell-veil）：不透明时取 --muted 实色；窗口材质（高斯
    // 模糊/Mica）开启时变 55% 半透明，系统材质从灰环透出（globals.css）
    <div data-shell-root className="relative flex h-full w-full flex-col overflow-hidden">
      {/* 窗体 chrome 条（44px）：整条拖拽区，只放窗口级导航/搜索/折叠，
          Windows 自绘三键浮在右端。页面自己的 Header（标题/面包屑/工具条/
          搜索输入）留在下方内容卡里，不再被吸到窗口顶部。 */}
      <div
        data-drag-region={desktop ? "deep" : undefined}
        style={
          railW === null
            ? undefined
            : ({ "--rail-w": `${railW}px` } as CSSProperties)
        }
        className="hidden h-11 shrink-0 items-center md:flex"
      >
        <div
          className={cn(
            "flex shrink-0 items-center",
            sidebarShown && "md:w-[calc(3.5rem+var(--rail-w,18.25rem))]",
          )}
        >
          <div
            className={cn(
              "hidden shrink-0 items-center gap-1 md:flex",
              macDesktop ? "pl-[84px]" : "pl-3",
            )}
          >
            <ThreadNavButtons />
            <TooltipIconButton
              variant="ghost"
              size="icon"
              tooltip={sidebarCollapsed ? t("chat.sidebar.expand") : t("chat.sidebar.collapse")}
              side="bottom"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="size-8"
            >
              <Panel2Icon className="size-4" />
            </TooltipIconButton>
          </div>
        </div>
        {/* 会话信息簇（标题/工作区徽章/更多）：宽度受控的左簇让位后，
            正好起始于内容卡片的左缘（与主区标题对齐）。layout 动画：侧栏
            收合/展开时左簇宽度瞬变、标题若跟着瞬移会"闪"一下——这里用
            与侧栏 width 过渡同一条 300ms 曲线把标题滑到位 */}
        <motion.div
          layout
          transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
          className="flex min-w-0 items-center gap-1"
        >
          {headerInfo}
        </motion.div>
        {/* 页面视图的页头槽位：收件箱/自动化/资料库/插件/远程把自己的页头
            （标题、返回、刷新、工具条）portal 到这里——内容区不再自画 header */}
        {currentMenu !== "" ? (
          <motion.div
            layout
            transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
            className="flex min-w-0 flex-1 items-center gap-1"
          >
            <div
              data-slot="page-header-actions"
              className="flex min-w-0 flex-1 items-center gap-1"
            />
          </motion.div>
        ) : null}
        {/* 右端留 16px：避免按钮贴住窗口圆角；Windows 三键浮层固定在
            right-16，占位贴齐同一内距，三键与右侧按钮组不叠 */}
        <div className="ml-auto flex shrink-0 items-center gap-1 pr-4">
          {actions}
          {/* Windows 自绘三键：浮层钉在窗口右上（fixed top-0 right-16px），
              原位占位 100px 落在 chrome 条右端；mac/网页端组件自身不渲染 */}
          <WindowControls right={16} />
        </div>
      </div>

      {/* 图标栏 + 内容浮层：距窗右/底内缩 8px 露出灰底 */}
      <div className="flex min-h-0 flex-1 max-md:pb-0 md:pr-2 md:pb-2">
        <NavRail
          active={currentMenu}
          inboxBadge={inboxBadge}
          onSelect={handleRailSelect}
          onOpenSettings={() => {
            setSearchOpen(false);
            onOpenSettings?.();
          }}
        />

        {/* 内容浮层：侧栏 + 主区共用同一个圆角裁切容器。父层直接
            rounded-3xl + overflow-hidden，透明窗口/材质模式下圆角也成立 */}
        <div className="relative flex min-w-0 flex-1 md:overflow-hidden md:rounded-3xl">
          <aside
            ref={asideRef}
            id={railPanelId}
            aria-label={t("chat.sidebar.aria")}
            data-shell-sidebar
            style={
              railW === null
                ? undefined
                : ({ "--rail-w": `${railW}px` } as CSSProperties)
            }
            className={cn(
              // 折叠动画 = aside 宽度（推挤主区）+ 内层整列 transform（内容平移
              // 出屏）。内层固定栏宽不参与重排：会话再多，行布局在动画期间完全
              // 静止，只有 aside 的盒宽和合成器上的 transform 在动。
              // 拖动中的可见宽度由 ElasticRailHandle 直接写内联 width；松手
              // 弹簧落定后提交 railW，再把内联值交还给类/变量以便折叠动画。
              // border-r = 侧栏与主区的分割线（参考实现同款 1px border-default）
              "relative hidden h-full shrink-0 flex-col overflow-hidden border-r border-border/60 bg-background md:flex",
              "transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
              railClassName,
              sidebarShown ? "w-[var(--rail-w,18.25rem)]" : "w-0 border-r-0",
            )}
          >
            <div
              ref={railInnerRef}
              className={cn(
                "flex h-full w-[var(--rail-w,18.25rem)] shrink-0 flex-col",
                "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
                sidebarShown ? "translate-x-0" : "-translate-x-full",
              )}
            >
              {/* 侧栏内容随分区切换：旧内容瞬间换新会显得生硬，这里按
                  currentMenu 做一次轻量淡入（MotionConfig 全局已尊重减弱动效） */}
              <motion.div
                key={currentMenu}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="flex min-h-0 flex-1 flex-col"
              >
              {/* 侧栏内容随分区切换（一个侧栏槽位）：
                  - 首页 = 新对话 + 会话列表；
                  - 能力中心/数据 = 各自的分区子导航（HubSidebar / DataSidebar）；
                  - 收件箱/定时任务 = 页面自己的列表列 portal 到
                    data-slot="section-sidebar" 槽位里，主区只留详情 */}
              {currentMenu === "" ? (
                <>
                  {/* 侧栏头部（Raccoon 式）：品牌 Logo + 名称，右侧搜索入口 */}
                  <div className="flex h-11 shrink-0 items-center gap-1 px-3">
                    <Logo />
                    <TooltipIconButton
                      variant="ghost"
                      size="icon"
                      tooltip={t("chat.sidebar.search")}
                      side="bottom"
                      onClick={() => setSearchOpen(true)}
                      className="ml-auto size-8"
                    >
                      <SearchIcon className="size-4" />
                    </TooltipIconButton>
                  </div>
                  <div className="shrink-0 px-3 pt-1">
                    <div
                      ref={newChatRef}
                      className="relative flex flex-col gap-0.5"
                      {...newChatHover.handlers}
                    >
                      <FluidHoverHighlight hover={newChatHover} className="rounded-lg" />
                      <FluidHoverRow
                        registerItem={newChatHover.registerItem}
                        index={0}
                      >
                        <ThreadListPrimitive.New asChild>
                          {newChatButton}
                        </ThreadListPrimitive.New>
                      </FluidHoverRow>
                    </div>
                  </div>

                  {/* 会话列表独立边界：列表崩了只塌这一块，菜单/设置按钮照常可用，
                      用户仍能开新对话、切管理页（ErrorBoundary 里已自动上报）。
                      点会话行即切回对话并清掉页面选中（clearMenuAfterNavigation） */}
                  <ErrorBoundary label="会话列表">
                    <ThreadListRoot
                      onClick={clearMenuAfterNavigation}
                      className={cn(
                        // min-h-0：flex-1 子项默认 min-height:auto，列表内容长时会撑高
                        // 整个 aside 列、把上方菜单顶出去——溢出滚动必须锁在本容器内。
                        // 恒为整栏宽：折叠动画期间列表不参与重排（外层整列 transform 出屏）
                        "relative min-h-0 w-full flex-1 overflow-y-auto p-3",
                      )}
                    >
                      <ThreadListItems
                        aria-hidden={!sidebarShown}
                        inert={!sidebarShown}
                        openDirs={projOpenDirs}
                        onOpenDirsChange={setProjOpenDirs}
                      />
                    </ThreadListRoot>
                  </ErrorBoundary>
                </>
              ) : currentMenu === "connector" ? (
                <HubSidebar
                  active={hubSection ?? "plugins"}
                  onSelect={(section) => onHubSectionChange?.(section)}
                  onOpenManage={(tab) => onOpenHubManage?.(tab)}
                />
              ) : currentMenu === "files" ? (
                <DataSidebar
                  kbs={libraryKbs ?? null}
                  activeKbId={libraryActiveKbId ?? null}
                  onSelect={(kbId) => onLibrarySelect?.(kbId)}
                />
              ) : (
                // 收件箱/定时任务：页面把自己的列表列 portal 进来
                <div
                  data-slot="section-sidebar"
                  className="flex min-h-0 w-full flex-1 flex-col overflow-hidden"
                />
              )}
              </motion.div>
            </div>
          </aside>

          {/* 分界锚点：0 宽定位点 = 侧栏右缘。把手以它为中心横跨两侧
              （自身 absolute -translate-x-1/2），不在任何 overflow-hidden
              内，命中带与悬停胶囊都不会被裁剪 */}
          <div className="relative z-30 w-0 shrink-0">
            {sidebarShown && (
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

          {/* 主区浮层：白底、右缘 24px 圆角；侧栏折叠后左缘也圆角。
              分割线由侧边栏的 border-r 承担，主区不再自画 */}
          <div
            data-shell-card
            className={cn(
              "bg-background relative min-w-0 flex-1 overflow-hidden",
              sidebarShown ? "md:rounded-r-3xl" : "md:rounded-3xl",
            )}
          >
            {children}
            {searchOpen ? (
              // 搜索页沿用与资料库/自动化一致的 Header（含导航与折叠按钮），
              // 不再自己造一条顶栏。
              // 搜索页独立边界：崩了显示占位卡（已自动上报），用户点「关闭」
              // 复位 searchOpen；否则 open 卡在 true，⌘K 重开也是死白屏
              <ErrorBoundary
                label="全局搜索"
                fallback={() => (
                  <div className="absolute inset-x-0 top-12 bottom-0 z-40 flex items-center justify-center bg-background">
                    <div className="text-muted-foreground flex flex-col items-center gap-2 text-xs">
                      搜索出了点问题
                      <Button size="sm" variant="outline" onClick={() => setSearchOpen(false)}>
                        关闭
                      </Button>
                    </div>
                  </div>
                )}
              >
                <div className="absolute inset-x-0 top-12 bottom-0 z-40 flex bg-background">
                  <GlobalSearchView
                    open
                    onOpenChange={setSearchOpen}
                    onNewThread={() => {
                      setSearchOpen(false);
                      setActiveMenu("");
                      // 同活动栏入口：动作驱动清指针；新对话沿用最近选择的项目空间
                      clearLastThread();
                      void restoreLastUsedWorkspace().catch(() => {});
                      void aui.threads.switchToNewThread();
                    }}
                  />
                </div>
              </ErrorBoundary>
            ) : null}
          </div>
        </div>
      </div>

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

          {/* 移动端的分区菜单（<md 无图标栏，沿用一维列表） */}
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
              {mobileMenuItems.map((item, index) => {
                const Icon = item.icon;
                const button = (
                  <Button
                    variant="ghost"
                    className={cn(
                      "h-8 w-full justify-start gap-2 rounded-md px-2.5 text-sm font-normal hover:bg-transparent dark:hover:bg-transparent",
                      !item.isNew && !searchOpen && currentMenu === item.id && "bg-selected",
                    )}
                    onClick={() => handleMobileMenuClick(item)}
                    aria-label={item.label}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="whitespace-nowrap">{item.label}</span>
                    {item.id === "inbox" ? (
                      <span className="border-border/70 text-muted-foreground -ml-1 shrink-0 rounded border px-1 py-px text-[9px] leading-3 font-medium tracking-wide">
                        Beta
                      </span>
                    ) : null}
                    {item.id === "inbox" && inboxBadge > 0 ? (
                      <span className="bg-primary text-primary-foreground ml-auto rounded-full px-1.5 py-0.5 text-[10px] leading-none tabular-nums">
                        {inboxBadge > 99 ? "99+" : inboxBadge}
                      </span>
                    ) : null}
                  </Button>
                );

                return (
                  <FluidHoverRow
                    key={`${item.id}-${index}`}
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

          <ErrorBoundary label="会话列表">
            <div
              className="relative flex-1 overflow-y-auto p-3"
              onClick={closeMobileSidebarAfterNavigation}
            >
              <ThreadList
                openDirs={projOpenDirs}
                onOpenDirsChange={setProjOpenDirs}
              />
            </div>
          </ErrorBoundary>

          {/* 移动端底部固定：设置 + 远程 + 使用统计（远程模式下隐藏） */}
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
              <FluidHoverRow registerItem={mobileSettingsHover.registerItem} index={1}>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("chat.sidebar.remote")}
                  title={t("chat.sidebar.remote")}
                  className={cn(
                    "shrink-0 font-normal hover:bg-transparent dark:hover:bg-transparent",
                    currentMenu === "remote" && "bg-selected",
                  )}
                  onClick={() => {
                    setActiveMenu(currentMenu === "remote" ? "" : "remote");
                    setMobileOpen(false);
                  }}
                >
                  <MonitorSmartphoneIcon className="size-4 shrink-0" />
                </Button>
              </FluidHoverRow>
              <FluidHoverRow registerItem={mobileSettingsHover.registerItem} index={2}>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("chat.sidebar.usageStats")}
                  title={t("chat.sidebar.usageStats")}
                  className={cn(
                    "shrink-0 font-normal hover:bg-transparent dark:hover:bg-transparent",
                    currentMenu === "usage" && "bg-selected",
                  )}
                  onClick={() => {
                    setActiveMenu(currentMenu === "usage" ? "" : "usage");
                    setMobileOpen(false);
                  }}
                >
                  <ChartColumnIcon className="size-4 shrink-0" />
                </Button>
              </FluidHoverRow>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* 移动会话对话框全局挂载一次：行菜单把请求投进模块级 store */}
      <MoveSessionDialogHost />
      {/* 交接至新对话：顶栏「更多」与侧边栏行菜单共用同一对话框 */}
      <HandoffDialogHost />
    </div>
  );
};
