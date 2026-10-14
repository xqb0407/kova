#!/usr/bin/env node
/**
 * 一键开发模式（仓库根 `bun run dev`）——三层各自的热更新策略：
 *
 *   渲染层  apps/desktop 的 `next dev`（:3000，HMR）→ 改前端代码即时生效，不用重启
 *   主进程  apps/electron 的 esbuild --watch → dist/*.cjs 变更后**自动重启 Electron**
 *           （主进程没法热更，只能换进程；重启约 1s）
 *   侧车    直接跑 src/index.ts（`bun --watch`）→ 改 sidecar 源码**原地重启**，
 *           不必编 87MB 单文件、也不重启 app
 *
 * 为什么侧车走源码：编译产物单文件 87MB、每次构建 ~40s，且 bun --compile 的产物
 * 在 macOS 上还要额外重签（见 PORTING-NOTES「侧车二进制的 macOS 签名坑」）。
 * 开发期跑源码等价（同一条 bun 运行时、同一套 env），只有分发才需要编译。
 *
 * 开关：
 *   KOVA_DEV_BINARY=1  用编译好的侧车二进制（apps/electron/binaries/kova-worker）（先确保已构建；验产物行为时用）
 *   KOVA_DEV_URL=…     渲染层地址（默认 http://localhost:3000）
 *   KOVA_DATA_DIR=…    数据目录（默认 dev 渠道库；换沙箱可避免与常开实例抢单实例锁）
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = join(root, "apps", "electron");
const sidecarDir = join(root, "apps", "sidecar", "pi-agent");
const devUrl = process.env.KOVA_DEV_URL ?? "http://localhost:3000";
const argv = process.argv.slice(2);
const useBinary = process.env.KOVA_DEV_BINARY === "1" || argv.includes("--binary");
/** 透传给 Electron 的额外参数（`bun run dev -- --remote-debugging-port=9222`） */
const electronArgs = argv.filter((a) => a !== "--binary" && !a.startsWith("--binary="));

const children = [];
let electron = null;
let appReadyAt = 0; // 见到应用自己的 "electron shell ready" 之后，构建播报才算「改动」
let restarting = false;
let shuttingDown = false;

const log = (msg) => console.log(`[dev] ${msg}`);

function track(proc) {
  children.push(proc);
  return proc;
}

/** 关停顺序：先 Electron，再 watch/next（它们都是我们要收掉的） */
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("收尾：关闭 Electron 与后台进程…");
  for (const p of [electron, ...children]) {
    try {
      p?.kill("SIGTERM");
    } catch {
      /* 已退出 */
    }
  }
  setTimeout(() => {
    for (const p of [electron, ...children]) {
      try {
        p?.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
    process.exit(code);
  }, 1500).unref();
}

async function reachable(url, timeoutMs = 800) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

async function waitForUrl(url, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let logged = false;
  while (Date.now() < deadline) {
    if (await reachable(url)) return true;
    if (!logged) {
      log(`等待 ${label} ${url} 就绪…（首次编译较慢）`);
      logged = true;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function launchElectron(extraEnv) {
  const bin = join(electronDir, "node_modules", ".bin", "electron");
  const proc = spawn(bin, [".", "--dev", ...electronArgs], {
    cwd: electronDir,
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  // 就绪判定两个流都看：应用日志走 stdout 还是 stderr 取决于 logger 实现，
  // 只挂一个流漏掉就会让"改动→重启"永久失效
  const noteLine = (line) => {
    if (line.includes("electron shell ready") && !appReadyAt) appReadyAt = Date.now();
  };
  createInterface({ input: proc.stdout }).on("line", (line) => {
    console.log(line);
    noteLine(line);
  });
  createInterface({ input: proc.stderr }).on("line", (line) => {
    console.error(line);
    noteLine(line);
  });
  proc.on("exit", (code) => {
    if (restarting || shuttingDown) return;
    log(`Electron 已退出（code=${code}）——dev 会话结束`);
    shutdown(code ?? 0);
  });
  return proc;
}

async function restartElectron() {
  if (shuttingDown) return;
  restarting = true;
  appReadyAt = 0; // 新实例的就绪位从头算
  log("主进程产物变更 → 重启 Electron");
  const old = electron;
  electron = null;
  await new Promise((resolve) => {
    if (!old) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // 单实例锁要等旧进程真正退出才释放；立刻拉起新实例会「启动即退出」
      setTimeout(resolve, 300);
    };
    old.once("exit", finish);
    try {
      old.kill("SIGTERM");
    } catch {
      finish();
    }
    setTimeout(finish, 4000); // 兜底：进程僵住也不能卡住 dev
  });
  electron = launchElectron(envForElectron);
  restarting = false;
}

/* ------------------------------ 0) 前置 ------------------------------ */
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (!existsSync(join(electronDir, "dist", "main.cjs"))) {
  log("dist/main.cjs 尚未构建：先跑一次构建");
}

/* --------------------------- 1) 侧车（源码模式） --------------------------- */
let envForElectron = {};
if (useBinary) {
  const bin = join(electronDir, "binaries", "pi-agent");
  if (!existsSync(bin)) {
    log("KOVA_DEV_BINARY=1 但二进制不存在：先 `bun run build:sidecar`");
    process.exit(1);
  }
  log(`侧车：使用编译产物 ${bin}`);
} else {
  // 插件包是 sidecar 构建产物（不入库），源码模式同样需要它
  const plugins = track(
    spawn("node", [join(root, "scripts", "build-plugins.mjs")], {
      cwd: root,
      stdio: "inherit",
    }),
  );
  await new Promise((r) => plugins.on("exit", r));

  const wrapperDir = join(tmpdir(), `kova-dev-${process.pid}`);
  mkdirSync(wrapperDir, { recursive: true });
  const wrapper = join(wrapperDir, "kova-worker");
  writeFileSync(
    wrapper,
    `#!/bin/bash\n# dev.mjs 生成的临时包装：宿主经 KOVA_WORKER_BIN 拉起它，改源码即原地重启\ncd ${JSON.stringify(sidecarDir)} || exit 1\nexec bun --watch src/index.ts\n`,
  );
  chmodSync(wrapper, 0o755);
  const cleanupWrapper = () => rmSync(wrapperDir, { recursive: true, force: true });
  process.on("exit", cleanupWrapper);
  envForElectron.KOVA_WORKER_BIN = wrapper;
  log("侧车：源码模式（bun --watch，改 apps/sidecar 源码即时重启）");
}

/* ---------------------------- 2) 渲染层 next dev ---------------------------- */
if (await reachable(devUrl)) {
  log(`渲染层：复用已在运行的 ${devUrl}`);
} else {
  track(
    spawn("bun", ["run", "--filter", "desktop", "dev"], { cwd: root, stdio: "inherit" }),
  );
  if (!(await waitForUrl(devUrl, "next dev"))) {
    log(`✗ next dev 未在超时内就绪（${devUrl}）`);
    shutdown(1);
    process.exit(1);
  }
  log(`渲染层：${devUrl}（HMR 已就绪）`);
}

/* --------------------------- 3) 主进程 watch --------------------------- */
let rebuilds = 0; // 构建器每次重建播报一行；据此判定"初次构建"还是"改动后重建"
let baselineRebuilds = 0; // Electron 拉起前的构建都算基线
let debounce = null; // 重建事件去抖（构建器一次改动可能连报两行：main + preload）
const watcher = spawn("node", [join(electronDir, "scripts", "build.mjs"), "--watch"], {
  cwd: electronDir,
  stdio: ["inherit", "pipe", "inherit"],
});
track(watcher);
let watcherReady = false;
createInterface({ input: watcher.stdout }).on("line", (line) => {
  console.log(line);
  if (line.includes("[build] watch ready")) {
    watcherReady = true;
    return;
  }
  if (!line.includes("[build] rebuilt")) return;
  rebuilds += 1;
  // 应用尚未就绪（或刚就绪不到 1s）时的播报一律重取基线：esbuild 首次 listen
  // 之后的自触发重建会晚于 watch ready 到达，不重取基线就会在启动期白重启一次
  if (!appReadyAt || Date.now() - appReadyAt < 1000) {
    baselineRebuilds = rebuilds;
    return;
  }
  if (rebuilds <= baselineRebuilds) return; // 初次构建：不算改动
  clearTimeout(debounce);
  debounce = setTimeout(() => void restartElectron(), 250);
});
// 等初次构建真正结束（dist 可能还是上一轮的旧文件，只看文件存在会竞争）
for (let i = 0; i < 100 && !watcherReady; i++) await new Promise((r) => setTimeout(r, 200));
const distDir = join(electronDir, "dist");
for (const f of ["main.cjs", "preload.cjs"]) {
  while (!existsSync(join(distDir, f))) await new Promise((r) => setTimeout(r, 200));
}

/* --------------------------- 4) 拉起 Electron --------------------------- */
electron = launchElectron(envForElectron);

baselineRebuilds = rebuilds; // 以拉起时刻的计数为基线：此前的构建（含初次）都不算改动

log("就绪：改前端即时生效(HMR)；改主进程自动重启；改侧车源码自动重启；Ctrl-C 全部退出");
