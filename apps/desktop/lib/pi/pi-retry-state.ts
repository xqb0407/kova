"use client";

import { useSyncExternalStore } from "react";
import { piStoreKeyForThread } from "@/lib/pi/pi-thread-adapter";

/**
 * provider 自动重试的直播状态（data-retry chunk 的 per-thread 镜像）。
 *
 * 形态与 pi-goal / pi-session-mode 同款：bypass chunk 直更 store，不进消息流。
 * 这条旁路是必须的——桌面 wire 层（pi-client-base handleWireLine）把 data-*
 * chunk 全部拦成分发事件，data-retry 从未到过消息 parts，旧 RetryMarker 按
 * 「消息末位 part」判重的实现在这条链路上恒为 null（倒计时卡片从未亮过）。
 *
 * 只服务「重试中」的直播呈现（倒计时），结算即无痕：成功有正文、失败有错误
 * 卡，轮次结束后不留重试标记（用户口径，2026-11-07）。store 忠实镜像
 * retrying/resolved 两态——resolved 覆写 retrying 是结算的关键一步，否则
 * 恢复后的流式期间会挂着最后一个倒计时不放。
 *
 * store 只做镜像不做水合：没有 get 请求（轮级瞬态；轮初 idle 清台 +
 * start/finish/error 帧兜底清，见 pi-client-base）。
 */

export type RetryData = {
  phase: "retrying" | "resolved" | "idle";
  attempt?: number;
  maxRetries?: number;
  /** 本次退避等待（毫秒），驱动倒计时 */
  delayMs?: number;
  /** 错误分类码（PROVIDER_RATE_LIMITED / NETWORK_ERROR / ...） */
  code?: string;
  /** provider 错误文本（sidecar 已脱敏截断） */
  error?: string;
};

type RetryStoreState = { retry: RetryData | null };

const EMPTY: RetryStoreState = { retry: null };

const states = new Map<string, RetryStoreState>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function storeKey(threadId: string): string {
  return piStoreKeyForThread(threadId);
}

function setState(threadId: string, next: RetryStoreState) {
  states.set(storeKey(threadId), next);
  notify();
}

function normalizeRetry(raw: unknown): RetryData | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<RetryData>;
  if (d.phase !== "retrying" && d.phase !== "resolved" && d.phase !== "idle") {
    return null;
  }
  return {
    phase: d.phase,
    ...(typeof d.attempt === "number" ? { attempt: d.attempt } : {}),
    ...(typeof d.maxRetries === "number" ? { maxRetries: d.maxRetries } : {}),
    ...(typeof d.delayMs === "number" ? { delayMs: d.delayMs } : {}),
    ...(typeof d.code === "string" ? { code: d.code } : {}),
    ...(typeof d.error === "string" ? { error: d.error } : {}),
  };
}

/** 消费 prompt 流里的 data-retry chunk（pi-client-base 调用） */
export function applyRetryChunk(threadId: string, data: unknown): void {
  const retry = normalizeRetry(data);
  if (!retry) return;
  // idle = sidecar 轮初的显式清台（每轮重置块发一次，多窗口自愈）：
  // 清掉上一轮可能残留的 resolved，新轮没有重试就不该再亮 chip
  if (retry.phase === "idle") {
    if (states.has(storeKey(threadId))) setState(threadId, EMPTY);
    return;
  }
  setState(threadId, { retry });
}

/** 清线程的重试态（start/finish/error 收尾帧观察处调用） */
export function clearRetryState(threadId: string): void {
  if (states.has(storeKey(threadId))) setState(threadId, EMPTY);
}

/** 订阅当前线程的重试直播态 */
export function useRetryStoreState(threadId: string | undefined): RetryStoreState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (threadId ? (states.get(storeKey(threadId)) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
}

/* ---------------- 测试缝 ---------------- */

/** 测试钩子：直读某线程重试态（与 hook 同源数据，绕开渲染器） */
export const retryStateForTest = (threadId: string): RetryStoreState =>
  states.get(storeKey(threadId)) ?? EMPTY;
