/**
 * 远程网关冒烟（CDP + 真 WS 客户端）：
 *   node apps/electron/scripts/e2e-remote.mjs [cdpPort] [gatewayPort]
 * 覆盖：pi_remote_start → HTTP 静态页可达（含 CSP 头）→ WS 未认证限次
 * → 配对码 pair 成功拿 token → authed 透传 list_sessions 且 id 往返还原
 * → 桌面专属类型被 REMOTE_DENIED 拒绝（请求级错误帧带原 id）→ 停止。
 */
import { chromium } from "playwright-core";
import WebSocket from "ws";

const port = process.argv[2] ?? "9226";
const gwPort = Number(process.argv[3] ?? 18787);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page = null;
for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("kova://")) page = p;
if (!page) {
  console.error("FAIL: no kova:// page");
  process.exit(1);
}

const call = (cmd, args = {}) =>
  page.evaluate(
    async ({ cmd, args }) => {
      const r = await window.kovaHost.invoke(cmd, args);
      if (!r?.ok) throw new Error(`${cmd}: ${r?.error}`);
      return r.value;
    },
    { cmd, args },
  );

const out = {};
out.stopFirst = await call("pi_remote_stop").then(() => true).catch(() => false);
const st = await call("pi_remote_start", { port: gwPort, lan: false });
out.start = { running: st.running, port: st.port, code: String(st.code).length, http: st.httpAddresses };
out.code = st.code;

// HTTP 静态页
const httpResp = await fetch(`http://127.0.0.1:${gwPort}/`);
out.http = {
  status: httpResp.status,
  contentType: httpResp.headers.get("content-type"),
  hasCsp: Boolean(httpResp.headers.get("content-security-policy")),
  bodyHead: (await httpResp.text()).slice(0, 80).replace(/\s+/g, " "),
};

// WS：错误配对码 → 限次错误；正确码 → paired
const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/ws`);
const frames = [];
const waitFrame = (pred, timeout = 15000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("frame timeout: " + JSON.stringify(frames.slice(-4)))), timeout);
    const check = () => {
      const hit = frames.find(pred);
      if (hit) {
        clearTimeout(t);
        resolve(hit);
      }
    };
    ws.on("message", (d) => {
      try {
        frames.push(JSON.parse(String(d)));
      } catch {
        /* ignore */
      }
      check();
    });
    check();
  });

await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "pair", code: "000000" }));
const bad = await waitFrame((f) => f.type === "error" && f.errorText === "invalid pairing code");
out.badPair = bad;

ws.send(JSON.stringify({ type: "pair", code: st.code }));
const paired = await waitFrame((f) => f.type === "paired");
out.paired = { hasToken: typeof paired.token === "string" && paired.token.length > 20 };

// authed 透传：list_sessions（管理类）→ 响应 id 应还原为客户端原始 id
ws.send(JSON.stringify({ type: "list_sessions", id: "cli-1" }));
const sessions = await waitFrame((f) => f.id === "cli-1", 20000);
out.forwarded = { frame: sessions };

// 桌面专属类型：请求级错误帧 + REMOTE_DENIED code
ws.send(JSON.stringify({ type: "list_credentials", id: "cli-2" }));
const denied = await waitFrame((f) => f.id === "cli-2" && f.type === "error");
out.denied = { id: denied.id, errorText: denied.errorText, code: denied.error?.code };

ws.close();
out.stop = await call("pi_remote_stop").then(() => true).catch(() => false);
await browser.close();
console.log(JSON.stringify(out, null, 2));
