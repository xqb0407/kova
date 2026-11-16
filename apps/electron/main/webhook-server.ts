/**
 * Webhook 触发端点（L1a）：127.0.0.1 loopback HTTP server。
 *
 * 安全链（顺序固定，见 docs/event-triggers-headless.md §4.1）：
 *   路径 trigger 存在且 enabled → HMAC 验签（timingSafeEqual）→ 时间窗防重放
 *   → 幂等 LRU → 每 trigger 限流 → body 上限 → fire。
 *
 * 只绑 127.0.0.1：公网暴露由用户的隧道/反代决定，Kova 不开公网口。
 * 触发解析走 hostAutomationRpc → sidecar（run_with_trigger），本文件不持有
 * scheduler；triggers.json 的事实源在 sidecar，这里只按 RPC 应答判断存在性。
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  checkWebhookRequest,
  createWebhookGuardState,
  summarizeWebhook,
  WEBHOOK_MAX_BODY_BYTES,
  type WebhookGuardState,
} from "automation-core";

/** kv 端口记忆（生产走 ./store；默认惰性动态 import，测试可整表替换） */
export const kvPortMemory = {
  get: (_key: string): string | null => null,
  set: (_key: string, _value: string): void => {},
};


import { logInfo, logWarn } from "./logging";
import { fireHostTrigger, lookupWebhookTrigger } from "./trigger-rpc";

const DEFAULT_PORT = 8788;
const PORT_RANGE = 10;
const PORT_KV_KEY = "triggers.webhook.port";
const RATE_LIMIT_PER_MIN = 10;
/** 幂等台账上限：delivery id 重试去重 */
const SEEN_DELIVERY_LIMIT = 1024;
/** HMAC 密钥：main 侧不存——验签需要的 secret 由 sidecar 经 RPC 查询（不缓存到磁盘） */

type WebhookState = {
  server: Server | null;
  port: number | null;
  /** delivery id LRU */
  seenDeliveries: Set<string>;
  /** triggerId → 时间窗内的请求时间戳 */
  rateWindows: Map<string, number[]>;
};

const state: WebhookState & { guard: WebhookGuardState } = {
  server: null,
  port: null,
  seenDeliveries: new Set(),
  rateWindows: new Map(),
  guard: createWebhookGuardState(),
};

export function webhookPort(): number | null {
  return state.port;
}

/**
 * 查 webhook trigger 的 secret：经 trigger-rpc 透传到事实源（生产为
 * automation dispatcher，dev 进程内模式为 sidecar 协议）。main 侧不缓存
 * （密钥重置立即生效）。
 */
async function lookupTrigger(
  triggerId: string,
): Promise<{ enabled: boolean; secret: string; taskId: string } | null> {
  return lookupWebhookTrigger(triggerId);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > WEBHOOK_MAX_BODY_BYTES) {
        reject(new Error("body-too-large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function summarize(req: IncomingMessage, body: string): string {
  return summarizeWebhook(req.headers, body);
}

async function handleHook(
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
  triggerId: string,
): Promise<void> {
  const reply = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") {
    reply(405, { error: "POST only" });
    return;
  }
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    reply(413, { error: err instanceof Error && err.message === "body-too-large" ? "body too large (64KB max)" : "read failed" });
    return;
  }

  const trigger = await lookupTrigger(triggerId);
  if (!trigger) {
    reply(404, { error: "unknown trigger" });
    return;
  }
  if (!trigger.enabled) {
    reply(409, { error: "trigger disabled" });
    return;
  }

  const decision = checkWebhookRequest(state.guard, {
    secret: trigger.secret,
    body,
    signature: String(req.headers["x-kova-signature"] ?? ""),
    timestamp: Number(req.headers["x-kova-timestamp"] ?? NaN),
    delivery: String(req.headers["x-kova-delivery"] ?? "") || randomUUID(),
  });
  if (!decision.ok) {
    reply(decision.status, { error: decision.reason });
    return;
  }
  if (decision.deduplicated) {
    reply(200, { ok: true, deduplicated: true });
    return;
  }
  const delivery = decision.delivery;

  try {
    const task = await fireHostTrigger(trigger.taskId, {
      type: "webhook",
      id: triggerId,
      summary: summarize(req, body),
    });
    if (!task) {
      reply(404, { error: "automation task not found" });
      return;
    }
    logInfo(`[webhook] fired trigger ${triggerId} (delivery ${delivery})`);
    reply(202, { ok: true, delivery });
  } catch (err) {
    logWarn(`[webhook] fire failed for ${triggerId}: ${err instanceof Error ? err.message : String(err)}`);
    reply(500, { error: "fire failed" });
  }
}

/** 启动 loopback server（index.ts ready 后调用）；失败只记日志不阻断启动 */
export async function startWebhookServer(): Promise<void> {
  if (state.server) return;
  let preferred = DEFAULT_PORT;
  try {
    const saved = kvPortMemory.get(PORT_KV_KEY);
    if (saved) {
      const n = Number(JSON.parse(saved));
      if (Number.isFinite(n) && n > 0 && n < 65_536) preferred = n;
    }
  } catch {
    /* 无 kv / 无记录：用默认 */
  }
  const server = createServer((req, res) => {
    const triggerId = /^\/hook\/([A-Za-z0-9_-]{1,64})$/.exec(req.url ?? "")?.[1] ?? "";
    if (!triggerId) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    void handleHook(req, res, triggerId).catch((err) => {
      logWarn(`[webhook] handler error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    });
  });
  for (let attempt = 0; attempt < PORT_RANGE; attempt += 1) {
    const port = preferred + attempt;
    const ok = await new Promise<boolean>((resolve) => {
      const onError = () => {
        resolve(false);
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve(true);
      });
    });
    if (ok) {
      state.server = server;
      state.port = port;
      break;
    }
  }
  if (!state.server) {
    logWarn("[webhook] no available port; webhook triggers disabled this session");
    return;
  }
  try {
    kvPortMemory.set(PORT_KV_KEY, JSON.stringify(state.port));
  } catch (err) {
    // db 未初始化（如单测环境）：端口记忆降级为会话内有效
    logWarn(`[webhook] port persist skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  logInfo(`[webhook] listening on 127.0.0.1:${state.port}`);
}

/** 生产初始化（index.ts ready 后调用一次）：把端口记忆接到真实 store kv */
export function initWebhookKv(read: (key: string) => string | null, write: (key: string, value: string) => void): void {
  kvPortMemory.get = read;
  kvPortMemory.set = write;
}

/** before-quit 收尾 */
export function stopWebhookServer(): void {
  if (!state.server) return;
  try {
    state.server.close();
  } catch {
    /* 容错 */
  }
  state.server = null;
  state.port = null;
  state.guard = createWebhookGuardState();
}
