"use client";

import { useMemo, useSyncExternalStore } from "react";

/**
 * 侧边栏会话未读集合（localStorage 持久化，键 pi.unread-sessions）。
 * - 键 = 会话行的 remoteId = pi sessionId；agent 事件的 threadId 同键。
 *   注意本会话新建的线程 mainThreadId 恒为 __LOCALID_ 草稿 id（绑定只写
 *   piSessionRegistry），置/清两侧都要先换出 sessionId 再进本 store
 * - 模块级不可变快照 + 订阅（同 pi-pinned-sessions 的 store 模式）
 * - 谁写未读：右键「标记为未读」；后台会话回复完成（agent.turn.completed
 *   且非当前打开线程，见 ThreadUnreadTracker）。谁清：切换到该会话（自动
 *   已读）或菜单「标记为已读」
 * - 已不存在的 id 惰性忽略：会话删除后残留键不显示也不报错
 */

const KEY = "pi.unread-sessions";
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
    // 配额/隐私模式写失败：未读仍在本会话内生效，只是不跨启动
  }
}

function setSnapshot(next: readonly string[]) {
  if (
    next.length === snapshot.length &&
    next.every((id, i) => id === snapshot[i])
  ) {
    return;
  }
  snapshot = next;
  persist();
  for (const l of listeners) l();
}

/** 置未读（幂等） */
export function markSessionUnread(threadId: string): void {
  if (snapshot.includes(threadId)) return;
  setSnapshot([threadId, ...snapshot]);
}

/** 置已读（幂等；未读集合里没有时不动快照） */
export function markSessionRead(threadId: string): void {
  if (!snapshot.includes(threadId)) return;
  setSnapshot(snapshot.filter((id) => id !== threadId));
}

/** 菜单「标记为未读/已读」的幂等切换 */
export function toggleSessionUnread(threadId: string): void {
  if (snapshot.includes(threadId)) markSessionRead(threadId);
  else markSessionUnread(threadId);
}

export function subscribeUnreadSessions(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getUnreadSessions(): readonly string[] {
  return snapshot;
}

export function isSessionUnread(threadId: string | undefined): boolean {
  return threadId ? snapshot.includes(threadId) : false;
}

/** 会话行用：单个 thread id 的未读状态 */
export function useIsThreadUnread(threadId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeUnreadSessions,
    () => isSessionUnread(threadId),
    () => false,
  );
}

/** 分组（项目文件夹组头）用：未读 id 全集，快照不变则集合引用不变 */
export function useUnreadSessionIds(): ReadonlySet<string> {
  const ids = useSyncExternalStore(
    subscribeUnreadSessions,
    getUnreadSessions,
    () => EMPTY,
  );
  return useMemo(() => new Set(ids), [ids]);
}
