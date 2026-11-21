"use client";

import type { InboxItem } from "pi-protocol";

/** 「收件箱」筛选：来源是数据驱动的，外部 provider（github/jira/...）自动出现 */

export type TimeFilter = "all" | "today" | "7d" | "30d";
export type Initiator = "human" | "agent" | "system";
export type InitiatorFilter = "all" | Initiator;

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

export function matchesTime(
  item: InboxItem,
  filter: TimeFilter,
  now = Date.now(),
): boolean {
  if (filter === "all") return true;
  const at = Date.parse(item.createdAt);
  if (!Number.isFinite(at)) return false;
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
