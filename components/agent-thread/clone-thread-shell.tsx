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
} from "lucide-react";
import {
  useEffect,
  useState,
  type FC,
  type MouseEvent,
  type ReactNode,
} from "react";

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
    { id: "search", label: "搜索", icon: SearchIcon },
    { id: "automation", label: "自动化", icon: ZapIcon },
    { id: "connector", label: "连接器", icon: PlugIcon },
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
                    <span className="ml-2 truncate text-sm font-medium">Chats</span>
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
          <div className="flex flex-col gap-0.5">
            {menuItems.map((item) => {
              const Icon = item.icon;
              const button = (
                <Button
                  key={item.id}
                  variant="ghost"
                  className={cn(
                    "hover:bg-muted h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal",
                    sidebarCollapsed && "w-8 justify-center px-2",
                    !item.isNew && activeMenu === item.id && "bg-muted",
                  )}
                  onClick={() => handleMenuClick(item)}
                  aria-label={item.label}
                >
                  <Icon className="size-4 shrink-0" />
                  {!sidebarCollapsed && (
                    <span className="whitespace-nowrap">{item.label}</span>
                  )}
                </Button>
              );

              return item.isNew ? (
                <ThreadListPrimitive.New key={item.id} asChild>
                  {button}
                </ThreadListPrimitive.New>
              ) : (
                button
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
              </Button>
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
          <div className="shrink-0 p-2">
            <Button
              variant="ghost"
              className="h-8 w-full justify-start gap-2 rounded-md px-2.5 text-sm font-normal hover:bg-muted"
              onClick={() => onOpenSettings?.()}
            >
              <SettingsIcon className="size-4 shrink-0" />
              {!sidebarCollapsed && (
                <span className="whitespace-nowrap">设置</span>
              )}
            </Button>
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
            <div className="flex flex-col gap-0.5">
              {menuItems.map((item) => {
                const Icon = item.icon;
                const button = (
                  <Button
                    key={item.id}
                    variant="ghost"
                    className={cn(
                      "hover:bg-muted h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal",
                      !item.isNew && activeMenu === item.id && "bg-muted",
                    )}
                    onClick={() => handleMenuClick(item)}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </Button>
                );

                return item.isNew ? (
                  <ThreadListPrimitive.New key={item.id} asChild>
                    {button}
                  </ThreadListPrimitive.New>
                ) : (
                  button
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
            <div className="shrink-0 border-t p-4">
              <Button
                variant="ghost"
                className="h-8 w-full justify-start gap-2 rounded-md px-2.5 text-sm font-normal hover:bg-muted"
                onClick={() => {
                  setMobileOpen(false);
                  onOpenSettings?.();
                }}
              >
                <SettingsIcon className="size-4 shrink-0" />
                <span className="whitespace-nowrap">设置</span>
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <CommandDialog open={searchOpen} onOpenChange={setSearchOpen} className="max-w-[30dvw]!">
        <Command className="w-full">
          <CommandInput placeholder="搜索对话..." />
          <CommandList>
            <CommandEmpty>没有找到结果</CommandEmpty>
            <CommandGroup heading="操作">
              <ThreadListPrimitive.New asChild>
                <CommandItem onSelect={() => setSearchOpen(false)}>
                  <PlusIcon className="size-4" />
                  <span>新对话</span>
                </CommandItem>
              </ThreadListPrimitive.New>
            </CommandGroup>
            {hasThreads && (
              <CommandGroup heading="对话">
                {threadIds.map((id) => {
                  const item = threadItems.find((t) => t.id === id);
                  return (
                    <CommandItem
                      key={id}
                      onSelect={() => {
                        aui.threads.switchToThread(id);
                        setSearchOpen(false);
                      }}
                    >
                      <MessageSquareIcon className="size-4 shrink-0" />
                      <span className="truncate">
                        {item?.title ?? "新对话"}
                      </span>
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
