"use client";

import { useSyncExternalStore } from "react";

/**
 * 乐观选中（点击即刻高亮）。
 *
 * 切会话的真实状态要等库把新线程的 runtime 启动完（其中包含 sidecar 快照
 * 来回：`_switchToThread` 先 `await startThreadRuntime` 才推进
 * `threads.mainThreadId`）——在此之前侧栏高亮一直停在旧行。点击到高亮之间的
 * 这段空档就是"切过去慢一截"的主要观感来源。
 *
 * 点击时先把目标行记为 pending，高亮即时移动；store 追平
 * （`mainThreadId === pending`）即清除。8 秒看门狗兜底：切换失败/会话被删等
 * 情况下不留幽灵高亮。
 *
 * 只服务观感：不改变任何切换语义，store 追平后本模块自动让位。
 */
const CLEAR_FALLBACK_MS = 8_000;

let pendingId: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** 记下点击到的行（本地 threadId）；重复点同一行不重开看门狗 */
export function markPendingThreadSelection(threadId: string): void {
  if (pendingId === threadId) return;
  pendingId = threadId;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (pendingId !== threadId) return;
    pendingId = null;
    timer = null;
    notify();
  }, CLEAR_FALLBACK_MS);
  notify();
}

/** store 追平（或看门狗超时）后清掉 */
export function clearPendingThreadSelection(): void {
  if (pendingId === null) return;
  pendingId = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  notify();
}

/** React 之外的读法（追平判定用） */
export function pendingThreadSelection(): string | null {
  return pendingId;
}

/** 该行是否是"待生效"的选中；primitive 切片，行只在自身翻转时重渲 */
export function usePendingThreadSelection(threadId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => pendingId === threadId,
    () => false,
  );
}

/** 测试缝：用例之间隔离 */
export function resetPendingThreadSelectionForTest(): void {
  pendingId = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  listeners.clear();
}
