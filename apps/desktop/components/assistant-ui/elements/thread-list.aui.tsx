"use client";

import { Button } from "@/components/ui/button";
import { DotMatrix } from "@/components/ui/dot-matrix";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { HoverScrollText } from "@/components/ui/hover-scroll-text";
import { cn } from "@/lib/utils";
import { useRemoteProjects } from "@/lib/workspace/remote-projects";
import {
  threadListSkeletonCondition,
  useThreadItems,
} from "@/lib/thread-list/thread-items";
import {
  clearPendingThreadSelection,
  markPendingThreadSelection,
  pendingThreadSelection,
  usePendingThreadSelection,
} from "@/lib/thread-list/pending-selection";
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
  ArrowRightLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderClosedIcon,
  FolderInputIcon,
  FolderOpenIcon,
  GitBranchIcon,
  HashIcon,
  ListChecksIcon,
  ListFilterIcon,
  MailIcon,
  MailOpenIcon,
  Maximize2Icon,
  Minimize2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SquareCheckBigIcon,
  TrashIcon,
  WaypointsIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/motion/ease";
import { useT } from "@/lib/i18n";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  forkPiSession,
  piSessionCwdMap,
  piSessionIdForThread,
  piSessionProjectIdMap,
  piSessionProjectMap,
  piSessionRegistry,
  useSessionPrefsVersion,
} from "@/lib/pi/pi-thread-adapter";
import { openMoveSessionDialog } from "@/components/agent-thread/move-session-dialog";
import {
  projectAppearanceOf,
  projectDisplayName,
  projectGroupKey,
  projectPrimaryPath,
  useProjectRegistry,
} from "@/lib/pi/pi-projects";
import { ensureLegacyProjectMetaMigrated } from "@/lib/projects/legacy-migration";
import { PI_THREAD_MISSING_EVENT } from "@/lib/pi/pi-runtime/runtime/thread-missing";
import { moveSessionToDirectory } from "@/lib/pi/pi-session-move";
import {
  SessionDragContext,
  SessionDragGhost,
  useIsSessionDragged,
  useSessionDragController,
  useSessionDragOverCwd,
  useSessionDragOverProjectId,
} from "./session-drag";
import { clearLastThread } from "@/lib/pi/pi-last-thread";
import {
  findProjectByPath,
  isPurgedFolderCwd,
  usePurgedFoldersVersion,
} from "@/lib/pi/pi-projects";
import { threadListEmptyState } from "@/lib/pi/pi-thread-list-empty";
import { isSessionRunning, usePiSessionRunning } from "@/lib/pi/pi-running";
import {
  getUnreadSessions,
  markSessionRead,
  markSessionUnread,
  toggleSessionUnread,
  useIsThreadUnread,
  useUnreadSessionIds,
} from "@/lib/pi/pi-unread-sessions";
import { getPinnedSessions } from "@/lib/pi/pi-pinned-sessions";
import {
  collectAutoArchiveCandidates,
  getRestoredSessions,
  useAutoArchivePrefs,
} from "@/lib/pi/pi-auto-archive";
import {
  enterThreadBatch,
  exitThreadBatch,
  setThreadBatchSelection,
  setThreadBatchVisible,
  toggleThreadBatchSelect,
  useIsThreadBatchSelected,
  useThreadBatchActive,
  useThreadBatchState,
  type ThreadBatchTab,
} from "@/lib/pi/pi-thread-batch";
import { subscribeAgentEvents } from "@/lib/pi/agent-events";
import { openPanelTab } from "@/lib/panels/panel-tabs";
import {
  fsErrorText,
  fsReveal,
} from "@/lib/workspace/fs";
import { taskWorkspaceDir } from "@/lib/workspace/task-workspace";
import { isDesktop } from "@/lib/desktop-env";
import { refreshGitStatus } from "@/lib/git/git-status";
import {
  togglePinSession,
  useIsPinned,
  usePinnedSessionIds,
} from "@/lib/pi/pi-pinned-sessions";
import {
  togglePinProject,
  usePinnedProjectIds,
} from "@/lib/pi/pi-pinned-projects";
import { useThreadActivity } from "@/lib/pi/pi-last-activity";
import { useThreadTitle } from "@/lib/pi/pi-thread-titles";
import {
  THREAD_TIME_RANGES,
  setThreadTimeRange,
  threadRangeStart,
  threadTimeRangeLabel,
  useThreadTimeRange,
  type ThreadFilterScope,
  type ThreadTimeRange,
} from "@/lib/pi/pi-thread-filter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  usePendingInteractionKind,
  type PendingInteractionKind,
} from "@/lib/pi/pi-interactions";
import { useSessionAppMode } from "@/lib/pi/pi-session-app-mode";
import { APP_MODE_META } from "@/lib/pi/app-mode-meta";
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
  pathBasename,
  setWorkspace,
  useWorkspace,
} from "@/lib/workspace/workspace-store";
import {
  projectLabelFor,
  useProjectDisplayNamesVersion,
  useProjectLabel,
} from "@/lib/projects/project-display-name";
import { WorkspaceCreateDialog } from "@/components/agent-thread/workspace-create-dialog";
import {
  hasProjectAppearance,
  projectAppearanceFor,
  useProjectAppearancesVersion,
} from "@/lib/projects/project-appearance";
import { ProjectBadge, projectColorTokens } from "@/components/ui/project-badge";
import { ProjectSettingsPopover } from "@/components/agent-thread/project-settings-popover";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  createContext,
  memo,
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
import { openHandoffDialog } from "@/components/agent-thread/handoff-dialog";
import {
  useFluidHover,
  useFluidHoverRegister,
  useRegisterFluidHoverItem,
} from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import { FluidHoverRow } from "@/components/fluid-hover-row";
import { FluidHoverScope } from "@/components/fluid-hover-scope";
import { TooltipIconButton } from "./tooltip-icon-button";

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

/** 项目文件夹内的会话行：标题相对组头缩进一个文件夹徽章位，让
 *  「文件夹 → 会话」的层级可辨（统一列表的行首一律不画档位图标） */
const ProjectChildRowContext = createContext(false);

/** 置顶卡顶部平铺的会话行：行首画图钉（取代模式图标），与分区头呼应 */
const PinnedRowContext = createContext(false);

/** 任务区的会话行：只做轻缩进（ps-6）与分区头拉开层级，不隐藏行首模式图标 */
const IndentedRowContext = createContext(false);

/**
 * 在 FluidHoverScope 的 children 内组装行槽位：registerItem 从作用域 context
 * 读（悬浮状态关在 Scope 里，换行高亮不重渲染列表主体，见 fluid-hover-scope），
 * index 由调用点按渲染序传入。脱离 Scope 渲染时 registerItem 落 noop——行
 * 照常显示，只是不参与高亮滑动。
 */
const ScopeRowSlot: FC<{ index: number; children: ReactNode }> = ({
  index,
  children,
}) => {
  const registerItem = useFluidHoverRegister();
  return (
    <RowHoverContext.Provider
      value={{ registerItem: registerItem ?? noopRegister, index }}
    >
      {children}
    </RowHoverContext.Provider>
  );
};
const noopRegister: RegisterItem = () => {};

// ---------------------------------------------------------------------------
// 会话树展开动画 —— 移植 components/custom-ui/file-tree.tsx 的动效配方：
//   1. TreeRow：新行以 opacity 0 / y -6 级联淡入（组内行序 × 0.02s，封顶
//      0.06s——延迟必须用组内相对序号，用全局槽位会让靠后的分组永远吃满
//      延迟、展开显得慢半拍），行被增删挤动时靠 layout="position" 的
//      SPRING_LAYOUT 平滑归位；项目卡内部例外（enter=false）——那里由面板
//      整体高度 + 淡入淡出承担，对齐 侧边栏的文件夹开合；
//   2. 项目文件夹图标保持闭合态，开合只由折叠面板与行展开表达。
// 收起时子树直接卸载、无退场动画，与 file-tree 的 flatten+挂载模型一致；
// 项目卡面板会先用 300ms 高度关键帧收起到 0 再卸载。
// 行高亮测量走 offsetTop（见 use-fluid-hover 注释），不受这里的 transform
// 影响，fluid hover 与动画可共存。useReducedMotion 下全部短路为静态。
// ---------------------------------------------------------------------------

const ROW_ENTER = { duration: 0.18, ease: EASE_OUT } as const;

/** 树行动画壳：外层只管 layout 滑移归位，内层只管入场级联淡入。二者必须分离
 *  ——layout 的位移投影与 animate 的 y 共享同一运动值时，投影过渡会被入场
 *  过渡（0.18s ease + delay）接管，换位仍会滑一段。instant：本次提交换位瞬时
 *  完成（外层 transition 时长置 0），置顶切换不让按钮在指针下飘走 */
const TreeRow: FC<{
  position: number;
  instant?: boolean;
  /** false：挂载时不跑逐行级联淡入（项目卡内部改用面板整体淡入，
   *  对齐 侧边栏的文件夹开合） */
  enter?: boolean;
  children: ReactNode;
}> = ({ position, instant, enter = true, children }) => {
  const reduce = useReducedMotion() ?? false;
  const skipEnter = reduce || !enter;
  return (
    <motion.div
      layout={reduce ? false : "position"}
      transition={reduce || instant ? { duration: 0 } : SPRING_LAYOUT}
    >
      <motion.div
        initial={skipEnter ? false : { opacity: 0, y: -6 }}
        animate={{
          opacity: 1,
          y: 0,
          transition: skipEnter
            ? { duration: 0 }
            : { ...ROW_ENTER, delay: Math.min(position * 0.02, 0.06) },
        }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
};

/** 侧栏项目图标槽：有外观（24px 徽章）与无外观（16px 文件夹图标）共用同一
 *  宽度，保证多项目列表里标题起始位置一致 */
const PROJECT_ICON_SLOT = "size-6 shrink-0";
const PROJECT_BADGE_CLASS = cn(PROJECT_ICON_SLOT, "rounded-md [&>svg]:size-4");

// ---------------------------------------------------------------------------
// 会话行右侧「距最后一条消息多久」的粗粒度显示：近 7 天用相对时间
// （刚刚 / N分钟前 / N小时前 / N天前），更早显示日期（同年 M月D日，跨年
// 用 YYYY/M/D——CJK 全格式对 7 字以上日期太宽，会压进标题的渐隐带）。
// 渲染时算一次的固定值，不做心跳——秒表式跳动不是预期交互；数值随后续
// 列表/状态更新自然刷新。
// ---------------------------------------------------------------------------

const formatElapsed = (at: number, now: number): string => {
  const total = Math.floor((now - at) / 1000);
  if (total < 60) return "刚刚";
  const min = Math.floor(total / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}天前`;
  const date = new Date(at);
  if (date.getFullYear() !== new Date(now).getFullYear()) {
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
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

// ---------------------------------------------------------------------------
// 分区折叠状态：统一分区列表（置顶 / 任务 / 项目）的开合，localStorage
// 持久化（ui.thread-section-collapsed，JSON 数组）。桌面 / 移动两份宿主
// 各自实例化，折叠选择经存储共享
// ---------------------------------------------------------------------------

type ThreadSectionKey = "pinned" | "tasks" | "projects";
const SECTION_COLLAPSED_KEY = "ui.thread-section-collapsed";

const readCollapsedSections = (): Set<ThreadSectionKey> => {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(SECTION_COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter(
        (value): value is ThreadSectionKey =>
          value === "pinned" || value === "tasks" || value === "projects",
      ),
    );
  } catch {
    return new Set();
  }
};

/** 移动端抽屉的列表入口：目录选择 + 统一分区列表（置顶 / 任务 / 项目）。
 *  新对话入口在抽屉菜单里，这里不再重复 */
export const ThreadList: FC<{
  openDirs?: Set<string>;
  onOpenDirsChange?: (next: Set<string>) => void;
}> = ({ openDirs, onOpenDirsChange }) => (
  <ThreadListRoot>
    <WorkspacePicker />
    <ThreadListItems openDirs={openDirs} onOpenDirsChange={onOpenDirsChange} />
  </ThreadListRoot>
);

/** 当前 workspace 选择器：点击打开「新建工作区」对话框，创建后作为新会话的 cwd */
const WorkspacePicker: FC = () => {
  const workspace = useWorkspace();
  const workspaceLabel = useProjectLabel(workspace);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        data-slot="aui_thread-list-workspace"
        onClick={() => setCreateOpen(true)}
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
          {workspace ? (workspaceLabel ?? pathBasename(workspace)) : "选择工作目录"}
        </span>
      </Button>
      <WorkspaceCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </>
  );
};

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
 * 自动归档扫描器（挂 ThreadListRoot 内，仅桌面端生效）：启动后与每 24h
 * 一轮，把「已完成（regular 且不在运行）、无未读、未置顶、超过保留期、
 * 非当前打开」的会话静默归档（用户选定：不弹 toast）。保留期自最近一次
 * 恢复重新起算（恢复时刻登记见 lib/pi/pi-auto-archive.ts）——否则恢复的
 * 旧会话仍满足超期条件，下一轮立刻被收回（2026-10-28 用户报）。归档走与
 * 行菜单同款 primitive（→ sidecar archive_session），设置 → 归档页可恢复。
 * - 判定读的全是本地 store（置顶/未读/恢复时刻）+ 运行中投影，所以扫描
 *   必须在渲染层做；配置见 lib/pi/pi-auto-archive.ts
 * - 60s 心跳只为"列表加载完成后尽快补跑首轮"与到点触发，tick 本体是
 *   一次时间比较，未到期近零成本；开关/保留期变化即重置到期时刻
 *   （打开开关 → 下一分钟内先跑一轮）
 */
const AUTO_ARCHIVE_TICK_MS = 60 * 1000;
const AUTO_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const ThreadAutoArchiver: FC = () => {
  const aui = useAui();
  const threadItems = useThreadItems();
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const prefs = useAutoArchivePrefs();

  const itemsRef = useRef(threadItems);
  itemsRef.current = threadItems;
  const mainRef = useRef(mainThreadId);
  mainRef.current = mainThreadId;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    if (!isDesktop() || !prefs.enabled) return;
    // 0 = 待跑首轮（含开关/保留期变化后的重新对齐）
    let nextRunAt = 0;
    const tick = () => {
      const now = Date.now();
      if (now < nextRunAt) return;
      const items = itemsRef.current;
      if (items.length === 0) return; // 列表未就绪：下一心跳再试
      nextRunAt = now + AUTO_ARCHIVE_INTERVAL_MS;
      const keep = new Set<string>();
      const current = mainRef.current;
      if (current) {
        keep.add(current);
        const bound = piSessionRegistry.get(current);
        if (bound) keep.add(bound);
      }
      const candidates = collectAutoArchiveCandidates({
        items: items.map((item) => ({
          id: item.id,
          remoteId: item.remoteId,
          status: item.status,
          lastMessageAt: item.lastMessageAt,
        })),
        pinnedIds: new Set(getPinnedSessions()),
        unreadIds: new Set(getUnreadSessions()),
        restoredAts: getRestoredSessions(),
        isRunning: isSessionRunning,
        keepIds: keep,
        retentionDays: prefsRef.current.retentionDays,
        nowMs: now,
      });
      for (const id of candidates) {
        // 静默尽力而为：单条失败（会话恰好被另一端删了等）跳过等下一轮
        try {
          void Promise.resolve(aui.threads.item({ id }).archive()).catch(
            () => {},
          );
        } catch {
          // 行已不在列表：同样等下一轮
        }
      }
    };
    tick();
    const timer = setInterval(tick, AUTO_ARCHIVE_TICK_MS);
    return () => clearInterval(timer);
  }, [aui, prefs.enabled, prefs.retentionDays]);

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
  const aui = useAui();

  // 点击了索引里已不存在的会话（陈旧行/过期指针）：刷新清单位置。
  // 缺行错误本身由 runtime 的 fetch 标记为 silent，不在这里抛给界面
  useEffect(() => {
    const onMissing = () => {
      void aui.threads.reload().catch(() => {});
    };
    window.addEventListener(PI_THREAD_MISSING_EVENT, onMissing);
    return () => window.removeEventListener(PI_THREAD_MISSING_EVENT, onMissing);
  }, [aui]);

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
      <ThreadAutoArchiver />
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
> & {
  searchQuery?: string;
  /** 项目分组展开状态（受控，供「展开全部」与移动会话后自动展开共用） */
  openDirs?: Set<string>;
  onOpenDirsChange?: (next: Set<string>) => void;
};

export const ThreadListItems: FC<ThreadListItemsProps> = ({
  className,
  searchQuery = "",
  openDirs,
  onOpenDirsChange,
  ...props
}) => {
  // 本容器的行共用一块滑动高亮；行在 ThreadListItemGroups 里按槽位注册。
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(listRef);
  // 乐观选中的退场：store 把 mainThreadId 推进到点击的行即清（否则留给
  // pending 自己的看门狗兜底）。挂在列表容器上只订阅一条 primitive 切片。
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  useEffect(() => {
    if (mainThreadId && pendingThreadSelection() === mainThreadId) {
      clearPendingThreadSelection();
    }
  }, [mainThreadId]);

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
      {/* 骨架只在"还没有任何数据"时出：后台整表 reload（跨端同步/定时任务结算）
          期间保留已渲染列表，否则每次 reload 都把列表整块换成骨架 */}
      <AuiIf condition={threadListSkeletonCondition}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !threadListSkeletonCondition(s)}>
        <ThreadListItemGroups
          searchQuery={searchQuery}
          registerItem={hover.registerItem}
          openDirs={openDirs}
          onOpenDirsChange={onOpenDirsChange}
        />
      </AuiIf>
    </motion.div>
  );
};

export type ThreadListProjectGroup = {
  /** 稳定分组键：projectId 优先（共享 primary 的两个项目不串折叠/分页） */
  key: string;
  /** 项目工作目录（完整路径；新建对话/拖拽落点用） */
  cwd: string;
  /** 目录 basename，作显示名 */
  label: string;
  /** 项目实体 id（新模型；旧会话/无项目为空） */
  projectId?: string;
  /** 该目录命中远程项目时带上项目名（组头显示「远程」徽标） */
  remoteName?: string;
  indices: number[];
  /** 项目置顶卡：组内会话已全部全局置顶时不显示「还没有会话」空态 */
  hideEmptyHint?: boolean;
};

export type ThreadListGroups = {
  threadIds: readonly string[];
  filteredIndices: number[];
  /** 置顶：任务会话（无 cwd）命中置顶集合的，最近活动倒序 */
  pinnedIndices: number[];
  /** 置顶：项目会话置顶后跳出所属文件夹，最近活动倒序 */
  pinnedProjectIndices: number[];
  /** 置顶（统一展示）：上面两组合并为一组，最近活动倒序 */
  mergedPinnedIndices: number[];
  /** 置顶项目：以项目卡形式进置顶分区（含组内会话，不重复平铺） */
  pinnedProjectGroups: ThreadListProjectGroup[];
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
 * 组内按最近活动倒序。统一分区列表的展示顺序：置顶（任务+项目合并）→
 * 项目 → 任务。
 */
export const useThreadListGroups = (searchQuery = ""): ThreadListGroups => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useThreadItems();
  const pinnedIds = usePinnedSessionIds();
  const pinnedProjectIds = usePinnedProjectIds();
  // 时间筛选分区独立：任务会话按任务区间卡，项目会话按项目区间卡
  const tasksRange = useThreadTimeRange("tasks");
  const projectsRange = useThreadTimeRange("projects");
  // 项目归属（projectCwd）不在 thread item 元数据里：项目目录变更时清单对象
  // 可能逐字段相同，只靠 threadItems 依赖不会重算分组。摘要落库即自增的版本号
  // 是这里唯一的稳定信号（applySessionSummaries 每次都会 bump）。
  const summariesVersion = useSessionPrefsVersion();
  // 项目自定义显示名：改名后分组标签要立即刷新（cwd 本身没变）
  const displayNamesVersion = useProjectDisplayNamesVersion();
  // 项目实体注册表：空项目展示与 DB 名称/外观的事实源
  const projects = useProjectRegistry();
  // 已彻底删除项目的残留目录：不降级成 cwd 分组（与「从侧栏移除」同语义）
  const purgedFoldersVersion = usePurgedFoldersVersion();
  void purgedFoldersVersion;
  // 启动闸门内加载一次项目实体；随后补跑 localStorage 旧元数据迁移
  // （桌面侧栏不渲染 WorkspacePicker，迁移不能再挂在那个组件上）
  useEffect(() => {
    void import("@/lib/pi/pi-projects")
      .then(({ initProjectRegistry }) => initProjectRegistry())
      .then(() => ensureLegacyProjectMetaMigrated());
  }, []);
  // 远程项目清单：组头「远程」徽标的事实源；清单变化要重算分组
  const { projects: remoteProjects } = useRemoteProjects();
  const remoteSignature = remoteProjects
    .map((p) => `${p.id}\0${p.remotePath}\0${p.name}`)
    .join("\x01");

  const query = searchQuery.trim().toLowerCase();

  return useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const searchedIndices = threadIds
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

    const taskStart = threadRangeStart(tasksRange);
    const projectStart = threadRangeStart(projectsRange);

    // 分组键：项目虚拟目录优先（附加根里的会话回主目录，多代码工程合并成一张卡）；
    // 没有项目归属时回落会话自己的 cwd。空 cwd = 任务
    const cwdOf = (id: string) => {
      const remoteId = itemsById.get(id)?.remoteId;
      if (!remoteId) return "";
      return (
        piSessionProjectMap.get(remoteId) ||
        piSessionCwdMap.get(remoteId) ||
        ""
      );
    };

    // 置顶分三类：任务会话、项目会话（跳出所属文件夹）、整个项目（项目卡
    // 进置顶分区）。项目内会话不再单独平铺，避免与项目卡重复。
    const pinnedSet = new Set(pinnedIds);
    // 置顶项目与注册表取交集：已删除/隐藏/归档的 id 惰性忽略
    const visibleProjectIds = new Set(
      projects
        .filter((project) => !project.archived && !project.hiddenFromSidebar)
        .map((project) => project.id),
    );
    const pinnedProjectSet = new Set(
      pinnedProjectIds.filter((id) => visibleProjectIds.has(id)),
    );

    // 单趟完成时间筛选与分桶：会话按自己所属分区的区间卡（置顶跟随归属），
    // 没有时间戳的（刚建还没聊过）当"新"处理——它们不是旧会话，任何区间
    // 都留着，否则新建一个空会话就会被筛选吃掉。
    const filteredIndices: number[] = [];
    const pinnedIndices: number[] = [];
    const pinnedProjectIndices: number[] = [];
    const taskIndices: number[] = [];
    const remoteByPath = new Map(
      remoteProjects.map((p) => [p.remotePath.replace(/\/+$/, ""), p]),
    );
    const projectByIdMap = new Map(projects.map((project) => [project.id, project]));
    // 分组键：有 projectId 用项目实体 id，旧会话才回落 cwd。共享同一
    // primary 的两个项目必须各自成卡——不能再拿 cwd 当身份（否则卡片
    // 的名字/图标/「+」会被组内最新会话的项目“劫持”）。
    type ProjectBucket = {
      key: string;
      cwd: string;
      projectId?: string;
      indices: number[];
    };
    const buckets = new Map<string, ProjectBucket>();
    for (const index of [...searchedIndices].sort((a, b) => time(b) - time(a))) {
      const at = dates[index];
      const remoteId = itemsById.get(threadIds[index])?.remoteId;
      const pinned = remoteId !== undefined && pinnedSet.has(remoteId);
      const cwd = cwdOf(threadIds[index]);
      const rangeStart = cwd ? projectStart : taskStart;
      if (at && rangeStart != null && at.getTime() < rangeStart) continue;
      if (!cwd) {
        filteredIndices.push(index);
        if (pinned) pinnedIndices.push(index);
        else taskIndices.push(index);
        continue;
      }
      const rawProjectId = remoteId
        ? piSessionProjectIdMap.get(remoteId)
        : undefined;
      const rawEntity = rawProjectId
        ? projectByIdMap.get(rawProjectId)
        : undefined;
      // 已从侧栏移除的项目：常态下卡片和会话分组都不出现（移除 = 从侧栏
      // 移除，不是降级成 cwd 历史分组）；只在主动搜索时按 cwd 兜底展示，
      // 保证“会话仍可被搜到”。
      const hidden = Boolean(rawEntity?.hiddenFromSidebar);
      if (hidden && !query) continue;
      // 已彻底删除项目的目录：常态下残留会话不再降级成 cwd 历史分组
      //（与「从侧栏移除」同语义）；主动搜索时仍按 cwd 兜底展示。
      // 目录若已被（新建/恢复的）项目重新占用则不跳过。
      if (
        !query &&
        isPurgedFolderCwd(cwd) &&
        !findProjectByPath(projects, cwd)
      ) {
        continue;
      }
      // 新模型口径：侧栏以工作空间为单位。没有项目归属的 cwd 会话不再降级成
      // cwd 历史分组（那是旧世界的历史包袱，也是彻底删除/移除后“看起来还在”
      // 的根源）；主动搜索时仍按 cwd 兜底展示，保证会话可被搜到。
      // 例外：远程项目会话——sidecar 禁止远程会话绑定本地项目实体
      //（resolve.ts new_session：remote 与 projectId 互斥），它们永远没有
      // projectId，必须按 cwd 归组展示；cwd 命中远程项目清单即放行，
      // 组头据 remoteByPath 带上「远程」徽标（缺失清单的旧远程路径仍按
      // 无归属规则隐藏，可在搜索中找回）。
      const boundProjectId = rawEntity && !hidden ? rawProjectId : undefined;
      const remoteGroup = cwd
        ? remoteByPath.get(cwd.replace(/\/+$/, ""))
        : undefined;
      if (!boundProjectId && !query && !remoteGroup) continue;
      filteredIndices.push(index);
      // 全局置顶是独立于项目置顶的：会话只要本身被置顶就平铺进置顶区，
      // 即使它所属的项目也被置顶（项目卡里不再重复画它）
      if (pinned && !hidden) {
        pinnedProjectIndices.push(index);
        continue;
      }
      const projectId = boundProjectId;
      const entity = projectId ? rawEntity : undefined;
      const key = projectId ? `project:${projectId}` : `cwd:${cwd}`;
      const bucket =
        buckets.get(key) ??
        {
          key,
          cwd: entity ? projectPrimaryPath(entity) || cwd : cwd,
          ...(projectId ? { projectId } : {}),
          indices: [],
        };
      bucket.indices.push(index);
      buckets.set(key, bucket);
    }

    const sessionGroups: ThreadListProjectGroup[] = [...buckets.values()].map(
      (bucket) => {
        const project = remoteByPath.get(bucket.cwd.replace(/\/+$/, ""));
        // 名称/图标以项目实体为准（共享目录/localStorage 缓存可能过期）
        const entity = bucket.projectId
          ? projectByIdMap.get(bucket.projectId)
          : undefined;
        return {
          key: bucket.key,
          cwd: bucket.cwd,
          label: entity ? projectDisplayName(entity) : projectLabelFor(bucket.cwd),
          ...(bucket.projectId ? { projectId: bucket.projectId } : {}),
          ...(project ? { remoteName: project.name } : {}),
          indices: bucket.indices,
        };
      },
    );

    // 空项目（show_when_empty=1）：没有会话也要在侧栏可见，新建工作区后
    // 立刻有落点。搜索/项目时间筛选开启时不展示（它没有任何匹配内容）。
    // 已有会话归属的项目、主目录已被旧 cwd 分组占用的项目不重复添加。
    const assignedProjectIds = new Set<string>();
    for (const id of threadIds) {
      const remoteId = itemsById.get(id)?.remoteId;
      const pid = remoteId ? piSessionProjectIdMap.get(remoteId) : undefined;
      if (pid) assignedProjectIds.add(pid);
    }
    // 只统计“旧会话 cwd 分组”的占用：项目分组按 id 唯一，不会和空项目撞卡
    const occupiedCwds = new Set(
      [...buckets.values()]
        .filter((bucket) => !bucket.projectId)
        .map((bucket) => bucket.cwd.replace(/\/+$/, "")),
    );
    const emptyGroups: ThreadListProjectGroup[] =
      !query && projectStart == null
        ? projects
            .filter((project) => {
              // 置顶项目即使没有会话也要在侧栏可见（否则置顶后反而消失）
              if (
                (!project.showWhenEmpty && !pinnedProjectSet.has(project.id)) ||
                project.archived
              ) {
                return false;
              }
              if (project.hiddenFromSidebar) return false;
              if (assignedProjectIds.has(project.id)) return false;
              const primary = projectPrimaryPath(project);
              if (!primary) return false;
              const key = primary.replace(/\/+$/, "");
              return !occupiedCwds.has(key) && !remoteByPath.has(key);
            })
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((project) => ({
              key: projectGroupKey(project.id, projectPrimaryPath(project)),
              cwd: projectPrimaryPath(project),
              label: projectDisplayName(project),
              projectId: project.id,
              indices: [] as number[],
            }))
        : [];
    const allProjectGroups: ThreadListProjectGroup[] = [
      ...sessionGroups,
      ...emptyGroups,
    ];
    // 置顶项目整体移到置顶分区；「项目」分区不再重复展示
    const pinnedProjectGroups = allProjectGroups.filter(
      (group) =>
        group.projectId !== undefined && pinnedProjectSet.has(group.projectId),
    );
    // 项目本身置顶、但组内会话全部被全局置顶（或暂时没有可见会话）时，
    // 项目卡仍要在置顶区有落点，否则置顶项目会凭空消失。搜索/时间筛选下
    // 不补，保持与普通项目一致的过滤语义。
    if (!query && projectStart == null) {
      const presentProjectIds = new Set(
        pinnedProjectGroups.map((group) => group.projectId),
      );
      for (const project of projects) {
        if (!pinnedProjectSet.has(project.id)) continue;
        if (presentProjectIds.has(project.id)) continue;
        if (!assignedProjectIds.has(project.id)) continue;
        const primary = projectPrimaryPath(project);
        if (!primary) continue;
        pinnedProjectGroups.push({
          key: projectGroupKey(project.id, primary),
          cwd: primary,
          label: projectDisplayName(project),
          projectId: project.id,
          indices: [],
          hideEmptyHint: true,
        });
      }
    }
    const projectGroups = allProjectGroups.filter(
      (group) =>
        group.projectId === undefined || !pinnedProjectSet.has(group.projectId),
    );

    const mergedPinnedIndices = [
      ...pinnedIndices,
      ...pinnedProjectIndices,
    ].sort((a, b) => time(b) - time(a));

    return {
      threadIds,
      filteredIndices,
      pinnedIndices,
      pinnedProjectIndices,
      mergedPinnedIndices,
      pinnedProjectGroups,
      taskIndices,
      projectGroups,
    };
  }, [
    threadIds,
    threadItems,
    query,
    pinnedIds,
    pinnedProjectIds,
    tasksRange,
    remoteSignature,
    projectsRange,
    summariesVersion,
    displayNamesVersion,
    projects,
    purgedFoldersVersion,
  ]);
};

/** 列表空态。任一分区的时间筛选开着时换一套文案并给「清除筛选」（同时清
 *  两个分区）——否则一句「暂无对话」会让人以为会话没了，其实只是被区间
 *  挡在外面 */
const ThreadListEmpty: FC<{ searching?: boolean; children: ReactNode }> = ({
  searching,
  children,
}) => {
  const tasksRange = useThreadTimeRange("tasks");
  const projectsRange = useThreadTimeRange("projects");
  const activeLabels = [tasksRange, projectsRange]
    .filter((range) => range !== "all")
    .map((range) => threadTimeRangeLabel(range));
  return (
    <div
      data-slot="aui_thread-list-empty"
      className="text-muted-foreground px-2.5 py-4 text-sm"
    >
      {activeLabels.length === 0
        ? children
        : `「${activeLabels.join("、")}」内没有${searching ? "匹配的" : ""}会话`}
      {activeLabels.length > 0 && (
        <Button
          variant="ghost"
          className="mt-1.5 -ms-2 h-6 gap-1 px-2 text-xs font-normal"
          onClick={() => {
            setThreadTimeRange("all", "tasks");
            setThreadTimeRange("all", "projects");
          }}
        >
          清除筛选
        </Button>
      )}
    </div>
  );
};

const ThreadListItemGroupsInner: FC<{
  searchQuery?: string;
  registerItem: RegisterItem;
  openDirs?: Set<string>;
  onOpenDirsChange?: (next: Set<string>) => void;
}> = ({ searchQuery = "", registerItem, openDirs, onOpenDirsChange }) => {
  const {
    threadIds,
    filteredIndices,
    taskIndices,
    mergedPinnedIndices,
    pinnedProjectGroups,
    projectGroups,
  } = useThreadListGroups(searchQuery);
  const query = searchQuery.trim();

  // 任务区分页：默认渲染最近 10 条，尾部的「查看更多」每点一次放出一页。
  // 不做滚动自动加载——会话多时侧栏会变成无限流，想定位旧会话反而更难；
  // 搜索时全量展示（结果已经过滤过，截断会让人误以为漏了条目），query 变化即重置页数。
  const [taskVisibleCount, setTaskVisibleCount] = useState(TASK_VISIBLE_LIMIT);
  useEffect(() => {
    setTaskVisibleCount(TASK_VISIBLE_LIMIT);
  }, [query]);
  const visibleTaskIndices = query
    ? taskIndices
    : taskIndices.slice(0, taskVisibleCount);
  const hiddenTaskCount = taskIndices.length - visibleTaskIndices.length;

  // 批量模式「全选」的可见集注册：置顶组（含项目置顶）+ 任务区当前渲染的
  // 会话是一池，项目区各分组行是另一池（搜索过滤后口径一致）。「全选」在
  // shell 里取两池并集，见 pi-thread-batch.ts
  const visibleTaskIds = useMemo(
    () =>
      [...mergedPinnedIndices, ...visibleTaskIndices].map(
        (index) => threadIds[index],
      ),
    [threadIds, mergedPinnedIndices, visibleTaskIndices],
  );
  useEffect(() => {
    setThreadBatchVisible("tasks", visibleTaskIds);
  }, [visibleTaskIds]);
  const visibleProjectIds = useMemo(
    () =>
      [...projectGroups, ...pinnedProjectGroups].flatMap((g) =>
        g.indices.map((index) => threadIds[index]),
      ),
    [threadIds, projectGroups, pinnedProjectGroups],
  );
  useEffect(() => {
    setThreadBatchVisible("projects", visibleProjectIds);
  }, [visibleProjectIds]);

  // 置顶切换检测：pinnedIds 快照身份仅在 pin/unpin 时变化。这一次提交传
  // instant 给 TreeRow，行瞬时换位不走滑移（新消息挤动等其他重排不受影响）
  const pinnedIds = usePinnedSessionIds();
  const prevPinnedRef = useRef<readonly string[] | null>(null);
  const pinReorder =
    prevPinnedRef.current !== null && prevPinnedRef.current !== pinnedIds;
  useEffect(() => {
    prevPinnedRef.current = pinnedIds;
  });

  // 分区折叠：置顶 / 任务 / 项目各自开合，localStorage 持久化（读写见
  // readCollapsedSections 与下方落盘 effect）
  const [collapsedSections, setCollapsedSections] = useState<Set<ThreadSectionKey>>(
    readCollapsedSections,
  );
  useEffect(() => {
    try {
      window.localStorage.setItem(
        SECTION_COLLAPSED_KEY,
        JSON.stringify([...collapsedSections]),
      );
    } catch {}
  }, [collapsedSections]);
  const toggleSection = (key: ThreadSectionKey) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const pinnedOpen = !collapsedSections.has("pinned");
  const tasksOpen = !collapsedSections.has("tasks");
  const projectsOpen = !collapsedSections.has("projects");

  // 批量模式开关只随进入/退出变化（勾选切换走 SectionBatchBar 的窄订阅，
  // 不牵连这里的行树重渲染）；筛选区间只用于动作区的常驻判断
  const batchActive = useThreadBatchActive();
  const tasksRange = useThreadTimeRange("tasks");
  const projectsRange = useThreadTimeRange("projects");

  // 「展开全部 / 收起全部」：受控的 openDirs 才能整表开合（桌面与移动端
  // shell 都传入；未受控时不出现该按钮）
  const allProjectsExpanded =
    projectGroups.length + pinnedProjectGroups.length > 0 &&
    [...projectGroups, ...pinnedProjectGroups].every(
      (g) => openDirs?.has(g.key) ?? false,
    );
  const toggleAllProjects = () => {
    if (!onOpenDirsChange) return;
    onOpenDirsChange(
      allProjectsExpanded
        ? new Set()
        : new Set(
            [...projectGroups, ...pinnedProjectGroups].map((g) => g.key),
          ),
    );
  };

  // 已归档会话不在侧栏展示，统一到「设置 → 归档」查看与恢复。
  // 空项目也会产生分组（showWhenEmpty），不能只看会话命中数就判空。
  const emptyState = threadListEmptyState({
    query,
    filteredCount: filteredIndices.length,
    projectGroupCount: projectGroups.length + pinnedProjectGroups.length,
  });
  if (emptyState === "search") {
    return <ThreadListEmpty searching>没有匹配的会话</ThreadListEmpty>;
  }
  if (emptyState === "empty") {
    return <ThreadListEmpty>暂无对话</ThreadListEmpty>;
  }

  // 置顶行在置顶卡里占最前槽位，任务区行与「查看更多」连续跟上
  //（置顶分区收起时任务区从 0 号槽位起）
  const taskSlotBase = pinnedOpen ? mergedPinnedIndices.length : 0;
  // 置顶卡计数 = 平铺的置顶会话 + 置顶项目（项目内会话不单独计数）
  const pinnedCount = mergedPinnedIndices.length + pinnedProjectGroups.length;

  return (
    <>
      {/* 置顶分区：任务置顶、项目会话置顶与项目置顶合并，独立灰底卡片展示；
          平铺会话注册进 fluid hover 槽位，置顶项目用项目卡（自带嵌套作用域） */}
      {pinnedCount > 0 && (
        <PinnedCard
          count={pinnedCount}
          open={pinnedOpen}
          onToggle={() => toggleSection("pinned")}
        >
          {mergedPinnedIndices.map((index, slot) => (
            <RowHoverContext.Provider
              key={threadIds[index]}
              value={{ registerItem, index: slot }}
            >
              <PinnedRowContext.Provider value>
                <TreeRow position={slot} instant={pinReorder}>
                  <ThreadListPrimitive.ItemByIndex
                    index={index}
                    components={{ ThreadListItem }}
                  />
                </TreeRow>
              </PinnedRowContext.Provider>
            </RowHoverContext.Provider>
          ))}
          {pinnedProjectGroups.length > 0 && (
            <ProjectGroupsSection
              searchQuery={searchQuery}
              openDirs={openDirs}
              onOpenDirsChange={onOpenDirsChange}
              groups={pinnedProjectGroups}
            />
          )}
        </PinnedCard>
      )}
      {projectGroups.length > 0 && (
        <CollapsibleSection
          label="项目"
          count={projectGroups.length}
          open={projectsOpen}
          onToggle={() => toggleSection("projects")}
          sticky={batchActive || projectsRange !== "all"}
          actions={
            batchActive ? (
              <SectionBatchBar scope="projects" />
            ) : (
              <>
                {onOpenDirsChange && (
                  <TooltipIconButton
                    variant="ghost"
                    tooltip={allProjectsExpanded ? "收起全部" : "展开全部"}
                    className="text-muted-foreground hover:text-foreground size-7 rounded-sm!"
                    onClick={toggleAllProjects}
                  >
                    {allProjectsExpanded ? (
                      <Minimize2Icon className="size-3.5" />
                    ) : (
                      <Maximize2Icon className="size-3.5" />
                    )}
                  </TooltipIconButton>
                )}
                <SectionFilterButton scope="projects" />
                <TooltipIconButton
                  variant="ghost"
                  tooltip="批量管理"
                  className="text-muted-foreground hover:text-foreground size-7 rounded-sm!"
                  onClick={enterThreadBatch}
                >
                  <ListChecksIcon className="size-3.5" />
                </TooltipIconButton>
              </>
            )
          }
        >
          <ProjectGroupsSection
            searchQuery={searchQuery}
            openDirs={openDirs}
            onOpenDirsChange={onOpenDirsChange}
          />
        </CollapsibleSection>
      )}
      {taskIndices.length > 0 && (
        <CollapsibleSection
          label="任务"
          count={taskIndices.length}
          open={tasksOpen}
          onToggle={() => toggleSection("tasks")}
          sticky={batchActive || tasksRange !== "all"}
          actions={
            batchActive ? (
              <SectionBatchBar scope="tasks" />
            ) : (
              <>
                <SectionFilterButton scope="tasks" />
                <TooltipIconButton
                  variant="ghost"
                  tooltip="批量管理"
                  className="text-muted-foreground hover:text-foreground size-7 rounded-sm!"
                  onClick={enterThreadBatch}
                >
                  <ListChecksIcon className="size-3.5" />
                </TooltipIconButton>
              </>
            )
          }
        >
          <IndentedRowContext.Provider value>
            {visibleTaskIndices.map((index, i) => (
              <RowHoverContext.Provider
                key={threadIds[index]}
                value={{ registerItem, index: taskSlotBase + i }}
              >
                <TreeRow position={i} instant={pinReorder}>
                  <ThreadListPrimitive.ItemByIndex
                    index={index}
                    components={{ ThreadListItem }}
                  />
                </TreeRow>
              </RowHoverContext.Provider>
            ))}
            {hiddenTaskCount > 0 && (
              <TreeRow position={visibleTaskIndices.length}>
                <FluidHoverRow
                  registerItem={registerItem}
                  index={taskSlotBase + visibleTaskIndices.length}
                >
                  <Button
                    variant="ghost"
                    // 左缘与任务区会话标题同缘（ps-6）
                    className="h-7 w-full justify-start ps-6 text-sm font-normal text-muted-foreground hover:bg-transparent dark:hover:bg-transparent"
                    onClick={() => setTaskVisibleCount((c) => c + TASK_VISIBLE_LIMIT)}
                  >
                    {`查看更多 (${Math.min(hiddenTaskCount, TASK_VISIBLE_LIMIT)})`}
                  </Button>
                </FluidHoverRow>
              </TreeRow>
            )}
          </IndentedRowContext.Provider>
        </CollapsibleSection>
      )}
      {/* 拖拽悬浮牌：全局挂一份（项目区与置顶项目卡共用同一拖拽 store） */}
      <SessionDragGhost />
    </>
  );
};

/** memo：悬浮换行只动容器的 activeIndex。registerItem（hook 内稳定引用）与
 *  searchQuery 不变 ⇒ 整棵行树跳过重渲染——每行挂着十几个订阅 hook 与菜单
 *  定义，全量重渲染正是侧栏悬浮「卡卡的」的主因（项目 tab 侧的同类问题由
 *  FluidHoverScope 把状态关进容器解决）。 */
const ThreadListItemGroups = memo(ThreadListItemGroupsInner);

/** 分区头触发器：文字左缘（px-2.5）与行内标题（trigger ps-2.5）同缘；
 *  折叠箭头常隐、悬浮分区头时在标题后方浮现（悬浮折叠），点击开合 */
const SectionHeaderTrigger: FC<{
  label: string;
  count: number;
  open: boolean;
  className?: string;
}> = ({ label, count, open, className }) => (
  <CollapsibleTrigger
    render={
      <button
        type="button"
        data-slot="aui_thread-list-section-header"
        className={cn(
          "flex w-full cursor-pointer items-center rounded-md px-2.5 pb-1 pt-2 text-start text-sm font-medium text-muted-foreground select-none hover:text-foreground",
          className,
        )}
      >
        <span className="min-w-0 truncate">{`${label} (${count})`}</span>
        <span
          aria-hidden
          className="w-0 shrink-0 overflow-hidden opacity-0 transition-[width,opacity] duration-150 group-hover/header:w-3.5 group-hover/header:opacity-100 max-md:w-3.5 max-md:opacity-100"
        >
          <ChevronRightIcon
            className={cn(
              "size-3 transition-transform duration-200",
              open && "rotate-90",
            )}
          />
        </span>
      </button>
    }
  />
);

/** 可折叠分区（统一分区列表的 置顶 / 任务 / 项目 共用）：分区头点击开合，
 *  右侧悬浮操作区承载分区各自的动作（筛选 / 批量 / 项目「展开全部」）；
 *  sticky = 动作常驻显示（批量模式、筛选生效中）。开合动画与项目组面板
 *  同款：面板高度关键帧 + 内容整体淡入淡出 */
const CollapsibleSection: FC<{
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  sticky?: boolean;
  children: ReactNode;
}> = ({ label, count, open, onToggle, actions, sticky, children }) => (
  <Collapsible
    open={open}
    onOpenChange={(next) => {
      if (next !== open) onToggle();
    }}
    style={{
      ["--animation-duration" as string]: `${PANEL_ANIMATION_MS}ms`,
    }}
  >
    <div className="group/header relative" data-fluid-hover-defer="">
      <SectionHeaderTrigger label={label} count={count} open={open} />
      {actions && (
        <div
          className={cn(
            "absolute end-0.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition-opacity duration-150",
            sticky
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-focus-within/header:pointer-events-auto group-focus-within/header:opacity-100 group-hover/header:pointer-events-auto group-hover/header:opacity-100",
            // 下拉菜单（筛选）开着时指针在 portal 里，group-hover 已丢失：
            // 触发按钮的 data-state=open 让操作区保持可见
            "has-data-[state=open]:pointer-events-auto has-data-[state=open]:opacity-100",
            // 移动端抽屉（md 以下）没有 hover：动作常驻，否则触摸无法触达
            "max-md:pointer-events-auto max-md:opacity-100",
          )}
        >
          {actions}
        </div>
      )}
    </div>
    <CollapsibleContent
      className={cn(
        "overflow-hidden outline-none ease-in-out",
        "motion-reduce:animate-none",
        "data-closed:animate-collapsible-up",
        "data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards",
        "data-closed:pointer-events-none",
        "[--tw-duration:var(--animation-duration)]",
      )}
    >
      {children}
    </CollapsibleContent>
  </Collapsible>
);

/** 分区筛选按钮：时间区间按分区独立（pi-thread-filter 的 tasks / projects
 *  两份），区间生效时常驻显示（配合 CollapsibleSection 的 sticky） */
const SectionFilterButton: FC<{ scope: ThreadFilterScope }> = ({ scope }) => {
  const range = useThreadTimeRange(scope);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <TooltipIconButton
            variant="ghost"
            tooltip={
              range === "all"
                ? "筛选会话"
                : `筛选：${threadTimeRangeLabel(range)}`
            }
            className={cn(
              "text-muted-foreground hover:text-foreground size-7 rounded-sm!",
              range !== "all" && "text-foreground bg-muted hover:bg-muted",
            )}
          >
            <ListFilterIcon className="size-3.5" />
          </TooltipIconButton>
        }
      />
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup
          value={range}
          onValueChange={(value) =>
            setThreadTimeRange(value as ThreadTimeRange, scope)
          }
        >
          {THREAD_TIME_RANGES.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              // base-ui 的 RadioItem 默认选中不关菜单（与 Item 相反）。
              // 筛选是"选完就走"的动作，这里显式关掉
              closeOnClick
              className="text-xs"
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** 批量模式的分区操作栏（挂在分区头右侧，常驻）：全选只覆盖本分区的
 *  可见池（pi-thread-batch 的注册集），归档 / 退出是全局动作——两个分区
 *  的头各挂一份、动作相同，勾选集合共享 */
const SectionBatchBar: FC<{ scope: ThreadBatchTab }> = ({ scope }) => {
  const aui = useAui();
  const batch = useThreadBatchState();
  const threadItems = useThreadItems();
  const visibleIds = batch.visible[scope] ?? [];
  const allSelected =
    visibleIds.length > 0 &&
    visibleIds.every((id) => batch.selected.includes(id));
  const archivableCount = useMemo(() => {
    const byKey = new Map<string, (typeof threadItems)[number]>();
    for (const item of threadItems) {
      byKey.set(item.id, item);
      if (item.remoteId) byKey.set(item.remoteId, item);
    }
    return batch.selected.filter((id) => byKey.get(id)?.status === "regular")
      .length;
  }, [batch.selected, threadItems]);

  const archiveSelected = () => {
    if (archivableCount === 0) {
      exitThreadBatch();
      return;
    }
    const byKey = new Map<string, (typeof threadItems)[number]>();
    for (const item of threadItems) {
      byKey.set(item.id, item);
      if (item.remoteId) byKey.set(item.remoteId, item);
    }
    for (const selected of batch.selected) {
      const item = byKey.get(selected);
      // 新建未落盘的会话（status "new"）不可归档，跳过；当前打开中的
      // 会话由 core 先切走再归档（同右键归档语义）
      if (item?.status !== "regular") continue;
      aui.threads.item({ id: item.id }).archive();
    }
    toast.add({ title: `已归档 ${archivableCount} 个会话`, type: "success" });
    exitThreadBatch();
  };

  return (
    <div className="flex items-center gap-0.5">
      <TooltipIconButton
        variant="ghost"
        tooltip={allSelected ? "取消全选" : "全选"}
        disabled={visibleIds.length === 0}
        className="text-muted-foreground hover:text-foreground size-7 rounded-sm!"
        onClick={() => setThreadBatchSelection(allSelected ? [] : visibleIds)}
      >
        <SquareCheckBigIcon className="size-3.5" />
      </TooltipIconButton>
      <TooltipIconButton
        variant="ghost"
        tooltip={archivableCount > 0 ? `归档（${archivableCount}）` : "归档"}
        disabled={archivableCount === 0}
        className="text-muted-foreground hover:text-foreground size-7 rounded-sm!"
        onClick={archiveSelected}
      >
        <ArchiveIcon className="size-3.5" />
      </TooltipIconButton>
      <TooltipIconButton
        variant="ghost"
        tooltip="退出批量管理"
        className="text-muted-foreground hover:text-foreground size-7 rounded-sm!"
        onClick={exitThreadBatch}
      >
        <XIcon className="size-3.5" />
      </TooltipIconButton>
    </div>
  );
};

/** 置顶分区卡片（ChatGPT 侧栏同形）：圆角灰底 + 可折叠的「置顶 (N)」头，
 *  任务置顶与项目置顶合并展示。头 px-2.5 + 卡片 p-1 使文字左缘与行内标题
 *  对齐；行的 fluid hover 槽位由调用方按渲染序分配 */
const PinnedCard: FC<{
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}> = ({ count, open, onToggle, children }) => (
  <Collapsible
    open={open}
    onOpenChange={(next) => {
      if (next !== open) onToggle();
    }}
    style={{
      ["--animation-duration" as string]: `${PANEL_ANIMATION_MS}ms`,
    }}
    className="my-1 mb-0 rounded-xl bg-muted/10 p-1 px-0"
  >
    <div className="group/header relative" data-fluid-hover-defer="">
      <SectionHeaderTrigger
        label="置顶"
        count={count}
        open={open}
        className="pb-1 pt-1.5"
      />
    </div>
    <CollapsibleContent
      className={cn(
        "overflow-hidden outline-none ease-in-out",
        "motion-reduce:animate-none",
        "data-closed:animate-collapsible-up",
        "data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards",
        "data-closed:pointer-events-none",
        "[--tw-duration:var(--animation-duration)]",
      )}
    >
      {children}
    </CollapsibleContent>
  </Collapsible>
);

/** 项目展开后默认可见的会话行数，超出折叠进「查看更多」 */
const PROJECT_VISIBLE_LIMIT = 5;
/** 任务区每页行数：尾部「查看更多」每点一次放出一页（不做滚动自动加载） */
const TASK_VISIBLE_LIMIT = 10;
/** 折叠面板开合（分区与项目组共用）：面板高度 300ms ease-in-out，
 *  内容作为整体同步淡入淡出（会话行不再逐行级联） */
const PANEL_ANIMATION_MS = 300;

/** 项目分区内容：有工作目录的会话按文件夹分组，Collapsible 展开显示会话列表。
 *  作为统一列表的「项目」分区渲染在 ThreadListPrimitive.Root 内部（会话项
 *  复用 ThreadListItem 的激活/重命名/删除能力）。骨架与空态由分区分组层
 *  统一处理，置顶的项目会话合并进顶部置顶卡、不在这里重复出现。
 *  展开目录集合可由外部受控（openDirs/onOpenDirsChange，供「展开全部」按钮用），
 *  不传则组件内部自管。
 */
const ProjectGroupsSection: FC<{
  searchQuery?: string;
  openDirs?: Set<string>;
  onOpenDirsChange?: (next: Set<string>) => void;
  /** 只渲染给定分组（置顶分区复用同一套项目卡）；不传时用全量分组 */
  groups?: ThreadListProjectGroup[];
}> = ({
  searchQuery = "",
  openDirs: controlledOpen,
  onOpenDirsChange,
  groups,
}) => {
  const aui = useAui();
  const t = useT();
  const reduce = useReducedMotion() ?? false;
  const { threadIds, projectGroups: computedGroups } =
    useThreadListGroups(searchQuery);
  const projectGroups = groups ?? computedGroups;
  // 项目置顶状态：组头菜单显示「置顶项目 / 取消置顶项目」
  const pinnedProjectIds = usePinnedProjectIds();
  const pinnedProjectSet = new Set(pinnedProjectIds);
  // 项目实体：分组外观兜底（localStorage 缓存缺失时用 DB appearance_json）
  const projects = useProjectRegistry();
  // 项目外观版本号：变一次整表重渲（外观极少变）；逐行直接读值——
  // 分组在 map 循环里渲染，hook 不能在循环里调，所以订阅收敛成这一条
  useProjectAppearancesVersion();
  const threadItems = useThreadItems();
  // 组头未读蓝点：组内任一会话未读即点亮（与会话行蓝点同款式）
  const unreadIds = useUnreadSessionIds();
  const [internalOpen, setInternalOpen] = useState<Set<string>>(
    () => new Set(),
  );
  const openDirs = controlledOpen ?? internalOpen;
  // 项目分组内当前可见行数（「查看更多」每点一次 +5 分页放出，不一次全开）；
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
  // 收起组的行自动注销，不影响剩余行的 rect）。状态关在下面的 FluidHoverScope
  // 里：换行高亮只重渲染容器，行树（每行十几个订阅 hook）整棵跳过。

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

  // 面板开合/「查看更多」的结构变化提交里，行的位移由面板高度动画逐帧带动。
  // 若同时让 TreeRow 跑 framer 的 layout 投影，两个位移会叠加——下方分组会
  // 先盖在刚展开的会话行上再滑开（收起时反向），观感即「展开折叠动画很奇怪」。
  // 因此只在这一帧把行位移置为瞬时，之后仍保留 layout 动画（置顶换位等）。
  const prevStructureRef = useRef({ openDirs, visibleCounts });
  const openDirsChanged = prevStructureRef.current.openDirs !== openDirs;
  const structureChanged =
    openDirsChanged ||
    prevStructureRef.current.visibleCounts !== visibleCounts;
  useEffect(() => {
    prevStructureRef.current = { openDirs, visibleCounts };
  }, [openDirs, visibleCounts]);

  /** 项目内"新对话"：先把 workspace 设为该组目录（与手动在胶囊选目录后
   *  点新对话同语义——首条消息落盘时会话带上此 cwd，即归入本组），再切新草稿。
   *  顺手展开该组，落盘后的新会话出现时不被折叠挡住 */
  const newChatInProject = (group: ThreadListProjectGroup) => {
    clearLastThread();
    setWorkspace(group.cwd, "user", group.projectId ?? null);
    // 显式重拉分支状态：同一目录可能沿用上次失败态的缓存（比如上次选中时
    // kv 还没落库），cwd 没变时 hook 不会自动重试——用户主动在本项目开
    // 新对话时补一次，Git 胶囊才不用等 agent 跑完一轮才出现。
    // 远程目录不走本地 git 查询（group.remoteName 标记）：本机没有这个路径，
    // 查了必然失败还会多一次尾随重试。
    if (!group.remoteName) refreshGitStatus(group.cwd);
    setOpenDirs((prev) => {
      if (prev.has(group.key)) return prev;
      const next = new Set(prev);
      next.add(group.key);
      return next;
    });
    void aui.threads.switchToNewThread();
  };

  /** 编辑项目：复用「新建工作区」对话框，预填名称/目录/外观 */
  const [editingGroup, setEditingGroup] =
    useState<ThreadListProjectGroup | null>(null);
  const editingProject = editingGroup?.projectId
    ? projects.find((project) => project.id === editingGroup.projectId)
    : undefined;
  /** 从侧栏移除：只隐藏项目卡，不归档、不解绑会话（设置页可恢复显示） */
  const removeFromSidebar = async (group: ThreadListProjectGroup) => {
    if (!group.projectId) return;
    try {
      const { saveProject } = await import("@/lib/pi/pi-projects");
      await saveProject({
        id: group.projectId,
        hiddenFromSidebar: true,
      });
      toast.add({
        title: `已从侧栏移除「${group.label}」`,
        description: "可在 设置 → 项目 中恢复显示",
        type: "info",
      });
    } catch (err) {
      toast.add({
        title: "移除失败",
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    }
  };

  /** 归档项目：项目实体一起归档（否则空项目会因 show_when_empty 又冒出来），
   *  该项目下的已落盘会话全部归档——包括置顶后跳出项目组的会话。
   *  只按 projectId 圈定：共享同一目录的另一个项目不受影响。
   *  卡片消失后给一条带「撤销」的提示，否则用户不知道项目去哪了。
   *  仅限有项目实体的分组调用（菜单入口已按 projectId 门控）；无实体的
   *  远程 cwd 分组没有「项目」可归档，不提供该动作。 */
  const archiveProject = (group: ThreadListProjectGroup) => {
    const projectIdToArchive = group.projectId;
    const projectLabel = group.label;
    if (!projectIdToArchive) return;
    void import("@/lib/pi/pi-projects")
      .then(async ({ deleteProject, restoreProject }) => {
        await deleteProject(projectIdToArchive);
        toast.add({
          title: `已归档项目「${projectLabel}」`,
          description: "可在 设置 → 项目 中查看、恢复或彻底删除",
          type: "info",
          action: {
            label: "撤销",
            onClick: () => {
              void restoreProject(projectIdToArchive)
                .then(() =>
                  toast.add({
                    title: `已恢复「${projectLabel}」`,
                    type: "success",
                  }),
                )
                .catch((err: unknown) =>
                  toast.add({
                    title: "恢复失败",
                    description:
                      err instanceof Error ? err.message : String(err),
                    type: "error",
                  }),
                );
            },
          },
        });
      })
      .catch((err: unknown) => {
        toast.add({
          title: "归档失败",
          description: err instanceof Error ? err.message : String(err),
          type: "error",
        });
      });
    // 只按 projectId 圈定：共享同一目录的另一个项目不受影响。入口已按
    // projectId 门控（远程 cwd 分组不给归档），这里必然有项目实体。
    const ids = new Set<string>();
    for (const item of threadItems) {
      if (
        item.remoteId &&
        piSessionProjectIdMap.get(item.remoteId) === projectIdToArchive
      ) {
        ids.add(item.id);
      }
    }
    for (const id of ids) {
      // 新建未落盘的会话（status "new"）不可归档，跳过
      if (threadItems.find((item) => item.id === id)?.status !== "regular")
        continue;
      aui.threads.item({ id }).archive();
    }
  };

  // 拖拽落组：先弹确认框，确认后走与「移动到项目…」对话框同一条链路——
  // 换绑 cwd、刷新列表，当前打开的会话同步工作目录胶囊；目标组由
  // pi:session-moved 事件自动展开
  const [pendingDrop, setPendingDrop] = useState<{
    sessionId: string;
    title: string;
    targetCwd: string;
    targetProjectId?: string;
  } | null>(null);
  const [movingDrop, setMovingDrop] = useState(false);
  const moveByDrop = async (
    sessionId: string,
    targetCwd: string,
    targetProjectId?: string,
  ) => {
    try {
      const result = await moveSessionToDirectory(
        sessionId,
        targetCwd,
        targetProjectId,
      );
      if (result.kind === "same-dir") return;
      // await 期间用户可能已切走：以**结算时**的当前会话决定胶囊跟随——
      // 渲染期捕获的 mainThreadId 是唤起瞬间值，切走后会把旧会话的 cwd
      // 套给新当前会话
      if (
        piSessionIdForThread(aui.threads.getState().mainThreadId) === sessionId
      )
        setWorkspace(result.cwd, "session", piSessionProjectIdMap.get(sessionId) ?? null);
      try {
        await aui.threads.reload();
      } catch (err) {
        // 移动已经生效；列表刷新失败由 sessions_changed 兜底，不报成移动失败
        console.error("threads.reload after move failed:", err);
      }
      toast.add({
        title: `已移动到「${projectLabelFor(result.cwd)}」`,
        type: "success",
      });
    } catch (err) {
      toast.add({
        title: "移动失败",
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    }
  };
  const dragApi = useSessionDragController(
    (sessionId, targetCwd, title, targetProjectId) => {
      setPendingDrop({ sessionId, title, targetCwd, targetProjectId });
    },
  );
  const dragOverCwd = useSessionDragOverCwd();
  const dragOverProjectId = useSessionDragOverProjectId();
  const confirmDrop = () => {
    if (!pendingDrop || movingDrop) return;
    setMovingDrop(true);
    void moveByDrop(
      pendingDrop.sessionId,
      pendingDrop.targetCwd,
      pendingDrop.targetProjectId,
    ).finally(() => {
      setMovingDrop(false);
      setPendingDrop(null);
    });
  };

  // 渲染序即注册序：组头与其子行连续跟上（置顶的项目会话在分区分组层的
  // 置顶卡里，不在这里渲染）
  let nextSlot = 0;

  return (
    <SessionDragContext.Provider value={dragApi}>
    <FluidHoverScope>
      {projectGroups.map((group) => {
        // 组内行数超过上限时默认截断 5 条，尾部「查看更多」每点放出 5 条，
        // 放完即无按钮（项目折叠再展开回默认）；截断后的行与按钮占连续 hover 槽位
        const visibleLimit =
          visibleCounts.get(group.key) ?? PROJECT_VISIBLE_LIMIT;
        const visibleIndices = group.indices.slice(0, visibleLimit);
        const hiddenCount = group.indices.length - visibleIndices.length;
        const headerSlot = nextSlot++;
        const childSlots = visibleIndices.map(() => nextSlot++);
        const moreSlot = hiddenCount > 0 ? nextSlot++ : -1;
        // 空项目也要有可展开的内容：占位行给出「新建对话」入口，
        // 否则点击组头折叠面板开合看不到任何变化（用户感知为“展不开”）。
        const isEmptyProject = group.indices.length === 0;
        const emptySlot = isEmptyProject ? nextSlot++ : -1;
        const isOpen = openDirs.has(group.key);
        const entity = group.projectId
          ? projects.find((project) => project.id === group.projectId)
          : undefined;
        const projectId = group.projectId;
        const pinned = projectId ? pinnedProjectSet.has(projectId) : false;
        // 外观优先级：DB appearance_json（唯一事实源）→ localStorage 缓存
        const appearance =
          projectAppearanceOf(entity) ?? projectAppearanceFor(group.cwd);
        const hasUnread = group.indices.some((i) =>
          unreadIds.has(threadIds[i]),
        );
        return (
          <Collapsible
            key={group.key}
            open={isOpen}
            onOpenChange={() => toggle(group.key)}
            style={{
              ["--animation-duration" as string]: `${PANEL_ANIMATION_MS}ms`,
            }}
          >
            <TreeRow position={headerSlot} instant={structureChanged}>
              <FluidHoverRow
                index={headerSlot}
                className="group/proj relative"
              >
                <CollapsibleTrigger
                  className="w-full"
                  render={
                    <Button
                      variant="ghost"
                      title={group.cwd}
                      // 拖拽落点：会话行拖到组头松开即移动到该项目
                      //（命中检测 elementFromPoint + closest，见 session-drag.tsx）
                      data-project-drop={group.cwd}
                      data-project-drop-id={group.projectId}
                      data-drag-over={
                        dragOverCwd === group.cwd &&
                        (group.projectId
                          ? dragOverProjectId === group.projectId
                          : dragOverProjectId == null)
                          ? "true"
                          : undefined
                      }
                      // hover 反馈交给 FluidHoverHighlight：压掉 ghost 变体
                      // 自带的 hover/aria-expanded 底色，避免与高亮叠加
                      className={cn(
                        "h-8 justify-start gap-2 px-2.5 text-sm font-normal hover:bg-transparent dark:hover:bg-transparent group-hover/proj:pe-14 aria-expanded:bg-transparent active:not-aria-[haspopup]:translate-y-0",
                        // 拖拽悬停高亮：属性选择器特异性高于 hover:bg-transparent
                        "data-[drag-over=true]:bg-accent data-[drag-over=true]:ring-2 data-[drag-over=true]:ring-primary/50",
                      )}
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
                      {/* 外观优先级：上传图/头像/吉祥物 → 徽章；只选了颜色 → 颜色套在
                          默认文件夹图标上（"颜色给图标上色"）；都没有 → 原样。
                          收起/展开保持同一套颜色：开合由折叠本身表达，不再压暗图标 */}
                      {hasProjectAppearance(appearance) ? (
                        <ProjectBadge
                          appearance={appearance}
                          className={PROJECT_BADGE_CLASS}
                        />
                      ) : (
                        <span
                          className={cn(
                            PROJECT_ICON_SLOT,
                            "grid place-items-center text-muted-foreground",
                          )}
                          style={
                            appearance?.color
                              ? { color: projectColorTokens(appearance.color).ink }
                              : undefined
                          }
                        >
                          {/* 项目文件夹：统一用闭合态文件夹图标 */}
                          <FolderClosedIcon className="size-4" />
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-start">
                        {group.label}
                      </span>
                      {group.remoteName && (
                        <span
                          data-slot="aui_thread-list-group-remote"
                          title={`远程项目：${group.remoteName}`}
                          className="shrink-0 rounded bg-emerald-500/10 px-1 text-2xs text-emerald-600 dark:text-emerald-400"
                        >
                          远程
                        </span>
                      )}
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
              {/* 该项目内新建对话：位置在「项目操作」按钮左侧 */}
              <TooltipIconButton
                variant="ghost"
                size="icon"
                tooltip={`在 ${group.label} 新建对话`}
                className="absolute end-[30px] top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100"
                onClick={() => newChatInProject(group)}
              >
                <PlusIcon className="size-3.5" />
                <span className="sr-only">项目内新建对话</span>
              </TooltipIconButton>
              {/* 项目设置卡（紧贴行右侧的 Popover）：图标/颜色/吉祥物 + 项目操作
                  收在同一个弹层里，选色/选吉祥物不关弹层，侧栏实时跟着变 */}
              <ProjectSettingsPopover
                cwd={group.cwd}
                label={group.label}
                pinned={pinned}
                onTogglePin={
                  projectId ? () => togglePinProject(projectId) : undefined
                }
                onEdit={
                  group.projectId ? () => setEditingGroup(group) : undefined
                }
                onRemove={
                  group.projectId ? () => void removeFromSidebar(group) : undefined
                }
                onArchive={
                  group.projectId ? () => archiveProject(group) : undefined
                }
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute end-1 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
                >
                    <MoreHorizontalIcon className="size-3.5" />
                    <span className="sr-only">项目操作</span>
                  </Button>
              </ProjectSettingsPopover>
              </FluidHoverRow>
            </TreeRow>
            {/* 折叠动效对齐 侧边栏：面板高度关键帧 + 内容整体淡入淡出。
                会话行不再逐行级联，避免「高度在长、行又在错峰冒出来」的双层动效 */}
            <CollapsibleContent
              className={cn(
                "group/collapsible-content overflow-hidden outline-none",
                "ease-in-out",
                "motion-reduce:animate-none",
                "data-closed:animate-collapsible-up",
                "data-open:animate-collapsible-down",
                "data-closed:fill-mode-forwards",
                "data-closed:pointer-events-none",
                "[--tw-duration:var(--animation-duration)]",
              )}
            >
              <ProjectChildRowContext.Provider value>
                <div
                  className={cn(
                    "relative flex flex-col gap-0.5 pl-0",
                    "ease-in-out motion-reduce:animate-none",
                    "group-data-open/collapsible-content:animate-in",
                    "group-data-open/collapsible-content:fade-in-0",
                    "group-data-closed/collapsible-content:animate-out",
                    "group-data-closed/collapsible-content:fade-out-0",
                    "group-data-closed/collapsible-content:fill-mode-forwards",
                    "[--tw-duration:var(--animation-duration)]",
                  )}
                >
                  {visibleIndices.map((index, i) => (
                    <ScopeRowSlot key={threadIds[index]} index={childSlots[i]}>
                      <TreeRow
                        position={i}
                        instant={structureChanged}
                        // 开合由面板整体淡入承担；「查看更多」新增的行仍走级联
                        enter={!openDirsChanged}
                      >
                        <ThreadListPrimitive.ItemByIndex
                          index={index}
                          components={{ ThreadListItem }}
                        />
                      </TreeRow>
                    </ScopeRowSlot>
                  ))}
                  {isEmptyProject && !group.hideEmptyHint && (
                    <TreeRow
                      position={0}
                      instant={structureChanged}
                      enter={!openDirsChanged}
                    >
                      <FluidHoverRow index={emptySlot}>
                        <button
                          type="button"
                          onClick={() => newChatInProject(group)}
                          className="text-muted-foreground hover:bg-muted/60 pl-4 hover:text-foreground flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] leading-5 transition-colors"
                        >
                          <PlusIcon className="size-3.5 shrink-0" />
                          {t("chat.threadList.projectEmptyHint")}
                        </button>
                      </FluidHoverRow>
                    </TreeRow>
                  )}
                  {hiddenCount > 0 && (
                    <TreeRow
                      position={visibleIndices.length}
                      instant={structureChanged}
                      enter={!openDirsChanged}
                    >
                      <FluidHoverRow index={moreSlot}>
                        <Button
                          variant="ghost"
                          // 左缘与组内会话标题同缘（行 trigger ps-9）
                          className="h-7 w-full justify-start ps-9 text-sm font-normal text-muted-foreground hover:bg-transparent dark:hover:bg-transparent"
                          onClick={() => expandMore(group.key)}
                        >
                          {`查看更多 (${Math.min(hiddenCount, PROJECT_VISIBLE_LIMIT)})`}
                        </Button>
                      </FluidHoverRow>
                    </TreeRow>
                  )}
                  {/* 层级引导线：从项目行下方垂下，串起组内会话与「查看更多」。
                      放在最后一位，保证悬停高亮/选中底色之上仍可见。
                      start-5 对齐项目徽章中心，行文字 ps-9 对齐项目标题左缘 */}
                  <span
                    aria-hidden
                    className="bg-border/30 pointer-events-none absolute inset-y-0 start-5 w-px"
                  />
                </div>
              </ProjectChildRowContext.Provider>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </FluidHoverScope>
    {/* 编辑项目：复用新建工作区对话框，底部可归档/从侧栏移除 */}
    <WorkspaceCreateDialog
      open={editingGroup !== null}
      project={editingProject ?? null}
      onClose={() => setEditingGroup(null)}
      onArchiveProject={() => {
        const group = editingGroup;
        setEditingGroup(null);
        if (group) archiveProject(group);
      }}
      onRemoveProject={() => {
        const group = editingGroup;
        setEditingGroup(null);
        if (group) void removeFromSidebar(group);
      }}
    />
    {/* 拖拽落组的二次确认：松手不直接移动，确认后才换绑（防误拖） */}
    <AlertDialog
      open={pendingDrop != null}
      onOpenChange={(open) => {
        if (!open) setPendingDrop(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>移动会话到项目？</AlertDialogTitle>
          <AlertDialogDescription>
            {pendingDrop &&
              `将把「${
                pendingDrop.title || "新对话"
              }」移动到项目「${pathBasename(pendingDrop.targetCwd)}」。会话 ID 与历史保持不变；历史消息中的绝对路径与旧检查点仍指向原项目。`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel size="default">取消</AlertDialogCancel>
          <AlertDialogAction size="default" disabled={movingDrop} onClick={confirmDrop}>
            {movingDrop ? "移动中…" : "移动"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </SessionDragContext.Provider>
  );
};

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

export const ThreadListItem: FC = () => {
  const t = useT();
  const aui = useAui();
  // 框架 isRunning 只覆盖挂载过运行时的线程（切走/刷新后的后台 run 会漏）；
  // 并上 sidecar 事实源的运行集合（pi-running store）后，运行中指示才常驻，
  // 没在跑的会话才不可见
  const isRunning = useAuiState((s) => s.threadListItem.isRunning);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  // 乐观选中（点击即刻高亮）：切会话的真实 mainThreadId 要等新线程 runtime
  // 启动完（含 sidecar 快照来回）才推进，此前先让点中的这一行自亮
  const itemId = useAuiState((s) => s.threadListItem.id);
  const pendingSelect = usePendingThreadSelection(itemId);
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
      ? formatElapsed(lastMs, Date.now())
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
  // 行首档位图标：会话的工作模式（工作/编码/设计）。键取 remoteId（= pi
  // sessionId，会话偏好镜像的键）；未落盘草稿无 remoteId，回落全局默认档
  const sessionAppMode = useSessionAppMode(remoteId);
  const ModeIcon = APP_MODE_META[sessionAppMode].icon;
  // 批量模式：行首换勾选框、点击行切换选中（不激活会话）
  const batchActive = useThreadBatchActive();
  const batchSelected = useIsThreadBatchSelected(remoteId ?? "");
  // 行菜单定义（"…"下拉与右键菜单共用一份，见 useThreadRowMenu）
  const rowMenu = useThreadRowMenu({
    onRename: () => setRenameOpen(true),
    onAskDelete: () => setDeleteOpen(true),
    running: showRunning,
    hasPending: pendingKind != null,
  });
  // 右键落点（虚拟锚点）：null = 菜单关闭。批量模式与草稿行不唤起
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  // 归入所在列表的 fluid hover 作用域；不在列表里渲染时（无 Provider）跳过
  const rowRef = useRef<HTMLDivElement>(null);
  const slot = useContext(RowHoverContext);
  useRegisterFluidHoverItem(slot?.registerItem, slot?.index, rowRef);
  // 项目文件夹内的行：去掉行首模式图标，标题与项目标题左缘对齐（ps-9）
  const nestedInProject = useContext(ProjectChildRowContext);
  // 置顶卡顶部平铺的行：行首画图钉，和「置顶」分区头呼应
  const inPinnedSection = useContext(PinnedRowContext);
  // 任务区行：轻缩进一档区分层级即可（ps-6），行首模式图标保留
  const taskIndented = useContext(IndentedRowContext);
  // 拖拽移动到项目：仅项目 tab 提供控制器（任务 tab 无可见落点，不可拖）；
  // 与「移动到项目…」菜单项同口径，桌面端专属
  const dragApi = useContext(SessionDragContext);
  const dragged = useIsSessionDragged(remoteId);
  const desktop = isDesktop();

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
      // hover:bg-muted；focus/open/active 底色保留（盖在高亮之上）；
      // data-pending：乐观选中（点击到 store 追平之间的即时高亮）
      // 拖拽源：按下即登记（位移过阈值才真正进入拖拽），运行中/挂起/批量
      // 模式不进入拖拽，行保持原点击行为
      onPointerDown={
        dragApi && desktop && remoteId && !batchActive
          ? (event) =>
              dragApi.onRowPointerDown(event, {
                sessionId: remoteId,
                title: title || "新对话",
                blocked: showRunning || pendingKind != null,
              })
          : undefined
      }
      className={cn(
        "group focus-visible:bg-selected data-active:bg-selected data-pending:bg-selected has-focus-visible:bg-selected has-data-[state=open]:bg-selected relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none data-[batch-selected]:bg-selected",
        // 正被拖拽的行置灰，落点由悬浮牌与目标组头高亮表达
        dragged && "opacity-40",
      )}
      data-batch-selected={batchActive && batchSelected ? "true" : undefined}
      data-pending={pendingSelect ? "true" : undefined}
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
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md ps-2.5 text-start text-sm outline-none",
            // 项目子树 ps-9 对齐项目标题、竖线留在外侧；任务区只轻缩进一档
            nestedInProject && "ps-9",
            taskIndented && "ps-6",
          )}
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
          {/* 档位图标：批量模式行首被勾选框占了，图标改挂在勾选框右侧（此模式下
              不与置顶/未读/运行态抢槽位，它们都让位给勾选流了）；项目子树里
              不画，靠缩进表达层级 */}
          {!nestedInProject && (
            <ModeIcon
              aria-label={t("chat.header.appModeAria", {
                mode: t(APP_MODE_META[sessionAppMode].labelKey),
              })}
              className="text-muted-foreground me-1.5 size-3.5 shrink-0"
            />
          )}
          <HoverScrollText
            data-slot="aui_thread-list-item-title"
            className={cn("me-3", unread && "font-medium")}
          >
            {title || t("common.newChat")}
          </HoverScrollText>
        </button>
      ) : (
        <ThreadListItemPrimitive.Trigger
          data-slot="aui_thread-list-item-trigger"
          // 与库的切换动作合并执行（createActionButton 的 composeEventHandlers）：
          // 点击瞬间高亮先动，真实切换随后按原路径进行
          onClick={() => markPendingThreadSelection(itemId)}
          // 右侧槽位常驻 pe-14(56px)：容纳用时（如「10月17日」）、挂起徽标
          // 与 hover 时右侧并排的置顶+更多两枚按钮，标题截断在任何状态下不跳动
          className={cn(
            "group focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center rounded-md pe-14 ps-2.5 text-start text-sm outline-none focus-visible:ring-1",
            nestedInProject && "ps-9",
            taskIndented && "ps-6",
            // 置顶卡行首留给常驻图钉按钮（28px + start-1 的 4px）
            inPinnedSection && "ps-8",
          )}
        >
          {/* 运行指示与未读点按条件内联占位：平铺行行首无图标，标题与分区头
              文字同缘；置顶卡行的行首由常驻图钉按钮占位（见下方 sibling），
              这里只处理运行/未读。项目子树 ps-9、任务区 ps-6 各自让出层级位。
              指示出现时行内让位、标题右移；未读点保留标题加粗双通道提示 */}
          {showRunning && (
            <DotMatrix
              aria-hidden
              state="loading"
              data-slot="aui_thread-list-item-running"
              className="text-muted-foreground me-1.5 size-3.5 shrink-0"
            />
          )}
          {unread && !showRunning && (
            <span
              aria-hidden
              data-slot="aui_thread-list-item-unread"
              className="bg-blue-500 me-1.5 size-1.5 shrink-0 rounded-full"
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
          <HoverScrollText
            data-slot="aui_thread-list-item-title"
            className={cn(unread && "font-medium")}
          >
            {liveTitle ?? <ThreadListItemPrimitive.Title fallback={t("common.newChat")} />}
          </HoverScrollText>
          {showRunning && <span className="sr-only">Running</span>}
        </ThreadListItemPrimitive.Trigger>
      )}
      {/* 置顶卡行的常驻图钉按钮：行首可见、直接点击取消置顶。放在 trigger
          外侧（button 不能嵌 button），trigger 用 ps-8 给 28px 命中区让位 */}
      {inPinnedSection && remoteId && !batchActive ? (
        <button
          type="button"
          data-slot="aui_thread-list-item-pinned"
          title={pinned ? "取消置顶" : "置顶"}
          aria-label={pinned ? "取消置顶" : "置顶"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePinSession(remoteId);
          }}
          className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring absolute start-1 top-1/2 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-md transition-colors"
        >
          <PinIcon className="size-3.5 fill-current" />
        </button>
      ) : null}
      {/* 置顶快捷按钮：非置顶区行 hover 时出现在右侧槽位（end-8 的 size-6，
          与靠边的「更多」按钮并排）；置顶区行已由行首常驻图钉承担取消置顶。
          不用 Button 组件——默认变体的 bg-primary/h-8/px-3 与 size-6 冲突导致
          盒子尺寸漂移、图标错位，且其 active:translate-y-px 会让点击时图标下移。
          运行中同样出现（按钮在行尾，与行首 spinner 不同槽）；停止入口只在
          输入框（侧边栏 stop 按钮已按需求移除） */}
      {remoteId && !batchActive && !inPinnedSection ? (
        <button
          data-slot="aui_thread-list-item-pin"
          title={pinned ? "取消置顶" : "置顶"}
          aria-label={pinned ? "取消置顶" : "置顶"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePinSession(remoteId);
          }}
          className="text-muted-foreground hover:bg-muted hover:text-foreground absolute end-8 top-1/2 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-has-focus-visible:opacity-100"
        >
          <PinIcon className="size-3.5" />
        </button>
      ) : null}
      {/* 用时与挂起徽标/置顶/更多共用右侧槽位（end-1.5 绝对定位），选中行也
          显示用时；显隐条件与右侧按钮严格互补（hover / 键盘焦点 / 菜单展开时
          按钮出现，此处隐藏）。双方都瞬时切换、不带透明度过渡，避免交叉淡出
          期间两个同时可见。trigger 常驻 pe-14 为该槽位留宽，标题截断在任何
          状态下不跳动。批量模式下 pin/用时/菜单全部让位勾选流 */}
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
            // 与「…」下拉同一版式：同宽（min-w-56）、同一套分隔线与行高
            className="min-w-56"
          >
            {rowMenu.items.map((item) => {
              if (item.kind === "separator") {
                return <ContextMenuSeparator key={item.key} className="bg-border" />;
              }
              const node = (
                <ContextMenuItem
                  disabled={item.disabled}
                  variant={item.destructive ? "destructive" : "default"}
                  onClick={item.onSelect}
                  // 与「…」下拉同版式：无行内图标、行更高、右留快捷键位；
                  // 危险项沿用 destructive 变体自带的红字/红底高亮
                  className={
                    item.destructive
                      ? "justify-between gap-6 rounded-md px-3 py-2"
                      : "focus:bg-accent justify-between gap-6 rounded-md px-3 py-2"
                  }
                >
                  <span className="min-w-0 truncate">{item.label}</span>
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
            <AlertDialogTitle>{t("chat.threadList.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat.threadList.deleteDesc", { title: title || t("common.newChat") })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default" onClick={() => setDeleteOpen(false)}>取消</AlertDialogCancel>
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
 * 菜单顺序对齐参考稿：置顶 → 重命名 → 分支 → 移动 → 归档 → 标记未读 ┃
 * Finder → 复制路径 → 复制会话 ID → 调用轨迹 ┃ 删除。
 */
const useThreadRowMenu = ({
  onRename,
  onAskDelete,
  running,
  hasPending,
}: {
  onRename: () => void;
  onAskDelete: () => void;
  /** 运行中：移动项禁用（行组件已订阅两路运行态，避免每行重复订阅） */
  running: boolean;
  /** 有挂起的审批/问题：移动会把按旧目录审阅的操作带到新目录，先结算 */
  hasPending: boolean;
}): { items: ThreadRowMenuItem[]; isNew: boolean } => {
  const t = useT();
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
    openPanelTab("loop", { sessionId: remoteId });
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

  /**
   * 移动会话到已有项目：只换 cwd，sessionId/历史不变（pi-move 的等价语义）。
   * 目标列表由全局对话框从"已有项目目录"里取，不弹系统任意文件夹。
   * 运行中/有挂起交互时菜单项直接置灰——见 items 里的 disabled 与 label。
   */
  const askMove = () => {
    if (!remoteId || running || hasPending) return;
    openMoveSessionDialog(remoteId);
  };

  const moveBlockedReason = running
    ? "运行中"
    : hasPending
      ? "先处理挂起"
      : null;

  const desktop = isDesktop();

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
          {
            kind: "item",
            key: "handoff",
            label: t("chat.handoff.action"),
            icon: ArrowRightLeftIcon,
            // 交接要跑一次摘要请求：运行中 sidecar 会拒绝，入口直接置灰
            onSelect: () => openHandoffDialog(remoteId),
            disabled: running || branching,
          },
          ...(desktop
            ? ([
                {
                  kind: "item",
                  key: "move",
                  label: moveBlockedReason
                    ? `移动到项目…（${moveBlockedReason}）`
                    : "移动到项目…",
                  icon: FolderInputIcon,
                  onSelect: askMove,
                  disabled: moveBlockedReason != null,
                },
              ] satisfies ThreadRowMenuItem[])
            : []),
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
          // transition-colors 覆盖 Button 基类的颜色/透明度过渡：基类过渡
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
        className="bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-56 overflow-hidden rounded-xl border p-1 shadow-lg"
      >
        {items.map((item) =>
          item.kind === "separator" ? (
            <ThreadListItemMorePrimitive.Separator
              key={item.key}
              className="bg-border -mx-1 my-1 h-px"
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
    // 系统菜单式排版（对齐 macOS / VSCode 右键菜单）：不带行内图标、行更高、
    // 右侧预留快捷键位（justify-between；将来有真实绑定再填 <kbd>）
    className={
      item.destructive
        ? "text-destructive hover:bg-destructive/10 focus:bg-destructive/10 flex cursor-pointer items-center justify-between gap-6 rounded-md px-3 py-2 text-sm outline-none select-none"
        : "hover:bg-accent focus:bg-accent flex cursor-pointer items-center justify-between gap-6 rounded-md px-3 py-2 text-sm outline-none select-none disabled:cursor-not-allowed disabled:opacity-50"
    }
    disabled={item.disabled}
    onSelect={item.onSelect}
  >
    <span className="min-w-0 truncate">{item.label}</span>
  </ThreadListItemMorePrimitive.Item>
);
