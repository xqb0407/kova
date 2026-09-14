"use client";

import { useSyncExternalStore } from "react";

/**
 * 运行检查点 store（git 集成 M2）：每次 agent 运行前在影子仓库打快照
 * （见 src-tauri/src/git.rs），运行结束 diff 出"本次改动"后写入这里，
 * 供消息尾部的 keep/revert 操作条（components/agent-thread/checkpoint-bar.tsx）消费。
 * 结果条为内存态（刷新后不留存）；进行中 turn 的快照 hash 另有 sessionStorage
 * 持久化（见 saveRunHash），保证刷新重挂后仍能结算出操作条。
 * 快照本身在影子仓库里 LRU 保 20 个，够找回。
 */
export type RunCheckpoint = {
  /** 快照所属工作目录 */
  cwd: string;
  /** 影子仓库检查点 commit hash */
  hash: string;
  files: number;
  added: number;
  removed: number;
};

const slots = new Map<string, RunCheckpoint>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function setRunCheckpoint(threadId: string, cp: RunCheckpoint): void {
  slots.set(threadId, cp);
  notify();
}

export function clearRunCheckpoint(threadId: string): void {
  if (slots.delete(threadId)) notify();
}

/**
 * 进行中 turn 的检查点 hash 持久化（sessionStorage）：打快照与结算分属
 * 流的两端，页面刷新会丢掉原页面里的 Promise——把 {cwd, hash} 落盘，
 * 重挂后的流（reconnectToStream）在 finish 时照样能 diff 出 keep/revert。
 * 与 resume storage 同用 sessionStorage：随标签页刷新存活、随标签页销毁作废。
 */
const RUN_HASH_PREFIX = "pi-run-hash:";

export type PersistedRunHash = { cwd: string; hash: string };

export function saveRunHash(threadId: string, value: PersistedRunHash | null): void {
  try {
    const key = RUN_HASH_PREFIX + threadId;
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 无 window（SSR）或存储被禁用：静默降级为仅内存态 */
  }
}

export function loadRunHash(threadId: string): PersistedRunHash | null {
  try {
    const raw = window.sessionStorage.getItem(RUN_HASH_PREFIX + threadId);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PersistedRunHash> | null;
    if (v && typeof v.cwd === "string" && typeof v.hash === "string") {
      return { cwd: v.cwd, hash: v.hash };
    }
    return null;
  } catch {
    return null;
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useRunCheckpoint(
  threadId: string | undefined,
): RunCheckpoint | null {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? (slots.get(threadId) ?? null) : null),
    () => null,
  );
}
