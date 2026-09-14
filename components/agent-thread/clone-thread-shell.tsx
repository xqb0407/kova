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
import { matchesShortcut, useShortcuts } from "@/lib/shortcuts";
import { useFluidHover } from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import { FluidHoverRow } from "@/components/fluid-hover-row";
import { Logo } from "./header";
import { ThreadListPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import {
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FolderIcon,
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
  type FC,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Kbd, KbdGroup } from "../ui/kbd";

type CloneThreadShellProps = {
  children: ReactNode;
  railClassName?: string | undefined;
  collapsed?: boolean | undefined;
  onCollapsedChange?: ((value: boolean) => void) | undefined;
  mobileSidebarOpen?: boolean | undefined;
  onMobileSidebarOpenChange?: ((value: boolean) => void) | undefined;
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
  onOpenSettings,
  headerContent,
  sheetTitle,
}) => {
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  const [internalMobileOpen, setInternalMobileOpen] = useState(false);
  // 「新对话」是常驻入口而非可选中项，不参与高亮；初始无选中
  const [activeMenu, setActiveMenu] = useState<string>("");
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
  const settingsHover = useFluidHover(settingsRef);
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
        void aui.threads.switchToNewThread();
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [aui, newThread]);

  const handleMenuClick = (item: (typeof menuItems)[number]) => {
    // 「新对话」是常驻入口：点击即取消其他菜单项的选中态
    if (item.isNew) {
      setActiveMenu("");
      return;
    }
    // 搜索走命令面板，其余菜单项保持高亮切换
    if (item.id === "search") {
      setSearchOpen(true);
      return;
    }
    setActiveMenu(item.id);
  };

  // A controlled value means the caller renders the chrome that drives it, so
  // the shell omits its own toggle / trigger and forwards changes instead.
  const collapsedControlled = collapsed !== undefined;
  const mobileControlled = mobileSidebarOpen !== undefined;

  const sidebarCollapsed = collapsed ?? internalCollapsed;
  const mobileOpen = mobileSidebarOpen ?? internalMobileOpen;

  const setSidebarCollapsed = (value: boolean) => {
    if (!collapsedControlled) setInternalCollapsed(value);
    onCollapsedChange?.(value);
  };
  const setMobileOpen = (open: boolean) => {
    if (!mobileControlled) setInternalMobileOpen(open);
    onMobileSidebarOpenChange?.(open);
  };

  const closeMobileSidebarAfterNavigation = (
    event: MouseEvent<HTMLDivElement>,
  ) => {
    if (!(event.target instanceof Element)) return;
    if (
      event.target.closest(
        '[data-slot="aui_thread-list-item-trigger"], [data-slot="aui_thread-list-new"]',
      )
    ) {
      setMobileOpen(false);
    }
  };

  const menuItems = [
    { id: "new", label: "新对话", icon: PlusIcon, isNew: true },
    {
      id: "search",
      label: "搜索",
      icon: SearchIcon,
      kbd: (
        <KbdGroup>
          <Kbd>Ctrl</Kbd>
          <span>+</span>
          <Kbd>P</Kbd>
        </KbdGroup>
      ),
    },
    { id: "automation", label: "自动化", icon: ZapIcon },
    { id: "connector", label: "插件市场", icon: PlugIcon },
  ];

  return (
    // bg-background
    <div className="relative flex h-full w-full overflow-hidden  ">
      <aside
        className={cn(
          "bg-muted/55 hidden h-full shrink-0 flex-col overflow-hidden border-r transition-[width] duration-200 md:flex",
          railClassName,
          sidebarCollapsed ? "w-0" : "w-65",
        )}
      >
        {/* header */}
        <div
          data-tauri-drag-region={isTauri() ? "deep" : undefined}
          className={cn(
            "flex h-12 shrink-0 items-center overflow-hidden px-2 gap-2",
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
            const inner =
              headerContent !== undefined
                ? headerContent
                : !sidebarCollapsed && (
                    <span className="ml-2 truncate text-sm font-medium">
                      Chats
                    </span>
                  );
            if (isMacPlatform()) return inner;
            // Windows/网页：Logo 靠左，折叠按钮靠右（窗口控制在主 Header 右上角）
            return (
              <>
                {!sidebarCollapsed && <Logo />}
                <div className="ml-auto flex items-center gap-1">{inner}</div>
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
                    sidebarCollapsed && "w-8 justify-center px-2",
                    !item.isNew && activeMenu === item.id && "bg-selected",
                  )}
                  onClick={() => handleMenuClick(item)}
                  aria-label={item.label}
                >
                  <div className="flex items-center gap-1 shrink-0">
                    <Icon className="size-4 shrink-0" />
                    {!sidebarCollapsed && (
                      <span className="whitespace-nowrap">{item.label}</span>
                    )}
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
        {!sidebarCollapsed && (
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
        )}

        <ThreadListRoot
          className={cn(
            // min-h-0：flex-1 子项默认 min-height:auto，列表内容长时会撑高
            // 整个 aside 列、把上方 tabs 行顶上去——溢出滚动必须锁在本容器内
            "relative min-h-0 flex-1 transition-[padding,width] duration-200",
            sidebarCollapsed
              ? "w-12 overflow-hidden px-2 pt-1"
              : "w-65 overflow-y-auto p-3",
          )}
        >
          {activeTab === "tasks" && hasThreads && (
            <ThreadListItems
              aria-hidden={sidebarCollapsed}
              inert={sidebarCollapsed}
              className={cn(
                "transition-[opacity,transform] duration-150",
                sidebarCollapsed
                  ? "pointer-events-none opacity-0"
                  : "translate-x-0 opacity-100",
              )}
            />
          )}
          {activeTab === "projects" && !sidebarCollapsed && (
            <ProjectListItems
              openDirs={projOpenDirs}
              onOpenDirsChange={setProjOpenDirs}
            />
          )}
        </ThreadListRoot>

        {/* 底部固定的设置按钮（远程模式下隐藏：模型/技能/远程配置均为桌面专属） */}
        {!isRemoteMode() && (
          <div
            ref={settingsRef}
            className="relative shrink-0 p-2"
            {...settingsHover.handlers}
          >
            <FluidHoverHighlight hover={settingsHover} className="rounded-md" />
            <FluidHoverRow registerItem={settingsHover.registerItem} index={0}>
              <Button
                variant="ghost"
                className="h-8 w-full justify-start gap-2 rounded-md px-2.5 text-sm font-normal hover:bg-transparent dark:hover:bg-transparent"
                onClick={() => onOpenSettings?.()}
              >
                <SettingsIcon className="size-4 shrink-0" />
                {!sidebarCollapsed && (
                  <span className="whitespace-nowrap">设置</span>
                )}
              </Button>
            </FluidHoverRow>
          </div>
        )}
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
                      !item.isNew && activeMenu === item.id && "bg-selected",
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
                  onSelect={() => setSearchOpen(false)}
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
