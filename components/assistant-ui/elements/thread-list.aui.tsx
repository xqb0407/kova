"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderIcon,
  FolderOpenIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { piSessionCwdMap } from "@/lib/pi-thread-adapter";
import {
  openWorkspacePicker,
  pathBasename,
  useWorkspace,
} from "@/lib/workspace-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  forwardRef,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FC,
  type ReactNode,
} from "react";
import { RenameTaskDialog } from "@/components/agent-thread/rename-task-dialog";

export const ThreadList: FC = () => {
  const [search, setSearch] = useState("");
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);

  return (
    <ThreadListRoot>
      <WorkspacePicker />
      <ThreadListNew />
      {hasThreads && (
        <ThreadListSearch value={search} onValueChange={setSearch} />
      )}
      <ThreadListItems searchQuery={hasThreads ? search : ""} />
    </ThreadListRoot>
  );
};

/** 当前 workspace 选择器：点击弹出系统目录选择框，选中后作为新会话的 cwd */
const WorkspacePicker: FC = () => {
  const workspace = useWorkspace();
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    setBusy(true);
    try {
      await openWorkspacePicker();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="ghost"
      data-slot="aui_thread-list-workspace"
      onClick={pick}
      disabled={busy}
      title={workspace ?? undefined}
      className="h-8 w-full justify-start gap-2 rounded-md px-2.5 text-sm font-normal"
    >
      <FolderOpenIcon
        data-slot="aui_thread-list-workspace-icon"
        className="size-4 shrink-0"
      />
      <span
        data-slot="aui_thread-list-workspace-label"
        className="min-w-0 flex-1 truncate text-start"
      >
        {workspace ? pathBasename(workspace) : "选择工作目录"}
      </span>
    </Button>
  );
};

export const ThreadListSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof Input>, "value" | "onChange"> & {
    value: string;
    onValueChange: (value: string) => void;
  }
>(({ className, value, onValueChange, ...props }, ref) => {
  return (
    <div data-slot="aui_thread-list-search" className=" px-0.5 py-1">
      {/* <Button  variant="ghost" className={"block w-full"}> */}
      {/* <SearchIcon
        data-slot="aui_thread-list-search-icon"
        // className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
      /> */}
      <Button variant="ghost" className={"flex w-full  items-center justify-start px-1"}>
         <SearchIcon
          data-slot="aui_thread-list-search-icon"
          // className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
        />
      搜索
        
      </Button>
      
      {/* <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-label="Search threads"
        placeholder="Search threads"
        className={cn("h-8 ps-8 text-sm", className)}
        {...props}
      /> */}
    </div>
  );
});

ThreadListSearch.displayName = "ThreadListSearch";

export const ThreadListRoot: FC<
  ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>
> = ({ className, ...props }) => {
  return (
    <ThreadListPrimitive.Root
      data-slot="aui_thread-list-root"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  );
};

export const ThreadListItems: FC<
  ComponentPropsWithoutRef<"div"> & { searchQuery?: string }
> = ({ className, searchQuery = "", ...props }) => {
  return (
    <div
      data-slot="aui_thread-list-items"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    >
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListItemGroups searchQuery={searchQuery} />
      </AuiIf>
    </div>
  );
};

export type ThreadListProjectGroup = {
  /** 项目工作目录（完整路径，作折叠 key） */
  cwd: string;
  /** 目录 basename，作显示名 */
  label: string;
  indices: number[];
};

export type ThreadListGroups = {
  threadIds: readonly string[];
  filteredIndices: number[];
  /** 任务：未选择工作目录的公共会话，最近活动倒序 */
  taskIndices: number[];
  /** 项目：有工作目录的会话按目录分组，组间按最近活动倒序 */
  projectGroups: ThreadListProjectGroup[];
};

/**
 * Filters the thread list by title and buckets the matches.
 * 会话分两类：任务（未选工作目录的公共对话）与项目（选定文件夹下的对话，
 * 按文件夹分组、可展开）。归属只由会话自身记录的 cwd 决定；
 * 组内按最近活动倒序。
 */
export const useThreadListGroups = (searchQuery = ""): ThreadListGroups => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);

  const query = searchQuery.trim().toLowerCase();

  return useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const filteredIndices = threadIds
      .map((id, index) => ({ id, index }))
      .filter(
        ({ id }) =>
          !query ||
          (itemsById.get(id)?.title || "新对话")
            .toLowerCase()
            .includes(query),
      )
      .map(({ index }) => index);

    const dates = threadIds.map((id) => itemsById.get(id)?.lastMessageAt);
    const time = (index: number) =>
      dates[index]?.getTime() ?? Number.MAX_SAFE_INTEGER;

    // cwd 归属只看会话自己记录的 cwd：空（含新建未落盘）= 任务，非空 = 项目分组。
    // 不用当前 workspace 兜底——那会让"默认选中的目录"污染会话归属
    const cwdOf = (id: string) => {
      const remoteId = itemsById.get(id)?.remoteId;
      return (remoteId && piSessionCwdMap.get(remoteId)) || "";
    };

    const taskIndices: number[] = [];
    const byCwd = new Map<string, number[]>();
    for (const index of [...filteredIndices].sort((a, b) => time(b) - time(a))) {
      const cwd = cwdOf(threadIds[index]);
      if (!cwd) {
        taskIndices.push(index);
        continue;
      }
      const bucket = byCwd.get(cwd);
      if (bucket) bucket.push(index);
      else byCwd.set(cwd, [index]);
    }

    const projectGroups: ThreadListProjectGroup[] = [...byCwd].map(
      ([cwd, indices]) => ({ cwd, label: pathBasename(cwd), indices }),
    );

    return { threadIds, filteredIndices, taskIndices, projectGroups };
  }, [threadIds, threadItems, query]);
};

const ThreadListItemGroups: FC<{ searchQuery?: string }> = ({
  searchQuery = "",
}) => {
  const { threadIds, filteredIndices, taskIndices } =
    useThreadListGroups(searchQuery);
  const query = searchQuery.trim();

  if (query && filteredIndices.length === 0) {
    return (
      <div
        data-slot="aui_thread-list-empty"
        className="text-muted-foreground px-2.5 py-4 text-sm"
      >
        No threads found
      </div>
    );
  }

  // 已归档会话不在侧栏展示，统一到「设置 → 归档」查看与恢复
  if (taskIndices.length === 0) {
    return (
      <div
        data-slot="aui_thread-list-empty"
        className="text-muted-foreground px-2.5 py-4 text-sm"
      >
        暂无任务对话
      </div>
    );
  }

  return (
    <>
      {taskIndices.map((index) => (
        <ThreadListPrimitive.ItemByIndex
          key={threadIds[index]}
          index={index}
          components={{ ThreadListItem }}
        />
      ))}
    </>
  );
};

/**
 * 项目 tab 内容：有工作目录的会话按文件夹分组，Collapsible 展开显示会话列表。
 * 必须渲染在 ThreadListPrimitive.Root 内部（会话项复用 ThreadListItem 的
 * 激活/重命名/删除能力）。
 * 展开目录集合可由外部受控（openDirs/onOpenDirsChange，供「展开全部」按钮用），
 * 不传则组件内部自管。
 */
export const ProjectListItems: FC<{
  openDirs?: Set<string>;
  onOpenDirsChange?: (next: Set<string>) => void;
}> = ({ openDirs: controlledOpen, onOpenDirsChange }) => {
  const aui = useAui();
  const { threadIds, projectGroups } = useThreadListGroups();
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const [internalOpen, setInternalOpen] = useState<Set<string>>(
    () => new Set(),
  );
  const openDirs = controlledOpen ?? internalOpen;

  const setOpenDirs = (updater: (prev: Set<string>) => Set<string>) => {
    const next = updater(openDirs);
    if (onOpenDirsChange) onOpenDirsChange(next);
    else setInternalOpen(next);
  };

  const toggle = (cwd: string) =>
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });

  /** 归档项目：组内全部已落盘会话批量归档；当前打开的会话由运行时先切走再归档 */
  const archiveProject = (group: ThreadListProjectGroup) => {
    const statusById = new Map(
      threadItems.map((item) => [item.id, item.status]),
    );
    for (const index of group.indices) {
      const id = threadIds[index];
      // 新建未落盘的会话（status "new"）不可归档，跳过
      if (statusById.get(id) !== "regular") continue;
      aui.threads.item({ id }).archive();
    }
  };

  if (projectGroups.length === 0) {
    return (
      <div
        data-slot="aui_thread-list-empty"
        className="text-muted-foreground px-2.5 py-4 text-sm"
      >
        暂无项目对话，选择工作目录后新建的对话会出现在这里
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {projectGroups.map((group) => {
        const isOpen = openDirs.has(group.cwd);
        return (
          <Collapsible
            key={group.cwd}
            open={isOpen}
            onOpenChange={() => toggle(group.cwd)}
          >
            <div className="group/proj relative">
              <CollapsibleTrigger
                className="w-full"
                render={
                  <Button
                    variant="ghost"
                    title={group.cwd}
                    className="h-8 justify-start gap-2 px-2.5 text-sm font-normal hover:bg-muted group-hover/proj:pe-8 aria-expanded:bg-transparent"
                  >
                    {isOpen ? (
                      <FolderOpenIcon className="size-4 shrink-0" />
                    ) : (
                      <FolderIcon className="size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-start">
                      {group.label}
                    </span>
                  </Button>
                }
              />
              {/* 项目操作菜单：归档整个项目（组内全部会话） */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute end-1 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
                    >
                      <MoreHorizontalIcon className="size-3.5" />
                      <span className="sr-only">项目操作</span>
                    </Button>
                  }
                />
                <DropdownMenuContent
                  side="right"
                  align="start"
                  sideOffset={6}
                  className="w-44"
                >
                  <DropdownMenuItem
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
                    onClick={() => archiveProject(group)}
                  >
                    <ArchiveIcon className="size-4" />
                    归档项目
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <CollapsibleContent className="overflow-hidden">
              <div className="flex flex-col gap-0.5 pl-0">
                {group.indices.map((index) => (
                  <ThreadListPrimitive.ItemByIndex
                    key={threadIds[index]}
                    index={index}
                    components={{ ThreadListItem }}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
};

export const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof Button> & { labelClassName?: string }
>(({ className, labelClassName, children, ...props }, ref) => {
  return (
    <ThreadListPrimitive.New asChild>
      <Button
        ref={ref}
        variant="ghost"
        data-slot="aui_thread-list-new"
        className={cn(
          "hover:bg-muted data-active:bg-muted h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <PlusIcon
              data-slot="aui_thread-list-new-icon"
              className="size-4 shrink-0"
            />
            <span
              data-slot="aui_thread-list-new-label"
              className={cn("whitespace-nowrap", labelClassName)}
            >
              新对话
            </span>
          </>
        )}
      </Button>
    </ThreadListPrimitive.New>
  );
});

ThreadListNew.displayName = "ThreadListNew";

const ThreadListSkeleton: FC = () => {
  return (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          role="status"
          aria-label="Loading threads"
          data-slot="aui_thread-list-skeleton-wrapper"
          className="flex h-8 items-center px-2.5"
        >
          <Skeleton
            data-slot="aui_thread-list-skeleton"
            className="h-3.5 w-full"
          />
        </div>
      ))}
    </div>
  );
};

/** 会话标题：文本被省略号截断时，悬浮缓慢左滚展示全文，移开后回位 */
const MarqueeTitle: FC<
  ComponentPropsWithoutRef<"span"> & { children: ReactNode }
> = ({ className, children, ...props }) => {
  const outerRef = useRef<HTMLSpanElement>(null);
  const [dx, setDx] = useState(0);

  const enter = () => {
    const el = outerRef.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth;
    // 末尾多留一点呼吸空间，避免最后一个字贴着裁切边
    if (overflow > 1) setDx(-(overflow + 16));
  };

  return (
    <span
      ref={outerRef}
      onMouseEnter={enter}
      onMouseLeave={() => setDx(0)}
      className={cn(
        "min-w-0 flex-1 overflow-hidden whitespace-nowrap",
        className,
      )}
      {...props}
    >
      <span
        className="block"
        style={{
          transform: `translateX(${dx}px)`,
          transition:
            dx !== 0
              ? `transform ${Math.min(6, Math.abs(dx) / 30)}s linear`
              : "transform 0.2s ease",
        }}
      >
        {children}
      </span>
    </span>
  );
};

export const ThreadListItem: FC = () => {
  const aui = useAui();
  const isRunning = useAuiState((s) => s.threadListItem.isRunning);
  const title = useAuiState((s) => s.threadListItem.title) ?? "";
  const [renameOpen, setRenameOpen] = useState(false);

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      className="group hover:bg-muted focus-visible:bg-muted data-active:bg-muted has-focus-visible:bg-muted has-data-[state=open]:bg-muted relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none"
    >
      <ThreadListItemPrimitive.Trigger
        data-slot="aui_thread-list-item-trigger"
        className="group focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center rounded-md px-2.5 text-start text-sm outline-none group-hover:pe-9 group-has-focus-visible:pe-9 group-has-data-[state=open]:pe-9 group-data-active:pe-9 focus-visible:ring-1"
      >
        {/* Loader DOM 常驻，永久占位 */}
        <Loader2Icon
          aria-hidden
          data-slot="aui_thread-list-item-running"
          data-running={isRunning}
          className="
            text-muted-foreground me-1.5 size-3.5 shrink-0 animate-spin
            invisible
            data-[running=true]:visible
          "
        />
        <MarqueeTitle data-slot="aui_thread-list-item-title">
          <ThreadListItemPrimitive.Title fallback="新对话" />
        </MarqueeTitle>
        {isRunning && <span className="sr-only">Running</span>}
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemMore onRename={() => setRenameOpen(true)} />
      {/* 重命名与顶栏共用同一 dialog；store client 的 rename 声明 void、运行时返回 Promise */}
      <RenameTaskDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        currentTitle={title}
        onRename={(t) =>
          aui.threadListItem.rename(t) as unknown as Promise<void>
        }
      />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemMore: FC<{ onRename: () => void }> = ({ onRename }) => {
  const archived = useAuiState((s) => s.threadListItem.status === "archived");
  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-slot="aui_thread-list-item-more"
          className="data-[state=open]:bg-accent absolute end-1.5 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-data-active:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
          <span className="sr-only">More options</span>
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        data-slot="aui_thread-list-item-more-content"
        className="bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-32 overflow-hidden rounded-xl border p-1.5"
      >
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          onSelect={onRename}
        >
          <PencilIcon className="size-4" />
          Rename
        </ThreadListItemMorePrimitive.Item>
        {archived ? (
          <ThreadListItemPrimitive.Unarchive asChild>
            <ThreadListItemMorePrimitive.Item
              data-slot="aui_thread-list-item-more-item"
              className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
            >
              <ArchiveRestoreIcon className="size-4" />
              Unarchive
            </ThreadListItemMorePrimitive.Item>
          </ThreadListItemPrimitive.Unarchive>
        ) : (
          <ThreadListItemPrimitive.Archive asChild>
            <ThreadListItemMorePrimitive.Item
              data-slot="aui_thread-list-item-more-item"
              className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
            >
              <ArchiveIcon className="size-4" />
              Archive
            </ThreadListItemMorePrimitive.Item>
          </ThreadListItemPrimitive.Archive>
        )}
        <ThreadListItemPrimitive.Delete asChild>
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          >
            <TrashIcon className="size-4" />
            Delete
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Delete>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
