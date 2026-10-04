#!/usr/bin/env bun
/**
 * 性能采样脚本（性能迭代计划 · 迭代 0）：
 *   bun scripts/perf-sample.mjs [label] [--interval 2] [--duration 0]
 *
 * 每 interval 秒采一次目标进程 RSS，写 perf-samples/<日期>-<label>.csv。
 * 角色划分（macOS）：
 *   sidecar    pi-agent（bun 编译产物）
 *   app        Tauri 主进程（kova / 扣瓦.app）
 *   webview    WebKit WebContent 进程；macOS 上父进程都是 launchd，无法按
 *              父子链归因。启发式：取"启动时间不早于主 App"的 WebContent 中
 *              RSS 最大者（WKWebView 进程随窗口创建而 spawn）；仍存疑时用
 *              --webview-pid 手动钉死。
 * 场景化采法：跑附录 A 场景前 `label=run-<场景名>` 启动，场景结束 Ctrl-C。
 */
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
let label = "run";
let intervalSec = 2;
let durationSec = 0; // 0 = 一直采直到 Ctrl-C
let pinnedWebviewPid = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--interval") intervalSec = Number(args[++i]);
  else if (args[i] === "--duration") durationSec = Number(args[++i]);
  else if (args[i] === "--webview-pid") pinnedWebviewPid = Number(args[++i]);
  else label = args[i];
}

const isMac = process.platform === "darwin";
if (!isMac) {
  console.error(
    `perf-sample: 暂只支持 macOS（当前 ${process.platform}）。` +
      "Windows 可用 typeperf/Get-Process 等价实现，留待迭代 3b。",
  );
  process.exit(1);
}

const ROLE_MATCHERS = [
  { role: "sidecar", test: (comm) => comm.endsWith("/pi-agent") },
  {
    role: "app",
    test: (comm) =>
      /kova$/i.test(comm) || /扣瓦(\.app)?\/.*MacOS\//.test(comm),
  },
  {
    role: "webview",
    test: (comm) => comm.includes("com.apple.WebKit.WebContent"),
  },
];

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** ps lstart（"Sat Sep 12 15:14:57 2026"，本地时区）→ epoch ms */
function parseLstart(s) {
  const m = s.match(/^\w+ (\w+) +(\d+) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/);
  if (!m) return 0;
  return new Date(
    Number(m[6]), MONTHS[m[1]] ?? 0, Number(m[2]),
    Number(m[3]), Number(m[4]), Number(m[5]),
  ).getTime();
}

function sample() {
  // rss 单位 KB；comm 取完整路径避免截断误配
  const out = Bun.spawnSync(
    ["ps", "-axo", "pid=,rss=,lstart=,comm="],
    { stdout: "pipe" },
  ).stdout.toString();
  const rows = [];
  let appStartEpoch = 0;
  const webContents = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+ \d{4})\s+(.+)$/);
    if (!m) continue;
    const [, pidS, rssS, lstart, comm] = m;
    const pid = Number(pidS);
    const rss = Number(rssS);
    for (const { role, test } of ROLE_MATCHERS) {
      if (!test(comm)) continue;
      if (role === "webview") {
        webContents.push({ pid, rss, started: parseLstart(lstart) });
      } else {
        rows.push({ pid, role, rss });
        if (role === "app") appStartEpoch = parseLstart(lstart);
      }
      break;
    }
  }
  // webview 归因：钉死 > （启动不早于主 App 的）RSS 最大者
  const candidates = pinnedWebviewPid
    ? webContents.filter((w) => w.pid === pinnedWebviewPid)
    : webContents.filter((w) => !appStartEpoch || w.started >= appStartEpoch - 2000);
  candidates.sort((a, b) => b.rss - a.rss);
  if (candidates[0]) {
    rows.push({ pid: candidates[0].pid, role: "webview", rss: candidates[0].rss });
  }
  return rows;
}

mkdirSync("perf-samples", { recursive: true });
const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const file = `perf-samples/${date}-${label}.csv`;
const lines = ["ts,pid,role,rss_kb"];
console.log(`采样 → ${file}（间隔 ${intervalSec}s，Ctrl-C 结束）`);

let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  writeFileSync(file, lines.join("\n") + "\n");
  console.log(`已写 ${lines.length - 1} 条样本 → ${file}`);
  process.exit(0);
};
process.on("SIGINT", stop);

const t0 = Date.now();
while (!stopped) {
  const ts = new Date().toISOString();
  for (const r of sample()) {
    lines.push(`${ts},${r.pid},${r.role},${r.rss}`);
    process.stdout.write(`${ts.slice(11, 19)} ${r.role.padEnd(8)} pid=${r.pid} RSS=${(r.rss / 1024).toFixed(1)}MB\n`);
  }
  if (durationSec > 0 && (Date.now() - t0) / 1000 >= durationSec) stop();
  await Bun.sleep(intervalSec * 1000);
}
