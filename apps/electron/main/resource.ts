/**
 * 资源管理器（对齐 resource.rs）：进程采样（本 app Chromium 进程 +
 * sidecar/PTY/Chrome 后代链）、存储扫描（仅本应用目录）、白名单清理、
 * reveal、独立窗口（加载 /resource 路由）。
 */
import { app, BrowserWindow, shell } from "electron";
import { execFile } from "node:child_process";
import { existsSync, statfsSync, type Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir, totalmem, freemem, cpus } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  trackWindow,
  getWindow,
  setWatchedSessions,
  isChannelArg,
  makeChannelPusher,
  type CmdCtx,
} from "./ipc";
import { appDataDir, appLogDir, sessionsDir } from "./paths";
import { logInfo, logWarn } from "./logging";
import { piAgentChildPid } from "./pi-agent";

/** 整机 CPU 采样器：保留上一次的 per-core 时间片快照算差值。
 *  不能用 os.loadavg()/核数——在 Apple Silicon 大小核上语义完全不同
 *  （loadavg 是 runnable 队列长度，且核数口径含糊），实测会恒显示 100%。
 *  时间片差值跨全部逻辑核（含 P/E 核）求和，得到真实的整机占用。 */
const cpuTimesSnapshot: { at: number; idle: number; total: number } = { at: 0, idle: 0, total: 0 };

function sampleSystemCpu(): number {
  const cores = cpus();
  let idle = 0;
  let total = 0;
  for (const c of cores) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  const prev = { ...cpuTimesSnapshot };
  cpuTimesSnapshot.at = Date.now();
  cpuTimesSnapshot.idle = idle;
  cpuTimesSnapshot.total = total;
  if (prev.at === 0 || total <= prev.total) return 0; // 首次采样：无差值可算
  const dTotal = total - prev.total;
  const dIdle = idle - prev.idle;
  const busy = 1 - dIdle / dTotal;
  return Math.max(0, Math.min(100, busy * 100));
}

interface PsRow {
  pid: number;
  ppid: number;
  rss: number; // KB
  cpuPct: number; // ps %cpu：单核口径（100% = 一个核跑满）
  comm: string;
}

async function psSnapshot(): Promise<PsRow[]> {
  // Windows 没有 ps（装了 Git Bash 时 PATH 里的 ps.exe 是 MSYS 进程，拉起又慢）：
  // 直接跳过——本 app 进程由 Electron metrics 覆盖，sidecar 树拿不到就不单独归组
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,comm="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((p) => p.length >= 5 && /^\d+$/.test(p[0]))
      .map((p) => ({
        pid: Number(p[0]),
        ppid: Number(p[1]),
        rss: Number(p[2]),
        cpuPct: Number(p[3]) || 0,
        comm: p.slice(4).join(" "),
      }));
  } catch (e: any) {
    logWarn(`[resource] ps failed: ${e?.message ?? e}`);
    return [];
  }
}

/** 后代链（pid → 子孙集合） */
function descendantsOf(rootPid: number, rows: PsRow[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const arr = children.get(r.ppid) ?? [];
    arr.push(r.pid);
    children.set(r.ppid, arr);
  }
  const out = new Set<number>();
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop()!;
    for (const c of children.get(p) ?? []) {
      if (!out.has(c)) {
        out.add(c);
        stack.push(c);
      }
    }
  }
  return out;
}

export async function resourceSample(): Promise<any> {
  const rows = await psSnapshot();
  const byPid = new Map<number, PsRow>(rows.map((r) => [r.pid, r]));
  const now = Date.now();
  const mainPid = process.pid;

  // CPU：Electron metrics 给出各 Chromium 进程 cpu.percentCPUUsage（整机口径百分比）
  const metrics = app.getAppMetrics();
  const chromiumPids = new Set(metrics.map((m) => m.pid));
  chromiumPids.add(mainPid);

  // sidecar + 其工具后代
  const piPid = piAgentPid();
  const piTree = piPid ? new Set<number>([piPid, ...descendantsOf(piPid, rows)]) : new Set<number>();
  // pty 壳进程与后代：所有 ppid 链能触达主进程且不在 chromium/sidecar 集合的进程
  const appPids = new Set<number>([...chromiumPids, ...piTree]);
  const otherTree: PsRow[] = [];
  for (const r of rows) {
    if (appPids.has(r.pid)) continue;
    let p: PsRow | undefined = r;
    let hops = 0;
    let attached = false;
    while (p && hops < 8) {
      if (appPids.has(p.ppid) || piTree.has(p.ppid)) {
        attached = true;
        break;
      }
      p = byPid.get(p.ppid);
      hops++;
    }
    if (attached) otherTree.push(r);
  }

  const cpuCount = cpus().length || 1;
  let appCpu = 0;
  let appMem = 0;
  const groups: any[] = [];

  let kovaCpu = 0;
  let kovaMem = 0;
  for (const m of metrics) {
    kovaCpu += m.cpu?.percentCPUUsage ?? 0;
    kovaMem += (m.memory?.workingSetSize ?? 0) * 1024; // KB → bytes
  }
  appCpu += kovaCpu;
  appMem += kovaMem;
  groups.push({
    id: "kova",
    label: "Kova 应用",
    count: metrics.length + 1,
    cpu: kovaCpu / cpuCount,
    mem: kovaMem,
    processes: metrics.map((m) => ({
      pid: m.pid,
      name: friendlyName(m.type ?? "unknown", m.pid),
      detail: m.type ?? "",
      cpu: (m.cpu?.percentCPUUsage ?? 0) / cpuCount,
      mem: (m.memory?.workingSetSize ?? 0) * 1024,
    })),
  });

  if (piPid && byPid.has(piPid)) {
    const t = collectTree(piTree, byPid, cpuCount);
    appCpu += t.cpu;
    appMem += t.mem;
    groups.push({ id: "pi-agent", label: "AI 运行时", count: t.procs.length, cpu: t.cpu, mem: t.mem, processes: t.procs });
  }

  if (otherTree.length > 0) {
    const t = {
      cpu: otherTree.reduce((s, r) => s + cpuOf(r.pid), 0),
      mem: otherTree.reduce((s, r) => s + r.rss * 1024, 0),
      procs: otherTree.map((r) => ({
        pid: r.pid,
        name: shortName(r.comm),
        detail: r.comm,
        cpu: cpuOf(r.pid),
        mem: r.rss * 1024,
      })),
    };
    appCpu += t.cpu; // t.cpu 已是"占整机"（每进程已除核数）
    appMem += t.mem;
    groups.push({ id: "tools", label: "终端与工具进程", count: t.procs.length, cpu: t.cpu, mem: t.mem, processes: t.procs });
  }

  const cpuTotal = totalmem();
  return {
    tsMs: now,
    appName: app.getName(),
    cpuCount,
    appCpu: appCpu / cpuCount,
    appMem,
    sysCpu: sampleSystemCpu(),
    sysMemUsed: cpuTotal - freemem(),
    sysMemTotal: cpuTotal,
    processCount: groups.reduce((s, g) => s + g.count, 0),
    groups,
  };

  function cpuOf(pid: number): number {
    // ps %cpu 是单核口径（100% = 一个核跑满）：先按核数归一到"占整机"百分比
    const row = byPid.get(pid);
    return row ? row.cpuPct / cpuCount : 0;
  }
}

/** 进程树汇总：cpu 与内存都按"占整机"口径（ps %cpu ÷ 逻辑核数，含大小核） */
function collectTree(tree: Set<number>, byPid: Map<number, PsRow>, cpuCount: number) {
  const procs: any[] = [];
  let cpu = 0;
  let mem = 0;
  for (const pid of tree) {
    const r = byPid.get(pid);
    if (!r) continue;
    const cpuPct = r.cpuPct / cpuCount;
    cpu += cpuPct;
    mem += r.rss * 1024;
    procs.push({ pid: r.pid, name: shortName(r.comm), detail: r.comm, cpu: cpuPct, mem: r.rss * 1024 });
  }
  return { cpu, mem, procs };
}

function shortName(comm: string): string {
  const base = comm.split("/").pop() ?? comm;
  return base.slice(0, 40);
}
function friendlyName(type: string, pid: number): string {
  // app.getAppMetrics() 的 type 取值为 "Browser"/"Tab"/"GPU"/"Utility"/…（大小写不定），
  // 统一小写比较，别按大写匹配（否则 Browser/Tab 全部落 default）
  switch (type.toLowerCase()) {
    case "browser":
    case "main":
      return "主进程";
    case "tab":
    case "renderer":
      return "渲染进程";
    case "gpu":
    case "gpu-process":
      return "GPU 进程";
    case "utility":
      return "服务进程";
    default:
      return `${type} ${pid}`;
  }
}

let piPidResolved: { pid: number | null; at: number } = { pid: null, at: 0 };
function piAgentPid(): number | null {
  if (Date.now() - piPidResolved.at < 2000) return piPidResolved.pid;
  const pid = piAgentChildPid() ?? null;
  piPidResolved = { pid, at: Date.now() };
  return pid;
}

/* ------------------------------ 存储扫描 ------------------------------ */

/**
 * 全部异步分批：每处理一批文件就 setImmediate 让出事件循环。Windows 上逐文件
 * stat 很慢（NTFS 元数据 + Defender 实时扫描），几万个文件的目录同步扫要按住
 * 主进程数秒到数十秒——期间所有窗口一起冻结（2026-11 资源管理器打开卡死即此）。
 */
interface WalkResult {
  bytes: number;
  files: number;
  /** 触到文件数预算：数字偏小 */
  truncated: boolean;
}
const SCAN_BUDGET_FILES = 200_000;
const SCAN_YIELD_EVERY = 200;

async function walkSize(dir: string): Promise<WalkResult> {
  let bytes = 0;
  let files = 0;
  const stack: string[] = [dir];
  let sinceYield = 0;
  while (stack.length > 0 && files < SCAN_BUDGET_FILES) {
    const d = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= SCAN_BUDGET_FILES) break;
      const p = join(d, entry.name);
      // Dirent 已带目录与否；符号链接与竞态仍走 stat 兜底
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      try {
        const st = await fsp.stat(p);
        if (st.isDirectory()) stack.push(p);
        else {
          bytes += st.size;
          files += 1;
        }
      } catch {
        /* 竞态/权限：跳过 */
      }
      sinceYield += 1;
      if (sinceYield >= SCAN_YIELD_EVERY) {
        sinceYield = 0;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
  return { bytes, files, truncated: files >= SCAN_BUDGET_FILES };
}

/** 单路径占用：目录递归走 walkSize，散文件（state.db 这类）直接取大小 */
async function pathBytes(p: string): Promise<{ bytes: number; truncated: boolean }> {
  try {
    const st = await fsp.stat(p);
    if (!st.isDirectory()) return { bytes: st.size, truncated: false };
    const r = await walkSize(p);
    return { bytes: r.bytes, truncated: r.truncated };
  } catch {
    return { bytes: 0, truncated: false };
  }
}

function diskInfo(): { mount: string; total: number; free: number } {
  const mount = appDataDir();
  try {
    const s = statfsSync(mount);
    return { mount, total: Number(s.bsize) * Number(s.blocks), free: Number(s.bsize) * Number(s.bavail) };
  } catch {
    return { mount, total: 0, free: 0 };
  }
}

/** 类目清单：paths() 现算（路径可能尚不存在）；扫描与清理共用同一份白名单 */
interface CategorySpec {
  id: string;
  label: string;
  hint: string;
  cleanable: boolean;
  paths: () => string[];
}

function categorySpecs(data: string): CategorySpec[] {
  return [
    {
      id: "sessions",
      label: "会话记录",
      hint: "对话转录与索引（sessions/*.jsonl + state.db）",
      cleanable: false,
      paths: () => [sessionsDir(), join(data, "state.db")].filter(isReal),
    },
    {
      id: "workspace",
      label: "任务产物",
      hint: "无目录任务的产物文件（task-workspace/）",
      cleanable: false,
      paths: () => [join(data, "task-workspace")],
    },
    {
      id: "attachments",
      label: "文档附件",
      hint: "粘贴文档中转副本（attachments/）",
      cleanable: false,
      paths: () => [join(data, "attachments")],
    },
    {
      id: "checkpoints",
      label: "Git 检查点",
      hint: "影子 git-dir 检查点（checkpoints/）",
      cleanable: false,
      paths: () => [join(data, "checkpoints")],
    },
    {
      id: "logs",
      label: "磁盘日志",
      hint: "按日归档日志目录",
      cleanable: true,
      paths: () => [appLogDir()],
    },
    {
      id: "browser-cache",
      label: "浏览器缓存",
      hint: "面板浏览器渲染缓存",
      cleanable: true,
      paths: () => [join(data, "browser-panel"), join(app.getPath("userData"), "browser-panel")].filter(isReal),
    },
    {
      id: "model-cache",
      label: "模型调用缓存",
      hint: "请求级缓存（~/.kova cache）",
      cleanable: true,
      paths: () => [join(homedir(), ".kova", "cache")].filter(isReal),
    },
  ];
}

function isReal(p: string): boolean {
  return existsSync(p);
}

export async function resourceStorageScan(args: Record<string, any> = {}, ctx?: CmdCtx): Promise<any> {
  // 渲染层可传 Channel（args.progress）：每完成一个类目推一拍，界面边扫边亮数
  const ch = args?.progress;
  const pushProgress = ctx && isChannelArg(ch) ? makeChannelPusher(ctx.sender, ch) : null;
  const data = appDataDir();
  const specs = categorySpecs(data);
  const cats: any[] = [];
  let total = 0;
  let truncated = false;
  let done = 0;
  for (const spec of specs) {
    const paths = spec.paths();
    let bytes = 0;
    for (const p of paths) {
      const r = await pathBytes(p);
      bytes += r.bytes;
      truncated ||= r.truncated;
    }
    total += bytes;
    const cat = { id: spec.id, label: spec.label, hint: spec.hint, bytes, paths, cleanable: spec.cleanable };
    cats.push(cat);
    done += 1;
    pushProgress?.({ done, total: specs.length, category: cat });
  }
  return {
    tsMs: Date.now(),
    appName: app.getName(),
    dataDir: data,
    totalBytes: total,
    truncated,
    disk: diskInfo(),
    categories: cats,
  };
}

export async function resourceStorageClean(args: { ids?: string[] }): Promise<any> {
  // 按白名单重建类目即可，不再全量重扫一遍（旧实现先完整扫描再删，Windows 上
  // 等于把冻结时间翻倍）；释放量只对被清理的类目现算
  const byId = new Map(categorySpecs(appDataDir()).map((s) => [s.id, s]));
  const entries: any[] = [];
  let freed = 0;
  for (const id of args.ids ?? []) {
    const spec = byId.get(String(id));
    if (!spec || !spec.cleanable) {
      entries.push({ id: String(id), label: String(id), freedBytes: 0, removed: [], failed: ["not-cleanable"] });
      continue;
    }
    let size = 0;
    const removed: string[] = [];
    const failed: string[] = [];
    for (const p of spec.paths()) {
      try {
        const r = await pathBytes(p);
        size += r.bytes;
        // Windows 上文件可能仍被占用：重试几次再判失败
        await fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed.push(p);
      } catch (e: any) {
        failed.push(`${p}: ${e?.message ?? e}`);
      }
    }
    freed += size;
    entries.push({ id, label: spec.label, freedBytes: size, removed, failed });
  }
  return { freedBytes: freed, entries, warnings: [] };
}

export function resourceReveal(args: { path: string }): null {
  // 只放行本应用自己的数据根内路径（对齐 resource.rs 白名单）
  const p = String(args.path ?? "");
  const allowed = [appDataDir(), appLogDir(), join(homedir(), ".kova")];
  if (!allowed.some((root) => p === root || p.startsWith(root + "/") || p.startsWith(root + "\\"))) {
    throw new Error("path-not-allowed");
  }
  void shell.openPath(p);
  return null;
}

/* ------------------------------ 资源窗口 ------------------------------ */

export async function resourceOpenWindow(): Promise<null> {
  const existing = getWindow("resource");
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return null;
  }
  const devUrl = (globalThis as any).__KOVA_DEV_URL as string | undefined; // index.ts 在 --dev 时写入
  const win = new BrowserWindow({
    width: 980,
    height: 640,
    title: "资源管理器",
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  trackWindow("resource", win);
  // 资源窗口不订阅任何 pi 会话：声明空观看集合，主进程不再向它投递逐 token 增量
  setWatchedSessions(win.webContents, []);
  // 诊断可观测性：窗口消失/渲染进程崩溃/加载失败都要留痕（此前静默，无法定位）
  win.on("closed", () => logInfo("[resource] window closed"));
  win.webContents.on("render-process-gone", (_e, details) => {
    logWarn(`[resource] renderer gone: ${details?.reason ?? "unknown"} (exitCode=${details?.exitCode ?? "?"})`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logWarn(`[resource] load failed (${code}): ${desc} — ${url}`);
  });
  // 静态导出路由是 out/resource.html：走 kova://app/resource（协议处理器按
  // 精确→path.html→path/index.html 的顺序命中）；dev 用 Next 路由 URL
  if (devUrl) {
    void win.loadURL(`${devUrl}/resource`).catch((e) => logWarn(`[resource] loadURL failed: ${e?.message ?? e}`));
  } else {
    void win.loadURL("kova://app/resource").catch((e) => logWarn(`[resource] loadURL failed: ${e?.message ?? e}`));
  }
  return null;
}

export function setupResourceCommands(
  register: (name: string, fn: (args: any, ctx: CmdCtx) => any) => void,
): void {
  register("resource_sample", () => resourceSample());
  register("resource_storage_scan", (a, ctx) => resourceStorageScan(a, ctx));
  register("resource_storage_clean", (a) => resourceStorageClean(a));
  register("resource_reveal", (a) => resourceReveal(a));
  register("resource_open_window", () => resourceOpenWindow());
}
