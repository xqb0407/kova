"use client";

import { useSyncExternalStore } from "react";
import { piStoreKeyForThread } from "@/lib/pi/pi-thread-adapter";

/**
 * 问答档的出口提示：模型调 ask_needs_work 后推来的 data-askNeedsWork chunk。
 *
 * 为什么是「提议」而不是模型自己切档：切档会当场把系统提示词与工具表一起换重，
 * 那正是问答档存在的理由要避免的事——决定权留给人（与 plan_exit 的 HITL 同路子）。
 * 因此这个状态是每线程**一条**的瞬时提示（不是挂起交互，不需要审批 ID、不进
 * Rust 重放缓冲）：模型说完这句就继续答，用户点不点都不影响本轮。
 *
 * 键归一：chunk 只带 sessionId，而渲染侧的 mainThreadId 对本会话新建的线程恒为
 * __LOCALID_ 草稿 id（规则见 piStoreKeyForThread）——读写都过 storeKey，否则
 * 新建会话里 chip 既不出现（读草稿键 miss）也清不掉（清草稿键 miss）。
 */

export type AskNeedsWorkView = {
  /** 模型给的一句话理由，展示在 chip 上 */
  reason: string;
  /** 到达时间戳：同理由重复到达时用于就地更新而非堆叠 */
  at: number;
};

const pending = new Map<string, AskNeedsWorkView>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function storeKey(threadId: string): string {
  return piStoreKeyForThread(threadId);
}

export function applyAskNeedsWorkChunk(threadId: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as { reason?: unknown };
  pending.set(storeKey(threadId), {
    reason: typeof d.reason === "string" ? d.reason : "",
    at: Date.now(),
  });
  notify();
}

/** 用户点了 chip（或切走模式）后清掉：提示是一次性的，留着会一直挂在 composer 上 */
export function clearAskNeedsWork(threadId: string): void {
  const key = storeKey(threadId);
  if (!pending.has(key)) return;
  pending.delete(key);
  notify();
}

export function useAskNeedsWork(threadId: string | undefined): AskNeedsWorkView | null {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? (pending.get(storeKey(threadId)) ?? null) : null),
    () => null,
  );
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/* ---------------- 测试缝 ---------------- */

/** 测试钩子：直读某线程当前提示（与 hook 同源数据，绕开渲染器） */
export const askNeedsWorkForTest = (
  threadId: string,
): AskNeedsWorkView | null => pending.get(storeKey(threadId)) ?? null;
