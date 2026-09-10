"use client";

import {
  ThreadList,
  ThreadListItems,
  ThreadListRoot,
  ProjectListItems,
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
import { Logo } from "./header";
import { ThreadListPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import {
  MenuIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  SearchIcon,
  ZapIcon,
  PlugIcon,
  PlusIcon,
  SettingsIcon,
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
  const [activeMenu, setActiveMenu] = useState<string>("new");
  const [activeTab, setActiveTab] = useState<string>("tasks");
  const [searchOpen, setSearchOpen] = useState(false);
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const aui = useAui();

  // ⌘K / Ctrl+K 全局唤起搜索命令面板
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const handleMenuClick = (item: (typeof menuItems)[number]) => {
    if (item.isNew) return;
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
                    activeMenu === item.id && "bg-muted",
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

        {/* Tabs 分段器 */}
        {!sidebarCollapsed && (
          <div className="shrink-0 px-3 pt-2 flex justify-between items-center w-full">
            <Tabs
              value={activeTab}
              className={"w-full"}
              onValueChange={setActiveTab}
            >
              <TabsList className={"w-full"} >
                <TabsTrigger value="tasks" className="flex-1 text-xs ">
                  任务
                </TabsTrigger>
                <TabsTrigger value="projects" className="flex-1 text-xs">
                  项目
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        )}

        <ThreadListRoot
          className={cn(
            "relative flex-1 transition-[padding,width] duration-200",
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
          {activeTab === "projects" && !sidebarCollapsed && <ProjectListItems />}
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
                      activeMenu === item.id && "bg-muted",
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

          {/* 移动端 Tabs 分段器 */}
          <div className="shrink-0 px-4 pt-2">
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              className="w-full"
            >
              <TabsList className="w-full">
                <TabsTrigger value="tasks" className="flex-1 text-xs">
                  任务
                </TabsTrigger>
                <TabsTrigger value="projects" className="flex-1 text-xs">
                  项目
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div
            className="relative flex-1 overflow-y-auto p-3"
            onClick={closeMobileSidebarAfterNavigation}
          >
            {activeTab === "tasks" && <ThreadList />}
            {activeTab === "projects" && (
              <ThreadListRoot className="relative flex-1 overflow-y-auto p-3">
                <ProjectListItems />
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
                        {item?.title ?? "New Chat"}
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
