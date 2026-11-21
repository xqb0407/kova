"use client";

import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { InboxItem } from "pi-protocol";
import {
  CheckCheckIcon,
  CheckIcon,
  InboxIcon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
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
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { toast } from "@/components/ui/toast";
import { requestOpenSession } from "@/lib/pi/open-session";
import { openExternal } from "@/lib/external-link";
import { useThreadItems } from "@/lib/thread-list/thread-items";
import {
  clearInboxDetail,
  ensureInboxLoaded,
  getInboxSnapshot,
  loadInboxDetail,
  loadMoreInbox,
  markAllInboxRead,
  refreshInbox,
  runInboxAction,
  setInboxFilter,
  setInboxTab,
  updateInboxItems,
  useInbox,
} from "@/lib/inbox/inbox-store";
import {
  groupInboxItems,
  type InboxGroup,
  type InboxViewTab,
} from "@/lib/inbox/inbox-groups";
import {
  matchesInitiator,
  matchesSource,
  matchesTime,
  sourceOptions,
  type InitiatorFilter,
  type TimeFilter,
} from "@/lib/inbox/inbox-filters";
import { SPRING_SWAP } from "@/lib/motion/ease";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { InboxDetailPanel } from "./inbox-detail";
import { InboxTaskRow } from "./inbox-task-row";

/**
 * 「收件箱」页：Qoder 式任务聚合注意力队列。
 *
 * 一行 = 一个任务（会话/自动化任务/外部工作项），不是一条事件；展开才看本次
 * 更新与动作。后端仍是事件投影，聚合、Tab 与来源/时间/发起人筛选都在纯函数里。
 */
export const InboxView: FC = () => {
  const t = useT();
  const snap = useInbox();
  const threadItems = useThreadItems();
  const [tab, setTab] = useState<InboxViewTab>("attention");
  // store 里的 query 可能来自上次进入本页；初始值必须跟它一致，否则输入框空着
  // 但列表仍被旧查询过滤（用户会以为“条目丢了”）
  const [query, setQuery] = useState(snap.filter.query ?? "");
  const [searchOpen, setSearchOpen] = useState(Boolean(snap.filter.query));
  const [sourceFilter, setSourceFilter] = useState(snap.filter.source ?? "all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [initiatorFilter, setInitiatorFilter] = useState<InitiatorFilter>("all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [dialogItem, setDialogItem] = useState<InboxItem | null>(null);
  /** 待确认删除：单条/整组共用；label = 分组标题（批量确认时展示条数） */
  const [deleteRequest, setDeleteRequest] = useState<{
    items: InboxItem[];
    label?: string;
  } | null>(null);

  const sessionTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of threadItems) {
      if (item.remoteId && item.title) map.set(item.remoteId, item.title);
    }
    return map;
  }, [threadItems]);

  // 会话可能已被删除：收件箱条目仍保留深链，点“查看任务”会静默失败。
  // 用侧栏同一份 threadItems 做存在性判断；列表尚未加载时不做拦截。
  const knownSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of threadItems) {
      if (item.remoteId) ids.add(item.remoteId);
      if (item.id) ids.add(item.id);
    }
    return ids;
  }, [threadItems]);

  /** 统一打开入口：已删会话给出明确提示，而不是让 switchToThread 静默失败 */
  const openSession = (sessionId: string | undefined) => {
    if (!sessionId) {
      toast.info(t("inbox.error.noSession"));
      return;
    }
    if (knownSessionIds.size > 0 && !knownSessionIds.has(sessionId)) {
      toast.info(t("inbox.error.noSession"));
      return;
    }
    // 收件箱里“查看对话”只是去看内容：已归档的会话保持归档，不因一次查看
    // 在侧栏里重新冒出来（switchToThread 默认会自动取消归档）
    requestOpenSession(sessionId, { unarchive: false });
  };

  useEffect(() => {
    // 服务端按 Tab 分页：进入页面固定回「待关注」，避免上一次停留的「历史」
    // 过滤条件让首屏看起来没有待处理事项
    const filter = getInboxSnapshot().filter;
    if (filter.tab !== "attention") {
      void setInboxFilter({ ...filter, tab: "attention" });
    } else {
      void ensureInboxLoaded();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 搜索沿用后端子串过滤；输入防抖，清空立即恢复。Tab 由 setInboxTab 维护，
  // 这里只改 query，不能把 Tab 重置成 all（否则待关注的独立分页失效）
  useEffect(() => {
    const next = query.trim();
    if ((snap.filter.query ?? "") === next) return;
    const timer = setTimeout(() => {
      void setInboxFilter({ ...getInboxSnapshot().filter, query: next || undefined });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const sources = useMemo(() => {
    // 服务端 facets 覆盖全部条目；旧 sidecar 没有 facets 时回落到当前页
    const options = snap.sources.length > 0 ? [...snap.sources] : sourceOptions(snap.items);
    // 选中的来源可能因为条目被处理后暂时没有数据；仍保留在菜单里可切回
    if (sourceFilter !== "all" && !options.includes(sourceFilter)) {
      options.push(sourceFilter);
    }
    return options;
  }, [snap.sources, snap.items, sourceFilter]);

  const changeSource = (next: string) => {
    setSourceFilter(next);
    // 来源交给后端过滤：否则选中第一页没出现的来源会看到空列表
    void setInboxFilter({
      ...getInboxSnapshot().filter,
      source: next === "all" ? undefined : next,
    });
  };
  const activeFilter =
    sourceFilter !== "all" || timeFilter !== "all" || initiatorFilter !== "all";

  const filteredItems = useMemo(
    () =>
      snap.items.filter(
        (item) =>
          matchesSource(item, sourceFilter) &&
          matchesTime(item, timeFilter) &&
          matchesInitiator(item, initiatorFilter),
      ),
    [snap.items, sourceFilter, timeFilter, initiatorFilter],
  );

  const groups = useMemo(
    () => groupInboxItems(filteredItems, { tab, sessionTitles }),
    [filteredItems, tab, sessionTitles],
  );

  const unreadIds = useMemo(
    () => snap.items.filter((item) => !item.readAt && !item.archivedAt).map((item) => item.id),
    [snap.items],
  );

  const toggleGroup = (group: InboxGroup) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(group.key)) next.delete(group.key);
      else next.add(group.key);
      return next;
    });
  };

  const changeTab = (next: InboxViewTab) => {
    if (next === tab) return;
    setTab(next);
    setExpanded(new Set());
    void setInboxTab(next);
  };

  const viewTask = (group: InboxGroup) => {
    const sessionId = group.sessionId;
    if (!sessionId) {
      toast.info(t("inbox.error.noSession"));
      return;
    }
    if (tab !== "history") {
      void updateInboxItems(
        group.items.filter((item) => !item.readAt).map((item) => item.id),
        { read: true },
      ).catch(() => {});
    }
    openSession(sessionId);
  };

  const handleAction = async (item: InboxItem, action: string) => {
    if (action === "open") {
      // 打开即视为看过：外链/会话都先清未读；历史 Tab 只读，不回写
      if (tab !== "history" && !item.readAt) {
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
          // 非法 URL 不交给系统 shell
        }
        return;
      }
      const sessionId = item.deepLink?.sessionId ?? item.sessionId;
      openSession(sessionId);
      return;
    }
    if (action === "mark_read" || action === "mark_unread") {
      try {
        await updateInboxItems([item.id], { read: action === "mark_read" });
      } catch (error) {
        toast.error(
          t("inbox.error.actionFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return;
    }
    try {
      await runInboxAction(item.id, action);
      if (action === "archive" || action === "unarchive") {
        // 行/分组可能因为还有兄弟事件不消失，必须给一个“动作成功”的回执，
        // 否则用户看到任务行还在，会以为归档/删除没生效
        toast.success(t(`inbox.actionDone.${action}`));
      }
      if (dialogItem?.id === item.id && action !== "mark_read") {
        setDialogItem(null);
        clearInboxDetail();
      }
    } catch (error) {
      toast.error(
        t("inbox.error.actionFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  /** 删除是墓碑：统一先进确认框（单条/详情/整组共用） */
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
      if (dialogItem && request.items.some((item) => item.id === dialogItem.id)) {
        setDialogItem(null);
        clearInboxDetail();
      }
    } catch (error) {
      toast.error(
        t("inbox.error.actionFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  /** 分组头批量归档/恢复：只提交符合状态的条目，避免整批被后端拒绝 */
  const bulkSetArchived = async (group: InboxGroup, archived: boolean) => {
    const ids = group.items
      .filter((item) =>
        archived
          ? item.state !== "open" && !item.archivedAt && item.actions.includes("archive")
          : Boolean(item.archivedAt),
      )
      .map((item) => item.id);
    if (ids.length === 0) return;
    try {
      await updateInboxItems(ids, { archived });
      toast.success(
        t(archived ? "inbox.actionDone.archive" : "inbox.actionDone.unarchive"),
      );
    } catch (error) {
      toast.error(
        t("inbox.error.actionFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const handleBulkAction = (
    group: InboxGroup,
    action: "archive" | "unarchive" | "delete",
  ) => {
    if (action === "delete") {
      requestDelete(group.items, group.title);
      return;
    }
    void bulkSetArchived(group, action === "archive");
  };

  const openDetail = (item: InboxItem) => {
    setDialogItem(item);
    // 历史 Tab 只读：打开详情不再回写已读
    if (tab !== "history" && !item.readAt) {
      void updateInboxItems([item.id], { read: true }).catch(() => {});
    }
    void loadInboxDetail(item.id);
  };

  const markAllRead = async () => {
    if (unreadIds.length === 0 && snap.counts.unread === 0) return;
    try {
      // 跨分页清空待关注：只清已加载的一页会让旧未读在“加载更多”后重新出现
      await markAllInboxRead();
    } catch (error) {
      toast.error(
        t("inbox.error.actionFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const empty = emptyCopy(tab, t, Boolean(query.trim()) || activeFilter);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl px-8 pt-8 pb-8">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{t("inbox.title")}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <AnimatePresence initial={false}>
              {searchOpen ? (
                <motion.div
                  key="inbox-search"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 240, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={SPRING_SWAP}
                  className="self-center overflow-hidden"
                >
                  <Input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setSearchOpen(false);
                        if (query) setQuery("");
                      }
                    }}
                    placeholder={t("inbox.searchPlaceholder")}
                    className="h-7 w-60 text-sm"
                    aria-label={t("inbox.searchPlaceholder")}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("inbox.searchPlaceholder")}
              title={t("inbox.searchPlaceholder")}
              aria-expanded={searchOpen}
              onClick={() => {
                if (searchOpen) {
                  setSearchOpen(false);
                  if (query) setQuery("");
                } else {
                  setSearchOpen(true);
                }
              }}
            >
              <SearchIcon className="size-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("inbox.filterMenu.title")}
                    title={t("inbox.filterMenu.title")}
                    className={cn(activeFilter && "text-primary")}
                  >
                    <SlidersHorizontalIcon className="size-4" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-64">
                <FilterSub
                  label={t("inbox.filterMenu.source")}
                  value={
                    sourceFilter === "all"
                      ? t("inbox.filterMenu.all")
                      : sourceText(sourceFilter, t)
                  }
                >
                  <FilterItem
                    label={t("inbox.filterMenu.all")}
                    active={sourceFilter === "all"}
                    onClick={() => changeSource("all")}
                  />
                  {sources.map((source) => (
                    <FilterItem
                      key={source}
                      label={sourceText(source, t)}
                      active={sourceFilter === source}
                      onClick={() => changeSource(source)}
                    />
                  ))}
                </FilterSub>
                <FilterSub
                  label={t("inbox.filterMenu.time")}
                  value={
                    timeFilter === "all"
                      ? t("inbox.filterMenu.all")
                      : t(`inbox.filterMenu.times.${timeFilter}`)
                  }
                >
                  <FilterItem
                    label={t("inbox.filterMenu.all")}
                    active={timeFilter === "all"}
                    onClick={() => setTimeFilter("all")}
                  />
                  {(["today", "7d", "30d"] as const).map((option) => (
                    <FilterItem
                      key={option}
                      label={t(`inbox.filterMenu.times.${option}`)}
                      active={timeFilter === option}
                      onClick={() => setTimeFilter(option)}
                    />
                  ))}
                </FilterSub>
                <FilterSub
                  label={t("inbox.filterMenu.initiator")}
                  value={
                    initiatorFilter === "all"
                      ? t("inbox.filterMenu.all")
                      : t(`inbox.filterMenu.initiators.${initiatorFilter}`)
                  }
                >
                  <FilterItem
                    label={t("inbox.filterMenu.all")}
                    active={initiatorFilter === "all"}
                    onClick={() => setInitiatorFilter("all")}
                  />
                  {(["human", "agent", "system"] as const).map((option) => (
                    <FilterItem
                      key={option}
                      label={t(`inbox.filterMenu.initiators.${option}`)}
                      active={initiatorFilter === option}
                      onClick={() => setInitiatorFilter(option)}
                    />
                  ))}
                </FilterSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!activeFilter}
                  onClick={() => {
                    const hadSource = sourceFilter !== "all";
                    setSourceFilter("all");
                    setTimeFilter("all");
                    setInitiatorFilter("all");
                    if (hadSource) {
                      void setInboxFilter({
                        ...getInboxSnapshot().filter,
                        source: undefined,
                      });
                    }
                  }}
                >
                  {t("inbox.filterMenu.reset")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("inbox.refresh")}
              title={t("inbox.refresh")}
              disabled={snap.loading}
              onClick={() => void refreshInbox()}
            >
              <RefreshCwIcon className={cn("size-4", snap.loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        <div className="mt-7 flex items-center gap-5">
          <TabButton active={tab === "attention"} onClick={() => changeTab("attention")}>
            {t("inbox.tabs.attention")}
          </TabButton>
          <TabButton active={tab === "history"} onClick={() => changeTab("history")}>
            {t("inbox.tabs.history")}
          </TabButton>
          <TabButton active={tab === "archived"} onClick={() => changeTab("archived")}>
            {t("inbox.tabs.archived")}
          </TabButton>
          {tab === "attention" ? (
            <Button
              variant="ghost"
              className="text-muted-foreground ml-auto gap-1"
              disabled={snap.counts.unread === 0}
              onClick={() => void markAllRead()}
            >
              <CheckCheckIcon className="size-3.5" />
              {t("inbox.markAllRead")}
            </Button>
          ) : null}
        </div>

        {/* 列表区给一个下限高度：骨架/空态/一两条结果的块高不同，切 Tab 时
            内容高度骤变会让整页滚动静止位置跟着跳；下限盖住三者差异 */}
        <div className="mt-4 flex min-h-[18rem] flex-col gap-1">
          {/* 切 Tab/筛选会先清空 items 再拉新页：此时 groups 为空但 loaded 仍
              是 true。若按「空列表」渲染，会先闪一下高高的空态再变成列表，
              整页高度来回跳。loading + 无数据一律走骨架，让占位高度稳定。 */}
          {snap.loading && groups.length === 0 ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="bg-muted/40 h-14 animate-pulse rounded-xl" />
              ))}
            </div>
          ) : snap.error ? (
            <div className="text-muted-foreground flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm">{t("inbox.error.loadFailed")}</p>
              <Button variant="outline" size="sm" onClick={() => void refreshInbox()}>
                {t("inbox.refresh")}
              </Button>
            </div>
          ) : groups.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-3 py-20 text-center">
              <div className="relative grid place-items-center">
                <DotCloud />
                <span className="bg-background text-muted-foreground ring-border/60 absolute grid size-14 place-items-center rounded-2xl ring-1 ring-inset">
                  <InboxIcon className="size-5" />
                </span>
              </div>
              <p className="text-foreground mt-2 text-sm font-medium">{empty.title}</p>
              <p className="max-w-sm text-xs leading-relaxed">{empty.description}</p>
            </div>
          ) : (
            groups.map((group) => (
              <InboxTaskRow
                key={group.key}
                group={group}
                expanded={expanded.has(group.key)}
                readOnly={tab === "history"}
                onToggle={toggleGroup}
                onViewTask={viewTask}
                onAction={handleAction}
                onOpenDetail={openDetail}
                onRequestDelete={(item) => requestDelete([item])}
                onBulkAction={handleBulkAction}
              />
            ))
          )}

          {snap.nextCursor ? (
            <div className="flex justify-center pt-3">
              <Button
                variant="ghost"
                size="sm"
                disabled={snap.loading}
                onClick={() => void loadMoreInbox()}
              >
                {snap.loading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                {t("inbox.loadMore")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <Dialog
        open={dialogItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialogItem(null);
            clearInboxDetail();
          }
        }}
      >
        {/* 详情弹窗：走 Dialog 标准骨架（p-6 / gap-6 / 右上角关闭），与知识库、
            自动化等弹窗同一套节奏。宽度必须用带 sm: 前缀的变体——DialogContent
            自带的 sm:max-w-sm 会盖掉不带前缀的 max-w-*。高度随内容自适应，
            超视口时只让中段滚动：滚动容器挂在 DialogContent 上时，默认关闭按钮
            与页脚操作行会随内容一起滚出可视区（见 mcp-settings 同款注释）。 */}
        <DialogContent className="flex max-h-[calc(100dvh-6rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <InboxDetailPanel
              item={dialogItem}
              detail={snap.detail}
              loading={snap.detailLoading}
              error={snap.detailError}
              readOnly={tab === "history"}
              onAction={handleAction}
              onOpenSession={(item) => {
                const sessionId = item.deepLink?.sessionId ?? item.sessionId;
                if (!sessionId) {
                  toast.info(t("inbox.error.noSession"));
                  return;
                }
                if (tab !== "history" && !item.readAt) {
                  void updateInboxItems([item.id], { read: true }).catch(() => {});
                }
                openSession(sessionId);
              }}
              onArchive={async (item, archived) => {
                try {
                  // 先等归档落库再关弹窗：失败时条目其实还在，关掉弹窗会让人
                  // 以为操作成功了（随后刷新又回来，观感像“归档没生效”）
                  await updateInboxItems([item.id], { archived });
                  toast.success(
                    t(archived ? "inbox.actionDone.archive" : "inbox.actionDone.unarchive"),
                  );
                } catch (error) {
                  toast.error(
                    t("inbox.error.actionFailed", {
                      message: error instanceof Error ? error.message : String(error),
                    }),
                  );
                  return;
                }
                // 归档 → 条目离开当前列表；在「已归档」里恢复也一样离开，
                // 两种方向都关闭弹窗，避免继续展示已过期的按钮状态
                if (archived || tab === "archived") {
                  setDialogItem(null);
                  clearInboxDetail();
                }
              }}
              onMarkUnread={(item) => {
                void updateInboxItems([item.id], { read: false }).catch(() => {});
              }}
              onRequestDelete={(item) => requestDelete([item])}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除确认：单条/详情/整组共用。墓碑不可撤销，所以统一在这里拦一道 */}
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

const SOURCE_KEY: Record<string, string> = {
  task: "task",
  automation: "automation",
  subagent: "subagent",
  background: "background",
  external: "external",
  github: "github",
  jira: "jira",
  linear: "linear",
  gitlab: "gitlab",
  azure_devops: "azure_devops",
};

/** 已知来源走词典；未来未知 provider 原样显示（数据驱动，不改筛选器） */
function sourceText(source: string, t: ReturnType<typeof useT>): string {
  const key = Object.prototype.hasOwnProperty.call(SOURCE_KEY, source)
    ? SOURCE_KEY[source]
    : undefined;
  return key ? t(`inbox.filterMenu.sources.${key}`) : source;
}

const FilterSub: FC<{ label: string; value: string; children: ReactNode }> = ({
  label,
  value,
  children,
}) => (
  <DropdownMenuSub>
    <DropdownMenuSubTrigger>
      <span className="flex-1">{label}</span>
      <span className="text-muted-foreground me-1 max-w-28 truncate text-xs">{value}</span>
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent side="left" className="w-44">
      {children}
    </DropdownMenuSubContent>
  </DropdownMenuSub>
);

const FilterItem: FC<{ label: string; active: boolean; onClick: () => void }> = ({
  label,
  active,
  onClick,
}) => (
  <DropdownMenuItem onClick={onClick} className="justify-between">
    <span>{label}</span>
    {active ? <CheckIcon className="size-4" /> : null}
  </DropdownMenuItem>
);

const TabButton: FC<{ active: boolean; onClick: () => void; children: ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <button
    type="button"
    aria-pressed={active}
    onClick={onClick}
    className={cn(
      "relative pb-1.5 text-sm transition-colors",
      active
        ? "text-foreground font-medium"
        : "text-muted-foreground hover:text-foreground",
    )}
  >
    {children}
    {active ? (
      <span className="bg-foreground absolute right-0 bottom-0 left-0 h-0.5 rounded-full" />
    ) : null}
  </button>
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
