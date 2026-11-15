"use client";

import type { InboxItem } from "pi-protocol";

/**
 * 「收件箱」按任务聚合的纯函数（Qoder 式注意力队列）。
 *
 * 后端仍按事件返回 InboxItem；这里把同属一个会话/自动化任务的条目收成一行，
 * 让页面回答的是「哪个任务需要我」而不是「哪条事件发生了」。
 */

export type InboxViewTab = "attention" | "history";

export type InboxGroup = {
  key: string;
  /** 行标题：任务名/会话标题/自动化任务名 */
  title: string;
  /** 行首类型标签：任务 / 自动化 / 子代理 / 后台任务 */
  label: string;
  sessionId?: string;
  threadId?: string;
  /** 新→旧 */
  items: InboxItem[];
  latest: InboxItem;
  hasUnread: boolean;
  needsAttention: boolean;
  updatedAt: string;
};

function isAttention(item: InboxItem): boolean {
  return !item.archivedAt && (item.requiresAction || !item.readAt);
}

export function filterByViewTab(items: InboxItem[], tab: InboxViewTab): InboxItem[] {
  return items.filter((item) => (tab === "attention" ? isAttention(item) : !isAttention(item)));
}

function groupKey(item: InboxItem): string {
  // 外部工作项按 provider + key 聚合（同一个 Issue/PR/Ticket 的多条更新一行）
  if (item.kind === "external") {
    const provider =
      item.external?.provider ||
      (typeof item.meta?.provider === "string" ? item.meta.provider : "external");
    const key = item.external?.key || item.sourceId || item.id;
    return `external:${provider}:${key}`;
  }
  if (item.kind === "automation") {
    const taskId = typeof item.meta?.taskId === "string" ? item.meta.taskId : "";
    if (taskId) return `automation:${taskId}`;
  }
  const scope = item.sessionId || item.threadId;
  return scope ? `session:${scope}` : `item:${item.id}`;
}

function groupTitle(
  key: string,
  latest: InboxItem,
  sessionTitles: ReadonlyMap<string, string>,
  sessionId: string | undefined,
): string {
  if (key.startsWith("external:")) return latest.title;
  if (key.startsWith("automation:")) {
    const taskName = latest.meta?.taskName;
    if (typeof taskName === "string" && taskName.trim()) return taskName;
    return latest.title.replace(/^自动化(完成|失败|已停止)：/u, "");
  }
  const sessionTitle = sessionId ? sessionTitles.get(sessionId) : "";
  if (sessionTitle) return sessionTitle;
  return latest.title;
}

function groupLabel(key: string, latest: InboxItem): string {
  if (key.startsWith("external:")) {
    const provider = key.split(":")[1] || "external";
    return `external:${provider}`;
  }
  if (key.startsWith("automation:")) return "automation";
  if (latest.sessionId || latest.threadId) return "task";
  return latest.kind;
}

function byNewest(a: InboxItem, b: InboxItem): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id);
}

export function groupInboxItems(
  items: InboxItem[],
  opts: {
    tab: InboxViewTab;
    sessionTitles?: ReadonlyMap<string, string>;
  },
): InboxGroup[] {
  const titles = opts.sessionTitles ?? new Map<string, string>();
  const groups = new Map<string, InboxItem[]>();
  for (const item of filterByViewTab(items, opts.tab)) {
    const key = groupKey(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }

  const out: InboxGroup[] = [];
  for (const [key, list] of groups) {
    list.sort(byNewest);
    const latest = list[0]!;
    const sessionId = list.find((item) => item.sessionId)?.sessionId;
    const threadId = list.find((item) => item.threadId)?.threadId;
    out.push({
      key,
      title: groupTitle(key, latest, titles, sessionId),
      label: groupLabel(key, latest),
      ...(sessionId ? { sessionId } : {}),
      ...(threadId ? { threadId } : {}),
      items: list,
      latest,
      hasUnread: list.some((item) => !item.readAt),
      needsAttention: list.some((item) => item.requiresAction),
      updatedAt: latest.createdAt,
    });
  }

  out.sort((a, b) => {
    // 待关注里「需要动作」优先，其次新→旧；历史纯按时间倒序
    if (opts.tab === "attention" && a.needsAttention !== b.needsAttention) {
      return a.needsAttention ? -1 : 1;
    }
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.key.localeCompare(b.key);
  });
  return out;
}
