"use client";

import { useSyncExternalStore } from "react";

/**
 * 侧边栏会话置顶集合（localStorage 持久化，键 pi.pinned-sessions）。
 * - 以 remoteId（pi sessionId）为键：未落盘会话没有 remoteId，不可置顶
 * - 模块级不可变数组快照 + 订阅（同 pi-running 的 store 模式），
 *   pin/unpin 后所有行与分组即时重渲染
 * - 列表里已不存在的 id 惰性忽略：分组计算时自然过滤，不做主动清理
 */

const KEY = "pi.pinned-sessions";
const EMPTY: readonly string[] = [];

const listeners = new Set<() => void>();

function load(): readonly string[] {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : EMPTY;
  } catch {
    return EMPTY;
  }
}

// 快照在模块初始化时同步读取：desktop 是纯客户端静态导出，首帧前已完成
let snapshot: readonly string[] = load();

function persist() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    // 配额/隐私模式写失败：置顶仍在本会话内生效，只是不跨启动
  }
}

function setSnapshot(next: readonly string[]) {
  snapshot = next;
  persist();
  for (const l of listeners) l();
}

/** 置顶 / 取消置顶（幂等切换） */
export function togglePinSession(remoteId: string): void {
  setSnapshot(
    snapshot.includes(remoteId)
      ? snapshot.filter((id) => id !== remoteId)
      : [remoteId, ...snapshot],
  );
}

export function subscribePinnedSessions(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getPinnedSessions(): readonly string[] {
  return snapshot;
}

export function isSessionPinned(remoteId: string | undefined): boolean {
  return remoteId ? snapshot.includes(remoteId) : false;
}

/** 分组计算用：整个置顶 id 快照，随集合变更重渲染 */
export function usePinnedSessionIds(): readonly string[] {
  return useSyncExternalStore(
    subscribePinnedSessions,
    getPinnedSessions,
    () => EMPTY,
  );
}

/** 会话行用：单个 remoteId 的置顶状态 */
export function useIsPinned(remoteId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribePinnedSessions,
    () => isSessionPinned(remoteId),
    () => false,
  );
}
