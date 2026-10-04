"use client";

import { useSyncExternalStore } from "react";

/**
 * 本地「会话实时标题」表（按 pi sessionId 记）。
 *
 * RemoteThreadList 快照里的 title 只在 adapter.list()（列表整体 reload）时
 * 刷新，智能标题与手动改名都不会回流到已渲染的行——顶栏与侧边栏因此一直显示
 * 旧标题（新建会话最明显：整轮聊完才生成的标题要刷新页面才看得到）。
 * 这里在 wire 上收到 session_info_changed 时盖一份本地标题，渲染侧优先取它；
 * 列表整体刷新后快照即真实值，两者同值（与 pi-last-activity 同一思路）。
 */

/** 有序无关的键值表：键=pi sessionId（= RemoteThreadMetadata.remoteId）。 */
const titles = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** 记一次实时标题；name 为空/undefined = 该会话无标题（事件里的清除语义） */
export function setThreadTitle(sessionId: string | undefined, name: string | undefined): void {
  if (!sessionId) return;
  const next = name?.trim() ? name : undefined;
  if (getThreadTitle(sessionId) === next) return;
  if (next === undefined) titles.delete(sessionId);
  else titles.set(sessionId, next);
  notify();
}

export function getThreadTitle(sessionId: string | undefined): string | undefined {
  return sessionId ? titles.get(sessionId) : undefined;
}

export function subscribeThreadTitles(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 订阅某会话的实时标题；无记录 = undefined（回落列表快照的 title） */
export function useThreadTitle(sessionId: string | undefined): string | undefined {
  return useSyncExternalStore(
    subscribeThreadTitles,
    () => getThreadTitle(sessionId),
    () => undefined,
  );
}
