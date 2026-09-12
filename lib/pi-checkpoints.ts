"use client";

import { useSyncExternalStore } from "react";

/**
 * 运行检查点 store（git 集成 M2）：每次 agent 运行前在影子仓库打快照
 * （见 src-tauri/src/git.rs），运行结束 diff 出"本次改动"后写入这里，
 * 供消息尾部的 keep/revert 操作条（components/agent-thread/checkpoint-bar.tsx）消费。
 * 仅内存态：重启/切走后不留存（快照本身在影子仓库里 LRU 保 20 个，够找回）。
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
