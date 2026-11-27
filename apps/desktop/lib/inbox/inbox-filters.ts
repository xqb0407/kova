"use client";

import type { InboxFilter, InboxItem } from "pi-protocol";

/** 「收件箱」筛选：来源是数据驱动的，外部 provider（github/jira/...）自动出现 */

export type TimeFilter = "all" | "today" | "7d" | "30d";
export type Initiator = "human" | "agent" | "system";
export type InitiatorFilter = "all" | Initiator;
export type AdvancedStatus = "all" | "open" | "closed";
export type AdvancedExternalKind = "all" | "issue" | "pr";

/** 本地任务类型：与 InboxItem.kind 一致，供筛选菜单与协议 kinds 复用 */
export const LOCAL_KINDS = [
  "approval",
  "question",
  "goal",
  "automation",
  "subagent",
  "background_task",
] as const;
export type LocalKind = (typeof LOCAL_KINDS)[number];

/** 桌面筛选菜单的完整条件（除来源 Tab 外） */
export type InboxAdvancedFilters = {
  time: TimeFilter;
  status: AdvancedStatus;
  team: string;
  /** "all" | "none" | projectId */
  project: string;
  kind: "all" | LocalKind;
  externalKind: AdvancedExternalKind;
  /** 待关注视图：是否把 snooze 中的条目也列出来 */
  includeSnoozed: boolean;
};

export const DEFAULT_INBOX_ADVANCED: InboxAdvancedFilters = {
  time: "all",
  status: "all",
  team: "all",
  project: "all",
  kind: "all",
  externalKind: "all",
  includeSnoozed: false,
};

/** 除时间外的筛选都跟来源绑定：各来源各存一份，切回来能恢复 */
export type SourceAdvancedFilters = Omit<InboxAdvancedFilters, "time">;

export const DEFAULT_SOURCE_ADVANCED: SourceAdvancedFilters = {
  status: "all",
  team: "all",
  project: "all",
  kind: "all",
  externalKind: "all",
  includeSnoozed: false,
};

const SOURCE_ORDER = [
  "task",
  "automation",
  "subagent",
  "background",
  "github",
  "jira",
  "linear",
  "gitlab",
  "azure_devops",
];

/** 条目来源：本地任务/自动化/子代理/后台任务；外部项用 provider */
export function sourceOf(item: InboxItem): string {
  if (item.kind === "external") {
    return (
      item.external?.provider ||
      (typeof item.meta?.provider === "string" ? item.meta.provider : "external")
    );
  }
  if (item.kind === "automation") return "automation";
  if (item.kind === "subagent") return "subagent";
  if (item.kind === "background_task") return "background";
  return "task";
}

/** 发起人：外部事项是人；自动化/后台任务/系统安全阀是系统；其余是 Agent */
export function initiatorOf(item: InboxItem): Initiator {
  if (item.kind === "external") return "human";
  if (item.kind === "automation" || item.kind === "background_task") return "system";
  if (item.kind === "goal") {
    const reason =
      typeof item.meta?.pauseReason === "string" ? item.meta.pauseReason : "";
    if (
      reason.includes("time budget") ||
      reason.includes("turn limit") ||
      reason.includes("no progress") ||
      reason.includes("sidecar restarted")
    ) {
      return "system";
    }
  }
  return "agent";
}

/** 来源筛选选项：只列当前数据里真实出现的来源，未知 provider 原样保留 */
export function sourceOptions(items: InboxItem[]): string[] {
  const seen = new Set(items.map(sourceOf));
  const known = SOURCE_ORDER.filter((source) => seen.has(source));
  const unknown = [...seen]
    .filter((source) => !SOURCE_ORDER.includes(source))
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...unknown];
}

function localDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 最近活动时间：与 sidecar 排序/筛选同口径 */
export function activityMs(item: InboxItem): number {
  const updated = Date.parse(item.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(item.createdAt);
  return Number.isFinite(created) ? created : 0;
}

export function matchesTime(
  item: InboxItem,
  filter: TimeFilter,
  now = Date.now(),
): boolean {
  if (filter === "all") return true;
  const at = activityMs(item);
  if (!Number.isFinite(at) || at <= 0) return false;
  if (filter === "today") {
    return localDayKey(new Date(at)) === localDayKey(new Date(now));
  }
  const days = filter === "7d" ? 7 : 30;
  return at >= now - days * 24 * 60 * 60 * 1000;
}

export function matchesInitiator(
  item: InboxItem,
  filter: InitiatorFilter,
): boolean {
  return filter === "all" || initiatorOf(item) === filter;
}

export function matchesSource(item: InboxItem, filter: string): boolean {
  return filter === "all" || sourceOf(item) === filter;
}

/** 外部事项按 provider 状态文本判断开放/关闭；本地事项按是否仍需动作判断。 */
export function isClosedItem(item: InboxItem): boolean {
  if (item.kind === "external") {
    return /closed|done|completed|cancel(?:l)?ed|merged|resolved/i.test(
      item.external?.status ?? "",
    );
  }
  return !item.requiresAction && item.state !== "open";
}

export function matchesStatus(
  item: InboxItem,
  status: AdvancedStatus,
): boolean {
  if (status === "all") return true;
  return status === "closed" ? isClosedItem(item) : !isClosedItem(item);
}

export function matchesExternalKind(
  item: InboxItem,
  kind: AdvancedExternalKind,
): boolean {
  if (kind === "all") return true;
  if (item.kind !== "external") return false;
  const type = (item.external?.type ?? "").toLowerCase();
  const isPr = type === "pull_request" || type === "merge_request";
  const isIssue = type === "issue" || type === "ticket";
  return kind === "pr" ? isPr : isIssue;
}

/** 客户端兜底过滤：服务端已按同一口径过滤，旧 sidecar 不支持新字段时仍能工作 */
export function matchesAdvancedFilters(
  item: InboxItem,
  advanced: InboxAdvancedFilters,
  now = Date.now(),
  /** 选中项目时=该项目会话；选择「无项目」时=全部已归属项目的会话（排除用） */
  projectSessionIds?: readonly string[],
): boolean {
  if (!matchesTime(item, advanced.time, now)) return false;
  if (!matchesStatus(item, advanced.status)) return false;
  if (advanced.kind !== "all" && item.kind !== advanced.kind) return false;
  if (!matchesExternalKind(item, advanced.externalKind)) return false;
  if (advanced.team !== "all" && item.external?.sourceName !== advanced.team) {
    return false;
  }
  if (advanced.project !== "all") {
    if (advanced.project === "none") {
      if (item.projectId) return false;
      if (item.sessionId && projectSessionIds?.includes(item.sessionId)) {
        return false;
      }
    } else {
      const byProject = item.projectId === advanced.project;
      // 审批/提问没有 projectId：用会话归属兜底
      const bySession = Boolean(
        item.sessionId && projectSessionIds?.includes(item.sessionId),
      );
      if (!byProject && !bySession) return false;
    }
  }
  return true;
}

export function countActiveAdvancedFilters(
  advanced: InboxAdvancedFilters,
  tab: "attention" | "history" | "archived",
): number {
  return [
    advanced.time !== "all",
    advanced.status !== "all",
    advanced.team !== "all",
    advanced.project !== "all",
    advanced.kind !== "all",
    advanced.externalKind !== "all",
    tab === "attention" && advanced.includeSnoozed,
  ].filter(Boolean).length;
}

/**
 * 把 UI 筛选状态映射成 list_inbox 的服务端筛选。
 *
 * - provider：外部平台 Tab → 只取 external，并带上 provider
 * - localOnly：任务 Tab → 只取本地 kinds；选了具体类型再收窄
 * - 其余（全部 Tab）→ 只在选了具体类型时收窄
 */
export function buildInboxFilter(args: {
  tab: "attention" | "history" | "archived";
  query: string;
  provider?: string;
  localOnly?: boolean;
  advanced: InboxAdvancedFilters;
  /** 项目下所有会话 id：审批/提问等条目没有 projectId 时用 */
  projectSessionIds?: readonly string[];
  /** 全部已归属项目的会话 id：「无项目」筛选排除用 */
  projectExcludeSessionIds?: readonly string[];
}): InboxFilter {
  const { tab, query, provider, localOnly, advanced } = args;
  const filter: InboxFilter = { tab };
  if (provider) {
    filter.source = provider;
    filter.kinds = ["external"];
  } else if (localOnly) {
    filter.kinds =
      advanced.kind === "all" ? [...LOCAL_KINDS] : [advanced.kind];
  } else if (advanced.kind !== "all") {
    filter.kinds = [advanced.kind];
  }
  const trimmed = query.trim();
  if (trimmed) filter.query = trimmed;
  if (advanced.time !== "all") filter.time = advanced.time;
  if (advanced.status !== "all") filter.status = advanced.status;
  if (advanced.team !== "all") filter.team = advanced.team;
  if (advanced.externalKind !== "all") {
    filter.externalKind = advanced.externalKind;
  }
  if (advanced.project !== "all") {
    if (advanced.project === "none") {
      filter.noProject = true;
      if (
        args.projectExcludeSessionIds &&
        args.projectExcludeSessionIds.length > 0
      ) {
        filter.excludeSessionIds = [...args.projectExcludeSessionIds];
      }
    } else {
      filter.projectId = advanced.project;
      if (args.projectSessionIds && args.projectSessionIds.length > 0) {
        filter.sessionIds = [...args.projectSessionIds];
      }
    }
  }
  if (advanced.includeSnoozed && tab === "attention") {
    filter.includeSnoozed = true;
  }
  return filter;
}

/** 比较两个筛选是否等价（用于判断界面条件是否已同步到 store） */
export function inboxFilterKey(filter: InboxFilter): string {
  return [
    filter.tab ?? "",
    filter.source ?? "",
    (filter.kinds ?? []).join(","),
    filter.query ?? "",
    filter.projectId ?? "",
    [...(filter.sessionIds ?? [])].sort().join(","),
    filter.noProject ? "1" : "",
    [...(filter.excludeSessionIds ?? [])].sort().join(","),
    filter.time ?? "",
    filter.status ?? "",
    filter.team ?? "",
    filter.externalKind ?? "",
    filter.includeSnoozed ? "1" : "",
  ].join("\u0000");
}
