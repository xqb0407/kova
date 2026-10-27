"use client";

import { useSyncExternalStore } from "react";

/**
 * 快速查看浮层的开合状态（形态仿 lib/terminal/dock.ts 的模块级 store）：
 * - 开态记录的是 threadId 而不是布尔——浮层只对打开它的那个会话成立，
 *   切换线程（openThreadId !== 当前线程）天然收起，不需要额外的切换监听；
 * - 不持久化：浮层是「扫一眼」的临时视图，刷新后收起是合理默认。
 */

let openThreadId: string | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 关闭某会话的浮层（threadId 不匹配时是 no-op，避免旧回调误关新会话） */
export function closeQuickView(threadId: string): void {
  if (openThreadId !== threadId) return;
  openThreadId = null;
  notify();
}

/** 切换某会话浮层的开合（header 按钮入口） */
export function toggleQuickView(threadId: string): void {
  if (openThreadId === threadId) {
    openThreadId = null;
  } else {
    openThreadId = threadId;
  }
  notify();
}

/** 订阅浮层是否对该会话打开（原始值快照：只有开合翻转才重渲染） */
export function useQuickViewOpen(threadId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? openThreadId === threadId : false),
    () => false,
  );
}

/** 非 hook 读取（测试缝 / 外部判定用） */
export const quickViewOpenForTest = (threadId: string): boolean =>
  openThreadId === threadId;
