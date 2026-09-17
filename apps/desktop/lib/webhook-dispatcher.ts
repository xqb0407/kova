"use client";

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import {
  eventLabel,
  subscribeAgentEvents,
  type AgentEvent,
  type AgentEventName,
} from "@/lib/agent-events";
import {
  getWebhookEndpoints,
  initWebhooks,
  type WebhookEndpoint,
} from "@/lib/webhooks";
import { isTauri } from "@/lib/tauri";
import { toast } from "@/components/ui/toast";

/**
 * 统一 webhook 派发：事件总线 → 订阅过滤 → 平台组包 → 加签 → 发送 → 记录。
 * 发送走 Rust http_post（webview fetch 会被钉钉/飞书等无 CORS 头的端点拦死）；
 * 网页模式降级为直连 fetch（尽力而为）。
 * 失败不重试：fire-and-forget + 最近推送记录 + toast，可观测优先。
 */

export interface WebhookDelivery {
  id: string;
  ts: number;
  endpointName: string;
  event: AgentEventName;
  ok: boolean;
  detail: string;
  durationMs: number;
}

/** 列表展示与清理保留的条数（设置页只查最近这些条，「清理」删除更早的） */
export const DELIVERY_KEEP = 20;

// 快照必须是新引用（原地改会骗过 useSyncExternalStore）
let deliveries: WebhookDelivery[] = [];
const EMPTY: WebhookDelivery[] = [];
const deliveryListeners = new Set<() => void>();

function emitDeliveries() {
  for (const l of deliveryListeners) l();
}

/** Rust webhook_delivery 表的行形状（camelCase 序列化） */
type WebhookDeliveryRow = {
  id: number;
  endpoint: string;
  event: string;
  ok: boolean;
  detail: string;
  durationMs: number;
  createdAt: number;
};

function rowToDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: String(row.id),
    ts: row.createdAt,
    endpointName: row.endpoint,
    event: row.event as AgentEventName,
    ok: row.ok,
    detail: row.detail,
    durationMs: row.durationMs,
  };
}

/** 记录：内存缓存置顶（仅最近 20 条）+ 桌面端落库；网页模式只有内存态 */
function record(delivery: WebhookDelivery) {
  deliveries = [delivery, ...deliveries].slice(0, DELIVERY_KEEP);
  emitDeliveries();
  if (isTauri()) {
    void invoke("webhook_delivery_add", {
      endpoint: delivery.endpointName,
      event: delivery.event,
      ok: delivery.ok,
      detail: delivery.detail,
      durationMs: delivery.durationMs,
    }).catch(() => {});
  }
}

/** 从 SQLite 水合最近 20 条（dispatcher 初始化时调用） */
async function loadDeliveries(): Promise<void> {
  if (!isTauri()) return;
  try {
    const rows = await invoke<WebhookDeliveryRow[]>("webhook_delivery_list", {
      limit: DELIVERY_KEEP,
    });
    deliveries = rows.map(rowToDelivery);
    emitDeliveries();
  } catch {
    // 数据库不可用时保持内存态
  }
}

export function useWebhookDeliveries(): WebhookDelivery[] {
  return useSyncExternalStore(
    (l) => {
      deliveryListeners.add(l);
      return () => deliveryListeners.delete(l);
    },
    () => deliveries,
    () => EMPTY,
  );
}

/** 删除某端点的全部推送记录（端点被删时级联清理，按端点名匹配） */
export async function removeWebhookDeliveries(endpointName: string): Promise<void> {
  const next = deliveries.filter((d) => d.endpointName !== endpointName);
  if (next.length !== deliveries.length) {
    deliveries = next;
    emitDeliveries();
  }
  if (isTauri()) {
    try {
      await invoke("webhook_delivery_delete", { endpoint: endpointName });
    } catch {
      // 库不可用时仅内存态生效
    }
  }
}

/** 清理：只保留最新 keep 条（默认 DELIVERY_KEEP，0 = 全部清空），返回删除数。
 *  内存缓存同步截断，保证 UI 与库里一致；网页模式内存已封顶 */
export async function pruneWebhookDeliveries(
  keep: number = DELIVERY_KEEP,
): Promise<number> {
  const truncate = () => {
    if (deliveries.length > keep) {
      deliveries = deliveries.slice(0, keep);
      emitDeliveries();
    }
  };
  if (!isTauri()) {
    const removed = Math.max(0, deliveries.length - keep);
    truncate();
    return removed;
  }
  try {
    const deleted = await invoke<number>("webhook_delivery_prune", { keep });
    truncate();
    return deleted;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 组包与加签
// ---------------------------------------------------------------------------

interface BuiltRequest {
  url: string;
  body: string;
  headers: [string, string][];
}

/** 一行式人读摘要（IM 机器人正文用） */
function summarize(event: AgentEvent): string {
  const parts = [eventLabel(event.name)];
  const d = event.data ?? {};
  if (typeof d.toolName === "string") parts.push(`工具 ${d.toolName}`);
  if (typeof d.message === "string" && d.message) parts.push(d.message.slice(0, 120));
  if (typeof d.prompt === "string" && d.prompt) parts.push(`「${d.prompt.slice(0, 60)}」`);
  if (event.threadId) parts.push(`会话 ${event.threadId.slice(0, 8)}`);
  return `[Xulux] ${parts.join(" · ")}`;
}

async function hmacSha256(keyStr: string, msgStr: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(keyStr),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, enc.encode(msgStr));
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(buf: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 按端点格式把事件信封翻译成最终 HTTP 请求（含签名） */
async function buildRequest(
  endpoint: WebhookEndpoint,
  event: AgentEvent,
): Promise<BuiltRequest> {
  const headers: [string, string][] = [["content-type", "application/json"]];
  const text = summarize(event);

  switch (endpoint.format) {
    case "dingtalk": {
      let url = endpoint.url;
      if (endpoint.secret) {
        const ts = Date.now();
        const sign = encodeURIComponent(
          toBase64(await hmacSha256(endpoint.secret, `${ts}\n${endpoint.secret}`)),
        );
        url += `${url.includes("?") ? "&" : "?"}timestamp=${ts}&sign=${sign}`;
      }
      return {
        url,
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
        headers,
      };
    }
    case "feishu": {
      const payload: Record<string, unknown> = { msg_type: "text", content: { text } };
      if (endpoint.secret) {
        // 飞书自定义机器人签名：HMAC-SHA256，key=`${timestamp}\n${secret}`，空消息体
        const ts = Math.floor(Date.now() / 1000);
        payload.timestamp = String(ts);
        payload.sign = toBase64(await hmacSha256(`${ts}\n${endpoint.secret}`, ""));
      }
      return { url: endpoint.url, body: JSON.stringify(payload), headers };
    }
    case "slack":
      return { url: endpoint.url, body: JSON.stringify({ text }), headers };
    case "generic":
    default: {
      // 通用信封：结构化事件，接收方按需消费；secret 走 GitHub 风格头签名
      const envelope = {
        id: event.id,
        event: event.name,
        occurredAt: new Date(event.occurredAt).toISOString(),
        app: { name: "Xulux", platform: "pi-desktop" },
        thread: event.threadId ? { id: event.threadId } : undefined,
        data: event.data ?? {},
      };
      const body = JSON.stringify(envelope);
      if (endpoint.secret) {
        headers.push([
          "x-pi-signature",
          `sha256=${toHex(await hmacSha256(endpoint.secret, body))}`,
        ]);
      }
      return { url: endpoint.url, body, headers };
    }
  }
}

// ---------------------------------------------------------------------------
// 发送通道
// ---------------------------------------------------------------------------

interface PostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

async function post(request: BuiltRequest): Promise<PostResult> {
  if (isTauri()) {
    try {
      const res = await invoke<{ status: number; ok: boolean; snippet: string }>(
        "http_post",
        {
          url: request.url,
          body: request.body,
          headers: request.headers,
          timeoutMs: 10000,
        },
      );
      return {
        ok: res.ok,
        status: res.status,
        error: res.ok ? undefined : `HTTP ${res.status} ${res.snippet.slice(0, 120)}`,
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  // 网页模式降级：直连 fetch，受 CORS 限制失败仅记录
  try {
    const resp = await fetch(request.url, {
      method: "POST",
      headers: Object.fromEntries(request.headers),
      body: request.body,
    });
    return {
      ok: resp.ok,
      status: resp.status,
      error: resp.ok ? undefined : `HTTP ${resp.status}`,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function dispatch(endpoint: WebhookEndpoint, event: AgentEvent): Promise<void> {
  const t0 = Date.now();
  let result: PostResult;
  try {
    result = await post(await buildRequest(endpoint, event));
  } catch (e) {
    result = { ok: false, error: String(e) };
  }
  record({
    id: crypto.randomUUID(),
    ts: Date.now(),
    endpointName: endpoint.name,
    event: event.name,
    ok: result.ok,
    detail: result.error ?? `HTTP ${result.status ?? "-"}`,
    durationMs: Date.now() - t0,
  });
  if (!result.ok) {
    toast.error({
      title: `Webhook「${endpoint.name}」推送失败`,
      description: result.error,
    });
  }
}

function subscribed(endpoint: WebhookEndpoint, name: AgentEventName): boolean {
  return (
    endpoint.events === "*" ||
    (Array.isArray(endpoint.events) && endpoint.events.includes(name))
  );
}

let initialized = false;

/** 挂到事件总线：生命周期事件 → 匹配订阅的端点逐个推送 */
export function initWebhookDispatcher(): void {
  if (initialized) return;
  initialized = true;
  void initWebhooks();
  void loadDeliveries();
  subscribeAgentEvents((event) => {
    for (const endpoint of getWebhookEndpoints()) {
      if (endpoint.enabled && endpoint.url && subscribed(endpoint, event.name)) {
        void dispatch(endpoint, event);
      }
    }
  });
}

/** 设置页「测试」：向指定端点单发一条 system.test，绕过订阅过滤，返回结果供展示 */
export async function sendWebhookTest(
  endpoint: WebhookEndpoint,
): Promise<{ ok: boolean; detail: string }> {
  const event: AgentEvent = {
    id: crypto.randomUUID(),
    name: "system.test",
    occurredAt: Date.now(),
    data: { note: "这是一条测试推送" },
  };
  const t0 = Date.now();
  let result: PostResult;
  try {
    result = await post(await buildRequest(endpoint, event));
  } catch (e) {
    result = { ok: false, error: String(e) };
  }
  const detail = result.error ?? `HTTP ${result.status ?? "-"}`;
  record({
    id: crypto.randomUUID(),
    ts: Date.now(),
    endpointName: endpoint.name,
    event: "system.test",
    ok: result.ok,
    detail,
    durationMs: Date.now() - t0,
  });
  return { ok: result.ok, detail };
}
