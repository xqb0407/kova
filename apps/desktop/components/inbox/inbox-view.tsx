"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useAui } from "@assistant-ui/react";
import type {
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
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InboxIcon,
  ListChecksIcon,
  Loader2Icon,
  MailIcon,
  MessageSquareIcon,
  PlusIcon,
  RefreshCwIcon,
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
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
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
  groupInboxItems,
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
import {
  ExternalIssueDetail,
  type SendToAgentMode,
} from "./external-issue-detail";
import { LocalItemDetail } from "./local-item-detail";

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
    <div className="text-muted-foreground px-2 pt-2 pb-1 text-[10.5px] font-semibold tracking-wide uppercase">
      {label}
    </div>
    {children}
  </>
);

const FilterChoice: FC<{
  label: string;
  active: boolean;
  onClick: () => void;
}> = ({ label, active, onClick }) => (
  <DropdownMenuItem onClick={onClick} className="justify-between">
    <span className="min-w-0 truncate">{label}</span>
    {active ? <CheckIcon className="size-3.5 shrink-0" /> : null}
  </DropdownMenuItem>
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
    mode === "send"
      ? "请先阅读上面的上下文，复述你对它的理解并给出处理方案；确认前不要改文件。"
      : "我的问题：\n";
  return `${chip}\n\n${instruction}`;
}

export const InboxView: FC = () => {
  const t = useT();
  const snap = useInbox();
  const aui = useAui();
  const threadItems = useThreadItems();
  const connectorView = useInboxConnectors();

  const [sourceId, setSourceId] = useState("all");
  const [viewTab, setViewTab] = useState<InboxViewTab>("attention");
  const [query, setQuery] = useState(snap.filter.query ?? "");
  const [sourceEdges, setSourceEdges] = useState({ left: false, right: false });
  const [advanced, setAdvanced] = useState<{
    time: TimeFilter;
    status: "all" | "open" | "closed";
    team: string;
    project: string;
    kind: "all" | (typeof LOCAL_KINDS)[number];
  }>({
    time: "all",
    status: "all",
    team: "all",
    project: "all",
    kind: "all",
  });
  const projects = useProjectRegistry();
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sourceScrollRef = useRef<HTMLDivElement | null>(null);
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

  // 列表滚动到接近底部时自动续拉下一页（每页 50 条，游标由 store 维护）
  useEffect(() => {
    const root = listScrollRef.current;
    const target = loadMoreRef.current;
    if (!root || !target || !snap.nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreInbox();
        }
      },
      { root, rootMargin: "0px 0px 240px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [snap.nextCursor, snap.loading]);

  const sourceTabs = useMemo<SourceTab[]>(() => {
    const tabs: SourceTab[] = [
      { id: "all", label: t("inbox.issue.sources.all") },
      { id: "task", label: t("inbox.issue.sources.task") },
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
      ?.querySelector<HTMLElement>(`[data-source-id="${sourceId}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sourceId]);

  const scrollSources = (direction: -1 | 1) => {
    sourceScrollRef.current?.scrollBy({
      left: direction * 140,
      behavior: "smooth",
    });
  };

  const buildFilter = (
    nextSource = sourceId,
    nextTab = viewTab,
    nextQuery = query,
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
    return filter;
  };

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
  ].filter(Boolean).length;
  /** 视图已挪到左栏顶部的分段切换里，筛选图标只提示额外筛选条件 */
  const filterActive = activeAdvancedCount > 0;

  const filteredItems = useMemo(
    () =>
      snap.items.filter((item) => {
        if (!matchesTime(item, advanced.time)) return false;
        if (!matchesStatus(item, advanced.status)) return false;
        if (advanced.kind !== "all" && item.kind !== advanced.kind) return false;
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

  const selectedGroup =
    groups.find((group) => group.key === selectedGroupKey) ?? null;
  // 一组（同一会话/任务）只展示最新事件；组内历史事件不再做二次切换列表，
  // 避免点击更新行时整块详情重挂载、内容跳动
  const selectedItem = selectedGroup?.latest ?? null;
  const readOnly = viewTab === "history" || viewTab === "archived";
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

  // 系统通知点击 → 打开对应事项：切回待关注，条目数据到了就选中
  useEffect(
    () =>
      subscribeOpenInboxItem((itemId) => {
        setViewTab("attention");
        setQuery("");
        setPendingOpenItemId(itemId);
      }),
    [],
  );

  useEffect(() => {
    if (!pendingOpenItemId) return;
    const item = snap.items.find((entry) => entry.id === pendingOpenItemId);
    if (!item) return;
    const group = groupInboxItems([item], {
      tab: "attention",
      sessionTitles,
    })[0];
    if (group) {
      setSelectedGroupKey(group.key);
    }
    setPendingOpenItemId(null);
  }, [pendingOpenItemId, snap.items, sessionTitles]);

  // query 只在输入防抖后下发；source/tab 由点击立即下发
  useEffect(() => {
    const next = query.trim();
    if ((snap.filter.query ?? "") === next) return;
    const timer = setTimeout(() => {
      void setInboxFilter(buildFilter(sourceId, viewTab, query));
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (groups.length === 0) {
      setSelectedGroupKey(null);
      return;
    }
    if (!selectedGroupKey || !groups.some((group) => group.key === selectedGroupKey)) {
      setSelectedGroupKey(groups[0].key);
    }
  }, [groups, selectedGroupKey]);

  useEffect(() => {
    if (!selectedItem || selectedItem.kind === "external") return;
    if (snap.detailItemId === selectedItem.id) return;
    void loadInboxDetail(selectedItem.id).catch(() => {});
  }, [selectedItem?.id, selectedItem?.kind]);

  useEffect(() => {
    if (!selectedItem || selectedItem.kind !== "external") return;
    if (readOnly || selectedItem.readAt) return;
    // 外部事项「打开即已读」；requiresAction 的条目仍留在待关注，
    // 只是去掉未读圆点。FYI 条目读后自然离开当前 Tab。
    void updateInboxItems([selectedItem.id], { read: true }).catch(() => {});
  }, [selectedItem?.id, selectedItem?.kind, selectedItem?.readAt, readOnly]);

  // 切换事项时右栏回到顶部，避免沿用上一条的滚动位置导致页面跳动
  useLayoutEffect(() => {
    detailScrollRef.current?.scrollTo({ top: 0 });
  }, [selectedItem?.id]);

  const changeSource = (next: string) => {
    if (next === sourceId) return;
    setSourceId(next);
    setSelectedGroupKey(null);
    // 来源相关的筛选（状态/仓库/项目/任务类型）只对当前来源有意义；
    // 切走时清掉，避免隐藏筛选把新来源的结果全部滤空。时间对所有来源通用，保留。
    setAdvanced((prev) => ({
      ...prev,
      status: "all",
      team: "all",
      project: "all",
      kind: "all",
    }));
    void setInboxFilter(buildFilter(next, viewTab, query));
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

  const showError = (error: unknown) => {
    toast.error(
      t("inbox.error.actionFailed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const handleAction = async (item: InboxItem, action: string) => {
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
      await runInboxAction(item.id, action);
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

  const handleMarkUnread = async (item: InboxItem) => {
    try {
      await updateInboxItems([item.id], { read: false });
    } catch (error) {
      showError(error);
    }
  };

  const requestDelete = (items: InboxItem[], label?: string) => {
    const eligible = items.filter((item) => item.state !== "open");
    if (eligible.length === 0) return;
    setDeleteRequest(label ? { items: eligible, label } : { items: eligible });
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
  ) => {
    if (sending) return;
    setSending(true);
    try {
      const prompt = buildAgentHandoff(item, detail, mode, t);
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
        t(mode === "send" ? "inbox.issue.sentToAgent" : "inbox.issue.askReady"),
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
        {t(`inbox.tabs.${viewTab}`)} · {groups.length}
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
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      {/* 左栏：队列 */}
      <ResizablePanel defaultSize={320} minSize={260} maxSize={360} className="min-h-0">
      <aside className="flex h-full min-h-0 flex-col border-r border-border/50">
        {/* 工具区：来源 tabs + 搜索/操作；视图分类收进筛选弹层 */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border/50 px-3 py-2">
          <div className="order-1 flex w-full min-w-0 items-center gap-1">
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
              className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            >
              {sourceTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  data-source-id={tab.id}
                  onClick={() => changeSource(tab.id)}
                  className={cn(
                    "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs whitespace-nowrap transition-colors",
                    sourceId === tab.id
                      ? "bg-muted text-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {tab.provider ? (
                    <ProviderMark
                      provider={tab.provider}
                      className="size-3.5 shrink-0"
                    />
                  ) : tab.id === "task" ? (
                    <ListChecksIcon className="size-3.5 shrink-0" />
                  ) : (
                    <InboxIcon className="size-3.5 shrink-0" />
                  )}
                  {tab.label}
                </button>
              ))}
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
          <div className="order-3 flex min-w-0 flex-1 items-center gap-1.5">
            <SearchIcon className="text-muted-foreground size-3.5 shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("inbox.searchPlaceholder")}
              aria-label={t("inbox.searchPlaceholder")}
              className="placeholder:text-muted-foreground/70 focus:placeholder:text-transparent h-8 min-w-0 flex-1 border-0 bg-transparent px-0 text-xs outline-none"
            />
            {query ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground grid size-5 shrink-0 place-items-center rounded-full"
                aria-label={t("common.action.close")}
                onClick={() => setQuery("")}
              >
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </div>
          <div className="order-3 flex shrink-0 items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={cn(
                      "text-muted-foreground relative size-8",
                      filterActive && "text-foreground",
                    )}
                    aria-label={t("inbox.filterMenu.title")}
                    title={t("inbox.filterMenu.title")}
                  />
                }
              >
                <SlidersHorizontalIcon className="size-3.5" />
                {filterActive ? (
                  <span className="bg-primary absolute top-1 right-1 size-1 rounded-full" />
                ) : null}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64 p-2">
              <FilterSection label={t("inbox.filterMenu.view")}>
                {(["attention", "history", "archived"] as const).map((tab) => (
                  <FilterChoice
                    key={tab}
                    label={t(`inbox.tabs.${tab}`)}
                    active={viewTab === tab}
                    onClick={() => changeViewTab(tab)}
                  />
                ))}
              </FilterSection>
              {localTab ? (
                <FilterSection label={t("inbox.filterMenu.taskType")}>
                  <FilterChoice
                    label={t("inbox.filter.all")}
                    active={advanced.kind === "all"}
                    onClick={() =>
                      setAdvanced({ ...advanced, kind: "all" })
                    }
                  />
                  {LOCAL_KINDS.map((kind) => (
                    <FilterChoice
                      key={kind}
                      label={t(`inbox.filter.${kind}`)}
                      active={advanced.kind === kind}
                      onClick={() => setAdvanced({ ...advanced, kind })}
                    />
                  ))}
                </FilterSection>
              ) : null}
              {externalTab ? (
                <FilterSection label={t("inbox.filterMenu.status")}>
                  <FilterChoice
                    label={t("inbox.filterMenu.statusAll")}
                    active={advanced.status === "all"}
                    onClick={() =>
                      setAdvanced({ ...advanced, status: "all" })
                    }
                  />
                  <FilterChoice
                    label={t("inbox.filterMenu.statusOpen")}
                    active={advanced.status === "open"}
                    onClick={() =>
                      setAdvanced({ ...advanced, status: "open" })
                    }
                  />
                  <FilterChoice
                    label={t("inbox.filterMenu.statusClosed")}
                    active={advanced.status === "closed"}
                    onClick={() =>
                      setAdvanced({ ...advanced, status: "closed" })
                    }
                  />
                </FilterSection>
              ) : null}
              <FilterSection label={t("inbox.filterMenu.time")}>
                <FilterChoice
                  label={t("inbox.filterMenu.all")}
                  active={advanced.time === "all"}
                  onClick={() => setAdvanced({ ...advanced, time: "all" })}
                />
                {(["today", "7d", "30d"] as const).map((time) => (
                  <FilterChoice
                    key={time}
                    label={t(`inbox.filterMenu.times.${time}`)}
                    active={advanced.time === time}
                    onClick={() => setAdvanced({ ...advanced, time })}
                  />
                ))}
              </FilterSection>
              {externalTab && teams.length > 0 ? (
                <FilterSection label={t("inbox.filterMenu.team")}>
                  <FilterChoice
                    label={t("inbox.filterMenu.all")}
                    active={advanced.team === "all"}
                    onClick={() =>
                      setAdvanced({ ...advanced, team: "all" })
                    }
                  />
                  {teams.map((team) => (
                    <FilterChoice
                      key={team}
                      label={team}
                      active={advanced.team === team}
                      onClick={() =>
                        setAdvanced({ ...advanced, team })
                      }
                    />
                  ))}
                </FilterSection>
              ) : null}
              {localTab ? (
                <FilterSection label={t("inbox.filterMenu.project")}>
                  <FilterChoice
                    label={t("inbox.filterMenu.allProjects")}
                    active={advanced.project === "all"}
                    onClick={() =>
                      setAdvanced({ ...advanced, project: "all" })
                    }
                  />
                  <FilterChoice
                    label={t("inbox.filterMenu.noProject")}
                    active={advanced.project === "none"}
                    onClick={() =>
                      setAdvanced({ ...advanced, project: "none" })
                    }
                  />
                  {projects
                    .filter((project) => !project.archived)
                    .map((project) => (
                      <FilterChoice
                        key={project.id}
                        label={projectDisplayName(project)}
                        active={advanced.project === project.id}
                        onClick={() =>
                          setAdvanced({ ...advanced, project: project.id })
                        }
                      />
                    ))}
                </FilterSection>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={snap.counts.unread === 0}
                onClick={() => void markAllRead()}
              >
                <CheckCheckIcon className="size-4" />
                {t("inbox.markAllRead")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setAdvanced({
                    time: "all",
                    status: "all",
                    team: "all",
                    project: "all",
                    kind: "all",
                  });
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
            </DropdownMenuContent>
            </DropdownMenu>
            <TooltipIconButton
              tooltip={t("inbox.refresh")}
              side="bottom"
              className="text-muted-foreground size-8"
              disabled={snap.loading}
              onClick={() => void refreshInbox()}
            >
              <RefreshCwIcon
                className={cn("size-3.5", snap.loading && "animate-spin")}
              />
            </TooltipIconButton>
          </div>
        </div>

        {/* Token 失效 / 同步失败：一条窄提示 + 重试同步 / 重新连接 */}
        {brokenSources.length > 0 ? (
          <div className="bg-destructive/10 text-destructive mx-2 mt-1.5 flex flex-wrap items-start gap-2 rounded-lg px-2.5 py-2 text-xs leading-5">
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

        <div
          ref={listScrollRef}
          className="bg-background min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {snap.loading && groups.length === 0 ? (
            <div className="flex flex-col gap-2 p-3">
              {Array.from({ length: 5 }).map((_, index) => (
                <div
                  key={index}
                  className="bg-muted/40 h-14 animate-pulse rounded-lg"
                />
              ))}
            </div>
          ) : groups.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 px-5 py-14 text-center">
              <span className="bg-muted/60 text-muted-foreground grid size-10 place-items-center rounded-xl">
                <InboxIcon className="size-4" />
              </span>
              <p className="text-foreground text-sm font-medium">{empty.title}</p>
              <p className="text-xs leading-5">
                {/* 已连接来源但待关注没有事项：说清「在等什么」，避免用户以为坏了 */}
                {viewTab === "attention" &&
                !filtered &&
                hasConnectors &&
                !snap.loading
                  ? t("inbox.empty.attentionConnected")
                  : empty.description}
              </p>
              {sourceId === "all" &&
              !query.trim() &&
              activeAdvancedCount === 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1"
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
            <div className="flex flex-col gap-0.5">
              {groups.map((group) => {
                const active = group.key === selectedGroupKey;
                const item = group.latest;
                const top = topLineOf(group, t);
                const bottom = bottomLineOf(group, t);
                return (
                  <ContextMenu key={group.key}>
                    <ContextMenuTrigger
                      render={
                        <button
                          type="button"
                          data-inbox-group={group.key}
                          aria-current={active}
                          onClick={() => {
                            setSelectedGroupKey(group.key);
                          }}
                          className={cn(
                            "block w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                            active
                              ? "bg-muted"
                              : "hover:bg-muted/50 data-popup-open:bg-muted",
                          )}
                        />
                      }
                    >
                    <div className="text-muted-foreground flex items-center gap-1.5 text-[11px] leading-4">
                      {item.kind === "external" ? (
                        <ProviderMark provider={item.external?.provider ?? ""} />
                      ) : (
                        (() => {
                          const Icon = KIND_ICONS[item.kind] ?? InboxIcon;
                          return <Icon className="size-3.5 shrink-0" />;
                        })()
                      )}
                      <span className="min-w-0 truncate">{top}</span>
                      <span className="text-muted-foreground/70 ml-auto shrink-0 pl-1.5 text-[10.5px] tabular-nums">
                        {relativeTime(group.updatedAt, t)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-start gap-1.5">
                      <span
                        className={cn(
                          "mt-[7px] size-1.5 shrink-0 rounded-full",
                          group.hasUnread ? "bg-primary" : "bg-transparent",
                        )}
                      />
                      <span
                        className={cn(
                          "line-clamp-2 text-[13.5px] leading-5",
                          group.hasUnread
                            ? "text-foreground font-semibold"
                            : "text-foreground/90 font-normal",
                        )}
                      >
                        {group.title}
                      </span>
                    </div>
                    {bottom ? (
                      <div className="text-muted-foreground mt-0.5 truncate pl-3 text-[11.5px] leading-4">
                        {bottom}
                      </div>
                    ) : null}
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => void handleMarkUnread(item)}>
                        <MailIcon className="size-4" />
                        {t("inbox.row.markUnread")}
                      </ContextMenuItem>
                      {item.archivedAt ? (
                        <ContextMenuItem
                          onClick={() => void handleArchive(item, false)}
                        >
                          <ArchiveRestoreIcon className="size-4" />
                          {t("inbox.row.unarchive")}
                        </ContextMenuItem>
                      ) : (
                        <ContextMenuItem
                          onClick={() => void handleArchive(item, true)}
                        >
                          <ArchiveIcon className="size-4" />
                          {t("inbox.row.archive")}
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        onClick={() => requestDelete(group.items)}
                      >
                        <Trash2Icon className="size-4" />
                        {t("inbox.row.delete")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
          )}
          {snap.nextCursor && groups.length > 0 ? (
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
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel className="min-h-0 min-w-0">
      {/* 右栏：阅读窗 */}
      <section
        ref={detailScrollRef}
        className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
      >
        {!selectedGroup || !selectedItem ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-sm">
            <div className="relative mb-1 grid place-items-center">
              <DotCloud className="h-40 w-60" />
              <div className="absolute grid size-14 place-items-center rounded-2xl backdrop-blur-sm">
                <InboxIcon
                  className="text-muted-foreground/70 size-6"
                  strokeWidth={1.75}
                />
              </div>
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
            onRequestDelete={(item) => requestDelete([item])}
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
            onOpenSession={(item) => {
              openSession(item.deepLink?.sessionId ?? item.sessionId);
            }}
            onArchive={handleArchive}
            onMarkUnread={handleMarkUnread}
            onRequestDelete={(item) => requestDelete([item])}
          />
        )}
      </section>
      </ResizablePanel>
      </ResizablePanelGroup>

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
