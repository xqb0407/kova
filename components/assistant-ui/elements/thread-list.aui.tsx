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
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  ZapIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@/lib/ease";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { forkPiSession, piSessionCwdMap } from "@/lib/pi-thread-adapter";
import { usePiSessionRunning } from "@/lib/pi-running";
import { useThreadActivity } from "@/lib/pi-last-activity";
import {
  requestAutomationFocus,
  useAutomationTaskIdForSession,
} from "@/lib/automations";
import { toast } from "@/components/ui/toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FC,
  type ReactNode,
} from "react";
import { RenameTaskDialog } from "@/components/agent-thread/rename-task-dialog";
import {
  useFluidHover,
  useRegisterFluidHoverItem,
} from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import { FluidHoverRow } from "@/components/fluid-hover-row";

// ---------------------------------------------------------------------------
// Fluid hover — 侧边栏列表与菜单（MenuItem）共用同一套悬浮机制：列表容器跑
// 一个 useFluidHover 作用域并渲染唯一的 FluidHoverHighlight（bg-hover，
// spring.fast 在行间滑动，进出各 0.08s 淡入淡出），行本身不再画 hover:bg-muted。
// 行通过 RowHoverContext 拿到所在槽位（容器的 registerItem + 序号）注册自己，
// 让 ThreadListItem 在任务列表和项目分组的嵌套列表里都归入正确的作用域。
// ---------------------------------------------------------------------------

type RegisterItem = (index: number, element: HTMLElement | null) => void;

interface RowHoverSlot {
  registerItem: RegisterItem;
  index: number;
}

const RowHoverContext = createContext<RowHoverSlot | null>(null);

// ---------------------------------------------------------------------------
// 会话树展开动画 —— 移植 components/custom-ui/file-tree.tsx 的动效配方：
//   1. TreeRow：新行以 opacity 0 / y -6 级联淡入（组内行序 × 0.02s，封顶
//      0.06s——延迟必须用组内相对序号，用全局槽位会让靠后的分组永远吃满
//      延迟、展开显得慢半拍），行被增删挤动时靠 layout="position" 的
//      SPRING_LAYOUT 平滑归位；
//   2. 箭头 90° 旋转、开合文件夹图标用 SPRING_SWAP 弹跳交叉淡换。
// 收起时子树直接卸载、无退场动画，与 file-tree 的 flatten+挂载模型一致。
// 行高亮测量走 offsetTop（见 use-fluid-hover 注释），不受这里的 transform
// 影响，fluid hover 与动画可共存。useReducedMotion 下全部短路为静态。
// ---------------------------------------------------------------------------

const ROW_ENTER = { duration: 0.18, ease: EASE_OUT } as const;

/** 树行动画壳：包裹任意行元素，提供入场级联淡入与布局滑移 */
const TreeRow: FC<{ position: number; children: ReactNode }> = ({
  position,
  children,
}) => {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      layout={reduce ? false : "position"}
      initial={reduce ? false : { opacity: 0, y: -6 }}
      animate={{
        opacity: 1,
        y: 0,
        transition: reduce
          ? { duration: 0 }
          : { ...ROW_ENTER, delay: Math.min(position * 0.02, 0.06) },
      }}
      transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
    >
      {children}
    </motion.div>
  );
};

/** 分组头的开合文件夹图标：弹簧交叉淡换（同 file-tree DefaultIcon） */
const FolderSwapIcon: FC<{ open: boolean }> = ({ open }) => {
  const reduce = useReducedMotion() ?? false;
  if (reduce) {
    return open ? (
      <FolderOpenIcon className="size-4 shrink-0" />
    ) : (
      <FolderIcon className="size-4 shrink-0" />
    );
  }
  return (
    <span className="relative grid size-4 shrink-0 place-items-center">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={open ? "open" : "closed"}
          initial={{ opacity: 0, scale: 0.75, rotate: open ? -8 : 8 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          exit={{ opacity: 0, scale: 0.75, rotate: open ? 8 : -8 }}
          transition={SPRING_SWAP}
          className="absolute inset-0 grid place-items-center"
        >
          {open ? (
            <FolderOpenIcon className="size-4" />
          ) : (
            <FolderIcon className="size-4" />
          )}
        </motion.span>
      </AnimatePresence>
    </span>
  );
};

// ---------------------------------------------------------------------------
// 会话行右侧「距最后一条消息多久」的粗粒度显示（刚刚 / 5分钟 / 3小时 / 2天），
// Codex 风格，不带秒。渲染时算一次的固定值，不做心跳——秒表式跳动不是预期
// 交互；数值随后续列表/状态更新自然刷新。
// ---------------------------------------------------------------------------

const formatElapsed = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  if (total < 60) return "刚刚";
  const min = Math.floor(total / 60);
  if (min < 60) return `${min}分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时`;
  return `${Math.floor(hr / 24)}天`;
};

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

// 容器是 motion.div（layoutRoot），DOM 动画/拖拽回调与 motion 同名 props 冲突，从入参里剔除
type ThreadListItemsProps = Omit<
  ComponentPropsWithoutRef<"div">,
  | "onAnimationStart"
  | "onAnimationEnd"
  | "onAnimationIteration"
  | "onTransitionEnd"
  | "onDrag"
  | "onDragEnd"
  | "onDragEnter"
  | "onDragExit"
  | "onDragLeave"
  | "onDragOver"
  | "onDragStart"
  | "onDrop"
> & { searchQuery?: string };

export const ThreadListItems: FC<ThreadListItemsProps> = ({
  className,
  searchQuery = "",
  ...props
}) => {
  // 本容器的行共用一块滑动高亮；行在 ThreadListItemGroups 里按槽位注册。
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(listRef);

  return (
    <motion.div
      ref={listRef}
      layoutRoot
      data-slot="aui_thread-list-items"
      className={cn("relative flex flex-col gap-0.5", className)}
      {...props}
      {...hover.handlers}
    >
      {/* 行是 relative、晚于高亮渲染，压在其上：选中行（data-active:bg-selected）
          仍盖过高亮，与 ask-user 的选中优先级一致 */}
      <FluidHoverHighlight hover={hover} className="rounded-md" />
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListItemGroups
          searchQuery={searchQuery}
          registerItem={hover.registerItem}
        />
      </AuiIf>
    </motion.div>
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

const ThreadListItemGroups: FC<{
  searchQuery?: string;
  registerItem: RegisterItem;
}> = ({ searchQuery = "", registerItem }) => {
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
      {taskIndices.map((index, slot) => (
        <RowHoverContext.Provider
          key={threadIds[index]}
          value={{ registerItem, index: slot }}
        >
          <TreeRow position={slot}>
            <ThreadListPrimitive.ItemByIndex
              index={index}
              components={{ ThreadListItem }}
            />
          </TreeRow>
        </RowHoverContext.Provider>
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
/** 项目展开后默认可见的会话行数，超出折叠进「显示更多」 */
const PROJECT_VISIBLE_LIMIT = 5;

export const ProjectListItems: FC<{
  openDirs?: Set<string>;
  onOpenDirsChange?: (next: Set<string>) => void;
}> = ({ openDirs: controlledOpen, onOpenDirsChange }) => {
  const aui = useAui();
  const reduce = useReducedMotion() ?? false;
  const { threadIds, projectGroups } = useThreadListGroups();
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const [internalOpen, setInternalOpen] = useState<Set<string>>(
    () => new Set(),
  );
  const openDirs = controlledOpen ?? internalOpen;
  // 项目分组内当前可见行数（「显示更多」每点一次 +5 分页放出，不一次全开）；
  // 不设「收起」按钮：项目折叠再展开即回默认 5 条（清理见 openDirs 效应）
  const [visibleCounts, setVisibleCounts] = useState<Map<string, number>>(
    () => new Map(),
  );
  const expandMore = (cwd: string) =>
    setVisibleCounts((prev) => {
      const next = new Map(prev);
      next.set(cwd, (prev.get(cwd) ?? PROJECT_VISIBLE_LIMIT) + PROJECT_VISIBLE_LIMIT);
      return next;
    });

  // 任务列表同款 fluid hover 作用域：组头与组内行注册进同一容器，
  // 高亮在「文件夹行 ↔ 会话行」之间连续滑动（Base UI Panel 关闭时卸载，
  // 收起组的行自动注销，不影响剩余行的 rect）。
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(listRef);

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

  // 折叠即重置：收起的组清掉已放出条数，再展开回默认 5 条；
  // 也覆盖「全部收起」等外部改 openDirs 的路径
  useEffect(() => {
    setVisibleCounts((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const cwd of prev.keys()) {
        if (!openDirs.has(cwd)) {
          next.delete(cwd);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [openDirs]);

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

  // 渲染序即注册序：组头与其子行占连续槽位，每次渲染重算、顺序稳定
  let nextSlot = 0;

  return (
    <motion.div
      ref={listRef}
      layoutRoot
      className="relative flex flex-col gap-0.5"
      {...hover.handlers}
    >
      <FluidHoverHighlight hover={hover} className="rounded-md" />
      {projectGroups.map((group) => {
        // 组内行数超过上限时默认截断 5 条，尾部「显示更多」每点放出 5 条，
        // 放完即无按钮（项目折叠再展开回默认）；截断后的行与按钮占连续 hover 槽位
        const visibleLimit =
          visibleCounts.get(group.cwd) ?? PROJECT_VISIBLE_LIMIT;
        const visibleIndices = group.indices.slice(0, visibleLimit);
        const hiddenCount = group.indices.length - visibleIndices.length;
        const headerSlot = nextSlot++;
        const childSlots = visibleIndices.map(() => nextSlot++);
        const moreSlot = hiddenCount > 0 ? nextSlot++ : -1;
        const isOpen = openDirs.has(group.cwd);
        return (
          <Collapsible
            key={group.cwd}
            open={isOpen}
            onOpenChange={() => toggle(group.cwd)}
          >
            <TreeRow position={headerSlot}>
              <FluidHoverRow
                registerItem={hover.registerItem}
                index={headerSlot}
                className="group/proj relative"
              >
                <CollapsibleTrigger
                  className="w-full"
                  render={
                    <Button
                      variant="ghost"
                      title={group.cwd}
                      // hover 反馈交给 FluidHoverHighlight：压掉 ghost 变体
                      // 自带的 hover/aria-expanded 底色，避免与高亮叠加
                      className="h-8 justify-start gap-2 px-2.5 text-sm font-normal hover:bg-transparent dark:hover:bg-transparent group-hover/proj:pe-8 aria-expanded:bg-transparent"
                    >
                      {/* file-tree 同款箭头：开合时弹簧旋转 90° */}
                      {/* <motion.span
                        aria-hidden="true"
                        animate={{ rotate: isOpen ? 90 : 0 }}
                        transition={reduce ? { duration: 0 } : SPRING_SWAP}
                        className="grid size-3.5 shrink-0 place-items-center"
                      >
                        <ChevronRightIcon className="size-3.5" />
                      </motion.span> */}
                      {/* 文件夹图标开合弹簧交叉淡换 */}
                      <FolderSwapIcon open={isOpen} />
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
              </FluidHoverRow>
            </TreeRow>
            <CollapsibleContent className="overflow-hidden">
              {/* 展开时子树整体挂载：会话行级联淡入 */}
              <div className="flex flex-col gap-0.5 pl-0">
                {visibleIndices.map((index, i) => (
                  <RowHoverContext.Provider
                    key={threadIds[index]}
                    value={{
                      registerItem: hover.registerItem,
                      index: childSlots[i],
                    }}
                  >
                    <TreeRow position={i}>
                      <ThreadListPrimitive.ItemByIndex
                        index={index}
                        components={{ ThreadListItem }}
                      />
                    </TreeRow>
                  </RowHoverContext.Provider>
                ))}
                {hiddenCount > 0 && (
                  <TreeRow position={visibleIndices.length}>
                    <FluidHoverRow
                      registerItem={hover.registerItem}
                      index={moreSlot}
                    >
                      <Button
                        variant="ghost"
                        // 左缘与会话标题对齐：行 ps-2.5(10px) + 占位图标 size-3.5(14px) + me-1.5(6px) = 30px
                        className="h-7 w-full justify-start ps-[30px] text-sm font-normal text-muted-foreground hover:bg-transparent dark:hover:bg-transparent"
                        onClick={() => expandMore(group.cwd)}
                      >
                        {`显示更多（${Math.min(hiddenCount, PROJECT_VISIBLE_LIMIT)}）`}
                      </Button>
                    </FluidHoverRow>
                  </TreeRow>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </motion.div>
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
          "hover:bg-selected data-active:bg-selected h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal",
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
        "block min-w-0 flex-1 overflow-hidden whitespace-nowrap",
        className,
      )}
      // 静止时溢出以省略号收尾；hover 滚动全文期间切回 clip，避免省略号
      // 压着正在滚动的文字。text-overflow 只对行内的 inline-level 溢出生效，
      // 所以内层用 inline-block 而非 block。
      style={{ textOverflow: dx !== 0 ? "clip" : "ellipsis" }}
      {...props}
    >
      {/* w-max：inline-block 默认 shrink-to-fit 会被容器宽度封顶，文字溢出
          发生在内层盒子内部，外层的 ellipsis 就永远不触发；按 max-content
          撑开让内层盒子本身溢出行盒，省略号才会画出来。 */}
      <span
        className="inline-block w-max"
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
  // 框架 isRunning 只覆盖挂载过运行时的线程（切走/刷新后的后台 run 会漏）；
  // 并上 sidecar 事实源的运行集合（pi-running store）后，运行中指示才常驻，
  // 没在跑的会话才不可见
  const isRunning = useAuiState((s) => s.threadListItem.isRunning);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  // 必须无条件调用：写进 `isRunning || usePiSessionRunning(...)` 会被 ||
  // 短路，isRunning 为 true 的那次渲染整个跳过 hook ⇒ hook 顺序抖动
  const runningExternally = usePiSessionRunning(remoteId);
  const showRunning = isRunning || runningExternally;
  // 定时任务出身标记（run_done 帧记账的 session→task 映射）：⚡ 徽标 + 定位
  const automationTaskId = useAutomationTaskIdForSession(remoteId);
  const title = useAuiState((s) => s.threadListItem.title) ?? "";
  // 「距最后一条消息」的固定用时；渲染时算一次，运行中直接显示「刚刚」。
  // 列表快照的 lastMessageAt 要等 reload 才更新，叠加本地活动时间戳
  // （发送/turn 收尾时盖的，见 pi-last-activity）才能刚聊完就显示「刚刚」
  const lastMessageAt = useAuiState((s) => s.threadListItem.lastMessageAt);
  const localActivityAt = useThreadActivity(remoteId);
  const lastMs = Math.max(lastMessageAt?.getTime() ?? 0, localActivityAt ?? 0);
  const elapsed = showRunning
    ? "刚刚"
    : lastMs
      ? formatElapsed(Date.now() - lastMs)
      : null;
  const [renameOpen, setRenameOpen] = useState(false);
  // 删除二次确认：菜单里的「删除」只打开 AlertDialog，确认后才真正调 delete
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // 归入所在列表的 fluid hover 作用域；不在列表里渲染时（无 Provider）跳过
  const rowRef = useRef<HTMLDivElement>(null);
  const slot = useContext(RowHoverContext);
  useRegisterFluidHoverItem(slot?.registerItem, slot?.index, rowRef);

  const confirmDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      // 删除当前会话时 core 会先自动切走（_ensureThreadIsNotMain）；
      // store client 的 delete 声明 void、运行时返回 Promise（同 rename）
      await (aui.threadListItem.delete() as unknown as Promise<void>);
    } catch (err) {
      toast.add({
        title: "删除失败",
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  return (
    <ThreadListItemPrimitive.Root
      ref={rowRef}
      data-slot="aui_thread-list-item"
      // hover 反馈由列表容器的 FluidHoverHighlight 负责，行不再自画
      // hover:bg-muted；focus/open/active 底色保留（盖在高亮之上）
      className="group focus-visible:bg-selected data-active:bg-selected has-focus-visible:bg-selected has-data-[state=open]:bg-selected relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none"
    >
      <ThreadListItemPrimitive.Trigger
        data-slot="aui_thread-list-item-trigger"
        className="group focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center rounded-md pe-9 ps-2.5 text-start text-sm outline-none focus-visible:ring-1"
      >
        {/* Loader DOM 常驻，永久占位 */}
        <Loader2Icon
          aria-hidden
          data-slot="aui_thread-list-item-running"
          data-running={showRunning}
          className="
            text-muted-foreground me-1.5 size-3.5 shrink-0 animate-spin
            invisible
            data-[running=true]:visible
          "
        />
        {/* {automationTaskId && (
          <ZapIcon
            aria-label="定时任务发起的会话"
            onClick={(e) => {
              // 不切换会话：请求宿主切到自动化管理页并滚动定位任务卡片
              e.preventDefault();
              e.stopPropagation();
              requestAutomationFocus(automationTaskId);
            }}
            className="text-muted-foreground hover:text-foreground me-1.5 size-3 shrink-0 cursor-pointer"
          />
        )} */}
        <MarqueeTitle data-slot="aui_thread-list-item-title">
          <ThreadListItemPrimitive.Title fallback="新对话" />
        </MarqueeTitle>
        {showRunning && <span className="sr-only">Running</span>}
      </ThreadListItemPrimitive.Trigger>
      {/* 用时与 more 按钮同位（end-1.5 的绝对槽位），选中行也显示；显隐条件
          与 more 严格互补（hover / 键盘焦点 / 菜单展开时 more 出现，此处隐藏）。
          双方都瞬时切换、不带透明度过渡，避免交叉淡出期间两个同时可见。
          trigger 常驻 pe-9 为该槽位留宽，标题截断在任何状态下不跳动 */}
      {elapsed && (
        <span
          data-slot="aui_thread-list-item-elapsed"
          title={showRunning ? "正在运行" : "距最后一条消息的时间"}
          className="text-muted-foreground pointer-events-none absolute end-1.5 top-1/2 -translate-y-1/2 text-xs leading-none tabular-nums opacity-100 group-hover:opacity-0 group-has-focus-visible:opacity-0 group-has-data-[state=open]:opacity-0"
        >
          {elapsed}
        </span>
      )}
      <ThreadListItemMore
        onRename={() => setRenameOpen(true)}
        onAskDelete={() => setDeleteOpen(true)}
      />
      {/* 重命名与顶栏共用同一 dialog；store client 的 rename 声明 void、运行时返回 Promise */}
      <RenameTaskDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        currentTitle={title}
        onRename={(t) =>
          aui.threadListItem.rename(t) as unknown as Promise<void>
        }
      />
      {/* 删除二次确认：AlertDialogAction 是普通 Button 不会自动关闭，confirmDelete 负责收尾 */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除对话？</AlertDialogTitle>
            <AlertDialogDescription>
              {`将永久删除「${title || "新对话"}」及其全部消息记录，此操作无法撤销。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              disabled={deleting}
              onClick={() => {
                void confirmDelete();
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemMore: FC<{
  onRename: () => void;
  onAskDelete: () => void;
}> = ({ onRename, onAskDelete }) => {
  const aui = useAui();
  const status = useAuiState((s) => s.threadListItem.status);
  const archived = status === "archived";
  // new：从未发送过消息、还没在后端落盘的会话。core 对 rename/archive/delete
  // 都有状态守卫（只接受 regular/archived），菜单项点了只会被拒绝
  const isNew = status === "new";
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  // 分支进行中标记：按钮置灰防重复点击
  const [branching, setBranching] = useState(false);

  /**
   * 分支对话：sidecar 复制整个会话为新 pi 会话（标题加「（分支）」），
   * 刷新列表后切换过去。未落盘的会话（无 remoteId）不显示该入口。
   */
  const branch = async () => {
    if (!remoteId || branching) return;
    setBranching(true);
    try {
      const newRemoteId = await forkPiSession(remoteId);
      await aui.threads.reload();
      await aui.threads.switchToThread(newRemoteId);
    } catch (err) {
      toast.add({
        title: "分支对话失败",
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    } finally {
      setBranching(false);
    }
  };

  // 未落盘的新会话：core 状态守卫会拒绝重命名/归档/删除，整个菜单就没有
  // 可用项，直接不渲染 More 按钮（发了首条消息后即恢复正常菜单）
  if (isNew) return null;

  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-slot="aui_thread-list-item-more"
          // transition-colors 覆盖 Button 基类的 transition-all：基类的过渡
          // 作用到 opacity，移开鼠标时会淡出 150ms，与瞬时恢复显示的用
          // 时间重叠——二者必须瞬时互换，任何一侧都不允许带透明度过渡
          className="data-[state=open]:bg-accent absolute end-1.5 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 transition-colors group-hover:opacity-100 group-has-focus-visible:opacity-100 data-[state=open]:opacity-100"
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
          重命名
        </ThreadListItemMorePrimitive.Item>
        {remoteId && (
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none disabled:cursor-not-allowed disabled:opacity-50"
            disabled={branching}
            onSelect={branch}
          >
            <GitBranchIcon className="size-4" />
            分支对话
          </ThreadListItemMorePrimitive.Item>
        )}
        {archived ? (
          <ThreadListItemPrimitive.Unarchive asChild>
            <ThreadListItemMorePrimitive.Item
              data-slot="aui_thread-list-item-more-item"
              className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
            >
              <ArchiveRestoreIcon className="size-4" />
              取消归档
            </ThreadListItemMorePrimitive.Item>
          </ThreadListItemPrimitive.Unarchive>
        ) : (
          <ThreadListItemPrimitive.Archive asChild>
            <ThreadListItemMorePrimitive.Item
              data-slot="aui_thread-list-item-more-item"
              className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
            >
              <ArchiveIcon className="size-4" />
              归档
            </ThreadListItemMorePrimitive.Item>
          </ThreadListItemPrimitive.Archive>
        )}
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          onSelect={onAskDelete}
        >
          <TrashIcon className="size-4" />
          删除
        </ThreadListItemMorePrimitive.Item>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
