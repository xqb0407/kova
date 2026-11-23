/**
 * 用无头 Chrome 真实时间跑一个 dev-preview 页面，取回它写进
 * [data-slot="diag"] 的报告。给「渲染成本」这类只能实测的问题用。
 *
 * 为什么不直接用 --dump-dom --virtual-time-budget：
 *   虚拟时间会把 performance.now() 一起虚拟化，而 React 的 Profiler 内部就用
 *   它算 actualDuration —— 读数会全变成 0.00ms（本文件就是这么被坑出来的）。
 *   所以这里走 CDP，等真实时间跑完再取。
 *
 * 端口：默认让 Chrome 自己选（--remote-debugging-port=0），从 profile 里的
 *   DevToolsActivePort 读实际端口。不要写死 9222——另一个会话的 Chrome /
 *   Electron 占着 9222 时，第二个 Chrome 绑不上端口，脚本会静默连到别人的
 *   页面。调试时可用 KOVA_CDP_PORT 显式指定（需自行保证端口空闲）。
 *
 * 用法：
 *   cd apps/desktop && bun run dev        # 另开一个终端
 *   bun scripts/measure-dev-preview.mjs \
 *     "http://localhost:3000/dev-preview/long-turn?steps=800&chunks=30&mode=fresh" 90
 *
 * 第二个参数是等待秒数（默认 90）。报告要到出现「已结束」为止，或超时。
 * 拿到报告退出码 0，没拿到（含 CDP 错误）退出码 1。
 */
import { readFileSync, rmSync } from "node:fs";

const url = process.argv[2];
const timeoutSec = Math.max(1, Number(process.argv[3] ?? 90) || 90);
if (!url) {
  console.error("用法：bun scripts/measure-dev-preview.mjs <url> [超时秒]");
  process.exit(1);
}

const requestedPort = Number(process.env.KOVA_CDP_PORT ?? 0);
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = `/tmp/dev-preview-profile-${Date.now()}-${process.pid}`;

const chrome = Bun.spawn(
  [
    CHROME,
    "--headless=new",
    `--remote-debugging-port=${Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 0}`,
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    `--user-data-dir=${profile}`,
    url,
  ],
  { stdout: "ignore", stderr: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopped = false;
async function stopChrome() {
  if (stopped) return;
  stopped = true;
  try {
    chrome.kill();
  } catch {
    /* 已退出 */
  }
  await Promise.race([chrome.exited, sleep(2_000)]).catch(() => undefined);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* profile 可能还被 Chrome 占着：留到系统清理 */
  }
}

async function readPort() {
  if (Number.isInteger(requestedPort) && requestedPort > 0) return requestedPort;
  const file = `${profile}/DevToolsActivePort`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      /* Chrome 还没写出文件 */
    }
    if (chrome.exitCode !== null) return null;
    await sleep(100);
  }
  return null;
}

const port = await readPort();
if (!port) {
  console.error("Chrome 没有写出 DevToolsActivePort（启动失败？检查 CHROME_PATH）");
  await stopChrome();
  process.exit(1);
}

function samePage(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.origin === ub.origin &&
      ua.pathname === ub.pathname &&
      ua.search === ub.search
    );
  } catch {
    return String(a) === String(b);
  }
}

async function findTarget() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) return { target: null, candidates: [], error: `HTTP ${res.status}` };
    const list = await res.json();
    const pages = list.filter(
      (t) =>
        t.type === "page" &&
        typeof t.webSocketDebuggerUrl === "string" &&
        !String(t.url).startsWith("devtools://"),
    );
    const exact = pages.find((t) => samePage(t.url, url));
    if (exact) return { target: exact, candidates: pages };
    // 允许服务端/客户端跳转：只有候选唯一时才兜底，避免连到别的会话。
    const httpPages = pages.filter((t) => /^https?:/i.test(String(t.url)));
    if (httpPages.length === 1) return { target: httpPages[0], candidates: pages };
    return { target: null, candidates: pages };
  } catch (err) {
    return { target: null, candidates: [], error: String(err?.message ?? err) };
  }
}

let target = null;
let candidates = [];
let lastError = "";
for (let i = 0; i < 100 && !target; i += 1) {
  const found = await findTarget();
  target = found.target;
  candidates = found.candidates;
  lastError = found.error ?? "";
  if (!target) await sleep(200);
}
if (!target) {
  console.error("找不到调试目标（Chrome 没起来，或页面已跳到别的 URL）");
  if (candidates.length > 0) {
    console.error(
      `候选页面：\n${candidates
        .map((t) => `- ${t.title || "(no title)"} ${t.url}`)
        .join("\n")}`,
    );
  } else if (lastError) {
    console.error(`CDP 错误：${lastError}`);
  }
  await stopChrome();
  process.exit(1);
}
console.log(`连接 ${target.title || target.url}\n${target.webSocketDebuggerUrl}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let openError = null;
await new Promise((resolve) => {
  const timer = setTimeout(() => {
    openError = new Error("ws 连接超时");
    resolve();
  }, 5_000);
  ws.onopen = () => {
    clearTimeout(timer);
    resolve();
  };
  ws.onerror = () => {
    clearTimeout(timer);
    openError = new Error("ws 连接失败");
    resolve();
  };
});
if (openError) {
  console.error(openError.message);
  await stopChrome();
  process.exit(1);
}

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id === undefined) return;
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
  else entry.resolve(msg.result);
};
ws.onclose = () => {
  for (const entry of pending.values()) {
    entry.reject(new Error("CDP 连接已关闭"));
  }
  pending.clear();
};
const send = (method, params = {}) => {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
};

const readReport = async () => {
  const r = await send("Runtime.evaluate", {
    expression:
      "document.querySelector('[data-slot=\"diag\"]')?.textContent ?? ''",
    returnByValue: true,
  });
  return r?.result?.value ?? "";
};

let report = "";
let lastReadError = "";
const deadline = Date.now() + timeoutSec * 1000;
while (Date.now() < deadline) {
  await sleep(700);
  try {
    report = await readReport();
    lastReadError = "";
    if (report.includes("已结束")) break;
  } catch (err) {
    lastReadError = String(err?.message ?? err);
  }
}

if (report) {
  console.log(report);
} else {
  if (lastReadError) console.error(`读取报告失败：${lastReadError}`);
  console.log("(没拿到报告)");
}
ws.close();
await stopChrome();
process.exit(report ? 0 : 1);
