"use client";

import { useSyncExternalStore } from "react";

/**
 * 本地「最后活动时间」表（按 pi sessionId 记）。
 *
 * 列表项的 lastMessageAt 来自 list() 拉取时的 session.modified 快照，聊完
 * 一轮并不会刷新——刚聊完的行显示不出「刚刚」。这里在 turn 收尾时
 * 盖一个本地时间戳，渲染侧与快照取较大者；跨端发生的会话活动同样经
 * turn_changed 收尾事件落进来（pi-running 的 onTurnEvent）。
 * 列表整体刷新（reload）后快照即真实值，本地戳被更大的快照顶掉或同值。
 */

const lastActivity = new Map<string, number>();
const listeners = new Set<() => void>();

export function markThreadActivity(sessionId: string | undefined): void {
  if (!sessionId) return;
  lastActivity.set(sessionId, Date.now());
  for (const l of listeners) l();
}

export function getThreadActivity(sessionId: string | undefined): number | undefined {
  return sessionId ? lastActivity.get(sessionId) : undefined;
}

export function subscribeThreadActivity(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 订阅某会话的本地活动时间戳（毫秒）；无记录 = undefined */
export function useThreadActivity(sessionId: string | undefined): number | undefined {
  return useSyncExternalStore(
    subscribeThreadActivity,
    () => getThreadActivity(sessionId),
    () => undefined,
  );
}
