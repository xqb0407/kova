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
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  HashIcon,
  Loader2Icon,
  MailIcon,
  MailOpenIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  WaypointsIcon,
  ZapIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@/lib/motion/ease";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  forkPiSession,
  piSessionCwdMap,
  piSessionRegistry,
} from "@/lib/pi/pi-thread-adapter";
import { clearLastThread } from "@/lib/pi/pi-last-thread";
import { usePiSessionRunning } from "@/lib/pi/pi-running";
import {
  markSessionRead,
  markSessionUnread,
  toggleSessionUnread,
  useIsThreadUnread,
  useUnreadSessionIds,
} from "@/lib/pi/pi-unread-sessions";
import {
  setThreadBatchVisible,
  toggleThreadBatchSelect,
  useIsThreadBatchSelected,
  useThreadBatchActive,
} from "@/lib/pi/pi-thread-batch";
import { subscribeAgentEvents } from "@/lib/pi/agent-events";
import { openPanelTab } from "@/lib/panels/panel-tabs";
import {
  fsErrorText,
  fsReveal,
} from "@/lib/workspace/fs";
import { taskWorkspaceDir } from "@/lib/workspace/task-workspace";
import { isTauri } from "@/lib/tauri";
import {
  togglePinSession,
  useIsPinned,
  usePinnedSessionIds,
} from "@/lib/pi/pi-pinned-sessions";
import { useThreadActivity } from "@/lib/pi/pi-last-activity";
import { useThreadTitle } from "@/lib/pi/pi-thread-titles";
import {
  usePendingInteractionKind,
  type PendingInteractionKind,
} from "@/lib/pi/pi-interactions";
import {
  requestAutomationFocus,
  useAutomationTaskIdForSession,
} from "@/lib/automation/automations";
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
  clearWorkspace,
  openWorkspacePicker,
  pathBasename,
  useWorkspace,
} from "@/lib/workspace/workspace-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
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

/** 树行动画壳：外层只管 layout 滑移归位，内层只管入场级联淡入。二者必须分离
 *  ——layout 的位移投影与 animate 的 y 共享同一运动值时，投影过渡会被入场
 *  过渡（0.18s ease + delay）接管，换位仍会滑一段。instant：本次提交换位瞬时
 *  完成（外层 transition 时长置 0），置顶切换不让按钮在指针下飘走 */
const TreeRow: FC<{ position: number; instant?: boolean; children: ReactNode }> = ({
  position,
  instant,
  children,
}) => {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      layout={reduce ? false : "position"}
      transition={reduce || instant ? { duration: 0 } : SPRING_LAYOUT}
    >
      <motion.div
        initial={reduce ? false : { opacity: 0, y: -6 }}
        animate={{
          opacity: 1,
          y: 0,
          transition: reduce
            ? { duration: 0 }
            : { ...ROW_ENTER, delay: Math.min(position * 0.02, 0.06) },
        }}
      >
        {children}
      </motion.div>
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

// ---------------------------------------------------------------------------
// 挂起徽标：轮次被审批/提问卡住时，行右侧（用时与 more 按钮同位）显示
// 「等待审批 / 等待回答」。它是可操作的阻塞态，优先级高于用时——两者
// 互斥出图，不叠字。
// ---------------------------------------------------------------------------

const PENDING_BADGE: Record<
  PendingInteractionKind,
  { label: string; title: string }
> = {
  approval: { label: "等待审批", title: "工具执行前等待你批准" },
  question: { label: "等待回答", title: "Agent 提问等待你作答" },
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

/** 列表上下缘渐隐带宽（px） */
const EDGE_FADE = 16;

/**
 * 未读状态跟踪（挂 ThreadListRoot 内，桌面/移动两份宿主各自实例化，标记
 * 幂等无碍）：
 * - 切换会话即已读：mainThreadId 变化时清掉该键
 * - 后台完成置未读：agent.turn.completed 且非当前打开线程——正在看的会话
 *   回复落地不算未读；agent.turn.error 不置（失败的轮用户会看到错误态）
 *
 * 键空间归一（未读键 = 行 remoteId = 事件 threadId = pi sessionId，但本会话
 * 新建的线程 mainThreadId 恒为 __LOCALID_ 草稿 id，绑定只写进
 * piSessionRegistry）：判定"是否正在看"要先把当前线程经注册表换出 sessionId
 * 再比，否则新建会话看着它跑完仍被置未读；清除同理双键都清，切回草稿线程时
 * 才清得掉 sessionId 键上那条未读。
 */
const ThreadUnreadTracker: FC = () => {
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const mainRef = useRef(mainThreadId);
  mainRef.current = mainThreadId;
  useEffect(() => {
    if (!mainThreadId) return;
    markSessionRead(mainThreadId);
    const bound = piSessionRegistry.get(mainThreadId);
    if (bound) markSessionRead(bound);
  }, [mainThreadId]);
  useEffect(
    () =>
      subscribeAgentEvents((event) => {
        if (event.name !== "agent.turn.completed") return;
        const threadId = event.threadId;
        if (!threadId) return;
        const current = mainRef.current;
        if (
          threadId === current ||
          (current && piSessionRegistry.get(current) === threadId)
        )
          return;
        markSessionUnread(threadId);
      }),
    [],
  );
  return null;
};

/**
 * 会话列表根容器：滚动时上下缘渐隐（与标题右渐隐同款内联 mask 方案，
 * 不走 shadcn scroll-fade 工具类——其 @property/animation-timeline 机制
 * 在 WKWebView 不可靠）。按实测位置施加：顶部滚过才淡出顶缘、底部还有
 * 内容才淡出底缘，不滚动/无溢出时完全无 mask。
 */
export const ThreadListRoot: FC<
  ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>
> = ({ className, children, ...props }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ t: false, b: false });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const top = el.scrollTop;
      const bottom = el.scrollHeight - top - el.clientHeight;
      const next = { t: top > 1, b: bottom > 1 };
      setFade((prev) =>
        prev.t === next.t && prev.b === next.b ? prev : next,
      );
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      // 容器尺寸与内容高度变化都可能改变可滚性：容器和直接子项一起观察
      ro = new ResizeObserver(measure);
      ro.observe(el);
      for (const c of Array.from(el.children)) ro.observe(c);
    }
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [children]);

  const mask =
    fade.t || fade.b
      ? `linear-gradient(to bottom, ${
          fade.t ? `transparent 0, #000 ${EDGE_FADE}px` : "#000 0"
        }, ${
          fade.b
            ? `#000 calc(100% - ${EDGE_FADE}px), transparent 100%`
            : "#000 100%"
        })`
      : undefined;

  return (
    <ThreadListPrimitive.Root
      ref={ref}
      data-slot="aui_thread-list-root"
      className={cn("flex flex-col gap-0.5", className)}
      style={
        mask
          ? { WebkitMaskImage: mask, maskImage: mask, maskRepeat: "no-repeat" }
          : undefined
      }
      {...props}
    >
      <ThreadUnreadTracker />
      {children}
    </ThreadListPrimitive.Root>
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
  /** 置顶（任务 tab）：任务会话（无 cwd）命中置顶集合的，最近活动倒序 */
  pinnedIndices: number[];
  /** 置顶（项目 tab）：项目会话置顶后跳出所属文件夹，进项目 tab 顶部全局
   *  置顶组，最近活动倒序 */
  pinnedProjectIndices: number[];
  /** 任务：未置顶的公共会话，最近活动倒序 */
  taskIndices: number[];
  /** 项目：有工作目录的会话按目录分组（不含置顶），组内最近活动倒序，
   *  组间按最近活动倒序 */
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
  const pinnedIds = usePinnedSessionIds();

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

    // 置顶分两类：任务会话（无 cwd）进任务 tab 顶部的全局置顶组；项目会话
    // 跳出所属文件夹，进项目 tab 顶部的全局置顶组——分组内不保留置顶行
    const pinnedSet = new Set(pinnedIds);

    const pinnedIndices: number[] = [];
    const pinnedProjectIndices: number[] = [];
    const taskIndices: number[] = [];
    const byCwd = new Map<string, number[]>();
    for (const index of [...filteredIndices].sort((a, b) => time(b) - time(a))) {
      const remoteId = itemsById.get(threadIds[index])?.remoteId;
      const pinned = remoteId !== undefined && pinnedSet.has(remoteId);
      const cwd = cwdOf(threadIds[index]);
      if (!cwd) {
        if (pinned) pinnedIndices.push(index);
        else taskIndices.push(index);
        continue;
      }
      if (pinned) {
        pinnedProjectIndices.push(index);
        continue;
      }
      const bucket = byCwd.get(cwd);
      if (bucket) bucket.push(index);
      else byCwd.set(cwd, [index]);
    }

    const projectGroups: ThreadListProjectGroup[] = [...byCwd].map(
      ([cwd, indices]) => ({ cwd, label: pathBasename(cwd), indices }),
    );

    return {
      threadIds,
      filteredIndices,
      pinnedIndices,
      pinnedProjectIndices,
      taskIndices,
      projectGroups,
    };
  }, [threadIds, threadItems, query, pinnedIds]);
};

const ThreadListItemGroups: FC<{
  searchQuery?: string;
  registerItem: RegisterItem;
}> = ({ searchQuery = "", registerItem }) => {
  const { threadIds, filteredIndices, taskIndices, pinnedIndices } =
    useThreadListGroups(searchQuery);
  const query = searchQuery.trim();

  // 批量模式「全选」的可见集注册：任务 tab 当前渲染的会话（含置顶组，
  // 搜索过滤后口径一致）。跨 tab 统一选择池的一侧，见 pi-thread-batch.ts
  const visibleTaskIds = useMemo(
    () => [...pinnedIndices, ...taskIndices].map((index) => threadIds[index]),
    [threadIds, pinnedIndices, taskIndices],
  );
  useEffect(() => {
    setThreadBatchVisible("tasks", visibleTaskIds);
  }, [visibleTaskIds]);

  // 置顶切换检测：pinnedIds 快照身份仅在 pin/unpin 时变化。这一次提交传
  // instant 给 TreeRow，行瞬时换位不走滑移（新消息挤动等其他重排不受影响）
  const pinnedIds = usePinnedSessionIds();
  const prevPinnedRef = useRef<readonly string[] | null>(null);
  const pinReorder =
    prevPinnedRef.current !== null && prevPinnedRef.current !== pinnedIds;
  useEffect(() => {
    prevPinnedRef.current = pinnedIds;
  });

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
  if (pinnedIndices.length === 0 && taskIndices.length === 0) {
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
      {/* 置顶组：独立灰底卡片与普通对话分开；行仍注册进 fluid hover 槽位
          （置顶在前、任务在后，序号连续） */}
      {pinnedIndices.length > 0 && (
        <PinnedCard>
          {pinnedIndices.map((index, slot) => (
            <RowHoverContext.Provider
              key={threadIds[index]}
              value={{ registerItem, index: slot }}
            >
              <TreeRow position={slot} instant={pinReorder}>
                <ThreadListPrimitive.ItemByIndex
                  index={index}
                  components={{ ThreadListItem }}
                />
              </TreeRow>
            </RowHoverContext.Provider>
          ))}
        </PinnedCard>
      )}
      {taskIndices.map((index, i) => (
        <RowHoverContext.Provider
          key={threadIds[index]}
          value={{ registerItem, index: pinnedIndices.length + i }}
        >
          <TreeRow position={i} instant={pinReorder}>
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
/** 置顶分组卡片（ChatGPT 侧栏同形）：圆角灰底 + 「已置顶」标签，与普通对话行
 *  分开渲染；任务 tab 与项目组内复用。标签 px-2.5 + 卡片 p-1 使文字左缘与
 *  行首图钉对齐；行的 fluid hover 槽位由调用方按渲染序分配 */
const PinnedCard: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="my-1 rounded-xl bg-muted/50 p-1">
    <div
      aria-hidden
      className="text-muted-foreground px-2.5 pb-1 pt-1.5 text-xs font-medium select-none"
    >
      已置顶
    </div>
    {children}
  </div>
);

/** 项目展开后默认可见的会话行数，超出折叠进「显示更多」 */
const PROJECT_VISIBLE_LIMIT = 5;

export const ProjectListItems: FC<{
  openDirs?: Set<string>;
  onOpenDirsChange?: (next: Set<string>) => void;
}> = ({ openDirs: controlledOpen, onOpenDirsChange }) => {
  const aui = useAui();
  const reduce = useReducedMotion() ?? false;
  const { threadIds, pinnedProjectIndices, projectGroups } =
    useThreadListGroups();
  const threadItems = useAuiState((s) => s.threads.threadItems);
  // 组头未读蓝点：组内任一会话未读即点亮（与会话行蓝点同款式）
  const unreadIds = useUnreadSessionIds();
  // 批量模式「全选」的可见集注册：项目 tab 全部会话（置顶卡 + 各组全员，
  // 含「显示更多」未放出的行——它们是真实会话，全选应覆盖）
  const visibleProjectIds = useMemo(
    () =>
      [...pinnedProjectIndices, ...projectGroups.flatMap((g) => g.indices)].map(
        (index) => threadIds[index],
      ),
    [threadIds, pinnedProjectIndices, projectGroups],
  );
  useEffect(() => {
    setThreadBatchVisible("projects", visibleProjectIds);
  }, [visibleProjectIds]);
  // 置顶切换检测：同任务列表——组内置顶换位瞬时完成，不走滑移
  const pinnedIds = usePinnedSessionIds();
  const prevPinnedRef = useRef<readonly string[] | null>(null);
  const pinReorder =
    prevPinnedRef.current !== null && prevPinnedRef.current !== pinnedIds;
  useEffect(() => {
    prevPinnedRef.current = pinnedIds;
  });
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

  if (projectGroups.length === 0 && pinnedProjectIndices.length === 0) {
    return (
      <div
        data-slot="aui_thread-list-empty"
        className="text-muted-foreground px-2.5 py-4 text-sm"
      >
        暂无项目对话，选择工作目录后新建的对话会出现在这里
      </div>
    );
  }

  // 渲染序即注册序：置顶卡片行占最前槽位，组头与其子行连续跟上
  let nextSlot = 0;
  const pinnedSlots = pinnedProjectIndices.map(() => nextSlot++);

  return (
    <motion.div
      ref={listRef}
      layoutRoot
      className="relative flex flex-col gap-0.5"
      {...hover.handlers}
    >
      <FluidHoverHighlight hover={hover} className="rounded-md" />
      {/* 置顶的项目会话跳出所属文件夹，进项目 tab 顶部的全局「已置顶」卡片 */}
      {pinnedProjectIndices.length > 0 && (
        <PinnedCard>
          {pinnedProjectIndices.map((index, i) => (
            <RowHoverContext.Provider
              key={threadIds[index]}
              value={{
                registerItem: hover.registerItem,
                index: pinnedSlots[i],
              }}
            >
              <TreeRow position={i} instant={pinReorder}>
                <ThreadListPrimitive.ItemByIndex
                  index={index}
                  components={{ ThreadListItem }}
                />
              </TreeRow>
            </RowHoverContext.Provider>
          ))}
        </PinnedCard>
      )}
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
        const hasUnread = group.indices.some((i) =>
          unreadIds.has(threadIds[i]),
        );
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
                      {/* 组内任一对话未读 → 蓝点（与会话行同款；hover 让位给
                          右侧「项目操作」按钮，同会话行 hover 让位规则） */}
                      {hasUnread && (
                        <span
                          aria-hidden
                          data-slot="aui_thread-list-group-unread"
                          className="bg-blue-500 size-1.5 shrink-0 rounded-full group-hover/proj:opacity-0"
                        />
                      )}
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
                    <TreeRow position={i} instant={pinReorder}>
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
>(({ className, labelClassName, children, onClick, ...props }, ref) => {
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
        onClick={(e) => {
          // 动作驱动清"最近打开的会话"指针（与外层 New 的框架切换合成执行），
          // 刷新后不再回旧会话（2026-09-22 修复）。
          // 同时清 workspace：新对话一律从"未选择目录"开始，杜绝静默继承上一个
          // 会话的目录（曾致"没选目录却总在某目录执行"）；旧目录靠 recents 一键可达。
          clearLastThread();
          clearWorkspace();
          onClick?.(e);
        }}
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

/** 会话标题：溢出时右缘渐隐（shadcn scroll-fade-e 的等效形态）取代省略号，
 *  hover 左滚展示全文期间同样保留（文字从渐隐下滚过，即真实滚动容器的观感）。
 *  不挂工具类而走内联 mask：scroll-fade-e 依赖 @property + animation-timeline
 *  + 嵌套 @supports 的机制，在 Tauri 的 WKWebView 上不可靠（实测无效果）；
 *  这里直接写等价 mask 渐变，并仍按实测溢出施加（短标题不蚀尾字）。 */
const TITLE_FADE =
  "linear-gradient(to right, #000 calc(100% - 16px), transparent)";
const MarqueeTitle: FC<
  ComponentPropsWithoutRef<"span"> & { children: ReactNode }
> = ({ className, children, ...props }) => {
  const outerRef = useRef<HTMLSpanElement>(null);
  const [dx, setDx] = useState(0);
  const [overflows, setOverflows] = useState(false);

  const measure = () => {
    const el = outerRef.current;
    if (el) setOverflows(el.scrollWidth - el.clientWidth > 1);
  };

  useLayoutEffect(() => {
    measure();
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // children 变化（改名/标题生成）后重测
  }, [children]);

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
      // 截断时：mask 渐隐收尾（蚀字而非叠色，任何底色自适应），省略号退役；
      // 未截断保持原样。text-overflow 只对行内 inline-level 溢出生效，
      // 所以内层用 inline-block 而非 block。
      style={
        overflows
          ? {
              textOverflow: "clip",
              WebkitMaskImage: TITLE_FADE,
              maskImage: TITLE_FADE,
            }
          : undefined
      }
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
  // 置顶状态（localStorage 集合，remoteId 为键；未落盘会话恒 false）
  const pinned = useIsPinned(remoteId);
  // 定时任务出身标记（run_done 帧记账的 session→task 映射）：⚡ 徽标 + 定位
  const automationTaskId = useAutomationTaskIdForSession(remoteId);
  // 列表快照的 title 只在整表 reload 时刷新；智能标题/改名经 wire 回流到
  // 本地实时标题表（见 pi-thread-titles），优先取它，取不到再回落快照
  const snapshotTitle = useAuiState((s) => s.threadListItem.title);
  const liveTitle = useThreadTitle(remoteId);
  const title = liveTitle ?? snapshotTitle ?? "";
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
  // 挂起交互徽标：台账键 = sessionId = 本行 remoteId，后台会话卡在审批上时
  // 侧边栏同样点亮（行不必被打开）。徽标比用时优先，两者互斥。
  const pendingKind = usePendingInteractionKind(remoteId);
  const pendingBadge = pendingKind ? PENDING_BADGE[pendingKind] : null;
  const [renameOpen, setRenameOpen] = useState(false);
  // 删除二次确认：菜单里的「删除」只打开 AlertDialog，确认后才真正调 delete
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // 未读标记（键 = remoteId = item id，新链路同值；草稿无 remoteId 恒已读）
  const unread = useIsThreadUnread(remoteId);
  // 批量模式：行首换勾选框、点击行切换选中（不激活会话）
  const batchActive = useThreadBatchActive();
  const batchSelected = useIsThreadBatchSelected(remoteId ?? "");
  // 行菜单定义（"…"下拉与右键菜单共用一份，见 useThreadRowMenu）
  const rowMenu = useThreadRowMenu({
    onRename: () => setRenameOpen(true),
    onAskDelete: () => setDeleteOpen(true),
  });
  // 右键落点（虚拟锚点）：null = 菜单关闭。批量模式与草稿行不唤起
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

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
      className="group focus-visible:bg-selected data-active:bg-selected has-focus-visible:bg-selected has-data-[state=open]:bg-selected relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none data-[batch-selected]:bg-selected"
      data-batch-selected={batchActive && batchSelected ? "true" : undefined}
      onContextMenu={(e) => {
        // 批量模式不唤起（勾选流里右键语义未定义）；草稿行无可操作项。
        // 右键锚在鼠标落点（虚拟锚点单例，见下方 ContextMenu）
        if (batchActive || rowMenu.isNew) return;
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {batchActive ? (
        /* 批量模式：行整体是勾选切换（不激活会话）；未落盘会话（无
           remoteId）不可归档，勾选框禁用置灰 */
        <button
          type="button"
          role="checkbox"
          aria-checked={batchSelected}
          aria-disabled={!remoteId}
          data-slot="aui_thread-list-item-batch-trigger"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (remoteId) toggleThreadBatchSelect(remoteId);
          }}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md ps-2.5 text-start text-sm outline-none"
        >
          <span
            aria-hidden
            className={cn(
              "grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors",
              batchSelected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-muted-foreground/40",
              !remoteId && "opacity-40",
            )}
          >
            {batchSelected && <CheckIcon className="size-3" />}
          </span>
          <MarqueeTitle
            data-slot="aui_thread-list-item-title"
            className={cn("me-3", unread && "font-medium")}
          >
            {title || "新对话"}
          </MarqueeTitle>
        </button>
      ) : (
        <ThreadListItemPrimitive.Trigger
          data-slot="aui_thread-list-item-trigger"
          // 右侧槽位常驻宽度随该槽内容切换：more 按钮/用时是 pe-9(36px)，
          // 挂起徽标「等待审批」四个汉字 @text-xs 约 48px，放不下会压到标题
          // 右缘，故挂起时放宽到 pe-14(56px)，并撤掉标题自留的 me-3
          className={cn(
            "group focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center rounded-md pe-9 ps-2.5 text-start text-sm outline-none focus-visible:ring-1",
            pendingBadge && "pe-14",
          )}
        >
          {/* Loader DOM 常驻，永久占位；hover 时让位给置顶按钮（行首槽位同一位置） */}
          <Loader2Icon
            aria-hidden
            data-slot="aui_thread-list-item-running"
            data-running={showRunning}
            className="
              text-muted-foreground me-1.5 size-3.5 shrink-0 animate-spin
              invisible
              data-[running=true]:visible
              group-hover:data-[running=true]:invisible
            "
          />
          {/* 未读点：占 loader 槽位（运行中让位 spinner、已置顶让位图钉）；
              标题同时加粗，双通道提示（点被盖住时仍有字重可辨）。蓝色区分
              于主题前景色，ChatGPT/Codex 同款未读语义 */}
          {unread && !showRunning && !pinned && (
            <span
              aria-hidden
              data-slot="aui_thread-list-item-unread"
              className="bg-blue-500 absolute start-[14px] top-1/2 size-1.5 -translate-y-1/2 rounded-full group-hover:opacity-0"
            />
          )}
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
          {/* me-3：用时标签是 end-1.5 绝对定位，"12小时"这类长文本会比
              pe-9(36px) 槽位宽、伸进标题右缘；让标题盒提前 12px 收尾，
              渐隐带（16px）与用时不再重叠。挂起徽标占了更宽的槽位，
              宽度已由 trigger 的 pe 让出，这里不再额外收尾 */}
          <MarqueeTitle
            data-slot="aui_thread-list-item-title"
            className={cn(!pendingBadge && "me-3", unread && "font-medium")}
          >
            {liveTitle ?? <ThreadListItemPrimitive.Title fallback="新对话" />}
          </MarqueeTitle>
          {showRunning && <span className="sr-only">Running</span>}
        </ThreadListItemPrimitive.Trigger>
      )}
      {/* 置顶常驻图钉：已置顶且非运行中时占据 loader 槽位（trigger ps-2.5 后的
          14px 位），hover 时淡出让位给下方按钮。运行中仍显示 spinner（临时态
          优先），停跑后图钉回归 */}
      {pinned && !showRunning && !batchActive && (
        <span
          aria-hidden
          data-slot="aui_thread-list-item-pinned"
          className="text-muted-foreground cursor-pointer pointer-events-none absolute start-2.5 top-1/2 grid size-3.5 -translate-y-1/2 place-items-center group-hover:opacity-0"
        >
          <PinIcon className="size-3.5 fill-current" />
        </span>
      )}
      {/* 置顶按钮：绝对定位悬浮在 loader 槽位上（start-[5px] + size-6 grid 居中，
          图标落点 [10,24] 与常驻图钉完全一致）。不用 Button 组件——默认变体的
          bg-primary/h-8/px-3 与 size-6 冲突导致盒子尺寸漂移、图标错位，且其
          active:translate-y-px 会让点击时图标下移。运行中 hover 同样出现并盖过
          spinner；图标恒定不随状态切换（点击只切换置顶，状态由常驻图钉表达）。
          停止入口只在输入框（侧边栏 stop 按钮已按需求移除） */}
      {remoteId && !batchActive ? (
        <button
          data-slot="aui_thread-list-item-pin"
          title={pinned ? "取消置顶" : "置顶"}
          aria-label={pinned ? "取消置顶" : "置顶"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePinSession(remoteId);
          }}
          className="text-muted-foreground hover:bg-muted hover:text-foreground absolute start-[5px] top-1/2 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-has-focus-visible:opacity-100"
        >
          <PinIcon className="size-3.5" />
        </button>
      ) : null}
      {/* 用时与 more 按钮同位（end-1.5 的绝对槽位），选中行也显示；显隐条件
          与 more 严格互补（hover / 键盘焦点 / 菜单展开时 more 出现，此处隐藏）。
          双方都瞬时切换、不带透明度过渡，避免交叉淡出期间两个同时可见。
          trigger 常驻 pe-9 为该槽位留宽，标题截断在任何状态下不跳动。
          批量模式下 pin/用时/菜单全部让位勾选流 */}
      {!batchActive && !pendingBadge && elapsed && (
        <span
          data-slot="aui_thread-list-item-elapsed"
          title={showRunning ? "正在运行" : "距最后一条消息的时间"}
          className="text-muted-foreground pointer-events-none absolute end-1.5 top-1/2 -translate-y-1/2 text-xs leading-none tabular-nums opacity-100 group-hover:opacity-0 group-has-focus-visible:opacity-0 group-has-data-[state=open]:opacity-0"
        >
          {elapsed}
        </span>
      )}
      {/* 挂起徽标与用时同位、互斥出图，并同样给 more 按钮让位（hover /
          键盘焦点 / 菜单展开即隐）。切换瞬时无淡入淡出：与用时、more 三者
          共享一个槽位，任何交叉淡出都会出现两段文字同时可见 */}
      {!batchActive && pendingBadge && (
        <span
          data-slot="aui_thread-list-item-pending"
          title={pendingBadge.title}
          className="text-amber-600 dark:text-amber-400 pointer-events-none absolute end-1.5 top-1/2 -translate-y-1/2 text-xs leading-none whitespace-nowrap group-hover:opacity-0 group-has-focus-visible:opacity-0 group-has-data-[state=open]:opacity-0"
        >
          {pendingBadge.label}
        </span>
      )}
      {!batchActive && !rowMenu.isNew && <ThreadListItemMore items={rowMenu.items} />}
      {/* 右键菜单：与「…」下拉同一份 item 定义，锚在鼠标落点（虚拟锚点，
          文件树右键同款模式）；归档/取消归档仍走行作用域 primitive */}
      <ContextMenu
        open={ctxMenu !== null}
        onOpenChange={(open) => {
          if (!open) setCtxMenu(null);
        }}
      >
        {ctxMenu && (
          <ContextMenuContent
            anchor={{
              getBoundingClientRect: () =>
                new DOMRect(ctxMenu.x, ctxMenu.y, 0, 0),
            }}
            className="min-w-44"
          >
            {rowMenu.items.map((item) => {
              if (item.kind === "separator") {
                return <ContextMenuSeparator key={item.key} />;
              }
              const node = (
                <ContextMenuItem
                  disabled={item.disabled}
                  variant={item.destructive ? "destructive" : "default"}
                  onClick={item.onSelect}
                >
                  <item.icon />
                  {item.label}
                </ContextMenuItem>
              );
              if (item.action === "archive") {
                return (
                  <ThreadListItemPrimitive.Archive asChild key={item.key}>
                    {node}
                  </ThreadListItemPrimitive.Archive>
                );
              }
              if (item.action === "unarchive") {
                return (
                  <ThreadListItemPrimitive.Unarchive asChild key={item.key}>
                    {node}
                  </ThreadListItemPrimitive.Unarchive>
                );
              }
              return node;
            })}
          </ContextMenuContent>
        )}
      </ContextMenu>
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

/** 行菜单项统一描述：「…」下拉与右键 ContextMenu 两套渲染共用一份定义，
 *  handler 与顺序单源维护（归档/取消归档是行作用域的 ThreadListItemPrimitive
 *  ActionButton，以 action 标记传递，由渲染端负责包装）。 */
type ThreadRowMenuAction = "archive" | "unarchive";

type ThreadRowMenuItem =
  | {
      kind: "item";
      key: string;
      label: string;
      icon: FC<{ className?: string }>;
      onSelect?: () => void;
      disabled?: boolean;
      destructive?: boolean;
      action?: ThreadRowMenuAction;
    }
  | { kind: "separator"; key: string };

/**
 * 行菜单定义与动作（行作用域：须在 ThreadListItemPrimitive.Root 内调用）。
 * 菜单顺序对齐参考稿：置顶 → 重命名 → 分支 → 归档 → 标记未读 ┃ Finder →
 * 复制路径 → 复制会话 ID → 调用轨迹 ┃ 删除。
 */
const useThreadRowMenu = ({
  onRename,
  onAskDelete,
}: {
  onRename: () => void;
  onAskDelete: () => void;
}): { items: ThreadRowMenuItem[]; isNew: boolean } => {
  const aui = useAui();
  const status = useAuiState((s) => s.threadListItem.status);
  const archived = status === "archived";
  // new：从未发送过消息、还没在后端落盘的会话。core 对 rename/archive/delete
  // 都有状态守卫（只接受 regular/archived），菜单项点了只会被拒绝
  const isNew = status === "new";
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  // 分支进行中标记：按钮置灰防重复点击
  const [branching, setBranching] = useState(false);
  const pinned = useIsPinned(remoteId);
  const unread = useIsThreadUnread(remoteId);

  /**
   * 会话目录解析：「复制路径 / 在 Finder 中打开」共用。项目会话（有 cwd）
   * 指向其工作目录；任务会话指向任务工作区里按会话隔离的子目录
   * （sidecar taskSessionCwd，见 use-panel-cwd.ts 同款口径）。
   */
  const resolveSessionDir = async (
    sessionId: string,
  ): Promise<{ cwd: string; path: string } | null> => {
    const cwd = piSessionCwdMap.get(sessionId);
    if (cwd) return { cwd, path: "." };
    const base = await taskWorkspaceDir();
    return base ? { cwd: base, path: sessionId } : null;
  };

  const revealSessionDir = async () => {
    if (!remoteId) return;
    const dir = await resolveSessionDir(remoteId);
    if (!dir) {
      toast.add({ title: "无法解析会话目录", type: "warning" });
      return;
    }
    const err = await fsReveal(dir.cwd, dir.path);
    if (err) toast.add({ title: fsErrorText(err), type: "warning" });
  };

  const copySessionPath = async () => {
    if (!remoteId) return;
    const dir = await resolveSessionDir(remoteId);
    if (!dir) {
      toast.add({ title: "无法解析会话目录", type: "warning" });
      return;
    }
    try {
      await navigator.clipboard.writeText(
        dir.path === "." ? dir.cwd : `${dir.cwd}/${dir.path}`,
      );
      toast.add({ title: "已复制路径", type: "success" });
    } catch {
      toast.add({ title: "复制失败", type: "warning" });
    }
  };

  const copySessionId = async () => {
    if (!remoteId) return;
    try {
      await navigator.clipboard.writeText(remoteId);
      toast.add({ title: "已复制会话 ID", type: "success" });
    } catch {
      toast.add({ title: "复制失败", type: "warning" });
    }
  };

  /** 调用轨迹面板：与顶栏「更多」同款（面板开合经事件请求展开） */
  const openTracePanel = () => {
    if (!remoteId) return;
    openPanelTab("trace", { sessionId: remoteId });
    window.dispatchEvent(new Event("agent-panel:open"));
  };

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

  const desktop = isTauri();

  const items: ThreadRowMenuItem[] = [
    ...(remoteId
      ? ([
          {
            kind: "item",
            key: "pin",
            label: pinned ? "取消置顶" : "置顶任务",
            icon: pinned ? PinOffIcon : PinIcon,
            onSelect: () => togglePinSession(remoteId),
          },
        ] satisfies ThreadRowMenuItem[])
      : []),
    {
      kind: "item",
      key: "rename",
      label: "重命名任务",
      icon: PencilIcon,
      onSelect: onRename,
    },
    ...(remoteId
      ? ([
          {
            kind: "item",
            key: "branch",
            label: "分支对话",
            icon: GitBranchIcon,
            onSelect: () => void branch(),
            disabled: branching,
          },
        ] satisfies ThreadRowMenuItem[])
      : []),
    archived
      ? {
          kind: "item",
          key: "unarchive",
          label: "取消归档",
          icon: ArchiveRestoreIcon,
          action: "unarchive",
        }
      : {
          kind: "item",
          key: "archive",
          label: "归档任务",
          icon: ArchiveIcon,
          action: "archive",
        },
    ...(remoteId
      ? ([
          {
            kind: "item",
            key: "unread",
            label: unread ? "标记为已读" : "标记为未读",
            icon: unread ? MailOpenIcon : MailIcon,
            onSelect: () => toggleSessionUnread(remoteId),
          },
          { kind: "separator", key: "sep-1" },
          ...(desktop
            ? ([
                {
                  kind: "item",
                  key: "reveal",
                  label: "在 Finder 中打开",
                  icon: FolderOpenIcon,
                  onSelect: () => void revealSessionDir(),
                },
                {
                  kind: "item",
                  key: "copy-path",
                  label: "复制路径",
                  icon: CopyIcon,
                  onSelect: () => void copySessionPath(),
                },
              ] satisfies ThreadRowMenuItem[])
            : []),
          {
            kind: "item",
            key: "copy-id",
            label: "复制会话 ID",
            icon: HashIcon,
            onSelect: () => void copySessionId(),
          },
          {
            kind: "item",
            key: "trace",
            label: "查看调用轨迹",
            icon: WaypointsIcon,
            onSelect: openTracePanel,
          },
          { kind: "separator", key: "sep-2" },
        ] satisfies ThreadRowMenuItem[])
      : []),
    {
      kind: "item",
      key: "delete",
      label: "删除",
      icon: TrashIcon,
      onSelect: onAskDelete,
      destructive: true,
    },
  ];

  return { items, isNew };
};

/** 「…」下拉（ThreadListItemMorePrimitive）渲染端：item 定义来自
 *  useThreadRowMenu（行组件持有，右键菜单共用） */
const ThreadListItemMore: FC<{ items: ThreadRowMenuItem[] }> = ({ items }) => {
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
        {items.map((item) =>
          item.kind === "separator" ? (
            <ThreadListItemMorePrimitive.Separator
              key={item.key}
              className="bg-foreground/10 -mx-1.5 my-1 h-px"
            />
          ) : item.action ? (
            item.action === "archive" ? (
              <ThreadListItemPrimitive.Archive asChild key={item.key}>
                <MoreItemShell item={item} />
              </ThreadListItemPrimitive.Archive>
            ) : (
              <ThreadListItemPrimitive.Unarchive asChild key={item.key}>
                <MoreItemShell item={item} />
              </ThreadListItemPrimitive.Unarchive>
            )
          ) : (
            <MoreItemShell key={item.key} item={item} />
          ),
        )}
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};

/** 「…」菜单 item 外壳：与既有条目同款样式。
 *  归档/取消归档经 ThreadListItemPrimitive.Archive/Unarchive 的 asChild 包装
 *  注入 onClick——必须把 rest props 透传给真实菜单项，否则 onClick 被组件
 *  吞掉，菜单项点了没反应（右键菜单无此问题：其子元素本身就是可收 props 的
 *  ContextMenuItem）。 */
const MoreItemShell: FC<{
  item: Extract<ThreadRowMenuItem, { kind: "item" }>;
} & ComponentProps<typeof ThreadListItemMorePrimitive.Item>> = ({
  item,
  ...rest
}) => (
  <ThreadListItemMorePrimitive.Item
    {...rest}
    data-slot="aui_thread-list-item-more-item"
    className={
      item.destructive
        ? "text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
        : "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none disabled:cursor-not-allowed disabled:opacity-50"
    }
    disabled={item.disabled}
    onSelect={item.onSelect}
  >
    <item.icon className="size-4" />
    {item.label}
  </ThreadListItemMorePrimitive.Item>
);
