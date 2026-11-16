/**
 * Webhook 触发校验链（L1a）：纯函数，sidecar / Electron main 两侧共用。
 *
 * 放在 automation-core（两侧都依赖的共享包）：sidecar 触发协议、Electron
 * webhook 端点、以及全部安全面测试都从这里走单一事实源。
 *
 * 语义（docs/event-triggers-headless.md §4.1，顺序即校验顺序）：
 * 1. HMAC-SHA256 验签（timingSafeEqual，`sha256=<hex>` 前缀格式）
 * 2. 时间窗防重放（X-Kova-Timestamp 偏移 ≤ tolerance）
 * 3. 幂等：delivery id LRU（重复 → deduplicated，不再触发）
 * 4. 限流：每 trigger 10 次/分钟（滑动窗口）
 * 5. body 上限由读取层执行（这里只有常量）
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
export const WEBHOOK_RATE_LIMIT_PER_MIN = 10;
export const WEBHOOK_SEEN_DELIVERY_LIMIT = 1024;

export type WebhookGuardState = {
  /** delivery id → 已见（LRU，超限淘汰一半最旧） */
  seenDeliveries: Set<string>;
  /** triggerId → 60s 窗口内的请求时间戳 */
  rateWindows: Map<string, number[]>;
};

export function createWebhookGuardState(): WebhookGuardState {
  return { seenDeliveries: new Set(), rateWindows: new Map() };
}

export type WebhookGuardDecision =
  | { ok: true; delivery: string; deduplicated: boolean }
  | { ok: false; status: 401 | 413 | 429; reason: string };

/** HMAC 验签：timingSafeEqual，长度不等直接 false（不同长度上比较无意义） */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  provided: string,
): boolean {
  if (!provided.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * 逐请求校验（签名 → 时间窗 → 幂等 → 限流）。delivery 缺省由调用方生成
 * （一次性随机），有 id 才具备幂等语义。
 */
export function checkWebhookRequest(
  state: WebhookGuardState,
  args: {
    secret: string;
    body: string;
    signature: string;
    timestamp: number | null;
    delivery: string;
    now?: number;
  },
): WebhookGuardDecision {
  if (!verifyWebhookSignature(args.secret, args.body, args.signature)) {
    return { ok: false, status: 401, reason: "invalid signature" };
  }
  const now = args.now ?? Date.now();
  if (
    !Number.isFinite(args.timestamp) ||
    Math.abs(now - args.timestamp!) > WEBHOOK_TIMESTAMP_TOLERANCE_MS
  ) {
    return { ok: false, status: 401, reason: "timestamp out of range" };
  }
  const delivery = args.delivery || `auto-${now}-${Math.random().toString(36).slice(2, 8)}`;
  if (state.seenDeliveries.has(delivery)) {
    return { ok: true, delivery, deduplicated: true };
  }
  if (state.seenDeliveries.size >= WEBHOOK_SEEN_DELIVERY_LIMIT) {
    // 简单淘汰：清一半最旧的（Set 保持插入序）
    const doomed = [...state.seenDeliveries].slice(0, WEBHOOK_SEEN_DELIVERY_LIMIT / 2);
    for (const d of doomed) state.seenDeliveries.delete(d);
  }
  state.seenDeliveries.add(delivery);
  const window = (state.rateWindows.get("") ?? []).filter(
    (t) => now - t < 60_000,
  );
  if (window.length >= WEBHOOK_RATE_LIMIT_PER_MIN) {
    state.rateWindows.set("", window);
    return { ok: false, status: 429, reason: "rate limited" };
  }
  window.push(now);
  state.rateWindows.set("", window);
  return { ok: true, delivery, deduplicated: false };
}

/** 触发摘要：事件头 + body 预览（调用方截 200 字进 run context） */
export function summarizeWebhook(
  headers: Record<string, string | string[] | undefined>,
  body: string,
): string {
  const first = (name: string): string => {
    const v = headers[name];
    return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  };
  const event = first("x-github-event") || first("x-gitlab-event");
  const eventTag = event ? `${event}: ` : "";
  const preview = body.trim().replace(/\s+/g, " ").slice(0, 160);
  return `${eventTag}${preview || "(empty body)"}`;
}
