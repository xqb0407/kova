/**
 * 远程访问网关（对齐 remote.rs）：HTTP + WebSocket 同端口（默认 8787）。
 * 浏览器 ⇄ http://<ip>:8787（静态页，构建产物 out/）⇄ ws://<ip>:8787/ws ⇄ sidecar。
 * 协议（auth 后透传 sidecar 原始 NDJSON，id 必填）：
 *   未认证：{"type":"pair","code":"483920"} | {"type":"auth","token":".."}
 *   服务端：{"type":"paired","token":".."} | {"type":"authed"}
 *           | {"type":"error","errorText":".."} | {"type":"closed","reason":".."}
 *           | {"id":"..","type":"accepted"}（prompt 投递确认：网关已写入 sidecar；
 *             断线重发以同 requestId 幂等去重，客户端据此停止重发）
 *   authed 后全部为 sidecar 原样响应/chunk 行（id 已还原为客户端原始 id）。
 * 安全：配对码 6 位仅存内存；每连接失败 5 次断开；未认证 10s 超时；
 * token 持久化于 kv（明文落盘口径同 secret.rs）；REMOTE_DENIED_TYPES 拒绝
 * 桌面专属管理消息（请求级错误帧 + REMOTE_DENIED code）。
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { kvGet, kvSet, kvDelete } from "./store";
import { logInfo, logWarn } from "./logging";
import { decrypt, encrypt } from "./secret";
import * as pi from "./pi-agent";
import * as tunnel from "./tunnel";
import { rendererOutDir } from "./out-dir";

const DEFAULT_PORT = 8787;
const MAX_PAIR_ATTEMPTS = 5;
const AUTH_TIMEOUT_MS = 10_000;
const TOKEN_KEY = "remote.token";
const BIND_LAN_KEY = "remote.bind.lan";
const OUTBOUND_QUEUE_LIMIT = 2048;
/** prompt 幂等台账上限：记住最近转发过的 requestId，重连重发不重复执行 */
const PROMPT_SEEN_LIMIT = 1024;

/** authed 后禁止远程转发的消息类型（桌面专属管理面，见 remote.rs 同名单） */
const REMOTE_DENIED_TYPES = new Set([
  "set_credential",
  "delete_credential",
  "list_credentials",
  "add_custom_provider",
  "delete_custom_provider",
  "toggle_custom_provider",
  "test_provider",
  "fetch_models",
  "save_mcp_server",
  "delete_mcp_server",
  "set_mcp_server_enabled",
  "test_mcp_server",
  "authorize_mcp_server",
  "revoke_mcp_server_auth",
  "list_mcp_servers",
  "get_mcp_server_tools",
  "get_mcp_server_log",
  "get_mcp_audit_log",
  "save_skill",
  "delete_skill",
  "set_skill_enabled",
  "set_skills_enabled",
  "save_subagent",
  "delete_subagent",
  "set_subagent_enabled",
  "write_memory_file",
  "set_memory",
  "set_personalization",
  "add_project_dir",
  "remove_project_dir",
  "update_model",
  "set_provider_filter",
  "set_thinking_maps",
  "automation_save",
  "automation_delete",
  "automation_set_enabled",
  "automation_run_now",
  "automation_history_delete",
]);

/** 无 id 自发通知白名单（原样广播给全部已认证连接） */
const BROADCAST_TYPES = new Set([
  "turn_changed",
  "session_state",
  "subagent_activity",
  "automation_fired",
  "automation_run_done",
  "plugin_op_result",
  "mcp_auth_result",
  "sessions_changed",
  "context_changed",
  "design_themes",
  "design_theme_set",
  "thread_event",
  // sidecar 换代广播：远程窗口据此对在跑线程拉快照归位（进程句柄未换，
  // 宿主 notifyTerminated 不响；不发这条会让远程端永远停在 running）
  "pi_restarted",
]);

/* ------------------------------ 连接与路由表 ------------------------------ */

interface RouteEntry {
  connId: number;
  clientId: string;
  send: (line: string) => void;
}

interface ConnHandle {
  send: (line: string) => void;
  kick: () => void;
}

const routes = new Map<string, RouteEntry>();
const conns = new Map<number, ConnHandle>();
const authedTxs = new Map<number, (line: string) => void>();
let nextConnId = 1;
/**
 * prompt 幂等台账：断线重连后客户端会用同一 requestId 重发未确认的 prompt，
 * 网关只把第一次转给 sidecar。命中即回 accepted，客户端据此停止重发，
 * 避免同一条消息被重复执行。sidecar 重启后清空（它已不记得这些请求）。
 */
const seenPrompts = new Map<string, true>();

function rememberPrompt(id: string): void {
  seenPrompts.set(id, true);
  while (seenPrompts.size > PROMPT_SEEN_LIMIT) {
    const oldest = seenPrompts.keys().next().value;
    if (oldest === undefined) break;
    seenPrompts.delete(oldest);
  }
}

/** 投递确认帧：客户端 outbox 收到任意同 id 回帧即出账；内容不需要 chunk */
function acceptedFrame(clientId: string): string {
  return JSON.stringify({ id: clientId, type: "accepted" });
}

function kickConn(connId: number): void {
  for (const [sid, e] of [...routes]) if (e.connId === connId) routes.delete(sid);
  const h = conns.get(connId);
  conns.delete(connId);
  authedTxs.delete(connId);
  h?.kick();
}

function isTerminal(v: any): boolean {
  const ct = v?.chunk?.type;
  if (ct === undefined) return true;
  return ct === "finish" || ct === "error";
}

/** sidecar stdout 循环调用：命中远程路由则还原 id 投递，返回 true 表示已消费 */
export function tryRoute(parsed: any): boolean {
  if (routes.size === 0 || parsed == null) return false;
  const sid = typeof parsed?.id === "string" ? parsed.id : null;
  if (!sid) return false;
  const entry = routes.get(sid);
  if (!entry) return false;
  const out = { ...parsed, id: entry.clientId };
  entry.send(JSON.stringify(out));
  if (isTerminal(out)) routes.delete(sid);
  return true;
}

export function broadcastNotification(parsed: any): void {
  if (parsed == null || parsed.id !== undefined) return;
  if (!BROADCAST_TYPES.has(parsed.type)) return;
  if (authedTxs.size === 0) return;
  const line = JSON.stringify(parsed);
  for (const [connId, send] of authedTxs) send(line);
}

export function notifyTerminated(): void {
  const line = JSON.stringify({ type: "error", errorText: "pi-agent terminated" });
  routes.clear();
  // sidecar 换代：请求台账失效，重连后的重发必须重新转发
  seenPrompts.clear();
  for (const h of conns.values()) h.send(line);
}

/* ------------------------------ 网关状态 ------------------------------ */

interface RemoteInner {
  server: Server | null;
  wss: WebSocketServer | null;
  port: number | null;
  code: string | null;
  lan: boolean;
  connCount: number;
}

const inner: RemoteInner = { server: null, wss: null, port: null, code: null, lan: false, connCount: 0 };

function generateCode(): string {
  const bytes = randomUUID().replace(/-/g, "");
  const n = parseInt(bytes.slice(0, 8), 16) % 1_000_000;
  return String(n).padStart(6, "0");
}

function loadOrCreateToken(): string {
  const stored = kvGet(TOKEN_KEY);
  if (stored && stored.length > 0) {
    const dec = decrypt(stored);
    if (dec.ok) return dec.value;
    logWarn(`[remote] stored token undecryptable, rotating: ${dec.error}`);
  }
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  kvSet(TOKEN_KEY, encrypt(token));
  return token;
}

function isLanIp(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127 || (a === 169 && b === 254)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT/Tailscale
  return false;
}

function lanIps(): string[] {
  const out: string[] = [];
  try {
    const ifaces = networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const i of list ?? []) {
        if (i.family === "IPv4" && !i.internal && isLanIp(i.address) && !out.includes(i.address)) {
          out.push(i.address);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function status(): any {
  const p = inner.port;
  const lan = inner.lan;
  const ips = p === null ? [] : lan ? lanIps() : ["127.0.0.1"];
  return {
    running: inner.server !== null,
    port: inner.port,
    code: inner.code,
    connections: inner.connCount,
    lan,
    lanAddresses: ips.map((ip) => `ws://${ip}:${p}/ws`),
    httpAddresses: ips.map((ip) => `http://${ip}:${p}`),
  };
}

/* ------------------------------ HTTP 静态页 ------------------------------ */

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  map: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
  wasm: "application/wasm",
};

const PAGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; " +
  "connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src 'self' data: blob:; " +
  "media-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'self'";

function hintPage(): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>Kova 远程访问</title>` +
    `<body style="font-family:system-ui;padding:2rem"><h2>网页界面尚未构建</h2>` +
    `<p>先执行 <code>bun run build:renderer</code> 生成静态产物（apps/desktop/out），` +
    `electron 版会把 <code>apps/electron/renderer-out</code> 作为远程网页 serve。</p></body>`
  );
}

function serveStatic(req: IncomingMessage, res: import("node:http").ServerResponse): void {
  const rawPath = (req.url ?? "/").split("?")[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    decoded = rawPath;
  }
  const segments = decoded.replace(/^\/+/, "").split(/[\\/]/);
  if (segments.some((s) => s === "..")) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const rel = segments.join("/");
  const root = rendererOutDir();
  if (!existsSync(root)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(hintPage());
    return;
  }
  const path = rel.length === 0 ? "index.html" : rel;
  const candidates = [path];
  if (!path.endsWith(".html")) {
    candidates.push(`${path}.html`, `${path}/index.html`);
  }
  if (!path.includes(".")) {
    candidates.push("index.html");
  }
  for (const c of candidates) {
    const file = normalize(join(root, c));
    if (!file.startsWith(normalize(root))) continue;
    try {
      if (statSync(file).isFile()) {
        const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
        res.writeHead(200, {
          "content-type": MIME[ext] ?? "application/octet-stream",
          "content-security-policy": PAGE_CSP,
          "cache-control": "no-cache",
        });
        res.end(readFileSync(file));
        return;
      }
    } catch {
      /* 下一个候选 */
    }
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

/* ------------------------------ WebSocket 会话 ------------------------------ */

function errorFrame(reqId: string | null, errorText: string): any {
  return reqId ? { id: reqId, type: "error", errorText } : { type: "error", errorText };
}

function deniedFrame(reqId: string | null): any {
  const frame = errorFrame(reqId, "该操作仅限桌面端");
  frame.error = { code: "REMOTE_DENIED", source: "runtime", retryable: false };
  return frame;
}

async function handleConn(ws: WebSocket): Promise<void> {
  const connId = nextConnId++;
  inner.connCount += 1;

  // 出站队列（有界）：满则按背压踢线（慢客户端不拖垮其他订阅者）
  const queue: string[] = [];
  let closed = false;
  let draining = false;
  const pump = () => {
    if (draining) return;
    draining = true;
    const step = () => {
      while (queue.length > 0 && ws.readyState === ws.OPEN) {
        const line = queue.shift()!;
        try {
          ws.send(line);
        } catch {
          break;
        }
      }
      draining = false;
    };
    step();
  };
  const send = (line: string) => {
    if (closed) return;
    if (queue.length >= OUTBOUND_QUEUE_LIMIT) {
      logWarn(`[remote] outbound queue full, dropping conn ${connId}`);
      kickConn(connId);
      return;
    }
    queue.push(line);
    pump();
  };
  const kick = () => {
    if (closed) return;
    closed = true;
    try {
      ws.close(1000, "gateway stopped");
    } catch {
      /* ignore */
    }
  };
  conns.set(connId, { send, kick });

  let authed = false;
  let failCount = 0;
  let authTimer: NodeJS.Timeout | null = setTimeout(() => {
    if (!authed) {
      send(JSON.stringify({ type: "error", errorText: "authentication timeout" }));
      kick();
    }
  }, AUTH_TIMEOUT_MS);

  ws.on("message", (data) => {
    void (async () => {
      let v: any;
      try {
        v = JSON.parse(String(data));
      } catch {
        send(JSON.stringify({ type: "error", errorText: "invalid json" }));
        return;
      }
      const mtype = typeof v?.type === "string" ? v.type : "";

      if (!authed) {
        if (mtype === "pair") {
          const expected = inner.code;
          const supplied = typeof v?.code === "string" ? v.code : "";
          if (expected !== null && supplied.length > 0 && supplied === expected) {
            const token = loadOrCreateToken();
            send(JSON.stringify({ type: "paired", token }));
            authed = true;
            authedTxs.set(connId, send);
          } else {
            failCount += 1;
            send(JSON.stringify({ type: "error", errorText: "invalid pairing code", attemptsLeft: MAX_PAIR_ATTEMPTS - failCount }));
          }
        } else if (mtype === "auth") {
          const stored = loadOrCreateToken();
          const supplied = typeof v?.token === "string" ? v.token : "";
          if (stored.length > 0 && supplied === stored) {
            // accepted=true 声明网关支持 prompt 幂等去重：客户端据此才敢重发
            // 「已发出但未确认」的帧；老网关不带该字段，客户端只补发从未出站的
            send(JSON.stringify({ type: "authed", accepted: true }));
            authed = true;
            authedTxs.set(connId, send);
          } else {
            failCount += 1;
            send(JSON.stringify({ type: "error", errorText: "invalid token", attemptsLeft: MAX_PAIR_ATTEMPTS - failCount }));
          }
        } else {
          send(JSON.stringify({ type: "error", errorText: "unauthorized" }));
        }
        if (failCount >= MAX_PAIR_ATTEMPTS) kick();
        return;
      }

      // authed：透传 sidecar 协议（桌面专属管理面按请求级错误帧拒绝）
      const reqId = typeof v?.id === "string" ? v.id : null;
      if (REMOTE_DENIED_TYPES.has(mtype)) {
        send(JSON.stringify(deniedFrame(reqId)));
        return;
      }
      try {
        await forwardToAgent(connId, v, send);
      } catch (e: any) {
        send(JSON.stringify(errorFrame(reqId, String(e?.message ?? e))));
      }
    })();
  });

  const cleanup = () => {
    closed = true;
    if (authTimer) {
      clearTimeout(authTimer);
      authTimer = null;
    }
    for (const [sid, e] of [...routes]) if (e.connId === connId) routes.delete(sid);
    conns.delete(connId);
    authedTxs.delete(connId);
    inner.connCount = Math.max(0, inner.connCount - 1);
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

/** authed 消息转发：id 重写为 rem-{conn}-{orig}，登记路由后写入 sidecar stdin */
async function forwardToAgent(connId: number, v: any, send: (line: string) => void): Promise<void> {
  if (v?.type === "abort") {
    await pi.ensureSpawned();
    await pi.writeRawLine(JSON.stringify(v)); // 无 id：全局透传，不占路由
    return;
  }
  const id = typeof v?.id === "string" ? v.id : null;
  if (!id) {
    send(JSON.stringify({ type: "error", errorText: "missing id" }));
    return;
  }
  // 断线重发：同一条 prompt 只转发一次；命中即投递确认，不重复执行
  const isPrompt = v?.type === "prompt";
  if (isPrompt && seenPrompts.has(id)) {
    send(acceptedFrame(id));
    return;
  }
  const sid = `rem-${connId}-${id}`;
  const out = { ...v, id: sid };
  routes.set(sid, { connId, clientId: id, send });
  try {
    await pi.ensureSpawned();
    await pi.writeRawLine(JSON.stringify(out));
    if (isPrompt) {
      rememberPrompt(id);
      send(acceptedFrame(id));
    }
  } catch (e) {
    routes.delete(sid);
    throw e;
  }
}

/* ------------------------------ 启动/停止 ------------------------------ */

async function startGateway(args: { port?: number | null; lan?: boolean | null }): Promise<any> {
  if (args?.lan != null) kvSet(BIND_LAN_KEY, args.lan ? "true" : "false");
  const lan = args?.lan != null ? Boolean(args.lan) : kvGet(BIND_LAN_KEY) === "true";
  if (inner.server) {
    if (inner.lan === lan) return status();
    tunnel.stopNow(); // 重启可能换端口：隧道先收掉，避免 502 幽灵地址
    stopSync();
  }
  const port = args?.port != null ? Number(args.port) : DEFAULT_PORT;
  const host = lan ? "0.0.0.0" : "127.0.0.1";

  const server = createServer((req, res) => serveStatic(req, res));
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleConn(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: any) => reject(new Error(`failed to bind ${host}:${port}: ${e?.message ?? e}`)));
    server.listen(port, host, () => resolve());
  });
  inner.server = server;
  inner.wss = wss;
  inner.port = port;
  inner.code = generateCode();
  inner.lan = lan;
  logInfo(`[remote] gateway started on ${host}:${port} (lan=${lan})`);
  return status();
}

function stopSync(): void {
  const server = inner.server;
  const wss = inner.wss;
  inner.server = null;
  inner.wss = null;
  inner.port = null;
  inner.code = null;
  const closedLine = JSON.stringify({ type: "closed", reason: "gateway stopped" });
  for (const h of conns.values()) h.send(closedLine);
  for (const id of [...conns.keys()]) kickConn(id);
  routes.clear();
  inner.connCount = 0;
  try {
    wss?.close();
  } catch {
    /* ignore */
  }
  try {
    server?.close();
  } catch {
    /* ignore */
  }
}

export function stopOnExit(): void {
  stopSync();
}

export function currentPort(): number | null {
  return inner.port;
}

/* ------------------------------ 命令注册 ------------------------------ */

export function setupRemoteCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("pi_remote_start", async (a) => startGateway(a ?? {}));
  register("pi_remote_stop", async () => {
    tunnel.stopNow();
    stopSync();
    logInfo("[remote] gateway stopped");
    return null;
  });
  register("pi_remote_status", async () => {
    const st = status();
    if (!st.running) {
      // 未运行时展示持久化的绑定模式（下次 start 生效的就是它）
      st.lan = kvGet(BIND_LAN_KEY) !== "false";
    }
    return st;
  });
  register("pi_remote_refresh_code", async () => {
    if (!inner.server) throw new Error("remote gateway is not running");
    inner.code = generateCode();
    return inner.code;
  });
  register("pi_remote_revoke", async () => {
    kvDelete(TOKEN_KEY);
    const ids = [...conns.keys()];
    for (const id of ids) kickConn(id);
    logInfo(`[remote] token revoked; ${ids.length} connection(s) kicked`);
    return status();
  });
}
