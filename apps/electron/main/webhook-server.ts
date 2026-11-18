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
  forgetWebhookDelivery,
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
/** HMAC 密钥：main 侧不存——验签需要的 secret 由 trigger-rpc 现查（不落盘） */

type WebhookState = {
  server: Server | null;
  port: number | null;
  /** 幂等 LRU / 每 trigger 限流窗口都在 guard 里（automation-core） */
  guard: WebhookGuardState;
};

const state: WebhookState = {
  server: null,
  port: null,
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

/** 提前拒绝（404/405/409）时把未读 body 排空，避免 keep-alive 连接错位 */
function drain(req: IncomingMessage): void {
  try {
    // 客户端可能读一半就断开：drain 期间必须有 error 监听，否则未处理
    // 的 'error' 事件会冒到进程级
    req.on("error", () => {});
    req.resume();
  } catch {
    /* ignore */
  }
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
    drain(req);
    reply(405, { error: "POST only" });
    return;
  }

  // 先查触发器再读 body：未知/停用 trigger 的请求不消耗读取与验签。
  // 查询失败回 503（可重试），不能伪装成 404——多数平台收到 404 会停用端点。
  let trigger: Awaited<ReturnType<typeof lookupTrigger>>;
  try {
    trigger = await lookupTrigger(triggerId);
  } catch (err) {
    logWarn(
      `[webhook] trigger lookup failed for ${triggerId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    drain(req);
    reply(503, { error: "trigger lookup failed" });
    return;
  }
  if (!trigger) {
    drain(req);
    reply(404, { error: "unknown trigger" });
    return;
  }
  if (!trigger.enabled) {
    drain(req);
    reply(409, { error: "trigger disabled" });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    reply(413, { error: err instanceof Error && err.message === "body-too-large" ? "body too large (64KB max)" : "read failed" });
    return;
  }

  const decision = checkWebhookRequest(state.guard, {
    triggerId,
    secret: trigger.secret,
    body,
    signature: String(req.headers["x-kova-signature"] ?? ""),
    timestamp: Number(req.headers["x-kova-timestamp"] ?? NaN),
    delivery: String(req.headers["x-kova-delivery"] ?? "") || randomUUID(),
  });
  if (!decision.ok) {
    // 401（签名/时间窗）连日志都不打：loopback 上任何进程可匿名刷，避免刷日志
    if (decision.status === 429) {
      logWarn(`[webhook] rate limited trigger ${triggerId}`);
    }
    reply(decision.status, { error: decision.reason });
    return;
  }
  if (decision.deduplicated) {
    logInfo(`[webhook] duplicate delivery ignored for ${triggerId}`);
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
      // 未真正入队：撤销幂等标记，允许发送方同 delivery 重试
      forgetWebhookDelivery(state.guard, triggerId, delivery);
      reply(404, { error: "automation task not found" });
      return;
    }
    logInfo(`[webhook] fired trigger ${triggerId} (delivery ${delivery})`);
    reply(202, { ok: true, delivery });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    forgetWebhookDelivery(state.guard, triggerId, delivery);
    logWarn(`[webhook] fire failed for ${triggerId}: ${message}`);
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
      // 常驻 error handler：listening 状态下的运行期 error（底层 socket 异常等）
      // 没有 handler 会以 uncaught exception 崩掉主进程。探测期不挂——
      // EADDRINUSE 是预期路径，挂早了会把每次端口被占都打成 warn 噪音。
      server.on("error", (err) => {
        logWarn(`[webhook] server error: ${err instanceof Error ? err.message : String(err)}`);
      });
      state.server = server;
      state.port = port;
      break;
    }
  }
  if (!state.server) {
    // 全部端口被占：探测留下的 server 句柄没有 listen 成功，显式关掉不留悬挂对象
    // （close 传回调：未 listen 时 ERR_SERVER_NOT_RUNNING 走回调而不是 error 事件）
    try {
      server.close(() => {});
    } catch {
      /* ignore */
    }
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
