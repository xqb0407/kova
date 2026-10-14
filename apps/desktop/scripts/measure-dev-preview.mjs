/**
 * 用无头 Chrome 真实时间跑一个 dev-preview 页面，取回它写进
 * [data-slot="diag"] 的报告。给「渲染成本」这类只能实测的问题用。
 *
 * 为什么不直接用 --dump-dom --virtual-time-budget：
 *   虚拟时间会把 performance.now() 一起虚拟化，而 React 的 Profiler 内部就用
 *   它算 actualDuration —— 读数会全变成 0.00ms（本文件就是这么被坑出来的）。
 *   所以这里走 CDP，等真实时间跑完再取。
 *
 * 用法：
 *   cd apps/desktop && bun run dev        # 另开一个终端
 *   bun scripts/measure-dev-preview.mjs \
 *     "http://localhost:3000/dev-preview/long-turn?steps=800&chunks=30&mode=fresh" 90
 *
 * 第二个参数是等待秒数（默认 90）。报告要到出现「已结束」为止，或超时。
 */

const url = process.argv[2];
const timeoutSec = Number(process.argv[3] ?? 90);
if (!url) {
  console.error("用法：bun scripts/measure-dev-preview.mjs <url> [超时秒]");
  process.exit(1);
}

const PORT = 9222;
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = `/tmp/dev-preview-profile-${Date.now()}`;

const chrome = Bun.spawn(
  [
    CHROME,
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    `--user-data-dir=${profile}`,
    url,
  ],
  { stdout: "ignore", stderr: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await res.json();
    return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? null;
  } catch {
    return null;
  }
}

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  target = await findTarget();
  if (!target) await sleep(500);
}
if (!target) {
  console.error("找不到调试目标（Chrome 没起来？）");
  chrome.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("ws 连接失败"));
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id !== undefined) pending.get(msg.id)?.(msg.result);
};
const send = (method, params) => {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
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
const deadline = Date.now() + timeoutSec * 1000;
while (Date.now() < deadline) {
  await sleep(700);
  report = await readReport();
  if (report.includes("已结束")) break;
}

console.log(report || "(没拿到报告)");
ws.close();
chrome.kill();
process.exit(0);
