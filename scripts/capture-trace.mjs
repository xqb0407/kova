#!/usr/bin/env node
/**
 * 通过 Chrome DevTools Protocol 抓 Electron 渲染进程的 Performance trace。
 *
 * 为什么需要它：DevTools 的 Performance 面板在保存大 trace 时会把 DevTools
 * 前端自己压白屏（几秒的录制 + CPU profile 很容易到几百 MB）。CDP 直接收
 * Tracing 事件并落盘，不经过 DevTools 的序列化/保存 UI。
 *
 * 用法：
 *   1) 重启 dev 并打开调试端口：
 *        bun run dev -- --remote-debugging-port=9222
 *   2) 另开一个终端录 8 秒（期间在应用里复现卡顿/流式回复）：
 *        node scripts/capture-trace.mjs 8
 *   3) 生成 ./kova-trace-<时间戳>.json；用 DevTools Performance 的
 *      "Load profile" 可以重新打开，也可以直接发给我分析。
 *
 * 环境变量：
 *   KOVA_CDP_PORT    调试端口（默认 9222）
 *   KOVA_CDP_TARGET  按 URL/title 片段指定页面；多窗口或浏览器面板也开着时用，
 *                    不指定则优先应用主窗口（kova:// 或 next dev 的 :3000）。
 */
import { writeFileSync } from "node:fs";

const port = process.env.KOVA_CDP_PORT ?? "9222";
const targetHint = (process.env.KOVA_CDP_TARGET ?? "").trim();
const seconds = Math.max(1, Number(process.argv[2] ?? 8) || 8);
const out = `kova-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

// DevTools Performance 默认采样的核心类别；v8.cpu_profiler 提供 JS 调用栈，
// 没有它就只能看到 RunTask 级别的长任务。
const CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-v8.cpu_profiler",
  "disabled-by-default-v8.cpu_profiler.hires",
  "blink.console",
  "blink.user_timing",
  "loading",
  "latencyInfo",
  "renderer.scheduler",
  "v8",
  "v8.execute",
].join(",");

let endpoints;
try {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  endpoints = await res.json();
} catch (err) {
  console.error(
    `连不上 CDP 端口 ${port}（${String(err?.message ?? err)}）。` +
      "确认 Electron 启动时带了 --remote-debugging-port，且端口没有被别的会话占用。",
  );
  process.exit(1);
}
if (!Array.isArray(endpoints)) {
  console.error(`CDP 端口 ${port} 返回了非预期的目标列表格式。`);
  process.exit(1);
}

const pages = endpoints.filter((t) => {
  const url = String(t.url);
  return (
    t.type === "page" &&
    typeof t.webSocketDebuggerUrl === "string" &&
    !url.startsWith("devtools://") &&
    !/^about:blank/i.test(url) &&
    !/^(chrome|chrome-extension|chrome-error):\/\//i.test(url)
  );
});
const byHint = targetHint
  ? pages.find(
      (t) =>
        String(t.url).includes(targetHint) ||
        String(t.title ?? "").includes(targetHint),
    )
  : undefined;
// 应用主窗口：打包后是 kova://，dev 是 next dev（默认 3000）。浏览器面板
// 的 guest 也可能以 page target 出现，优先主窗口，避免 trace 到被打开的网页。
const appPage = pages.find((t) => {
  const u = String(t.url);
  return (
    u.startsWith("kova://") ||
    /^https?:\/\/(localhost|127\.0\.0\.1):3000(\/|$)/.test(u)
  );
});
const page = targetHint ? byHint : (appPage ?? pages[0]);
if (!page) {
  if (targetHint) {
    console.error(`KOVA_CDP_TARGET=${targetHint} 没有匹配到页面。`);
  } else {
    console.error("没找到可调试的页面。确认启动时带了 --remote-debugging-port。");
  }
  if (pages.length > 0) {
    console.error(
      `候选页面：\n${pages.map((t) => `- ${t.title || "(no title)"} ${t.url}`).join("\n")}`,
    );
  }
  process.exit(1);
}
if (!targetHint && pages.length > 1) {
  console.log(
    `检测到 ${pages.length} 个页面，选中「${page.title || page.url}」。` +
      "可用 KOVA_CDP_TARGET=<url 或 title 片段> 指定。",
  );
}
console.log(`连接 ${page.title || page.url}\n${page.webSocketDebuggerUrl}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
const events = [];
let complete;
const finished = new Promise((resolve) => {
  complete = resolve;
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Tracing.dataCollected") {
    for (const event of msg.params.value) events.push(event);
  } else if (msg.method === "Tracing.tracingComplete") {
    complete();
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

await send("Tracing.start", {
  categories: CATEGORIES,
  options: "record-as-much-as-possible",
});
console.log(`录制中（${seconds}s）——现在去应用里复现卡顿/流式回复…`);

setTimeout(async () => {
  try {
    await send("Tracing.end");
    // tracingComplete 事件可能在 end 响应前后到达：加一个超时兜底
    await Promise.race([finished, new Promise((r) => setTimeout(r, 15_000))]);
    writeFileSync(out, JSON.stringify({ traceEvents: events }));
    console.log(`已保存 ${out}（${events.length} 个事件）`);
  } catch (err) {
    console.error("录制失败：", err);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
}, seconds * 1000);
