"use client";

/**
 * 消息定位意图（模块级 store，与 panel-tabs / pi-last-thread 同族）：
 * 全局搜索的内容命中点开后，把「跳到 pi-msg:<seq> + 高亮 query」的意图交给
 * thread 层消费。走 store 而非 <Thread> props——Thread 被刻意 memo 成零 props
 * （base.tsx 的 threadNode useMemo），props 通道会让整棵消息流跟着重渲染。
 *
 * 生命周期：base 的 open-session 订阅写入 → thread 在历史到达后 take 消费
 * （一次性，消费即清）；switchToThread 失败/取消时不消费，下一次写入覆盖。
 */

export type ThreadNavigateIntent = {
  seq: number;
  query?: string;
  /** 目标会话（mainThreadId / pi sessionId）：不匹配不消费——旧意图不得
   *  在用户已切走的会话里突然生效（短会话 seq 号段极易撞） */
  sessionKey: string;
  /** 写入时刻：30s 内未消费即视为失效（历史永远到不了时的自愈） */
  createdAt: number;
};

/** 意图有效期：覆盖慢会话（大转录 reload+switchToThread）的加载窗口即可 */
const INTENT_TTL_MS = 30_000;

export function isIntentFresh(intent: ThreadNavigateIntent): boolean {
  return Date.now() - intent.createdAt <= INTENT_TTL_MS;
}

let pending: ThreadNavigateIntent | null = null;

export function setThreadNavigateIntent(intent: ThreadNavigateIntent | null): void {
  pending = intent;
}

/** 一次性取出并清除（thread 层历史到达后调用） */
export function takeThreadNavigateIntent(): ThreadNavigateIntent | null {
  const current = pending;
  pending = null;
  return current;
}

export function peekThreadNavigateIntent(): ThreadNavigateIntent | null {
  return pending;
}
