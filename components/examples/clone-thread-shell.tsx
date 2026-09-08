"use client";

import {
  ThreadList,
  ThreadListItems,
  ThreadListRoot,
} from "@/components/assistant-ui/elements/thread-list.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import {
  MenuIcon,
  PanelLeftIcon,
  SearchIcon,
  ZapIcon,
  PlugIcon,
  PlusIcon,
  ChevronDownIcon,
  FolderIcon,
  FileIcon,
  FolderOpen,
  PinIcon,
  ArchiveIcon,
  EllipsisIcon,
} from "lucide-react";
import { useState, type FC, type MouseEvent, type ReactNode } from "react";

type CloneThreadShellProps = {
  children: ReactNode;
  railClassName?: string | undefined;
  collapsed?: boolean | undefined;
  onCollapsedChange?: ((value: boolean) => void) | undefined;
  mobileSidebarOpen?: boolean | undefined;
  onMobileSidebarOpenChange?: ((value: boolean) => void) | undefined;
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
  headerContent,
  sheetTitle,
}) => {
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  const [internalMobileOpen, setInternalMobileOpen] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string>("new");
  const [activeTab, setActiveTab] = useState<string>("tasks");
  const [searchQuery, setSearchQuery] = useState("");
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);

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

  // 示例项目数据
  const projectsData = [
    {
      id: "project-1",
      name: "前端项目",
      items: [
        { id: "item-1", name: "页面设计" },
        { id: "item-2", name: "组件开发" },
        { id: "item-3", name: "性能优化" },
      ],
    },
    {
      id: "project-2",
      name: "后端项目",
      items: [
        { id: "item-4", name: "API设计" },
        { id: "item-5", name: "数据库优化" },
      ],
    },
  ];

  // 项目树组件
  const ProjectTree = () => {
    const [openProjects, setOpenProjects] = useState<string[]>([]);
    const [selectedItem, setSelectedItem] = useState<string | null>(null);

    const toggleProject = (projectId: string) => {
      setOpenProjects((prev) =>
        prev.includes(projectId)
          ? prev.filter((id) => id !== projectId)
          : [...prev, projectId],
      );
    };

    return (
      <div className="flex flex-col gap-0.5">
        {projectsData.map((project) => {
          const isOpen = openProjects.includes(project.id);
          return (
            <Collapsible
              key={project.id}
              open={isOpen}
              onOpenChange={() => toggleProject(project.id)}
            >
              <CollapsibleTrigger
                className="w-full"
                render={
                  <Button
                    variant="ghost"
                    className="h-8 justify-start group gap-2 px-2.5 text-sm font-normal hover:bg-muted !translate-y-0 [&_button]:!translate-y-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:bg-transparent data-[state=open]:!bg-transparent data-[state=open]:hover:bg-muted active:!bg-transparent aria-expanded:!bg-transparent aria-expanded:hover:bg-muted"
                  >
                    {isOpen ? (
                      <FolderOpen className="size-4 shrink-0" />
                    ) : (
                      <FolderIcon className="size-4 shrink-0" />
                    )}
                    <div className="flex flex-1 justify-between items-center">
                      <span className="truncate">{project.name}</span>
                      <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            // Add your action here
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.stopPropagation();
                              // Add your action here
                            }
                          }}
                          className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground h-6 w-6 cursor-pointer"
                        >
                          <EllipsisIcon className="size-4" />
                        </div>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            // Add your action here
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.stopPropagation();
                              // Add your action here
                            }
                          }}
                          className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground h-6 w-6 cursor-pointer"
                        >
                          <ArchiveIcon className="size-4" />
                        </div>
                      </div>
                    </div>
                  </Button>
                }
              />
              <CollapsibleContent className="overflow-hidden grid transition-all duration-500 ease-in-out">
                <div>
                  {project.items.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => setSelectedItem(item.id)}
                      className={cn(
                        "group w-full h-8 flex items-center rounded-md justify-start gap-2 px-2.5 text-sm font-normal hover:bg-muted cursor-pointer",
                        selectedItem === item.id && "bg-muted",
                      )}
                    >
                      <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        <Button
                          variant="ghost"
                          size={"icon-xs"}
                          className={"cursor-pointer"}
                        >
                          <PinIcon className="size-4" />
                        </Button>
                      </div>
                      <div className="flex-1 flex justify-between items-center">
                        <span className="truncate">{item.name}</span>
                        <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          <Button
                            variant="ghost"
                            size={"icon-xs"}
                            className={"cursor-pointer"}
                          >
                            <ArchiveIcon className="size-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    );
  };

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      <aside
        className={cn(
          "bg-muted/55 hidden h-full shrink-0 flex-col overflow-hidden border-r transition-[width] duration-200 md:flex",
          railClassName,
          sidebarCollapsed ? "w-0" : "w-65",
        )}
      >
        <div className="flex h-12 shrink-0 items-center overflow-hidden px-2">
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
          {headerContent !== undefined
            ? headerContent
            : !sidebarCollapsed && (
                <span className="ml-2 truncate text-sm font-medium">Chats</span>
              )}
        </div>

        {/* 固定的四个菜单项 */}
        <div className="shrink-0 px-2 pt-2">
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
                  onClick={() => !item.isNew && setActiveMenu(item.id)}
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
          <div className="shrink-0 px-3 pt-2">
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
              searchQuery={activeMenu === "search" ? searchQuery : ""}
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
          {activeTab === "projects" && !sidebarCollapsed && <ProjectTree />}
        </ThreadListRoot>
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
                    onClick={() => !item.isNew && setActiveMenu(item.id)}
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

              {/* 移动端搜索输入框 */}
              {activeMenu === "search" && (
                <div className="px-0.5 py-1">
                  <Input
                    type="search"
                    placeholder="搜索对话..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
              )}
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
            {activeTab === "projects" && <ProjectTree />}
          </div>
        </SheetContent>
      </Sheet>

      <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
};
