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
 *   KOVA_DEV_BINARY=1  用编译好的侧车二进制（apps/electron/binaries/kova-worker(.exe)）（先确保已构建；验产物行为时用）
 *   KOVA_DEV_URL=…     渲染层地址（默认 http://localhost:3000）
 *   KOVA_DATA_DIR=…    数据目录（默认 dev 渠道库；换沙箱可避免与常开实例抢单实例锁）
 */
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
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

const isWin = process.platform === "win32";

function track(proc) {
  children.push(proc);
  return proc;
}

/**
 * 结束整棵进程树。
 *
 * Windows 上 child.kill() 只结束直接子进程（TerminateProcess，不给清理机会），
 * Electron 拉起的侧车（bun --watch）会变成孤儿继续握着 SQLite；下次启动就会出现
 * 两个侧车/端口被占。taskkill /T 连整棵树一起收。
 */
function killTree(pid) {
  if (!pid) return;
  if (isWin) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 10_000,
      });
    } catch {
      /* 已退出或无权 */
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出或无权 */
  }
}

/** Windows 进程快照（短缓存：启动期连续三处判定共用一次枚举） */
let winTableAt = 0;
let winTableCache = [];
function winProcesses() {
  if (Date.now() - winTableAt < 500) return winTableCache;
  winTableAt = Date.now();
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const rows = JSON.parse(out || "[]");
    winTableCache = (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      pid: r.ProcessId,
      ppid: r.ParentProcessId,
      name: String(r.Name ?? ""),
      cmd: String(r.CommandLine ?? ""),
    }));
  } catch {
    winTableCache = [];
  }
  return winTableCache;
}

/** 监听指定端口的 PID（Windows 走 Get-NetTCPConnection；POSIX 走 lsof） */
function listeningPids(port) {
  const pids = new Set();
  if (isWin) {
    try {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
        ],
        { encoding: "utf8" },
      );
      for (const raw of out.split(/\s+/).filter(Boolean)) pids.add(Number(raw));
    } catch {
      /* 端口空闲/查询失败 */
    }
    return [...pids];
  }
  try {
    const out = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" },
    );
    for (const raw of out.split(/\s+/).filter(Boolean)) pids.add(Number(raw));
  } catch {
    /* 端口空闲/lsof 不可用 */
  }
  return [...pids];
}

/**
 * 进程是否仍挂在一个活着的 dev 会话下（dev.mjs 或它拉起的 Electron）。
 *
 * Windows 没有 ppid=1 语义：父进程死了 ppid 仍指向旧 PID，只能沿父链找活会话。
 * 找不到 → 上一次会话遗留的孤儿，可以回收；找到 → 另一套 dev 正在用，不动。
 */
function hasLiveSessionAncestor(pid, table) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const seen = new Set();
  let cur = byPid.get(pid);
  while (cur && !seen.has(cur.pid) && seen.size < 64) {
    seen.add(cur.pid);
    if (cur.pid !== process.pid) {
      if (/scripts[\\/]dev\.mjs/.test(cur.cmd)) return true;
      if (/electron/i.test(cur.name) && cur.cmd.includes("--dev")) return true;
    }
    cur = byPid.get(cur.ppid);
  }
  return false;
}

/** 关停顺序：先 Electron，再 watch/next（它们都是我们要收掉的） */
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("收尾：关闭 Electron 与后台进程…");
  for (const p of [electron, ...children]) {
    if (!p?.pid || p.exitCode !== null) continue;
    if (isWin) {
      // Ctrl-C 在 Windows 上不替我们收子进程：Electron 被强杀后它拉起的侧车
      // 还在跑（握着 dev 库），下次启动就会撞锁/白屏。这里按树收干净。
      killTree(p.pid);
      continue;
    }
    try {
      p.kill("SIGTERM");
    } catch {
      /* 已退出 */
    }
  }
  if (isWin) {
    process.exit(code);
    return;
  }
  setTimeout(() => {
    for (const p of [electron, ...children]) {
      if (!p?.pid || p.exitCode !== null) continue;
      try {
        p.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
    process.exit(code);
  }, 1500).unref();
}

/**
 * 渲染层健康检查：必须真的回一个非空 2xx，而不只是 TCP 连上。
 *
 * 僵尸 next-server（父会话消失、写日志抛 EPIPE 后陷入 uncaughtException 循环）
 * 仍然占着端口、也接受连接，但请求永远不返回；只看 fetch 是否 resolve 会把
 * 它误判成"可复用"，Electron 加载后就是白屏。
 */
async function healthy(url, timeoutMs = 800) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = await res.text();
    return body.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 回收僵死的渲染层 next 进程。
 *
 * 场景（今天复现过三次的坑）：上一个 dev 会话被强杀/退出不干净，留下一个
 * "活着但不服务"的 next-server——端口探测不通（走不到复用分支），但 Next 的
 * 进程锁还在，新 `next dev` 直接报 "Another next dev server is already
 * running" 退出，整个 `bun run dev` 起不来。
 *
 * 判定纪律：
 * - **只在本函数被调用时执行**（调用点已确认 devUrl 探测不通，故此路径上任何
 *   自家 next 进程都属于僵死残留）；
 * - 包装进程（`.../apps/desktop/node_modules/.bin/next dev`）按仓库路径精确
 *   认定；next-server 会改写进程标题、丢路径，改按"占用 devUrl 端口"认定，
 *   且只认 next 系命令行，其他服务绝不误伤。
 */
function reclaimStaleRenderer() {
  const killed = [];
  const kill = (pid, why) => {
    killTree(pid);
    killed.push(`${pid}（${why}）`);
  };

  const port = new URL(devUrl).port || "80";

  // Windows：没有 ps/lsof，改用 CIM 快照 + 端口归属。
  // 只认 next 系命令行，其他服务绝不误伤。
  if (isWin) {
    const table = winProcesses();
    const targets = new Set(listeningPids(port));
    for (const p of table) {
      if (!/next/i.test(p.cmd) && !/next/i.test(p.name)) continue;
      if (p.cmd.includes(root)) targets.add(p.pid);
    }
    for (const pid of targets) {
      const proc = table.find((p) => p.pid === pid);
      if (!proc || !/next/i.test(`${proc.name} ${proc.cmd}`)) continue;
      kill(pid, "本仓 next dev 残留");
    }
    return killed;
  }

  // ① 本仓的 next dev 包装进程：命令行含仓库路径，可精确认定
  try {
    const out = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmd = m[2] ?? "";
      if (cmd.includes("dev.mjs")) continue;
      if (!cmd.includes(root) || !/next/.test(cmd)) continue;
      kill(pid, "本仓 next dev 残留");
    }
  } catch {}

  // ② 占用 devUrl 端口的 next-server（标题被改写、无路径，按端口+命令行认定）
  for (const pid of listeningPids(port)) {
    let cmd = "";
    try {
      cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      }).trim();
    } catch {}
    if (!/next-server|next dev/.test(cmd)) continue;
    kill(pid, `占用 ${port} 的 next-server`);
  }

  return killed;
}

/**
 * 现有渲染层"能回 HTTP 但不能复用"的判定。
 *
 * 典型场景：旧的 dev.mjs 被强杀/终端关闭后，next-server 的 stdout/stderr 管道
 * 断开，之后每次写日志都抛 EPIPE；Next 把它当 uncaughtException 无限重试，
 * 端口还在 listen 但请求永远不返回。另一个信号是 next dev 包装进程被 launchd
 * 收养（ppid=1），说明所属 dev 会话已经不在了。
 *
 * 只认 next 系进程，其他服务绝不误伤。
 */
function devServerUnusable(port) {
  // Windows：没有 lsof，改用"端口归属 + 父链是否还有活着的 dev 会话"判定。
  // 端口在听、命令行是 next，但父链上已经没有 dev.mjs/Electron —— 上一次会话
  // 被强杀留下的僵尸，复用就是白屏；回收后重启。
  if (isWin) {
    const table = winProcesses();
    for (const pid of listeningPids(port)) {
      const proc = table.find((p) => p.pid === pid);
      if (!proc || !/next/i.test(`${proc.name} ${proc.cmd}`)) continue;
      if (!hasLiveSessionAncestor(pid, table)) return true;
    }
    return false;
  }

  let pids = [];
  try {
    pids = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" },
    )
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return false;
  }

  const read = (pid, field) => {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", field], {
        encoding: "utf8",
      }).trim();
    } catch {
      return "";
    }
  };

  for (const pid of pids) {
    if (!/next-server|next dev/.test(read(pid, "command="))) continue;

    // ① 输出管道已断（只剩 ->(none)）
    try {
      const fds = execFileSync("lsof", ["-p", String(pid), "-a", "-d", "1,2"], {
        encoding: "utf8",
      });
      if (fds.includes("->(none)")) return true;
    } catch {}

    // ② 所属 dev 会话已退出：包装进程被 launchd 收养
    const ppid = Number(read(pid, "ppid="));
    if (ppid === 1) return true;
    if (ppid > 1 && /next dev|next-server/.test(read(ppid, "command="))) {
      if (Number(read(ppid, "ppid=")) === 1) return true;
    }
  }

  return false;
}

async function waitForUrl(url, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let logged = false;
  while (Date.now() < deadline) {
    if (await healthy(url)) return true;
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
    if (isWin) {
      // Windows：SIGTERM 不会触发 Electron 的收尾，侧车会成为孤儿；
      // 按进程树收，再拉新实例时不会出现两个侧车抢 dev 库。
      killTree(old.pid);
    } else {
      try {
        old.kill("SIGTERM");
      } catch {
        finish();
      }
    }
    setTimeout(finish, 4000); // 兜底：进程僵住也不能卡住 dev
  });
  electron = launchElectron(envForElectron);
  restarting = false;
}

/* ------------------------------ 0) 前置 ------------------------------ */
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
// 终端被直接关掉时也要收掉子进程，否则 next dev 会被 launchd 收养、
// 输出管道断开后变成 EPIPE 僵尸，下一次 bun dev 会误复用它。
process.on("SIGHUP", () => shutdown(0));

if (!existsSync(join(electronDir, "dist", "main.cjs"))) {
  log("dist/main.cjs 尚未构建：先跑一次构建");
}

/**
 * 回收上一次 dev 会话遗留的侧车孤儿。
 *
 * 侧车由 Electron main 以 `bun --watch src/index.ts` 拉起；dev 会话被强杀
 * （SIGKILL / 终端直接关闭）时 Electron 来不及收子进程，`bun --watch` 的
 * 孙进程会被 launchd 收养（ppid=1）并长期驻留——每个约 100MB+，还会握着
 * dev 数据目录的 SQLite。判定三件事同时成立才杀：ppid=1、cwd 是本仓
 * sidecar 目录、命令是 bun --watch src/index.ts。正在跑的 dev 会话里的
 * 侧车有活父进程，不会命中。
 */
function reclaimStaleSidecars() {
  const killed = [];

  // Windows：没有 ppid=1/lsof，按"命令行 + 父链是否还有活着的 dev 会话"认定。
  // 侧车是 Electron 的子进程，父链断了就是上一次会话的孤儿。
  if (isWin) {
    const table = winProcesses();
    for (const p of table) {
      if (!/^bun(\.exe)?$/i.test(p.name)) continue;
      if (!p.cmd.includes("--watch") || !p.cmd.includes("src/index.ts")) continue;
      if (hasLiveSessionAncestor(p.pid, table)) continue;
      killTree(p.pid);
      killed.push(p.pid);
    }
    return killed;
  }

  try {
    const out = execFileSync("ps", ["-eo", "pid=,ppid=,command="], {
      encoding: "utf8",
    });
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      const cmd = m[3] ?? "";
      if (ppid !== 1) continue;
      if (
        !cmd.includes("bun") ||
        !cmd.includes("--watch") ||
        !cmd.includes("src/index.ts")
      ) {
        continue;
      }
      let cwdOut = "";
      try {
        cwdOut = execFileSync(
          "lsof",
          ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
          { encoding: "utf8" },
        );
      } catch {
        continue;
      }
      if (!cwdOut.split("\n").includes(`n${sidecarDir}`)) continue;
      try {
        process.kill(pid, "SIGKILL");
        killed.push(pid);
      } catch {
        /* 已退出或无权 */
      }
    }
  } catch {
    /* ps/lsof 不可用：跳过回收，不影响启动 */
  }
  return killed;
}

/* --------------------------- 1) 侧车（源码模式） --------------------------- */
const staleSidecars = reclaimStaleSidecars();
if (staleSidecars.length > 0) {
  log(`侧车：回收上次会话遗留的孤儿进程 ${staleSidecars.join("、")}`);
}
let envForElectron = {};
if (useBinary) {
  const binNames =
    process.platform === "win32"
      ? ["kova-worker.exe", "kova-worker"]
      : ["kova-worker"];
  const bin = binNames
    .map((n) => join(electronDir, "binaries", n))
    .find((p) => existsSync(p));
  if (!bin) {
    log("KOVA_DEV_BINARY=1 但二进制不存在：先 `bun run build:sidecar`");
    process.exit(1);
  }
  log(`侧车：使用编译产物 ${bin}`);
} else {
  // 源码模式不再生成 bash 包装脚本：Windows 上无扩展名的 bash 文件不能被
  // spawn 执行（ENOENT）。直接把 Bun 本体、参数和工作目录交给宿主
  // （main/pi-agent.ts 读取 KOVA_WORKER_ARGS / KOVA_WORKER_CWD）。
  envForElectron.KOVA_WORKER_BIN = process.execPath;
  envForElectron.KOVA_WORKER_ARGS = JSON.stringify(["--watch", "src/index.ts"]);
  envForElectron.KOVA_WORKER_CWD = sidecarDir;
  // 源码模式没有重建 kova-automation：强制 sidecar 走进程内调度，
  // 避免主进程拉起旧二进制、sidecar 却跑新源码的两套调度器。
  envForElectron.KOVA_AUTOMATION_INPROC = "1";
  log("侧车：源码模式（bun --watch，改 apps/sidecar 源码即时重启）");
}

/* ---------------------- 1.4) 更新日志（CHANGELOG → TS） ---------------------- */
// 设置页 / 升级弹窗读的是生成文件；改了 CHANGELOG.md 后 dev 启动时同步一次。
// 失败只告警：日志旧一点不影响开发，构建时还会再生成。
try {
  execFileSync("node", [join(root, "scripts", "build-changelog.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
} catch {
  log("更新日志生成失败：设置页可能显示旧数据");
}

/* ------------------------- 1.5) 非默认字体资源 ------------------------- */
// 首屏只加载 Geist；其余字体 CSS/woff2 由 build-fonts 复制到 public/fonts，
// FontCssLoader 在选中时才注入。失败只影响字体切换，不阻断 dev。
const fonts = track(
  spawn("node", [join(root, "scripts", "build-fonts.mjs")], {
    cwd: root,
    stdio: "inherit",
  }),
);
const fontsExit = await new Promise((r) => fonts.on("exit", r));
if (fontsExit !== 0) log("非默认字体资源生成失败：字体切换可能回退系统字体");

/* ---------------------------- 2) 渲染层 next dev ---------------------------- */
const rendererPort = new URL(devUrl).port || "80";
// 探测不通 ≠ 没有服务在跑：先给一次长探测（另一端可能正在启动，800ms 探测
// 会误判）；通了还要再排除"端口在听但进程已坏"的孤儿/断管僵尸，否则会复用
// 一个永远不回包的服务，Electron 加载后就是白屏。
const responds = (await healthy(devUrl)) || (await healthy(devUrl, 3_000));
if (responds && !devServerUnusable(rendererPort)) {
  log(`渲染层：复用已在运行的 ${devUrl}`);
} else {
  if (responds) {
    log("渲染层：现有 next dev 已失去父会话/输出管道，回收后重启");
  }
  const reclaimed = reclaimStaleRenderer();
  if (reclaimed.length > 0) {
    log(`渲染层：回收僵死/孤儿进程 ${reclaimed.join("、")}，重新启动`);
    await new Promise((r) => setTimeout(r, 500));
  }
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
// Electron 44 起不再通过 postinstall 下载二进制，bun install 后首次启动前补齐
execFileSync(process.execPath, [join(electronDir, "scripts", "ensure-electron.mjs")], { stdio: "inherit" });
electron = launchElectron(envForElectron);

baselineRebuilds = rebuilds; // 以拉起时刻的计数为基线：此前的构建（含初次）都不算改动

log("就绪：改前端即时生效(HMR)；改主进程自动重启；改侧车源码自动重启；Ctrl-C 全部退出");
