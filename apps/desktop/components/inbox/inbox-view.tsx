"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useAui } from "@assistant-ui/react";
import type {
  InboxExternalChecks,
  InboxExternalDetail,
  InboxFilter,
  InboxItem,
} from "pi-protocol";
import {
  AlertCircleIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  CheckCheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  FilterIcon,
  InboxIcon,
  ListChecksIcon,
  Loader2Icon,
  MailIcon,
  MessageSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  TargetIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClampedText } from "@/components/ui/clamped-text";
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
  PROVIDER_META,
  ProviderMark,
} from "@/components/custom-ui/provider-glyph";
import { toast } from "@/components/ui/toast";
import { requestSettingsSection } from "@/lib/connector-nav";
import { openExternal } from "@/lib/external-link";
import {
  initInboxConnectors,
  syncInboxConnector,
  useInboxConnectors,
} from "@/lib/inbox/connectors";
import { relativeTime } from "@/lib/inbox/format";
import {
  markSentAgentPending,
  recordSentAgentThread,
} from "@/lib/inbox/sent-agent";
import {
  requestOpenInboxItem,
  subscribeOpenInboxItem,
} from "@/lib/inbox/inbox-events";
import {
  buildInboxAgentContext,
  buildInboxChip,
  saveInboxAgentContext,
} from "@/lib/composer/inbox-reference";
import {
  archivableItemIdsOfGroup,
  groupInboxItems,
  unreadItemIdsOfGroup,
  type InboxGroup,
  type InboxViewTab,
} from "@/lib/inbox/inbox-groups";
import {
  ensureInboxLoaded,
  loadInboxDetail,
  loadMoreInbox,
  markAllInboxRead,
  refreshInbox,
  runInboxAction,
  setInboxFilter,
  updateInboxItems,
  useInbox,
} from "@/lib/inbox/inbox-store";
import {
  matchesTime,
  type TimeFilter,
} from "@/lib/inbox/inbox-filters";
import { requestOpenChat } from "@/lib/pi/open-chat";
import { requestOpenSession } from "@/lib/pi/open-session";
import {
  projectDisplayName,
  projectPrimaryPath,
  useProjectRegistry,
  type ProjectRecord,
} from "@/lib/pi/pi-projects";
import { useThreadItems } from "@/lib/thread-list/thread-items";
import { setWorkspace } from "@/lib/workspace/workspace-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { snoozeUntil, type SnoozePreset } from "@/lib/inbox/snooze";
import {
  ExternalIssueDetail,
  type SendToAgentMode,
} from "./external-issue-detail";
import { LocalItemDetail } from "./local-item-detail";
import { Tooltip } from "../ui/tooltip-adapter";
import { TooltipTrigger } from "../ui/tooltip";

/**
 * 收件箱：Linear 式 issue inbox。
 *
 * 左栏 = 来源 Tab + 队列（每个 Issue/任务一行，选中即读）；右栏 = 详情阅读窗。
 * 外部来源的正文/评论按需从 provider 拉取（主进程有 Token），不在 journal 里。
 * 本地 agent 事件（审批/提问/自动化/子代理/后台任务）复用 InboxDetailPanel。
 */

const LOCAL_KINDS = [
  "approval",
  "question",
  "goal",
  "automation",
  "subagent",
  "background_task",
] as const;

const VIEW_TABS = ["attention", "history", "archived"] as const;
/** 稳定的空数组：避免 scope 切换时每次渲染新建 [] 触发选择/焦点 effect */
const NO_GROUPS: InboxGroup[] = [];

type AdvancedFilters = {
  time: TimeFilter;
  status: "all" | "open" | "closed";
  team: string;
  project: string;
  kind: "all" | (typeof LOCAL_KINDS)[number];
  /** 外部平台 tab：Issue / PR 类型筛选 */
  externalKind: "all" | "issue" | "pr";
  /** 待关注视图：是否把 snooze 中的条目也列出来 */
  includeSnoozed: boolean;
};

const DEFAULT_ADVANCED: AdvancedFilters = {
  time: "all",
  status: "all",
  team: "all",
  project: "all",
  kind: "all",
  externalKind: "all",
  includeSnoozed: false,
};

/** 除时间外的筛选都跟来源绑定：各来源各存一份，切回来能恢复 */
type SourceAdvancedFilters = Omit<AdvancedFilters, "time">;
const DEFAULT_SOURCE_ADVANCED: SourceAdvancedFilters = {
  status: "all",
  team: "all",
  project: "all",
  kind: "all",
  externalKind: "all",
  includeSnoozed: false,
};

const KIND_ICONS: Record<InboxItem["kind"], LucideIcon> = {
  approval: ShieldCheckIcon,
  question: MessageSquareIcon,
  goal: TargetIcon,
  automation: ZapIcon,
  subagent: BotIcon,
  background_task: TerminalIcon,
  external: InboxIcon,
};

type SourceTab = {
  id: string;
  label: string;
  provider?: string;
  icon?: LucideIcon;
};

const TYPE_KEYS: Record<string, string> = {
  issue: "issue",
  pull_request: "pullRequest",
  merge_request: "mergeRequest",
  ticket: "ticket",
  discussion: "discussion",
  release: "release",
  commit: "commit",
};

function externalTypeLabel(
  type: string | undefined,
  t: ReturnType<typeof useT>,
): string {
  if (!type) return "";
  const key = TYPE_KEYS[type];
  if (!key) return type;
  const full = `inbox.issue.types.${key}`;
  const text = t(full);
  return text === full ? type : text;
}

function externalReasonLabel(
  item: InboxItem,
  t: ReturnType<typeof useT>,
): string | undefined {
  const reason = item.external?.reason ??
    (typeof item.meta?.reason === "string" ? item.meta.reason : undefined);
  if (!reason) return undefined;
  const full = `inbox.reasons.${reason}`;
  const text = t(full);
  return text === full ? reason : text;
}

function groupLabel(group: InboxGroup, t: ReturnType<typeof useT>): string {
  if (group.label === "task") return t("inbox.row.task");
  return t(`inbox.event.${group.label}`);
}

/** 行首来源线：外部事项给「类型 · 编号」，本地事件给事件类型。 */
function topLineOf(group: InboxGroup, t: ReturnType<typeof useT>): string {
  const item = group.latest;
  if (item.kind === "external") {
    return [
      externalTypeLabel(item.external?.type, t) ||
        PROVIDER_META[item.external?.provider ?? ""]?.label,
      item.external?.key,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
  }
  return groupLabel(group, t);
}

/** 行末辅助线：外部事项给触发原因/来源，本地事件给最新结果摘要。 */
function bottomLineOf(group: InboxGroup, t: ReturnType<typeof useT>): string {
  const item = group.latest;
  const updates =
    group.items.length > 1
      ? t("inbox.issue.updates", { count: group.items.length })
      : undefined;
  if (item.kind === "external") {
    return [
      externalReasonLabel(item, t),
      item.external?.sourceName,
      updates,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
  }
  return [updates, item.summary]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/** 外部事项按 provider 状态文本判断开放/关闭；本地事项按是否仍需动作判断。 */
function isClosedItem(item: InboxItem): boolean {
  if (item.kind === "external") {
    return /closed|done|completed|cancel(?:l)?ed|merged|resolved/i.test(
      item.external?.status ?? "",
    );
  }
  return !item.requiresAction && item.state !== "open";
}

function matchesStatus(
  item: InboxItem,
  status: "all" | "open" | "closed",
): boolean {
  if (status === "all") return true;
  return status === "closed" ? isClosedItem(item) : !isClosedItem(item);
}

const FilterSection: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <>
    <div className="text-muted-foreground px-2 pt-2 pb-1 text-3xs font-semibold tracking-wide uppercase">
      {label}
    </div>
    {children}
  </>
);

const FilterChoice: FC<{
  label: string;
  value: string;
}> = ({ label, value }) => (
  <DropdownMenuRadioItem value={value} className="justify-between">
    <Tooltip side="right" content={label} children={<span className="w-full text-ellipsis  line-clamp-1 text-nowrap">
      {label}
    </span>}>
    </Tooltip>
    {/* <ClampedText text={label} lines={1} className="min-w-0" /> */}
  </DropdownMenuRadioItem>
);

function emptyCopy(
  tab: InboxViewTab,
  t: ReturnType<typeof useT>,
  filtered: boolean,
): { title: string; description: string } {
  if (filtered) {
    return {
      title: t("inbox.empty.searchTitle"),
      description: t("inbox.empty.searchDescription"),
    };
  }
  if (tab === "archived") {
    return {
      title: t("inbox.empty.archivedTitle"),
      description: t("inbox.empty.archivedDescription"),
    };
  }
  if (tab === "history") {
    return {
      title: t("inbox.empty.historyTitle"),
      description: t("inbox.empty.historyDescription"),
    };
  }
  return {
    title: t("inbox.empty.attentionTitle"),
    description: t("inbox.empty.attentionDescription"),
  };
}

/**
 * 「交给 Agent」的输入：一枚收件箱事项芯片 + 一行指令。
 * 标题/链接/正文/评论在点击时固化进上下文快照（inbox-reference），发送时展开成
 * 隐藏块——composer 里不再糊一整段 issue 文本。
 */
function buildAgentHandoff(
  item: InboxItem,
  detail: InboxExternalDetail | null,
  mode: SendToAgentMode,
  t: ReturnType<typeof useT>,
  checks?: InboxExternalChecks,
): string {
  const provider =
    PROVIDER_META[item.external?.provider ?? ""]?.label ??
    item.external?.provider ??
    t("inbox.event.external");
  const type =
    externalTypeLabel(item.external?.type, t) || t("inbox.event.external");
  const ctx = buildInboxAgentContext({
    itemId: item.id,
    providerLabel: provider,
    typeLabel: type,
    key: item.external?.key ?? item.sourceId,
    title: detail?.title ?? item.title,
    url: detail?.url ?? item.external?.url ?? item.deepLink?.url,
    status: detail?.state ?? item.external?.status,
    assignee: detail?.assignee,
    body: detail?.body ?? item.summary,
    comments: detail?.comments,
  });
  saveInboxAgentContext(ctx);
  const chip = buildInboxChip(ctx);
  const instruction =
    mode === "repair"
      ? "下面是这个 PR/MR 当前失败的检查项。请先定位失败原因并给出修复方案；确认前不要改文件。"
      : mode === "send"
        ? "请先阅读上面的上下文，复述你对它的理解并给出处理方案；确认前不要改文件。"
        : "我的问题：\n";
  const checksText = checks
    ? `\n\n失败的检查项：\n${formatChecksForPrompt(checks)}`
    : "";
  return `${chip}\n\n${instruction}${checksText}`;
}

/** checks 面板交给 Agent 时的正文：只带失败项 + 截断输出，避免整页日志进模型 */
function formatChecksForPrompt(checks: InboxExternalChecks): string {
  const failed = checks.checks.filter((check) => check.state === "fail");
  const rows = (failed.length > 0 ? failed : checks.checks).slice(0, 10);
  return rows
    .map((check, index) => {
      const workflow = check.workflow ? `（${check.workflow}）` : "";
      const description = check.description?.trim();
      const output = check.output?.trim();
      return [
        `${index + 1}. ${check.name}${workflow} — ${check.state}`,
        description ? `   说明：${description.slice(0, 600)}` : "",
        output ? `   输出：${output.slice(0, 1_200)}` : "",
        check.detailsUrl ? `   链接：${check.detailsUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

export const InboxView: FC = () => {
  const t = useT();
  const snap = useInbox();
  const aui = useAui();
  const threadItems = useThreadItems();
  const connectorView = useInboxConnectors();

  /** 手动刷新至少让图标转 ~600ms：接口太快时 spinner 一闪而过，
   *  按钮看起来像没反应（loading 态本身由 store 正确维护） */
  const [manualSpin, setManualSpin] = useState(false);
  const manualSpinTimer = useRef<number | null>(null);
  const spinRefresh = useCallback(() => {
    setManualSpin(true);
    if (manualSpinTimer.current) window.clearTimeout(manualSpinTimer.current);
    void refreshInbox().finally(() => {
      manualSpinTimer.current = window.setTimeout(
        () => setManualSpin(false),
        600,
      );
    });
  }, []);
  useEffect(
    () => () => {
      if (manualSpinTimer.current) window.clearTimeout(manualSpinTimer.current);
    },
    [],
  );
  const refreshing = snap.loading || manualSpin;

  const [sourceId, setSourceId] = useState("all");
  const [viewTab, setViewTab] = useState<InboxViewTab>("attention");
  const [query, setQuery] = useState(snap.filter.query ?? "");
  const [sourceEdges, setSourceEdges] = useState({ left: false, right: false });
  const [filterOpen, setFilterOpen] = useState(false);
  const [advanced, setAdvanced] = useState<AdvancedFilters>({
    ...DEFAULT_ADVANCED,
  });
  /** 按来源缓存除时间外的筛选条件，切换来源时存一份、取一份 */
  const advancedBySourceRef = useRef(new Map<string, SourceAdvancedFilters>());
  const projects = useProjectRegistry();
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  /** 键盘 roving tabindex：只有当前行是 Tab 停靠点，↑/↓ 在行间移动 */
  const [focusGroupKey, setFocusGroupKey] = useState<string | null>(null);
  /** 行被已读/归档移除时，焦点需要落到新的第一行，而不是掉到 body */
  const listHasFocusRef = useRef(false);
  const [sending, setSending] = useState(false);
  const sourceScrollRef = useRef<HTMLDivElement | null>(null);
  /** 来源 tab 的按钮引用：下划线按激活按钮的几何定位 */
  const sourceButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  /** 下划线相对滚动容器的 left/width；null 表示还没量到，先不渲染避免从 0 滑入 */
  const [sourceUnderline, setSourceUnderline] = useState<{
    left: number;
    width: number;
  } | null>(null);
  /** 横幅「重试同步」进行中：逐个重推失败来源，避免等退避 */
  const [retryingBroken, setRetryingBroken] = useState(false);
  /** 整页视图的顶栏槽位：把收件箱 header 并进应用 48px 窗口边框条 */
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  /** 系统通知点击直达：等数据到了再选中这条事项（inbox:open 可能早于列表加载） */
  const [pendingOpenItemId, setPendingOpenItemId] = useState<string | null>(
    null,
  );
  const [deleteRequest, setDeleteRequest] = useState<{
    items: InboxItem[];
    label?: string;
  } | null>(null);
  const initialFilterApplied = useRef(false);
  const detailScrollRef = useRef<HTMLElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  /** 上次自动续拉时的可见行数：客户端筛选可能把整页滤掉，行数不涨就停止空转 */
  const autoLoadVisibleRef = useRef<number | null>(null);

  const sourceTabs = useMemo<SourceTab[]>(() => {
    const tabs: SourceTab[] = [
      { id: "all", label: t("inbox.issue.sources.all"), icon: InboxIcon },
      { id: "task", label: t("inbox.issue.sources.task"), icon: ListChecksIcon },
    ];
    const seen = new Set<string>();
    for (const connector of connectorView.connectors) {
      if (seen.has(connector.provider)) continue;
      seen.add(connector.provider);
      tabs.push({
        id: connector.provider,
        label: PROVIDER_META[connector.provider]?.label ?? connector.provider,
        provider: connector.provider,
      });
    }
    return tabs;
  }, [connectorView.connectors, t]);
  /** 来源 tabs 横向滚动：只在溢出方向显示箭头 */
  const updateSourceEdges = () => {
    const el = sourceScrollRef.current;
    if (!el) {
      setSourceEdges((prev) =>
        prev.left || prev.right ? { left: false, right: false } : prev,
      );
      return;
    }
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setSourceEdges((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  };

  useEffect(() => {
    const el = sourceScrollRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(updateSourceEdges);
    const observer = new ResizeObserver(updateSourceEdges);
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [sourceTabs.length]);

  useEffect(() => {
    sourceScrollRef.current
      ?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sourceId]);

  /** 下划线：量激活 tab 在滚动容器内的几何，切换时交给 CSS transition 滑过去 */
  const measureSourceUnderline = useCallback(() => {
    const btn = sourceButtonRefs.current.get(sourceId);
    if (!btn) return;
    // 左右各收 6px，下划线比按钮稍窄，不贴满整个可点击区
    setSourceUnderline({
      left: btn.offsetLeft + 6,
      width: btn.offsetWidth - 12,
    });
  }, [sourceId]);

  useLayoutEffect(() => {
    measureSourceUnderline();
  }, [measureSourceUnderline, sourceTabs.length]);

  // 字体就绪 / 连接器增多导致文本宽度变化后重测，避免指示器偏移
  useEffect(() => {
    const el = sourceScrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(measureSourceUnderline);
    observer.observe(el);
    for (const btn of sourceButtonRefs.current.values()) observer.observe(btn);
    return () => observer.disconnect();
  }, [measureSourceUnderline, sourceTabs.length]);

  const scrollSources = (direction: -1 | 1) => {
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    sourceScrollRef.current?.scrollBy({
      left: direction * 140,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  const buildFilter = (
    nextSource = sourceId,
    nextTab = viewTab,
    nextQuery = query,
    nextAdvanced = advanced,
  ): InboxFilter => {
    const source = sourceTabs.find((tab) => tab.id === nextSource);
    const trimmed = nextQuery.trim();
    const filter: InboxFilter = { tab: nextTab };
    if (source?.provider) {
      filter.source = source.provider;
      filter.kinds = ["external"];
    } else if (nextSource === "task") {
      filter.kinds = [...LOCAL_KINDS];
    }
    if (trimmed) filter.query = trimmed;
    if (nextAdvanced.includeSnoozed && nextTab === "attention") {
      filter.includeSnoozed = true;
    }
    return filter;
  };

  /** 切换来源：先存下当前来源的筛选，再取出目标来源上次的条件（时间全局保留） */
  const switchAdvancedForSource = (nextSource: string): AdvancedFilters => {
    const { time, ...sourceScoped } = advanced;
    advancedBySourceRef.current.set(sourceId, sourceScoped);
    const restored = advancedBySourceRef.current.get(nextSource);
    return { ...(restored ?? DEFAULT_SOURCE_ADVANCED), time };
  };

  // 连接器被移除/禁用后，当前选中的来源 tab 可能已经不存在：回落到「全部」，
  // 否则筛选会停在已消失的 provider 上，列表会一直等不到数据。
  useEffect(() => {
    if (sourceId === "all" || sourceId === "task") return;
    if (sourceTabs.some((tab) => tab.id === sourceId)) return;
    const nextAdvanced = switchAdvancedForSource("all");
    setSourceId("all");
    setSelectedGroupKey(null);
    setAdvanced(nextAdvanced);
    void setInboxFilter(buildFilter("all", viewTab, query, nextAdvanced));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, sourceTabs, viewTab, query]);

  const sessionTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of threadItems) {
      if (item.remoteId && item.title) map.set(item.remoteId, item.title);
    }
    return map;
  }, [threadItems]);

  const knownSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of threadItems) {
      if (item.remoteId) ids.add(item.remoteId);
      if (item.id) ids.add(item.id);
    }
    return ids;
  }, [threadItems]);

  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const item of snap.items) {
      if (item.kind === "external" && item.external?.sourceName) {
        set.add(item.external.sourceName);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [snap.items]);

  const activeAdvancedCount = [
    advanced.time !== "all",
    advanced.status !== "all",
    advanced.team !== "all",
    advanced.project !== "all",
    advanced.kind !== "all",
    advanced.externalKind !== "all",
    viewTab === "attention" && advanced.includeSnoozed,
  ].filter(Boolean).length;
  /** 视图已挪到左栏顶部的分段切换里，筛选图标只提示额外筛选条件 */
  const filterActive = activeAdvancedCount > 0;
  const filterButtonLabel = filterActive
    ? t("inbox.filterMenu.active", { count: activeAdvancedCount })
    : t("inbox.filterMenu.title");

  const filteredItems = useMemo(
    () =>
      snap.items.filter((item) => {
        if (!matchesTime(item, advanced.time)) return false;
        if (!matchesStatus(item, advanced.status)) return false;
        if (advanced.kind !== "all" && item.kind !== advanced.kind) return false;
        if (advanced.externalKind !== "all") {
          if (item.kind !== "external") return false;
          const type = (item.external?.type ?? "").toLowerCase();
          const isPr = type === "pull_request" || type === "merge_request";
          const isIssue = type === "issue" || type === "ticket";
          if (advanced.externalKind === "pr" && !isPr) return false;
          if (advanced.externalKind === "issue" && !isIssue) return false;
        }
        if (
          advanced.team !== "all" &&
          item.external?.sourceName !== advanced.team
        ) {
          return false;
        }
        if (advanced.project !== "all") {
          if (advanced.project === "none") {
            if (item.projectId) return false;
          } else if (item.projectId !== advanced.project) {
            return false;
          }
        }
        return true;
      }),
    [snap.items, advanced],
  );

  const groups = useMemo(
    () => groupInboxItems(filteredItems, { tab: viewTab, sessionTitles }),
    [filteredItems, viewTab, sessionTitles],
  );
  /**
   * 切换来源/Tab/搜索时 store 会先清空 items 再拉取。上一份分组只在
   * 「同一个筛选条件」的刷新中复用，避免切完 Tab 还挂着上一个列表的
   * 内容（看起来像旧数据闪了一下才消失）；跨筛选切换宁可短暂留白/加载态。
   * 搜索词不放进 scope：输入过程中列表保持原样，防抖发出请求后才进入加载。
   */
  const listScope = `${viewTab}\u0000${sourceId}\u0000${advanced.time}\u0000${
    advanced.status
  }\u0000${advanced.team}\u0000${advanced.project}\u0000${advanced.kind}\u0000${
    advanced.externalKind
  }\u0000${advanced.includeSnoozed ? 1 : 0}`;
  // 切换来源/Tab 后回到列表顶部：沿用上一份列表的滚动位置会让新列表
  // 一开始就停在半截，看起来像旧内容还没退干净。
  useLayoutEffect(() => {
    listScrollRef.current?.scrollTo({ top: 0 });
  }, [listScope]);
  const expectedFilter = buildFilter(sourceId, viewTab, query);
  const listScopeSettled =
    (snap.filter.tab ?? "action") === expectedFilter.tab &&
    (snap.filter.source ?? "") === (expectedFilter.source ?? "") &&
    (snap.filter.kinds ?? []).join(",") ===
      (expectedFilter.kinds ?? []).join(",") &&
    Boolean(snap.filter.includeSnoozed) ===
      Boolean(expectedFilter.includeSnoozed);
  const lastGroupsRef = useRef<{
    scope: string;
    groups: InboxGroup[];
  }>({ scope: "", groups: [] });
  /** 当前 UI 的筛选还没同步到 store（或首次加载）：此时 groups 可能还是上一份筛选的数据 */
  const filterTransitioning =
    !listScopeSettled || (!snap.loaded && !snap.error);
  /** 当前列表在等数据：筛选切换后会清空 items；同筛选刷新则保留 items */
  const awaitingData =
    filterTransitioning || (snap.loading && groups.length === 0);
  useEffect(() => {
    if (!filterTransitioning && !snap.loading && groups.length > 0) {
      lastGroupsRef.current = { scope: listScope, groups };
    }
  }, [groups, filterTransitioning, snap.loading, listScope]);
  const cachedGroups = lastGroupsRef.current;
  const visibleGroups = awaitingData
    ? cachedGroups.scope === listScope
      ? cachedGroups.groups
      : NO_GROUPS
    : groups;
  const awaitingGroups = awaitingData && visibleGroups.length === 0;
  /** 同筛选的列表重拉：保留旧行但置灰，避免列表闪空 */
  const showingCachedGroups = awaitingData && visibleGroups.length > 0;

  // 列表接近底部时自动续拉下一页（每页 50 条，游标由 store 维护）。
  // 客户端筛选（今天/状态/来源等）在本地过滤，服务端分页并不知道；续拉回来
  // 的整页可能被全部滤掉，若继续自动续拉就会一页接一页地空转，列表和右侧
  // 详情跟着反复闪。可见行数没有增长就停止自动续拉。
  useEffect(() => {
    autoLoadVisibleRef.current = null;
  }, [listScope]);
  useEffect(() => {
    const root = listScrollRef.current;
    const target = loadMoreRef.current;
    if (!root || !target || !snap.nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const last = autoLoadVisibleRef.current;
        if (last !== null && visibleGroups.length <= last) return;
        autoLoadVisibleRef.current = visibleGroups.length;
        void loadMoreInbox();
      },
      { root, rootMargin: "0px 0px 240px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [snap.nextCursor, snap.loading, visibleGroups.length]);

  /** 骨架屏只用于首次加载：sidecar 列表查询通常几十毫秒，直接挂骨架会在
   *  切换来源/Tab 时闪一帧，看起来像页面抖了一下。已有数据后的切换不再
   *  展示骨架，最多在真的等了一会儿后给一个轻量加载提示。 */
  const loadingWithoutGroups = snap.loading && visibleGroups.length === 0;
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (!loadingWithoutGroups) {
      setShowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoading(true), 200);
    return () => window.clearTimeout(timer);
  }, [loadingWithoutGroups]);

  // 选中项/焦点都跟随**当前可见**的行，而不是底层 groups：切换来源/Tab 时
  // groups 可能还残留上一份数据，跟随它会让右栏闪一下上一个条目。
  const selectedGroup =
    visibleGroups.find((group) => group.key === selectedGroupKey) ?? null;
  // 一组（同一会话/任务）只展示最新事件；组内历史事件不再做二次切换列表，
  // 避免点击更新行时整块详情重挂载、内容跳动
  const selectedItem = selectedGroup?.latest ?? null;
  const readOnly = viewTab === "history" || viewTab === "archived";

  /**
   * 打开聚合行 = 看过这个任务的更新：把组内未读一起标已读。
   * 列表只展示每组最新一条，较早的未读事件没有单独入口；只标最新一条会让
   * 圆点永远清不掉（用户只能归档或「全部标为已读」）。requiresAction 的条目
   * 即使已读仍留在待关注，不会把等你决定的事藏掉。
   * 「已归档」Tab 也适用：未读就归档的条目同样有圆点，查看后应当清掉。
   */
  const markGroupRead = (group: InboxGroup) => {
    const ids = unreadItemIdsOfGroup(group);
    if (ids.length === 0) return;
    void updateInboxItems(ids, { read: true }).catch(() => {});
  };

  // 只使用当前事项自己的详情，避免切换时先闪一下上一条的详情
  const selectedItemDetail =
    selectedItem && snap.detailItemId === selectedItem.id ? snap.detail : null;
  const selectedItemDetailLoading =
    selectedItem !== null &&
    selectedItem.kind !== "external" &&
    (snap.detailLoading || snap.detailItemId !== selectedItem.id);
  const selectedItemDetailError =
    selectedItem && snap.detailItemId === selectedItem.id
      ? snap.detailError
      : null;

  useEffect(() => {
    void initInboxConnectors();
  }, []);

  useEffect(() => {
    setHeaderSlot(
      document.querySelector<HTMLElement>('[data-slot="page-header-actions"]'),
    );
  }, []);

  useEffect(() => {
    if (initialFilterApplied.current) return;
    initialFilterApplied.current = true;
    void setInboxFilter({ tab: "attention" });
    void ensureInboxLoaded();
  }, []);

  // 系统通知点击 → 打开对应事项：切回待关注、清掉筛选并重新拉取，
  // 否则在历史/归档 Tab 下点击通知会等不到条目数据。
  useEffect(
    () =>
      subscribeOpenInboxItem((itemId) => {
        setViewTab("attention");
        setQuery("");
        setSourceId("all");
        advancedBySourceRef.current.clear();
        setAdvanced({ ...DEFAULT_ADVANCED });
        setPendingOpenItemId(itemId);
        void setInboxFilter({ tab: "attention" });
      }),
    [],
  );

  useEffect(() => {
    if (!pendingOpenItemId) return;
    const item = snap.items.find((entry) => entry.id === pendingOpenItemId);
    if (!item) return;
    // 系统通知点击 = 用户主动查看该条目：和点击聚合行一样结算整组未读，
    // 避免组内其他未读把圆点继续挂在列表上。
    const group = groups.find((candidate) =>
      candidate.items.some((entry) => entry.id === item.id),
    );
    if (group) {
      setSelectedGroupKey(group.key);
      const ids = unreadItemIdsOfGroup(group);
      if (ids.length > 0) {
        void updateInboxItems(ids, { read: true }).catch(() => {});
      }
    } else {
      // 当前筛选/分页里看不到所属组：至少清掉通知对应的这一条
      const fallback = groupInboxItems([item], {
        tab: "attention",
        sessionTitles,
      })[0];
      if (fallback) setSelectedGroupKey(fallback.key);
      if (!item.readAt) {
        void updateInboxItems([item.id], { read: true }).catch(() => {});
      }
    }
    setPendingOpenItemId(null);
  }, [pendingOpenItemId, snap.items, sessionTitles, groups]);

  // query 只在输入防抖后下发；source/tab 由点击立即下发。
  // deps 必须带 sourceId/viewTab：否则输入后 300ms 内切换来源/Tab，旧定时器
  // 会用旧闭包把 filter 改回上一来源，UI 与列表数据不一致。
  useEffect(() => {
    const next = query.trim();
    if ((snap.filter.query ?? "") === next) return;
    const timer = setTimeout(() => {
      void setInboxFilter(buildFilter(sourceId, viewTab, query));
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, sourceId, viewTab, advanced.includeSnoozed]);

  useEffect(() => {
    if (visibleGroups.length === 0) {
      setSelectedGroupKey(null);
      return;
    }
    if (
      !selectedGroupKey ||
      !visibleGroups.some((group) => group.key === selectedGroupKey)
    ) {
      setSelectedGroupKey(visibleGroups[0].key);
    }
  }, [visibleGroups, selectedGroupKey]);

  // 选中变化时把 Tab 停靠点同步到该行；分组刷新后原停靠点不存在则回到首行
  useEffect(() => {
    if (selectedGroupKey) setFocusGroupKey(selectedGroupKey);
  }, [selectedGroupKey]);
  useEffect(() => {
    if (
      !focusGroupKey ||
      !visibleGroups.some((group) => group.key === focusGroupKey)
    ) {
      setFocusGroupKey(visibleGroups[0]?.key ?? null);
    }
  }, [visibleGroups, focusGroupKey]);

  // 已读/归档让当前行消失后，焦点会掉到 body；把它接回新的第一行
  useEffect(() => {
    if (!listHasFocusRef.current) return;
    const list = listScrollRef.current;
    if (!list) return;
    const active = document.activeElement;
    if (active && active !== document.body && list.contains(active)) return;
    const key = selectedGroupKey ?? focusGroupKey ?? visibleGroups[0]?.key;
    if (!key) return;
    listHasFocusRef.current = false;
    requestAnimationFrame(() => {
      const buttons =
        list.querySelectorAll<HTMLButtonElement>("[data-inbox-group]");
      for (const button of buttons) {
        if (button.dataset.inboxGroup !== key) continue;
        button.focus();
        break;
      }
    });
  }, [visibleGroups, selectedGroupKey, focusGroupKey]);

  useEffect(() => {
    if (!selectedItem || selectedItem.kind === "external") return;
    if (snap.detailItemId === selectedItem.id) return;
    void loadInboxDetail(selectedItem.id).catch(() => {});
  }, [selectedItem?.id, selectedItem?.kind]);

  // 注意：不要在这里对 selectedItem 做「选中即已读」。自动选中首行不是用户
  // 动作，会把打开页面当成已读；行点击、打开会话、通知打开会显式结算。

  // 切换事项时右栏回到顶部，避免沿用上一条的滚动位置导致页面跳动
  useLayoutEffect(() => {
    detailScrollRef.current?.scrollTo({ top: 0 });
  }, [selectedItem?.id]);

  const changeSource = (next: string) => {
    if (next === sourceId) return;
    // 各来源的筛选条件分别记住：切回来时恢复上次的条件，而不是被清空
    const nextAdvanced = switchAdvancedForSource(next);
    setSourceId(next);
    setSelectedGroupKey(null);
    setAdvanced(nextAdvanced);
    void setInboxFilter(buildFilter(next, viewTab, query, nextAdvanced));
  };

  const changeViewTab = (next: InboxViewTab) => {
    if (next === viewTab) return;
    setViewTab(next);
    setSelectedGroupKey(null);
    void setInboxFilter(buildFilter(sourceId, next, query));
  };

  const openSession = (sessionId: string | undefined) => {
    if (!sessionId) {
      toast.info(t("inbox.error.noSession"));
      return;
    }
    if (knownSessionIds.size > 0 && !knownSessionIds.has(sessionId)) {
      toast.info(t("inbox.error.noSession"));
      return;
    }
    requestOpenSession(sessionId, { unarchive: false });
  };

  /** 阅读窗里的「打开会话」也是查看：先清组内未读再跳转 */
  const openItemSession = (item: InboxItem) => {
    if (selectedGroup?.items.some((entry) => entry.id === item.id)) {
      markGroupRead(selectedGroup);
    }
    openSession(item.deepLink?.sessionId ?? item.sessionId);
  };

  /** 外部详情里的「打开链接 / 交给 Agent」等显式查看动作 */
  const handleMarkRead = (item: InboxItem) => {
    if (selectedGroup?.items.some((entry) => entry.id === item.id)) {
      markGroupRead(selectedGroup);
      return;
    }
    if (!item.readAt) {
      void updateInboxItems([item.id], { read: true }).catch(() => {});
    }
  };

  const showError = (error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    // 服务端错误是英文内部文案；常见用户动作错误翻成可执行的提示
    const message =
      raw.includes("INBOX_ACTION_NOT_ALLOWED") ||
      /cannot archive an open actionable|action is not valid|unknown action/i.test(
        raw,
      )
        ? t("inbox.error.actionNotAllowed")
        : raw.includes("INBOX_ALREADY_RESOLVED") ||
            /no longer actionable|already resolved/i.test(raw)
          ? t("inbox.error.alreadyResolved")
          : raw.includes("INBOX_ITEM_NOT_FOUND") || /item not found/i.test(raw)
            ? t("inbox.error.itemMissing")
            : raw;
    toast.error(t("inbox.error.actionFailed", { message }));
  };

  const handleAction = async (
    item: InboxItem,
    action: string,
    payload?: unknown,
  ) => {
    if (action === "open") {
      if (!readOnly && !item.readAt) {
        void updateInboxItems([item.id], { read: true }).catch(() => {});
      }
      const url = item.deepLink?.url;
      if (url) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            openExternal(url);
          }
        } catch {
          /* ignore invalid url */
        }
        return;
      }
      openSession(item.deepLink?.sessionId ?? item.sessionId);
      return;
    }
    if (action === "mark_read" || action === "mark_unread") {
      try {
        await updateInboxItems([item.id], { read: action === "mark_read" });
      } catch (error) {
        showError(error);
      }
      return;
    }
    try {
      // 审批的「允许并记住」、提问的 answers 都在 payload 里；丢掉它会让
      // 回答以空数组结算，Agent 收不到用户答案。
      await runInboxAction(item.id, action, payload);
      if (action === "archive" || action === "unarchive") {
        toast.success(t(`inbox.actionDone.${action}`));
      }
    } catch (error) {
      showError(error);
    }
  };

  const handleArchive = async (item: InboxItem, archived: boolean) => {
    try {
      await updateInboxItems([item.id], { archived });
      toast.success(
        t(archived ? "inbox.actionDone.archive" : "inbox.actionDone.unarchive"),
      );
    } catch (error) {
      showError(error);
    }
  };

  /** 行 = 任务：右键归档/恢复作用于组内所有可归档条目，而不是最新一条 */
  const handleGroupArchive = async (group: InboxGroup, archived: boolean) => {
    const ids = archivableItemIdsOfGroup(group, archived);
    if (ids.length === 0) return;
    try {
      await updateInboxItems(ids, { archived });
      toast.success(
        t(archived ? "inbox.actionDone.archive" : "inbox.actionDone.unarchive"),
      );
    } catch (error) {
      showError(error);
    }
  };

  const handleMarkUnread = async (item: InboxItem) => {
    try {
      await updateInboxItems([item.id], { read: false });
    } catch (error) {
      showError(error);
    }
  };

  /** 稍后提醒：null = 取消；行/详情共用一份写入与提示。 */
  const applySnooze = async (
    items: InboxItem[],
    preset: SnoozePreset | null,
  ) => {
    const ids = items.map((item) => item.id);
    if (ids.length === 0) return;
    try {
      await updateInboxItems(ids, {
        snoozedUntil: preset ? snoozeUntil(preset) : null,
      });
      if (preset) {
        toast.success({
          title: t("inbox.row.snoozeDone"),
          action: {
            label: t("inbox.row.undo"),
            onClick: (entry) => {
              toast.dismiss(entry.id);
              void updateInboxItems(ids, { snoozedUntil: null }).catch(
                showError,
              );
            },
          },
        });
      } else {
        toast.success(t("inbox.row.unsnoozeDone"));
      }
    } catch (error) {
      showError(error);
    }
  };

  /** 清掉搜索/来源/类型等全部条件，回到当前视图的完整列表 */
  const clearInboxFilters = () => {
    setQuery("");
    setSourceId("all");
    advancedBySourceRef.current.clear();
    setAdvanced({ ...DEFAULT_ADVANCED });
    setSelectedGroupKey(null);
    setFocusGroupKey(null);
    void setInboxFilter({ tab: viewTab });
  };

  /** ↑/↓/Home/End 在行间移动焦点；Enter/Space 由原生 button 负责打开 */
  const moveRowFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    group: InboxGroup,
  ) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "e") {
      if (readOnly) return;
      event.preventDefault();
      // 非只读只剩「待关注」Tab，归档方向固定为 true
      void handleGroupArchive(group, true);
      return;
    }
    if (event.key === "r") {
      event.preventDefault();
      markGroupRead(group);
      return;
    }
    const keys = visibleGroups.map((entry) => entry.key);
    const index = keys.indexOf(group.key);
    if (index < 0) return;
    let nextIndex = index;
    if (event.key === "ArrowDown" || event.key === "j")
      nextIndex = Math.min(keys.length - 1, index + 1);
    else if (event.key === "ArrowUp" || event.key === "k")
      nextIndex = Math.max(0, index - 1);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = keys.length - 1;
    else return;
    event.preventDefault();
    const nextKey = keys[nextIndex];
    if (!nextKey || nextKey === group.key) return;
    setFocusGroupKey(nextKey);
    const buttons =
      listScrollRef.current?.querySelectorAll<HTMLButtonElement>("[data-inbox-group]");
    for (const button of buttons ?? []) {
      if (button.dataset.inboxGroup !== nextKey) continue;
      button.focus();
      button.scrollIntoView({ block: "nearest" });
      break;
    }
  };

  const moveViewTab = (
    event: KeyboardEvent<HTMLButtonElement>,
    tab: InboxViewTab,
  ) => {
    const index = VIEW_TABS.indexOf(tab);
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % VIEW_TABS.length;
    else if (event.key === "ArrowLeft")
      nextIndex = (index - 1 + VIEW_TABS.length) % VIEW_TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = VIEW_TABS.length - 1;
    else return;
    event.preventDefault();
    const next = VIEW_TABS[nextIndex];
    if (!next) return;
    changeViewTab(next);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(`[data-inbox-view-tab="${next}"]`)
        ?.focus();
    });
  };

  const requestDelete = (items: InboxItem[], label?: string) => {
    const eligible = items.filter((item) => item.state !== "open");
    if (eligible.length === 0) return;
    setDeleteRequest(
      label && eligible.length > 1
        ? { items: eligible, label }
        : { items: eligible },
    );
  };

  const confirmDelete = async () => {
    const request = deleteRequest;
    setDeleteRequest(null);
    if (!request) return;
    try {
      await updateInboxItems(
        request.items.map((item) => item.id),
        { deleted: true },
      );
      toast.success(t("inbox.actionDone.delete"));
    } catch (error) {
      showError(error);
    }
  };

  const sendToAgent = async (
    item: InboxItem,
    detail: InboxExternalDetail | null,
    mode: SendToAgentMode,
    project: ProjectRecord | null,
    checks?: InboxExternalChecks,
  ) => {
    if (sending) return;
    setSending(true);
    try {
      const prompt = buildAgentHandoff(item, detail, mode, t, checks);
      if (project) {
        const path = projectPrimaryPath(project);
        if (path) setWorkspace(path, "user", project.id);
      }
      // 挂起回链：能同步拿到新线程 id 就直接记；拿不到再由 Base 在
      // mainThreadId 变化后补记（详情里可「查看会话」）
      markSentAgentPending(item.id);
      await aui.threads.switchToNewThread();
      const threadId = aui.threads.getState?.().mainThreadId;
      if (threadId) recordSentAgentThread(item.id, threadId);
      aui.composer.setText(prompt);
      if (mode === "send") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          aui.composer.send({ steer: false });
        } catch {
          toast.info(t("inbox.issue.fillManually"));
        }
      }
      requestOpenChat();
      toast.success(
        t(
          mode === "send"
            ? "inbox.issue.sentToAgent"
            : mode === "repair"
              ? "inbox.pr.checks.sentToAgent"
              : "inbox.issue.askReady",
        ),
      );
    } catch (error) {
      showError(error);
    } finally {
      setSending(false);
    }
  };

  const markAllRead = async () => {
    if (snap.counts.unread === 0) return;
    try {
      await markAllInboxRead();
      toast.success(t("inbox.actionDone.markAllRead"));
    } catch (error) {
      showError(error);
    }
  };

  /** 失败来源逐个重推一轮：代理抖动这类瞬态错误点一下就能恢复 */
  const retryBrokenSources = async () => {
    if (retryingBroken || brokenSources.length === 0) return;
    setRetryingBroken(true);
    try {
      for (const entry of brokenSources) {
        try {
          await syncInboxConnector(entry.connector.id);
        } catch {
          /* 单个来源失败不挡其它来源重试，横幅会展示最新错误 */
        }
      }
    } finally {
      setRetryingBroken(false);
    }
  };

  const filtered =
    Boolean(query.trim()) || sourceId !== "all" || activeAdvancedCount > 0;
  const empty = emptyCopy(viewTab, t, filtered);
  const hasConnectors = connectorView.connectors.length > 0;
  /** 任务 tab 用本地事件的条件；平台 tab 用 issue 的条件；「全部」只保留通用条件 */
  const localTab = sourceId === "task";
  const externalTab = sourceId !== "all" && sourceId !== "task";
  /** Token 失效/同步失败的来源：收件箱里直接提示，别让用户翻设置页才发现 */
  const brokenSources = connectorView.connectors
    .map((connector) => {
      const status = connectorView.statuses.find(
        (item) => item.id === connector.id,
      );
      const state = !connector.enabled
        ? "disabled"
        : (status?.state ?? "idle");
      return {
        connector,
        status,
        failed: state === "needs_auth" || state === "error",
      };
    })
    .filter((entry) => entry.failed);

  const headerContent = (
    <div className="flex shrink-0 items-baseline gap-2">
      <h1 className="text-sm font-semibold tracking-tight">
        {t("inbox.title")}
      </h1>
      <span className="text-muted-foreground text-xs">
        {t(`inbox.tabs.${viewTab}`)}
      </span>
    </div>
  );

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      {/* 收件箱 header 并进应用窗口边框条：避免整页视图上方出现两条 48px 横条 */}
      {headerSlot ? (
        createPortal(headerContent, headerSlot)
      ) : (
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
          {headerContent}
        </header>
      )}
      <div className="flex min-h-0 flex-1 max-[1024px]:flex-col">
      {/* 左栏：队列 */}
      <aside className="border-border/60 flex h-full w-[288px] min-h-0 shrink-0 flex-col border-r max-[1024px]:h-[55%] max-[1024px]:w-full max-[1024px]:border-r-0 max-[1024px]:border-b">
        {/* 视图：待关注 / 历史 / 已归档（下划线切换）+ 全部标为已读 */}
        <div className="border-border/60 flex h-10 shrink-0 items-center border-b px-2">
          <div
            className="flex h-full min-w-0 flex-1 items-stretch gap-1"
            role="tablist"
            aria-label={t("inbox.issue.viewFilter")}
          >
            {VIEW_TABS.map((tab) => {
              const active = viewTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`inbox-view-tab-${tab}`}
                  data-inbox-view-tab={tab}
                  aria-selected={active}
                  aria-controls="inbox-view-panel"
                  tabIndex={active ? 0 : -1}
                  onClick={() => changeViewTab(tab)}
                  onKeyDown={(event) => moveViewTab(event, tab)}
                  className={cn(
                    "text-muted-foreground hover:text-foreground relative inline-flex min-w-0 items-center px-1.5 text-xs font-medium transition-colors",
                    active && "text-foreground",
                  )}
                >
                  <span className="block truncate">{t(`inbox.tabs.${tab}`)}</span>
                  {active ? (
                    <span className="bg-foreground absolute inset-x-1 bottom-0 h-0.5 rounded-full" />
                  ) : null}
                </button>
              );
            })}
          </div>
          {viewTab === "attention" && snap.counts.unread > 0 ? (
            <TooltipIconButton
              tooltip={t("inbox.markAllRead")}
              side="bottom"
              className="text-muted-foreground size-6 shrink-0"
              onClick={() => void markAllRead()}
            >
              <CheckCheckIcon className="size-3.5" />
            </TooltipIconButton>
          ) : null}
        </div>
        {/* 搜索 / 筛选 / 刷新 */}
        <div className="border-border/60 flex h-10 shrink-0 items-center gap-1 border-b px-2">
          <div className="relative flex h-7 min-w-0 flex-1 items-center">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute left-2 size-3.5" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("inbox.searchPlaceholder")}
              aria-label={t("inbox.searchPlaceholder")}
              className="text-foreground placeholder:text-muted-foreground/60 h-7 w-full min-w-0 rounded-md bg-transparent pr-6 pl-7 text-xs outline-none"
            />
            {query ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-0.5 grid size-5 -translate-y-1/2 place-items-center rounded-full"
                aria-label={t("inbox.searchClear")}
                onClick={() => setQuery("")}
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <DropdownMenu open={filterOpen} onOpenChange={setFilterOpen}>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={cn(
                      "text-muted-foreground relative size-6",
                      filterActive && "text-foreground",
                    )}
                    aria-label={filterButtonLabel}
                    title={filterButtonLabel}
                  />
                }
              >
                <FilterIcon className="size-3.5" />
                {filterActive ? (
                  <span className="bg-primary absolute top-1 right-1 size-1 rounded-full" />
                ) : null}
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="flex max-h-[min(480px,var(--available-height))] w-64 flex-col overflow-y-hidden p-2"
              >
              {/* 中间筛选区独立滚动，底部操作固定不动 */}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {viewTab === "attention" ? (
                <FilterSection label={t("inbox.filterMenu.snoozedItems")}>
                  <DropdownMenuRadioGroup
                    value={advanced.includeSnoozed ? "show" : "hide"}
                    onValueChange={(value) => {
                      const includeSnoozed = value === "show";
                      setAdvanced({ ...advanced, includeSnoozed });
                      setFilterOpen(false);
                      const nextFilter = buildFilter(sourceId, viewTab, query);
                      if (includeSnoozed) nextFilter.includeSnoozed = true;
                      else delete nextFilter.includeSnoozed;
                      void setInboxFilter(nextFilter);
                    }}
                  >
                    <FilterChoice
                      label={t("inbox.filterMenu.snoozedHide")}
                      value="hide"
                    />
                    <FilterChoice
                      label={t("inbox.filterMenu.snoozedShow")}
                      value="show"
                    />
                  </DropdownMenuRadioGroup>
                </FilterSection>
              ) : null}
              {localTab ? (
                <FilterSection label={t("inbox.filterMenu.taskType")}>
                  <DropdownMenuRadioGroup
                    value={advanced.kind}
                    onValueChange={(value) => {
                      setAdvanced({
                        ...advanced,
                        kind: value as AdvancedFilters["kind"],
                      });
                      setFilterOpen(false);
                    }}
                  >
                    <FilterChoice label={t("inbox.filter.all")} value="all" />
                    {LOCAL_KINDS.map((kind) => (
                      <FilterChoice
                        key={kind}
                        label={t(`inbox.filter.${kind}`)}
                        value={kind}
                      />
                    ))}
                  </DropdownMenuRadioGroup>
                </FilterSection>
              ) : null}
              {externalTab ? (
                <FilterSection label={t("inbox.filterMenu.externalKind")}>
                  <DropdownMenuRadioGroup
                    value={advanced.externalKind}
                    onValueChange={(value) => {
                      setAdvanced({
                        ...advanced,
                        externalKind: value as AdvancedFilters["externalKind"],
                      });
                      setFilterOpen(false);
                    }}
                  >
                    <FilterChoice
                      label={t("inbox.filterMenu.externalAll")}
                      value="all"
                    />
                    <FilterChoice
                      label={t("inbox.filterMenu.externalIssue")}
                      value="issue"
                    />
                    <FilterChoice
                      label={t("inbox.filterMenu.externalPr")}
                      value="pr"
                    />
                  </DropdownMenuRadioGroup>
                </FilterSection>
              ) : null}
              {externalTab ? (
                <FilterSection label={t("inbox.filterMenu.status")}>
                  <DropdownMenuRadioGroup
                    value={advanced.status}
                    onValueChange={(value) => {
                      setAdvanced({
                        ...advanced,
                        status: value as AdvancedFilters["status"],
                      });
                      setFilterOpen(false);
                    }}
                  >
                    <FilterChoice
                      label={t("inbox.filterMenu.statusAll")}
                      value="all"
                    />
                    <FilterChoice
                      label={t("inbox.filterMenu.statusOpen")}
                      value="open"
                    />
                    <FilterChoice
                      label={t("inbox.filterMenu.statusClosed")}
                      value="closed"
                    />
                  </DropdownMenuRadioGroup>
                </FilterSection>
              ) : null}
              <FilterSection label={t("inbox.filterMenu.time")}>
                <DropdownMenuRadioGroup
                  value={advanced.time}
                  onValueChange={(value) => {
                    setAdvanced({ ...advanced, time: value as TimeFilter });
                    setFilterOpen(false);
                  }}
                >
                  <FilterChoice label={t("inbox.filterMenu.all")} value="all" />
                  {(["today", "7d", "30d"] as const).map((time) => (
                    <FilterChoice
                      key={time}
                      label={t(`inbox.filterMenu.times.${time}`)}
                      value={time}
                    />
                  ))}
                </DropdownMenuRadioGroup>
              </FilterSection>
              {externalTab && teams.length > 0 ? (
                <FilterSection label={t("inbox.filterMenu.team")}>
                  <DropdownMenuRadioGroup
                    value={advanced.team}
                    onValueChange={(value) => {
                      setAdvanced({ ...advanced, team: value });
                      setFilterOpen(false);
                    }}
                  >
                    <FilterChoice label={t("inbox.filterMenu.all")} value="all" />
                    {teams.map((team) => (
                      <FilterChoice key={team} label={team} value={team} />
                    ))}
                  </DropdownMenuRadioGroup>
                </FilterSection>
              ) : null}
              {localTab ? (
                <FilterSection label={t("inbox.filterMenu.project")}>
                  <DropdownMenuRadioGroup
                    value={advanced.project}
                    onValueChange={(value) => {
                      setAdvanced({ ...advanced, project: value });
                      setFilterOpen(false);
                    }}
                  >
                    <FilterChoice
                      label={t("inbox.filterMenu.allProjects")}
                      value="all"
                    />
                    <FilterChoice
                      label={t("inbox.filterMenu.noProject")}
                      value="none"
                    />
                    {projects
                      .filter((project) => !project.archived)
                      .map((project) => (
                        <FilterChoice
                          key={project.id}
                          label={projectDisplayName(project)}
                          value={project.id}
                        />
                      ))}
                  </DropdownMenuRadioGroup>
                </FilterSection>
              ) : null}
              </div>
              <div className="shrink-0">
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  setAdvanced({ ...DEFAULT_ADVANCED });
                  setFilterOpen(false);
                }}
              >
                <RotateCcwIcon className="size-4" />
                {t("inbox.filterMenu.reset")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => requestSettingsSection("inbox-sources")}
              >
                <PlusIcon className="size-4" />
                {hasConnectors
                  ? t("inbox.issue.manageSources")
                  : t("inbox.issue.addSource")}
              </DropdownMenuItem>
              </div>
            </DropdownMenuContent>
            </DropdownMenu>
            <TooltipIconButton
              tooltip={t("inbox.refresh")}
              side="bottom"
              className="text-muted-foreground size-6"
              disabled={refreshing}
              onClick={spinRefresh}
            >
              <RotateCwIcon
                className={cn("size-3.5", refreshing && "animate-spin")}
              />
            </TooltipIconButton>
          </div>
        </div>

        {/* 来源切换：下划线 tabs，溢出时用两侧箭头横向滚动 */}
        <div className="flex shrink-0 items-center gap-0.5 border-b border-border/50 px-2">
          {sourceEdges.left ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground size-6 shrink-0"
              aria-label={t("inbox.tabs.previousSource")}
              onClick={() => scrollSources(-1)}
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : null}
          <div
            ref={sourceScrollRef}
            onScroll={updateSourceEdges}
            className="scrollbar-none relative flex h-8 min-w-0 flex-1 items-stretch overflow-x-auto"
          >
            {sourceUnderline ? (
              <span
                aria-hidden
                style={{
                  left: sourceUnderline.left,
                  width: sourceUnderline.width,
                }}
                className="bg-foreground pointer-events-none absolute bottom-0 h-0.5 rounded-full motion-safe:transition-[left,width] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]"
              />
            ) : null}
            {sourceTabs.map((tab) => {
              const active = sourceId === tab.id;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    if (el) sourceButtonRefs.current.set(tab.id, el);
                    else sourceButtonRefs.current.delete(tab.id);
                  }}
                  type="button"
                  aria-current={active}
                  aria-label={`${t("inbox.filterMenu.source")}：${tab.label}`}
                  onClick={() => changeSource(tab.id)}
                  className={cn(
                    "flex shrink-0 items-center justify-center gap-1 px-4 text-xs  whitespace-nowrap transition-colors",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab.provider ? (
                    <ProviderMark provider={tab.provider} />
                  ) : Icon ? (
                    <Icon className="size-3.5 shrink-0" />
                  ) : null}
                  {tab.label}
                </button>
              );
            })}
          </div>
          {sourceEdges.right ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground size-6 shrink-0"
              aria-label={t("inbox.tabs.nextSource")}
              onClick={() => scrollSources(1)}
            >
              <ChevronRightIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>

        {/* Token 失效 / 同步失败：一条窄提示 + 重试同步 / 重新连接 */}
        {brokenSources.length > 0 ? (
          <div className="bg-destructive/10 text-destructive-strong mx-2 mt-1.5 flex flex-wrap items-start gap-2 rounded-lg px-2.5 py-2 text-xs leading-5">
            <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0 flex-1 basis-40 space-y-0.5">
              {brokenSources.map((entry) => {
                const label =
                  PROVIDER_META[entry.connector.provider]?.label ??
                  entry.connector.provider;
                const rawError =
                  entry.status?.lastError ??
                  t("settings.inboxSources.status.error");
                // 后端错误已带「Jira:」前缀时不再重复拼一次
                const message =
                  rawError.startsWith(`${label}:`) ||
                  rawError.startsWith(`${label}：`)
                    ? rawError.slice(label.length + 1).trimStart()
                    : rawError;
                return (
                  <p
                    key={entry.connector.id}
                    className="line-clamp-2 break-words"
                    title={`${label}：${message}`}
                  >
                    <span className="font-medium">{label}</span>
                    <span className="opacity-80">：{message}</span>
                  </p>
                );
              })}
            </div>
            {/* 网络抖动/代理重启：重试一轮立即恢复，不等退避 */}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="bg-background/70 h-7 px-2 text-xs"
                disabled={retryingBroken}
                onClick={() => void retryBrokenSources()}
              >
                {t("inbox.issue.retrySync")}
              </Button>
              {brokenSources.some(
                (entry) => entry.status?.state === "needs_auth",
              ) ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="bg-background/70 h-7 px-2 text-xs"
                  onClick={() => requestSettingsSection("inbox-sources")}
                >
                  {t("inbox.issue.reconnect")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {snap.error ? (
          <div
            role="alert"
            className="border-destructive/20 bg-destructive/5 text-destructive-strong mx-2 mt-1.5 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs leading-5"
          >
            <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">
              {t("inbox.error.loadFailed")}：{snap.error}
            </span>
            <Button
              variant="ghost"
              size="xs"
              className="shrink-0 gap-1"
              disabled={refreshing}
              onClick={spinRefresh}
            >
              <RefreshCwIcon className={cn("size-3", refreshing && "animate-spin")} />
              {t("common.action.retry")}
            </Button>
          </div>
        ) : null}

        <div
          ref={listScrollRef}
          id="inbox-view-panel"
          role="tabpanel"
          aria-labelledby={`inbox-view-tab-${viewTab}`}
          onFocusCapture={() => {
            listHasFocusRef.current = true;
          }}
          onBlurCapture={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && !event.currentTarget.contains(next)) {
              listHasFocusRef.current = false;
            }
          }}
          className="bg-background min-h-0 flex-1 overflow-y-auto p-1.5 [scrollbar-gutter:stable]"
        >
          {awaitingGroups ? (
            !showLoading ? (
              // 延迟期内先留白：数据很快到达时，骨架屏根本不会出现
              <div className="min-h-full" aria-busy="true" />
            ) : !snap.loaded ? (
              <div className="flex flex-col gap-2 p-3" aria-hidden="true">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div
                    key={index}
                    className="bg-muted/40 h-14 animate-pulse rounded-lg"
                  />
                ))}
              </div>
            ) : (
              <div
                className="text-muted-foreground flex min-h-full items-center justify-center gap-2 text-xs"
                aria-busy="true"
              >
                <Loader2Icon className="size-3.5 animate-spin" />
                {t("inbox.loading")}
              </div>
            )
          ) : visibleGroups.length === 0 ? (
            <div className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center">
              <p className="text-foreground/90 max-w-xs text-sm font-medium leading-6">
                {empty.title}
              </p>
              <p className="text-muted-foreground mt-1.5 max-w-xs text-xs leading-5">
                {empty.description}
              </p>
              {filtered ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground mt-3 h-7 gap-1 px-2 text-xs"
                  onClick={clearInboxFilters}
                >
                  <RotateCcwIcon className="size-3.5" />
                  {t("inbox.empty.clearFilters")}
                </Button>
              ) : viewTab === "attention" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground mt-3 h-7 gap-1 px-2 text-xs"
                  onClick={() => requestSettingsSection("inbox-sources")}
                >
                  <PlusIcon className="size-3.5" />
                  {hasConnectors
                    ? t("inbox.issue.manageSources")
                    : t("inbox.issue.addSource")}
                </Button>
              ) : null}
            </div>
          ) : (
            <div
              key={listScope}
              className={cn(
                "animate-in fade-in-0 slide-in-from-bottom-1 flex flex-col gap-0.5 transition-opacity duration-150 motion-reduce:animate-none",
                // 旧列表先垫着，新数据到达前不可点，避免误点不属于当前 Tab 的条目
                showingCachedGroups && "pointer-events-none opacity-60",
              )}
            >
              {visibleGroups.map((group) => {
                const active = group.key === selectedGroupKey;
                const focusTarget =
                  (focusGroupKey ?? selectedGroupKey ?? visibleGroups[0]?.key) ===
                  group.key;
                const item = group.latest;
                const top = topLineOf(group, t);
                const bottom = bottomLineOf(group, t);
                const snoozed = group.items.some(
                  (entry) =>
                    entry.snoozedUntil &&
                    Date.parse(entry.snoozedUntil) > Date.now(),
                );
                const canArchiveGroup =
                  archivableItemIdsOfGroup(group, true).length > 0;
                const canUnarchiveGroup =
                  archivableItemIdsOfGroup(group, false).length > 0;
                const canDeleteGroup = group.items.some(
                  (entry) => entry.state !== "open",
                );
                return (
                  <ContextMenu key={group.key}>
                    <ContextMenuTrigger
                      render={
                        <button
                          type="button"
                          data-inbox-group={group.key}
                          aria-current={active}
                          tabIndex={showingCachedGroups || !focusTarget ? -1 : 0}
                          disabled={showingCachedGroups}
                          onFocus={() => setFocusGroupKey(group.key)}
                          onKeyDown={(event) => moveRowFocus(event, group)}
                          onClick={() => {
                            setSelectedGroupKey(group.key);
                            markGroupRead(group);
                          }}
                          className={cn(
                            "block w-full rounded-md px-2.5 py-2 text-left transition-colors",
                            active
                              ? "bg-selected"
                              : "hover:bg-muted/50 data-popup-open:bg-selected",
                          )}
                        />
                      }
                    >
                    <div className="text-muted-foreground flex items-center gap-1.5 text-2xs leading-4">
                      {item.kind === "external" ? (
                        <ProviderMark provider={item.external?.provider ?? ""} />
                      ) : (
                        (() => {
                          const Icon = KIND_ICONS[item.kind] ?? InboxIcon;
                          return <Icon className="size-3.5 shrink-0" />;
                        })()
                      )}
                      <span className="min-w-0 truncate">{top}</span>
                      {snoozed ? (
                        <span
                          className="text-muted-foreground inline-flex shrink-0 items-center"
                          title={t("inbox.row.snoozed")}
                          aria-label={t("inbox.row.snoozed")}
                        >
                          <ClockIcon className="size-3" />
                        </span>
                      ) : null}
                      <span className="text-muted-foreground ml-auto shrink-0 pl-1.5 text-2xs tabular-nums">
                        {relativeTime(group.updatedAt, t)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-start gap-1.5">
                      <span
                        className={cn(
                          "mt-[7px] size-1.5 shrink-0 rounded-full",
                          group.hasUnread ? "bg-primary" : "bg-transparent",
                        )}
                        aria-hidden
                      />
                      <span
                        className={cn(
                          "line-clamp-2 text-sm leading-5",
                          group.hasUnread
                            ? "text-foreground font-semibold"
                            : "text-foreground/90 font-normal",
                        )}
                      >
                        {group.title}
                      </span>
                      {group.hasUnread ? (
                        <span className="sr-only">{t("inbox.row.unread")}</span>
                      ) : null}
                    </div>
                    {bottom ? (
                      <div className="text-muted-foreground mt-0.5 truncate pl-3 text-2xs leading-4">
                        {bottom}
                      </div>
                    ) : null}
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => void handleMarkUnread(item)}>
                        <MailIcon className="size-4" />
                        {t("inbox.row.markUnread")}
                      </ContextMenuItem>
                      {!readOnly ? (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onClick={() => void applySnooze(group.items, "1h")}
                          >
                            <ClockIcon className="size-4" />
                            {t("inbox.row.snooze1h")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() =>
                              void applySnooze(group.items, "tomorrow")
                            }
                          >
                            <ClockIcon className="size-4" />
                            {t("inbox.row.snoozeTomorrow")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() => void applySnooze(group.items, "1w")}
                          >
                            <ClockIcon className="size-4" />
                            {t("inbox.row.snooze1w")}
                          </ContextMenuItem>
                          {group.items.some((entry) => entry.snoozedUntil) ? (
                            <ContextMenuItem
                              onClick={() => void applySnooze(group.items, null)}
                            >
                              <ClockIcon className="size-4" />
                              {t("inbox.row.unsnooze")}
                            </ContextMenuItem>
                          ) : null}
                          <ContextMenuSeparator />
                        </>
                      ) : null}
                      {canUnarchiveGroup ? (
                        <ContextMenuItem
                          onClick={() => void handleGroupArchive(group, false)}
                        >
                          <ArchiveRestoreIcon className="size-4" />
                          {t("inbox.row.unarchive")}
                        </ContextMenuItem>
                      ) : null}
                      {canArchiveGroup ? (
                        <ContextMenuItem
                          onClick={() => void handleGroupArchive(group, true)}
                        >
                          <ArchiveIcon className="size-4" />
                          {t("inbox.row.archive")}
                        </ContextMenuItem>
                      ) : null}
                      {canDeleteGroup ? (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            variant="destructive"
                            onClick={() => requestDelete(group.items, group.title)}
                          >
                            <Trash2Icon className="size-4" />
                            {t("inbox.row.delete")}
                          </ContextMenuItem>
                        </>
                      ) : null}
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
          )}
          {snap.nextCursor && visibleGroups.length > 0 ? (
            <div
              ref={loadMoreRef}
              className="flex items-center justify-center py-3"
            >
              {snap.loading ? (
                <span className="border-muted-foreground/30 border-t-foreground size-3.5 animate-spin rounded-full border" />
              ) : (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground text-xs"
                  onClick={() => void loadMoreInbox()}
                >
                  {t("inbox.loadMore")}
                </button>
              )}
            </div>
          ) : null}
        </div>
      </aside>
      {/* 右栏：阅读窗 */}
      <section
        ref={detailScrollRef}
        className="h-full min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] max-[1024px]:h-auto"
      >
        {awaitingGroups ? (
          // 切换筛选时别闪一下「选择一条事项」的大空态；数据到了直接选中首条
          <div className="h-full" aria-busy="true" />
        ) : !selectedGroup || !selectedItem ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center px-6 text-center text-xs">
            <div className="relative mb-1 grid place-items-center">
              <DotCloud className="h-40 w-60" />
              <span className="bg-primary/5 text-primary ring-border/70 absolute grid size-14 place-items-center rounded-2xl ring-1 ring-inset">
                <InboxIcon className="size-6" strokeWidth={1.75} />
              </span>
            </div>
            <p>{t("inbox.issue.selectItem")}</p>
          </div>
        ) : selectedItem.kind === "external" ? (
          <ExternalIssueDetail
            key={selectedItem.id}
            item={selectedItem}
            readOnly={readOnly}
            onArchive={handleArchive}
            onMarkUnread={handleMarkUnread}
            onMarkRead={handleMarkRead}
            onRequestDelete={(item) => requestDelete([item])}
            onSnooze={(item, preset) => void applySnooze([item], preset)}
            onSendToAgent={sendToAgent}
          />
        ) : (
          <LocalItemDetail
            key={selectedItem.id}
            item={selectedItem}
            detail={selectedItemDetail}
            loading={selectedItemDetailLoading}
            error={selectedItemDetailError}
            readOnly={readOnly}
            onAction={handleAction}
            onOpenSession={openItemSession}
            onArchive={handleArchive}
            onMarkUnread={handleMarkUnread}
            onRequestDelete={(item) => requestDelete([item])}
          />
        )}
      </section>
      </div>

      <AlertDialog
        open={deleteRequest !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteRequest(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteRequest?.label
                ? t("inbox.detail.deleteBulkTitle", {
                    name: deleteRequest.label,
                    count: deleteRequest.items.length,
                  })
                : t("inbox.detail.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("inbox.detail.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.action.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void confirmDelete()}
            >
              {t("common.action.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
