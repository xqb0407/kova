/**
 * 主机工具执行（对齐 tool_exec.rs）：bash / task_output / task_stop / read /
 * write / edit / http / screenshot；read/write/edit 的"读后写"stale 守卫、
 * 输出脱敏、进程组整树杀掉、后台任务归属校验逐条镜像。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unavailableMessage, type SandboxPlan } from "pi-sandbox";
import { envFromResolved, redact, takeResolved, type SecretPair } from "./secret-env";
import {
  isUnavailableBlocking,
  parseSandboxPlan,
  sandboxEnvOverrides,
  wrapSandboxCommand,
  type SandboxBackend,
} from "./sandbox";
import {
  assertNetworkAllowed,
  assertReadAllowed,
  assertWriteAllowed,
  sandboxInfo,
} from "./sandbox/path-guard";
import {
  activeThreadSecrets,
  redactToolResult,
  rememberThreadSecrets,
} from "./secret-redaction";
import { logWarn } from "./logging";
import { resolveShellCommand } from "./shell-resolve";

const MAX_TOOL_OUTPUT = 30 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_TIMEOUT_MS = 600_000;
const READER_JOIN_GRACE_MS = 2_000;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const MAX_HTTP_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES_CAP = 10 * 1024 * 1024;
const READ_STATE_CAP = 4096;
const MAX_BG_OUTPUT = 256 * 1024;
const MAX_BG_TASKS = 32;
const SCREENSHOT_DEFAULT_MAX_DIM = 1920;
const SCREENSHOT_DEFAULT_QUALITY = 70;
const SCREENSHOT_INLINE_BUDGET_BYTES = 1_800_000;

/* --------------------------- 读后写一致性（stale 守卫） --------------------------- */

type ReadStateMap = { hashes: Map<string, string>; order: string[] };
const readState: ReadStateMap = { hashes: new Map(), order: [] };

function contentHash(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function recordContent(full: string, bytes: Buffer): void {
  const fresh = !readState.hashes.has(full);
  readState.hashes.set(full, contentHash(bytes));
  if (fresh) readState.order.push(full);
  while (readState.order.length > READ_STATE_CAP) {
    const old = readState.order.shift();
    if (old !== undefined) readState.hashes.delete(old);
  }
}

function ensureFreshReadBytes(full: string, filePath: string, verb: string, current: Buffer): void {
  const known = readState.hashes.get(full);
  if (known === contentHash(current)) return;
  if (known !== undefined) {
    throw new Error(
      `refusing to ${verb} ${filePath}: it changed since you last read it. Read it again and retry.`,
    );
  }
  throw new Error(
    `refusing to ${verb} ${filePath}: read it first, then retry. (Never overwrite a file you have not read in this session.)`,
  );
}

function ensureFreshRead(full: string, filePath: string, verb: string): void {
  try {
    ensureFreshReadBytes(full, filePath, verb, readFileSync(full));
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("refusing")) throw e;
    // 不存在/不可读：交给真正的写路径报错，守卫不抢答
  }
}

/* ------------------------------ 在飞工具与进程树 ------------------------------ */

interface CancelEntry {
  cancelled: boolean;
  pid?: number;
  /** 发起线程 id（sidecar 随工具信封带，见 envelope.owner）：abort(threadId) 时按它定向取消 */
  owner?: string;
}
const inFlight = new Map<string, CancelEntry>();

class CancelGuard {
  entry: CancelEntry = { cancelled: false };
  constructor(private id: string, owner?: string) {
    this.entry.owner = owner && owner.length > 0 ? owner : undefined;
    if (id) inFlight.set(id, this.entry);
  }
  attachPid(pid: number): void {
    this.entry.pid = pid;
    if (this.entry.cancelled) killTree(pid);
  }
  isCancelled(): boolean {
    return this.entry.cancelled;
  }
  release(): void {
    if (this.id && inFlight.get(this.id) === this.entry) inFlight.delete(this.id);
  }
}

export function cancelTool(id: string): void {
  const entry = inFlight.get(id);
  if (!entry) return; // 已完成/非工具：no-op
  entry.cancelled = true;
  if (entry.pid !== undefined) killTree(entry.pid);
}

/**
 * 按线程取消在飞的前台工具（pi_abort 联动）：用户在界面点"停止"时，光结束模型流
 * 不够——宿主里正在跑的 bash 会继续跑到自身超时（实测 120s 命令会挂满全程）。
 * owner 由 sidecar 随工具信封带上（envelope.owner = 发起线程 id）。
 * threadId=null 表示全局中断 → 收掉全部前台工具；runInBackground 的任务在
 * 独立的 bgTasks 表里，按设计跨回合存活，不受此影响。
 */
export function cancelToolsByOwner(owner: string | null): number {
  let n = 0;
  for (const [id, entry] of [...inFlight]) {
    if (owner !== null && entry.owner !== owner) continue;
    entry.cancelled = true;
    if (entry.pid !== undefined) killTree(entry.pid);
    inFlight.delete(id);
    n += 1;
  }
  return n;
}

export function cancelAllTools(): void {
  for (const entry of inFlight.values()) {
    entry.cancelled = true;
    if (entry.pid !== undefined) killTree(entry.pid);
  }
  inFlight.clear();
}

/** 在飞前台工具数（切换任务产物位置前的忙判定：有工具在跑就不搬目录） */
export function activeToolCount(): number {
  return inFlight.size;
}

export function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      /* ignore */
    }
    return;
  }
  // 负 pid = 整个进程组（detached spawn 后 pgid 即 pid）；组已空时单点兜底
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* ignore */
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* ignore */
  }
}

/* ------------------------------ shell / env 解析 ------------------------------ */

/** git insteadOf 加速 env：白名单键名，非字符串值丢弃（对齐 accel_env） */
function accelEnv(inner: any): Record<string, string> {
  const map = inner?.accelEnv;
  if (!map || typeof map !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k !== "GIT_CONFIG_COUNT" && !k.startsWith("GIT_CONFIG_KEY_") && !k.startsWith("GIT_CONFIG_VALUE_")) continue;
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function strParam(p: any, key: string): string {
  const v = p?.[key];
  if (typeof v !== "string") throw new Error(`missing param: ${key}`);
  return v;
}

function resolvePath(cwd: string, p: string): string {
  if (/^([a-zA-Z]:[\\/]|[\/])/.test(p)) return p;
  return join(cwd, p);
}

function imageMime(filePath: string): string | null {
  const ext = (filePath.split(/[.\\/]/).pop() ?? "").toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  return map[ext] ?? null;
}

/* ------------------------------ 前台 bash ------------------------------ */

async function runBash(
  cwd: string,
  command: string,
  timeoutMs: number,
  guard: CancelGuard,
  secrets: SecretPair[],
  accel: Record<string, string>,
  owner: string,
  sandbox?: SandboxPlan,
): Promise<any> {
  const shell = resolveShellCommand();
  const wrapped = sandbox ? wrapSandboxCommand(command, sandbox) : null;
  if (sandbox && !wrapped && isUnavailableBlocking(sandbox)) {
    throw new Error(unavailableMessage("seatbelt"));
  }
  const backend: SandboxBackend = wrapped?.backend ?? "none";
  const file = wrapped?.file ?? shell.file;
  const args = wrapped?.args ?? [...shell.prefixArgs, command];
  const sandboxEnv = sandboxEnvOverrides(sandbox, backend);
  if (sandboxEnv.TMPDIR) {
    try {
      mkdirSync(sandboxEnv.TMPDIR, { recursive: true });
    } catch {
      /* 目录创建失败交给命令自身报错 */
    }
  }
  const child = spawn(file, args, {
    cwd: cwd || undefined,
    env: { ...process.env, ...envFromResolved(secrets), ...accel, ...sandboxEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  if (child.pid === undefined) throw new Error(`failed to spawn ${file}: no pid`);
  guard.attachPid(child.pid);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let killedByOverflow = false;
  // 纯超时（非输出超限杀进程）：诊断码 timeout_backgrounded/timeout_killed 的
  // 数据源。killedByOverflow 时不置位——输出超限杀进程不是超时。
  let timedOut = false;
  const collect = (buf: Buffer) => {
    if (totalBytes >= MAX_TOOL_OUTPUT) return;
    chunks.push(buf);
    totalBytes += buf.length;
    if (totalBytes >= MAX_TOOL_OUTPUT && !killedByOverflow) {
      killedByOverflow = true;
      killTree(child.pid!);
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const exitState: { done: boolean; code: number | null } = { done: false, code: null };
  const exitPromise = new Promise<void>((res) => {
    child.on("exit", (code) => {
      exitState.done = true;
      exitState.code = code;
      res();
    });
  });

  // 轮询取消/超时（镜像 Rust try_wait 循环：15ms 步进）
  const start = Date.now();
  let cancelled = guard.isCancelled();
  for (;;) {
    if (exitState.done) break;
    if (cancelled) {
      killTree(child.pid!);
      break;
    }
    if (Date.now() - start >= timeoutMs) {
      if (killedByOverflow) {
        // 输出超限已在杀进程（collect 里的 killTree）：进程在死，转后台没意义，
        // 走原有杀路径返回（exitCode 为 null 时的 timeout 文案，历史行为）
        break;
      }
      timedOut = true;
      // 超时不杀：长 build/测试前功尽弃，模型只能原样重跑。降级为后台任务——
      // 已收集的输出与进程都保留，模型稍后 task_output 续读（对齐"显式
      // runInBackground 跨回合存活"的语义；owner 随行，task_output/task_stop
      // 的线程归属检查不受影响）。兜底：转换本身出错才回落旧的杀进程路径。
      try {
        child.stdout?.off("data", collect);
        child.stderr?.off("data", collect);
        const task: BgTask = {
          command,
          pid: child.pid!,
          chunks,
          bytes: totalBytes,
          killed: false,
          running: true,
          exitCode: null,
          secrets,
          owner,
          source: "timeout",
          // 从命令发起算起：台账排序/展示与真实生命周期一致
          startedAt: start,
        };
        const collectBg = (buf: Buffer) => {
          if (task.killed) return;
          task.chunks.push(buf);
          task.bytes += buf.length;
          if (task.bytes > MAX_BG_OUTPUT) {
            let merged = Buffer.concat(task.chunks);
            merged = merged.subarray(merged.length - MAX_BG_OUTPUT);
            task.chunks = [merged];
            task.bytes = merged.length;
          }
        };
        child.stdout?.on("data", collectBg);
        child.stderr?.on("data", collectBg);
        const id = registerBgTask(task);
        watchBgTaskExit(id, task, child);
        guard.release(); // 先出在飞表：线程取消不再误杀这个已后台化的进程
        const out = redact(Buffer.concat(chunks).toString("utf8"), secrets);
        return {
          output:
            `${out}\n[timeout after ${Math.floor(timeoutMs / 1000)}s — the process was NOT killed; ` +
            `it was converted to background task ${id} and keeps running across turns. ` +
            `The output above is partial. Read collected output and status with task_output (taskId=${id}); ` +
            `kill it with task_stop (taskId=${id}) if it is no longer needed.]`,
          taskId: id,
          running: true,
          timedOut: true,
          exitCode: null,
          truncated: false,
          cancelled: false,
          sandbox: sandboxInfo(sandbox, backend),
        };
      } catch (e: any) {
        logWarn(`bash timeout backgrounding failed, falling back to kill: ${e?.message ?? e}`);
        killTree(child.pid!);
        break;
      }
    }
    await Promise.race([exitPromise, sleep(15)]);
    if (guard.isCancelled()) cancelled = true; // 出口兜底：取消优先于超时
  }
  // 等退出与流收尾（上限 2s，对齐 READER_JOIN_GRACE_MS）
  const drainDeadline = Date.now() + READER_JOIN_GRACE_MS;
  while (!exitState.done && Date.now() < drainDeadline) await sleep(20);
  // 给 stdout/stderr close 一点余量收尾尾行
  const closeAll = Promise.all([
    child.stdout ? once(child.stdout, "close") : Promise.resolve(),
    child.stderr ? once(child.stderr, "close") : Promise.resolve(),
  ]);
  await Promise.race([closeAll, sleep(150)]);

  let outBuf = Buffer.concat(chunks);
  let truncated = false;
  if (outBuf.length > MAX_TOOL_OUTPUT) {
    outBuf = outBuf.subarray(0, MAX_TOOL_OUTPUT);
    truncated = true;
  }
  let out = outBuf.toString("utf8");
  const exitCode: number | null = exitState.done ? exitState.code : null;
  // killedByOverflow 的进程也是被杀死的（exitCode=null），但它不是超时——
  // 旧文案说 "timeout after Ns" 会与 timedOut=false 的诊断码直接矛盾，
  // 模型会以为等待更久有用。按真实原因分流文案。
  const status = cancelled
    ? "\n[cancelled]"
    : exitCode === 0
      ? ""
      : exitCode === null
        ? killedByOverflow
          ? `\n[killed: output exceeded the ${Math.floor(MAX_TOOL_OUTPUT / 1024)}KB tool-output cap — the process was stopped mid-run. Its state is unknown; do not assume it completed. Split the work into smaller steps, redirect bulk output to a file and read it with read, or pass runInBackground:true and poll with task_output.]`
          : `\n[timeout after ${Math.floor(timeoutMs / 1000)}s — output above is what was collected before the kill. For long-running commands pass runInBackground:true and poll with task_output, or split the work into shorter steps.]`
        : `\n[exit code: ${exitCode}]`;
  const suffix = truncated ? "\n…[output truncated]" : "";
  const sandboxHint =
    backend === "seatbelt" && exitCode !== null && exitCode !== 0
      ? "\n[sandbox] write isolation is active; 'Operation not permitted' means the path is outside the allowed write roots."
      : "";
  out = redact(out, secrets);
  // Seatbelt 的拒绝通常以 EPERM 文案出现；只在这类失败上标 denied，
  // 避免把 grep 无匹配之类的普通非零退出误标成沙箱拒绝。
  const sandboxDenied =
    backend === "seatbelt" &&
    exitCode !== null &&
    exitCode !== 0 &&
    /Operation not permitted|Permission denied/i.test(out);
  guard.release();
  return {
    output: `${out}${status}${suffix}${sandboxHint}`,
    truncated,
    exitCode,
    cancelled,
    // 超时后杀进程回落（转后台失败）才带 timedOut；输出超限杀进程与用户取消
    // 都不是超时。cancelled 优先：用户中断语义压过超时。
    timedOut: timedOut && !cancelled,
    sandbox: sandboxInfo(sandbox, backend, sandboxDenied ? "write" : undefined),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
function once(emitter: NodeJS.EventEmitter, ev: string): Promise<void> {
  return new Promise((res) => emitter.once(ev, () => res()));
}

/* ------------------------------ 后台 bash 任务 ------------------------------ */

interface BgTask {
  command: string;
  pid: number;
  chunks: Buffer[];
  bytes: number;
  killed: boolean;
  running: boolean;
  exitCode: number | null;
  secrets: SecretPair[];
  owner: string;
  /** explicit = 模型主动 runInBackground；timeout = 超时自动转后台 */
  source: "explicit" | "timeout";
  startedAt: number;
}
const bgTasks = new Map<number, BgTask>();
let bgNextId = 1;

/**
 * 后台任务退出通知（宿主 → sidecar 台账实时回写）。
 *
 * sidecar 只在工具结果落位与轮边界探测时才知道状态：任务若在会话空闲时退出
 * （用户停掉会话后命令自己崩了、被外部 kill、超时后台化的构建结束），没有
 * 下一次探测——header 徽标/快速查看会一直挂着「运行中」，直到下一次对话或
 * 重启。宿主是进程退出的一手信号源，这里提供一条旁路回调让 main 侧把终态
 * 推给 sidecar。未接线或回调抛错都不影响任务表/工具结果。
 */
export type BgTaskExitEvent = {
  taskId: number;
  /** 发起线程 id（工具信封的 owner）：sidecar 台账键 */
  owner: string;
  command: string;
  source: "explicit" | "timeout";
  startedAt: number;
  exitCode: number | null;
  /** 用户/退出流程主动停止（task_stop / stopAllBgTasks） */
  stopped: boolean;
};

let bgTaskExitListener: ((event: BgTaskExitEvent) => void) | null = null;

/** 接线退出通知（main 装配时注册；传 null 退订） */
export function setBgTaskExitListener(
  listener: ((event: BgTaskExitEvent) => void) | null,
): void {
  bgTaskExitListener = listener;
}

/** 登记退出结算：只在拿到 taskId 后调用（通知要带 id） */
function watchBgTaskExit(
  id: number,
  task: BgTask,
  child: ReturnType<typeof spawn>,
): void {
  child.on("exit", (code, signal) => {
    task.exitCode = code === null ? (signal ? null : -1) : code;
    if (code === null && signal) task.exitCode = null;
    task.running = false;
    persistRunningBgTasks();
    if (!bgTaskExitListener || !task.owner) return;
    try {
      bgTaskExitListener({
        taskId: id,
        owner: task.owner,
        command: task.command,
        source: task.source,
        startedAt: task.startedAt,
        exitCode: task.exitCode,
        stopped: task.killed,
      });
    } catch (e: any) {
      logWarn(`background task ${id} exit notify failed: ${e?.message ?? e}`);
    }
  });
}

/** 登记后台任务并分配 id：表满时优先驱逐一条已结束的旧任务（超时降级与显式
 *  runInBackground 共用同一张表、同一套上限） */
function registerBgTask(task: BgTask): number {
  if (bgTasks.size >= MAX_BG_TASKS) {
    let oldestDone: number | null = null;
    for (const [id, t] of bgTasks) {
      if (!t.running) {
        oldestDone = id;
        break;
      }
    }
    if (oldestDone !== null) bgTasks.delete(oldestDone);
  }
  const id = bgNextId++;
  bgTasks.set(id, task);
  persistRunningBgTasks();
  return id;
}

async function runBashBackground(
  cwd: string,
  command: string,
  secrets: SecretPair[],
  accel: Record<string, string>,
  owner: string,
  sandbox?: SandboxPlan,
): Promise<any> {
  const shell = resolveShellCommand();
  const wrapped = sandbox ? wrapSandboxCommand(command, sandbox) : null;
  if (sandbox && !wrapped && isUnavailableBlocking(sandbox)) {
    throw new Error(unavailableMessage("seatbelt"));
  }
  const backend: SandboxBackend = wrapped?.backend ?? "none";
  const file = wrapped?.file ?? shell.file;
  const args = wrapped?.args ?? [...shell.prefixArgs, command];
  const sandboxEnv = sandboxEnvOverrides(sandbox, backend);
  if (sandboxEnv.TMPDIR) {
    try {
      mkdirSync(sandboxEnv.TMPDIR, { recursive: true });
    } catch {
      /* 目录创建失败交给命令自身报错 */
    }
  }
  const child = spawn(file, args, {
    cwd: cwd || undefined,
    env: { ...process.env, ...envFromResolved(secrets), ...accel, ...sandboxEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  if (child.pid === undefined) throw new Error(`failed to spawn ${file}: no pid`);
  const pid = child.pid;

  const task: BgTask = {
    command,
    pid,
    chunks: [],
    bytes: 0,
    killed: false,
    running: true,
    exitCode: null,
    secrets,
    owner,
    source: "explicit",
    startedAt: Date.now(),
  };
  const collect = (buf: Buffer) => {
    if (task.killed) return;
    task.chunks.push(buf);
    task.bytes += buf.length;
    if (task.bytes > MAX_BG_OUTPUT) {
      // 超限丢头部保尾部
      let merged = Buffer.concat(task.chunks);
      merged = merged.subarray(merged.length - MAX_BG_OUTPUT);
      task.chunks = [merged];
      task.bytes = merged.length;
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const id = registerBgTask(task);
  watchBgTaskExit(id, task, child);
  return {
    output:
      `Started in background (task ${id}). The process keeps running across turns and is NOT killed when this turn is cancelled. Use task_output with taskId=${id} to read collected output and check status; use task_stop with taskId=${id} to kill it. Do not poll in a tight loop — do other work first, then check again.`,
    taskId: id,
    sandbox: sandboxInfo(sandbox, backend),
  };
}

/* --------------------------- 退出收尾用的后台任务面 --------------------------- */

export type RunningBgTaskInfo = {
  id: number;
  command: string;
  owner: string;
};

/** 运行中的后台 bash 任务快照（应用退出逐项停止用；不做归属过滤） */
export function listRunningBgTasks(): RunningBgTaskInfo[] {
  const out: RunningBgTaskInfo[] = [];
  for (const [id, task] of bgTasks) {
    if (!task.running) continue;
    out.push({ id, command: task.command, owner: task.owner });
  }
  return out;
}

/** 后台任务全表快照（按发起线程过滤）——sidecar 水合/对账的事实源。
 *  sidecar 内存台账会在重启时清零，宿主这张表才是跨回合存活的真身；
 *  没有这条通道，重启后仍在跑的任务会从 UI 消失（反向地，旧快照也可能
 *  一直挂着「运行中」）。排序与 sidecar 台账一致（startedAt 升序）。 */
export type BgTaskListInfo = {
  taskId: number;
  command: string;
  source: "explicit" | "timeout";
  startedAt: number;
  running: boolean;
  exitCode: number | null;
};

export function listBgTasks(owner?: string): BgTaskListInfo[] {
  const out: BgTaskListInfo[] = [];
  for (const [id, task] of bgTasks) {
    if (owner && task.owner !== owner) continue;
    out.push({
      taskId: id,
      command: task.command,
      source: task.source,
      startedAt: task.startedAt,
      running: task.running,
      exitCode: task.exitCode,
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt || a.taskId - b.taskId);
}

/**
 * 线程键改绑：把某线程名下的后台任务移交给新线程键（刷新后草稿 id → sessionId，
 * 见 sidecar rebindRunThread）。归属检查（task_output/task_stop 只认本线程）
 * 依赖 owner，不改绑的话刷新后探测/停止都会被判「属于别的线程」。
 * 返回移交的任务数；空键/同键 no-op。
 */
export function reownBgTasks(oldOwner: string, newOwner: string): number {
  if (!oldOwner || !newOwner || oldOwner === newOwner) return 0;
  let moved = 0;
  for (const task of bgTasks.values()) {
    if (task.owner !== oldOwner) continue;
    task.owner = newOwner;
    moved += 1;
  }
  return moved;
}

/** 停止单个后台任务：杀整个进程组并标记终态（幂等；已结束的 task 跳过） */
export function stopBgTask(id: number): void {
  const task = bgTasks.get(id);
  if (!task || !task.running) return;
  task.killed = true;
  task.running = false;
  killTree(task.pid);
  persistRunningBgTasks();
}

/** 应用退出兜底：停掉所有仍在运行的后台任务 */
export function stopAllBgTasks(): void {
  for (const id of [...bgTasks.keys()]) stopBgTask(id);
}

/* --------------------- SIGKILL 孤儿清扫（下次启动回收） --------------------- *
 * 正常退出走 stopAllBgTasks；但应用被 SIGKILL/崩溃时后台任务（detached 进程组）
 * 会存活下来，而宿主任务表是内存态——新实例无法发现它们，变成看不见的常驻
 * 进程（还握着任务工作目录的句柄）。这里把运行中任务的 pgid/启动时间持久化到
 * kv，启动时逐项校验回收：pgid 仍存活且进程启动时间与登记一致才杀（防 PID/
 * PGID 复用误杀无关进程）。登记本身有界（最多 32 条运行中任务），覆盖写即可。
 */

type OrphanRecord = {
  pgid: number;
  /** 进程启动时刻（ps 的 lstart 毫秒）：PGID 复用后启动时间对不上就不杀 */
  startedAt: number;
  command: string;
};

const BG_ORPHAN_KV_KEY = "bg_orphan_tasks";

/** kv 持久化钩子（store.ts 装配后注入；bun test 没有 Electron 宿主，静态
 *  import store 会连带拉起 electron 模块炸掉整个测试文件，必须注入解耦） */
let kvPersist: { get(key: string): string | null; set(key: string, value: string): void } | null =
  null;

/** 接线孤儿登记的 kv 读写（index.ts / 测试注入；传 null 退化为不持久化） */
export function setBgOrphanKv(
  impl: { get(key: string): string | null; set(key: string, value: string): void } | null,
): void {
  kvPersist = impl;
}

/** 运行中后台任务 → kv 登记（注册/退出/停止都会刷新，保持只含运行中集合） */
function persistRunningBgTasks(): void {
  if (!kvPersist) return;
  try {
    const rows: OrphanRecord[] = [];
    for (const task of bgTasks.values()) {
      if (!task.running) continue;
      rows.push({ pgid: task.pid, startedAt: task.startedAt, command: task.command });
    }
    kvPersist.set(BG_ORPHAN_KV_KEY, JSON.stringify(rows));
  } catch (e: any) {
    // kv 写失败：孤儿清扫退化为不可用，不影响任务本身
    logWarn(`bg orphan persist failed: ${e?.message ?? e}`);
  }
}

/** 读上一次实例遗留的孤儿登记；解析失败按无遗留处理 */
function readOrphanRecords(): OrphanRecord[] {
  try {
    if (!kvPersist) return [];
    const raw = kvPersist.get(BG_ORPHAN_KV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: OrphanRecord[] = [];
    for (const row of parsed as Array<Partial<OrphanRecord>>) {
      if (
        typeof row?.pgid === "number" &&
        Number.isFinite(row.pgid) &&
        row.pgid > 1 &&
        typeof row?.startedAt === "number"
      ) {
        out.push({ pgid: row.pgid, startedAt: row.startedAt, command: String(row.command ?? "") });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** macOS：按 pgid 取组内最老进程的启动时刻（毫秒）；查不到返回 null */
function processGroupStartTime(pgid: number): number | null {
  if (process.platform === "win32") return null; // win 走 lstart 等价查询成本高：只按存活杀
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-g", String(pgid)], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) return null;
    const line = r.stdout.split("\n").map((l) => l.trim()).find(Boolean);
    if (!line) return null;
    const ms = Date.parse(line);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** 组内任一进程是否仍在运行（unix 按 pgid 信号 0 探测；win 按 pid） */
function processGroupAlive(pgid: number): boolean {
  if (process.platform === "win32") {
    try {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pgid}`, "/NH"], { encoding: "utf8" });
      return r.status === 0 && (r.stdout ?? "").includes(String(pgid));
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动清扫：杀掉上个实例遗留的、仍存活且启动时间吻合的孤儿进程组。
 * 在 db 就绪后调用一次；纯旁路，任何失败只留痕。
 */
export function reapOrphanBgTasks(): number {
  const records = readOrphanRecords();
  if (records.length === 0) return 0;
  let reaped = 0;
  for (const rec of records) {
    if (!processGroupAlive(rec.pgid)) continue;
    // 启动时间对不上 = PGID 已被无关进程复用：不碰
    const startedAt = processGroupStartTime(rec.pgid);
    if (startedAt !== null && Math.abs(startedAt - rec.startedAt) > 1_500) {
      logWarn(`bg orphan reap skipped (pgid ${rec.pgid} reused by another process)`);
      continue;
    }
    killTree(rec.pgid);
    reaped += 1;
    logWarn(
      `bg orphan reaped: pgid=${rec.pgid} cmd=${rec.command.replace(/(?:sk-|Bearer\s+)\S+/gi, "***").slice(0, 120)}`,
    );
  }
  // 无论回收与否，遗留登记已消费完毕：清空，避免下次启动重复校验同一批
  try {
    kvPersist?.set(BG_ORPHAN_KV_KEY, "[]");
  } catch {
    /* ignore */
  }
  return reaped;
}

function ownedTask(id: number, owner: string): BgTask {
  const task = bgTasks.get(id);
  if (!task) {
    throw new Error(`no such background task: ${id} (it may have been reaped after completion)`);
  }
  if (owner && task.owner && task.owner !== owner) {
    throw new Error(
      `background task ${id} belongs to another thread; it is not readable or stoppable from here. Only task ids issued to this thread may be used.`,
    );
  }
  return task;
}

function handleTaskOutput(inner: any, owner: string): any {
  const id = Number(inner?.taskId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("taskId is required");
  const task = ownedTask(Math.trunc(id), owner);
  const out = redact(Buffer.concat(task.chunks).toString("utf8"), task.secrets);
  const status = task.running
    ? "\n[still running]"
    : task.exitCode === 0
      ? "\n[exited cleanly]"
      : task.exitCode === null
        ? ""
        : `\n[exited with code ${task.exitCode}]`;
  return { output: `${out}${status}`, running: task.running, exitCode: task.exitCode };
}

function handleTaskStop(inner: any, owner: string): any {
  const id = Number(inner?.taskId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("taskId is required");
  const task = ownedTask(Math.trunc(id), owner);
  if (!task.running) {
    return { output: `task ${id} already exited.`, running: false };
  }
  task.killed = true;
  killTree(task.pid);
  // 孤儿登记跟着走（与 stopBgTask 同步清）：不在 exit 事件里等——killTree
  // 后进程组死没死要等 SIGKILL 生效，先摘登记防「停止失败仍被登记」的窗口
  task.running = false;
  persistRunningBgTasks();
  task.running = true;
  return { output: `task ${id} killed: ${task.command.slice(0, 120)}`, running: false };
}

/* ------------------------------ read / write / edit ------------------------------ */

function readTextFile(cwd: string, filePath: string): { raw: Buffer; full: string } {
  const full = resolvePath(cwd, filePath);
  let raw: Buffer;
  try {
    raw = readFileSync(full);
  } catch (e: any) {
    throw new Error(`failed to read ${filePath}: ${e?.message ?? e}`);
  }
  return { raw, full };
}

/** write/edit 成功后附加的新鲜提示：内容已在上下文里，别再重读确认。 */
const FILE_STATE_FRESH_SUFFIX =
  " (file state is current in your context — no need to Read it back)";

function handleRead(inner: any, sandbox?: SandboxPlan): any {
  const filePath = strParam(inner, "file_path");
  const cwd = typeof inner?.cwd === "string" ? inner.cwd : "";
  assertReadAllowed(sandbox, cwd, filePath);
  const sandboxMeta = sandboxInfo(sandbox, "host");
  const { raw, full } = readTextFile(cwd, filePath);
  const mime = imageMime(filePath);
  if (mime) {
    const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
    if (raw.length > MAX_IMAGE_BYTES) {
      return {
        output:
          `${filePath} is an image (${Math.floor(raw.length / 1024)} KB) too large to attach inline (>2MiB). ` +
          `Downscale it first, e.g. \`sips -Z 1600 "${filePath}" --out small.png\`, then read the downscaled copy.`,
        sandbox: sandboxMeta,
      };
    }
    recordContent(full, raw);
    return {
      output: `Image attached: ${mime}, ${Math.floor(raw.length / 1024)} KB`,
      base64: raw.toString("base64"),
      mimeType: mime,
      bytes: raw.length,
      sandbox: sandboxMeta,
    };
  }
  if (raw.subarray(0, Math.min(raw.length, 64 * 1024)).includes(0)) {
    throw new Error(`${filePath} is a binary file and cannot be read as text`);
  }
  // 全文重读的显式纠偏：内容与上次记录一致且未带 offset/limit 时不重贴正文。
  // 只拦无参全文重读——带 offset/limit 是有目的的分页/定位，一律放行；压缩后
  // 早前 read 不在上下文里时，模型按提示带 offset 重读即可拿到内容（逃生通道）。
  // 命中时不更新 read-state：内容没变，哈希仍然新鲜。
  if (
    inner?.offset === undefined &&
    inner?.limit === undefined &&
    readState.hashes.get(full) === contentHash(raw)
  ) {
    return {
      output:
        "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead. " +
        "If that read is no longer in your context (e.g. after a summary), read again with offset=1 to reload it.",
      sandbox: sandboxMeta,
    };
  }
  recordContent(full, raw);
  const text = raw.toString("utf8");
  const allLines = text.split("\n");
  const offset = Math.max(1, Math.trunc(Number(inner?.offset ?? 1)));
  const limitRaw = inner?.limit;
  const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : allLines.length;
  const start = Math.max(0, offset - 1);
  const end = Math.min(start + limit, allLines.length);
  let slice = allLines
    .slice(start, end)
    .map((line, i) => `${start + i + 1}\t${line}`)
    .join("\n");
  if (Buffer.byteLength(slice, "utf8") > MAX_READ_BYTES) {
    const buf = Buffer.from(slice, "utf8").subarray(0, MAX_READ_BYTES);
    const kept = buf.toString("utf8");
    // 续读路标：按保留文本的换行数推出下一行号（截断可能切在半行上，next 是
    // 近似值——差一行无妨，模型带 offset 重读自然对齐）
    const nextOffset = start + kept.split("\n").length;
    slice = `${kept}\n…[truncated — continue with offset=${nextOffset} and a limit, or search for the specific section instead]`;
  }
  const more =
    end < allLines.length ? `\n…[${allLines.length - end} more lines, total ${allLines.length}]` : "";
  return { output: `${slice}${more}`, totalLines: allLines.length, sandbox: sandboxMeta };
}

function guardJson(filePath: string, content: string): void {
  if (!/\.[jJ][sS][oO][nN]$/.test(filePath)) return;
  try {
    JSON.parse(content);
  } catch (e: any) {
    throw new Error(
      `${filePath} would not be valid JSON after this change (${e?.message ?? e}); write the whole file with corrected content instead of a partial edit`,
    );
  }
}

function handleWrite(inner: any, sandbox?: SandboxPlan): any {
  const filePath = strParam(inner, "file_path");
  const content = strParam(inner, "content");
  const cwd = typeof inner?.cwd === "string" ? inner.cwd : "";
  assertWriteAllowed(sandbox, cwd, filePath);
  const sandboxMeta = sandboxInfo(sandbox, "host");
  const full = resolvePath(cwd, filePath);
  const append = inner?.mode === "append";
  let isFile = false;
  try {
    isFile = statSync(full).isFile();
  } catch {
    isFile = false;
  }
  if (isFile) ensureFreshRead(full, filePath, append ? "append to" : "overwrite");
  if (append && isFile) {
    // append 的片段单独 parse 必然失败（如 JSON 中段），要校验“已有内容 + 本次追加”
    let existing = "";
    try {
      existing = readFileSync(full, "utf8");
    } catch {
      existing = "";
    }
    guardJson(filePath, existing + content);
  } else {
    guardJson(filePath, content);
  }
  const parent = dirname(full);
  if (parent) {
    try {
      mkdirSync(parent, { recursive: true });
    } catch (e: any) {
      throw new Error(`failed to create dirs for ${filePath}: ${e?.message ?? e}`);
    }
  }
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (append) {
    try {
      appendFileSync(full, content, "utf8");
    } catch (e: any) {
      throw new Error(`failed to append ${filePath}: ${e?.message ?? e}`);
    }
    try {
      recordContent(full, readFileSync(full));
    } catch {
      /* ignore */
    }
    return {
      output: `Appended ${contentBytes} bytes to ${filePath}${FILE_STATE_FRESH_SUFFIX}`,
      sandbox: sandboxMeta,
    };
  }
  try {
    writeFileSync(full, content, "utf8");
  } catch (e: any) {
    throw new Error(`failed to write ${filePath}: ${e?.message ?? e}`);
  }
  recordContent(full, Buffer.from(content, "utf8"));
  return {
    output: `Wrote ${contentBytes} bytes to ${filePath}${FILE_STATE_FRESH_SUFFIX}`,
    sandbox: sandboxMeta,
  };
}

function handleEdit(inner: any, sandbox?: SandboxPlan): any {
  const filePath = strParam(inner, "file_path");
  const oldString = strParam(inner, "old_string");
  const newString = strParam(inner, "new_string");
  const replaceAll = inner?.replace_all === true;
  const cwd = typeof inner?.cwd === "string" ? inner.cwd : "";
  assertWriteAllowed(sandbox, cwd, filePath);
  const sandboxMeta = sandboxInfo(sandbox, "host");
  const { raw, full } = readTextFile(cwd, filePath);
  if (raw.subarray(0, Math.min(raw.length, 64 * 1024)).includes(0)) {
    throw new Error(`${filePath} is a binary file and cannot be edited as text`);
  }
  ensureFreshReadBytes(full, filePath, "edit", raw);
  const text = raw.toString("utf8");
  const occurrences = text.split(oldString).length - 1;
  if (occurrences === 0) throw new Error(`old_string not found in ${filePath}`);
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string appears ${occurrences} times in ${filePath}; provide more context or set replace_all=true`,
    );
  }
  const updated = occurrences > 1 ? text.split(oldString).join(newString) : text.replace(oldString, newString);
  guardJson(filePath, updated);
  try {
    writeFileSync(full, updated, "utf8");
  } catch (e: any) {
    throw new Error(`failed to write ${filePath}: ${e?.message ?? e}`);
  }
  recordContent(full, Buffer.from(updated, "utf8"));
  const count = replaceAll && occurrences > 1 ? occurrences : 1;
  return {
    output: `Replaced ${count} occurrence(s) in ${filePath}${FILE_STATE_FRESH_SUFFIX}`,
    sandbox: sandboxMeta,
  };
}

/* ------------------------------ http ------------------------------ */

function isTextualContentType(ct: string): boolean {
  const c = ct.toLowerCase();
  const prefixes = ["text/", "application/json", "application/xml", "application/javascript", "application/x-www-form-urlencoded"];
  const suffixes = ["+json", "+xml"];
  return prefixes.some((p) => c.startsWith(p)) || suffixes.some((s) => c.includes(s));
}

async function handleHttp(inner: any, sandbox?: SandboxPlan): Promise<any> {
  assertNetworkAllowed(sandbox);
  const sandboxMeta = sandboxInfo(sandbox, "host");
  const urlS = strParam(inner, "url");
  let url: URL;
  try {
    url = new URL(urlS);
  } catch (e: any) {
    throw new Error(`invalid url: ${e?.message ?? e}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported url scheme: ${url.protocol.replace(":", "")}`);
  }
  const method = String(inner?.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) {
    throw new Error(`unsupported method: ${method}`);
  }
  const headers = new Headers();
  if (inner?.headers && typeof inner.headers === "object") {
    for (const [k, v] of Object.entries(inner.headers)) {
      if (typeof v !== "string") throw new Error(`header ${k}: value must be a string`);
      headers.set(k, v);
    }
  }
  let body: string | undefined;
  if (inner?.body !== undefined && inner?.body !== null) {
    if (typeof inner.body === "string") {
      body = inner.body;
    } else if (typeof inner.body === "object") {
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      body = JSON.stringify(inner.body);
    } else {
      throw new Error("body must be a string or object");
    }
  }
  const timeoutMs = clampNum(inner?.timeoutMs, DEFAULT_HTTP_TIMEOUT_MS, 1, MAX_HTTP_TIMEOUT_MS);
  const maxBytes = clampNum(inner?.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, MAX_RESPONSE_BYTES_CAP);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(urlS, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body, signal: ac.signal, redirect: "follow" });
  } catch (e: any) {
    clearTimeout(timer);
    const aborted = e?.name === "AbortError";
    throw new Error(aborted ? `request timed out after ${timeoutMs}ms: ${urlS}` : `request failed: ${e?.message ?? e}`);
  }
  clearTimeout(timer);

  // 只读 max+1 探测字节
  const buf: Buffer[] = [];
  let total = 0;
  const reader = resp.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        buf.push(Buffer.from(value));
        total += value.length;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
      }
    }
  }
  let bodyBuf = Buffer.concat(buf);
  const truncated = bodyBuf.length > maxBytes;
  if (truncated) bodyBuf = bodyBuf.subarray(0, maxBytes);

  const contentType = resp.headers.get("content-type") ?? "application/octet-stream";
  const declared = Number(resp.headers.get("content-length"));
  const responseHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });
  const textual = isTextualContentType(contentType);
  return {
    output: textual ? bodyBuf.toString("utf8") : bodyBuf.toString("base64"),
    status: resp.status,
    statusText: resp.statusText ?? "",
    ok: resp.ok,
    url: resp.url || urlS,
    contentType,
    headers: responseHeaders,
    totalBytes: Number.isFinite(declared) ? declared : bodyBuf.length,
    truncated,
    encoding: textual ? "utf-8" : "base64",
    sandbox: sandboxMeta,
  };
}

function clampNum(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : def;
  return Math.max(min, Math.min(max, n));
}

/* ------------------------------ screenshot（macOS 阶梯压缩） ------------------------------ */

interface ScreenshotResult {
  base64: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
}

function buildLadder(maxDim: number, quality: number): [number, number][] {
  const ladder: [number, number][] = [[maxDim, quality]];
  for (const q of [Math.max(quality - 15, 35), Math.max(quality - 30, 35)]) {
    if (ladder[ladder.length - 1][1] !== q) ladder.push([maxDim, q]);
  }
  const midQ = Math.min(60, Math.max(45, quality));
  for (const d of [1600, 1280, 1024]) {
    if (d < maxDim) ladder.push([d, midQ]);
  }
  return ladder;
}

/**
 * 异步子进程 + 硬超时（超时杀进程树后 reject）。
 * 旧实现是 spawnSync：powershell 截屏在锁屏/RDP/AV 扫描下可无限挂起，
 * 同步等待会把主进程事件循环冻死——整个应用所有点击都石沉大海
 * （Windows 用户实测"页面哪里都点不了"的头号根因）。改异步后最坏情况
 * 退化为一次可恢复的工具报错。
 */
function runCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ status: number | null; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e: any) {
      reject(new Error(`failed to launch ${cmd}: ${e?.message ?? e}`));
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) killTree(child.pid);
        else child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      // 上限 64MB：超限部分丢弃（截图 base64 可达 ~2.4MB，正常远不到）
      if (stdout.length < 64 * 1024 * 1024) stdout = Buffer.concat([stdout, d]);
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 1024 * 1024) stderr = Buffer.concat([stderr, d]);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to launch ${cmd}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s (killed)`));
        return;
      }
      resolve({ status: code, stdout, stderr });
    });
  });
}

async function queryDimsMac(path: string): Promise<{ w: number; h: number }> {
  let r: { status: number | null; stdout: Buffer };
  try {
    r = await runCapture("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], 5000);
  } catch {
    return { w: 0, h: 0 };
  }
  if (r.status !== 0) return { w: 0, h: 0 };
  const s = r.stdout.toString();
  const grab = (key: string) => {
    const line = s.split("\n").find((l) => l.trim().startsWith(key));
    const m = line ? Number(line.split(":")[1]?.trim()) : 0;
    return Number.isFinite(m) ? m : 0;
  };
  return { w: grab("pixelWidth"), h: grab("pixelHeight") };
}

async function handleScreenshot(inner: any): Promise<any> {
  const maxDim = clampInt(inner?.maxDim, SCREENSHOT_DEFAULT_MAX_DIM, 640, 3840);
  const quality = clampInt(inner?.quality, SCREENSHOT_DEFAULT_QUALITY, 30, 100);
  if (process.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "kova-shot-"));
    const pngS = join(dir, "shot.png");
    const jpgS = join(dir, "shot.jpg");
    try {
      const cap = await runCapture("screencapture", ["-x", pngS], 15000);
      if (cap.status !== 0) {
        throw new Error(`screencapture failed: ${cap.stderr?.toString().trim() ?? ""}`);
      }
      let best: Buffer | null = null;
      for (const [dim, q] of buildLadder(maxDim, quality)) {
        const conv = await runCapture(
          "sips",
          ["-Z", String(dim), "-s", "format", "jpeg", "-s", "formatOptions", String(q), pngS, "--out", jpgS],
          10000,
        );
        if (conv.status !== 0) continue;
        let bytes: Buffer;
        try {
          bytes = readFileSync(jpgS);
        } catch {
          continue;
        }
        if (!best || bytes.length < best.length) best = bytes;
        if (best && best.length <= SCREENSHOT_INLINE_BUDGET_BYTES) break;
      }
      if (!best) throw new Error("screenshot produced no output (sips failed at every tier)");
      const dims = await queryDimsMac(jpgS);
      const r: ScreenshotResult = {
        base64: best.toString("base64"),
        mimeType: "image/jpeg",
        bytes: best.length,
        width: dims.w,
        height: dims.h,
      };
      return r;
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  if (process.platform === "win32") {
    return captureWindows(maxDim, quality);
  }
  throw new Error("screenshot is only supported on macOS/Windows");
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : def;
  return Math.max(min, Math.min(max, n));
}

/* ------------------------------ screenshot（Windows：PowerShell + System.Drawing） ------------------------------ */

/**
 * PowerShell 抓图脚本（照 Rust windows_capture_script 逐条移植）：
 * - DPI 感知：不先 SetProcessDPIAware，HiDPI 缩放下 VirtualScreen/CopyFromScreen
 *   会按逻辑像素工作，抓出来是错尺寸的半分辨率图；
 * - 抓整块虚拟桌面（多显示器合并）→ 按阶梯缩放 + JPEG 编码，命中预算即停；
 * - 全内存（Bitmap → MemoryStream），不落盘；
 * - 只用 ConvertTo-Json -Compress 输出一行 JSON。
 * tiersJson 只含整数（无注入面）；budget 为内联预算字节数。
 */
function windowsCaptureScript(tiersJson: string, budget: number): string {
  return `$ErrorActionPreference = 'Stop'
try {
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class KovaDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][KovaDpi]::SetProcessDPIAware()

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($vs.Width -le 0 -or $vs.Height -le 0) { throw 'virtual screen has no area' }
$full = New-Object System.Drawing.Bitmap -ArgumentList $vs.Width, $vs.Height
$g = [System.Drawing.Graphics]::FromImage($full)
try {
  $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $full.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
} finally { $g.Dispose() }

$tiers = ConvertFrom-Json '${tiersJson}'
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
if ($null -eq $codec) { throw 'no JPEG encoder available' }
$best = $null
foreach ($t in $tiers) {
  $dim = [int]$t.d
  $scale = [Math]::Min(1.0, $dim / [double][Math]::Max($full.Width, $full.Height))
  $w = [int][Math]::Max(1, [Math]::Round($full.Width * $scale))
  $h = [int][Math]::Max(1, [Math]::Round($full.Height * $scale))
  $bmp = $null
  $ms = $null
  try {
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h
    $g2 = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g2.DrawImage($full, (New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $w, $h))
    } finally { $g2.Dispose() }
    $enc = New-Object System.Drawing.Imaging.EncoderParameters -ArgumentList 1
    $enc.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter -ArgumentList ([System.Drawing.Imaging.Encoder]::Quality), ([long]$t.q)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, $codec, $enc)
    $bytes = $ms.ToArray()
    if ($null -eq $best -or $bytes.Length -lt $best.bytes.Length) {
      $best = [pscustomobject]@{ bytes = $bytes; width = $w; height = $h }
    }
  } finally {
    if ($null -ne $ms) { $ms.Dispose() }
    if ($null -ne $bmp) { $bmp.Dispose() }
  }
  if ($null -ne $best -and $best.bytes.Length -le ${budget}) { break }
}
if ($null -eq $best) { throw 'screenshot produced no output at every tier' }
$full.Dispose()
@{
  base64 = [Convert]::ToBase64String($best.bytes)
  mimeType = 'image/jpeg'
  bytes = $best.bytes.Length
  width = $best.width
  height = $best.height
} | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
}

async function captureWindows(maxDim: number, quality: number): Promise<ScreenshotResult> {
  const tiersJson = JSON.stringify(buildLadder(maxDim, quality).map(([d, q]) => ({ d, q })));
  const script = windowsCaptureScript(tiersJson, SCREENSHOT_INLINE_BUDGET_BYTES);
  // -EncodedCommand 收 Base64(UTF-16LE)：绕开引号转义，也绕开 ExecutionPolicy 限制
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // 20s 硬超时：PowerShell 冷启动 + AV 扫描最慢也就十秒级；锁屏/RDP 会话下
  // CopyFromScreen 可能永不返回——旧实现 spawnSync 会把主进程整个冻死
  const out = await runCapture(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    20000,
  );
  if (out.status !== 0) {
    const err = (out.stderr ?? Buffer.alloc(0)).toString("utf8").trim();
    throw new Error(
      err.length > 0 ? `screenshot capture failed: ${err}` : `screenshot capture failed (exit ${out.status})`,
    );
  }
  // 取最后一行 JSON：脚本只输出一行，前面若有杂音也不影响
  const stdout = (out.stdout ?? Buffer.alloc(0)).toString("utf8");
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith("{"));
  if (!line) throw new Error("powershell produced no screenshot JSON");
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch (e: any) {
    throw new Error(`screenshot payload parse failed: ${e?.message ?? e}`);
  }
  // 形状校验：payload 缺 base64 时早失败，别让 UI 收到空图才发现
  if (typeof parsed?.base64 !== "string" || parsed.base64.length === 0) {
    throw new Error("screenshot payload missing base64");
  }
  return {
    base64: parsed.base64,
    mimeType: typeof parsed.mimeType === "string" ? parsed.mimeType : "image/jpeg",
    bytes: Number(parsed.bytes) || Buffer.from(parsed.base64, "base64").length,
    width: Number(parsed.width) || 0,
    height: Number(parsed.height) || 0,
  };
}

/* ------------------------------ 总入口 ------------------------------ */

export async function handleTool(id: string, p: any): Promise<any> {
  const envelopeOwner0 = typeof p?.owner === "string" ? p.owner : "";
  const guard = new CancelGuard(id, envelopeOwner0);
  try {
    const name = strParam(p, "name");
    const sandbox = parseSandboxPlan(p?.sandbox);
    const inner = p?.params && typeof p.params === "object" ? { ...p.params } : {};
    if (inner.cwd === undefined || inner.cwd === null) inner.cwd = p?.cwd ?? null;
    const envelopeOwner = typeof p?.owner === "string" ? p.owner : "";
    const result = await (async () => {
    switch (name) {
      case "bash": {
        const cwd = typeof p?.cwd === "string" ? p.cwd : ".";
        const command = strParam(inner, "command");
        const secrets = takeResolved(p);
        // 线程级登记：之后 read/browser/http/task_output 的输出也要脱敏，
        // 防止模型把密钥写进文件再读回来绕过 bash 输出脱敏。
        rememberThreadSecrets(envelopeOwner, secrets);
        const accel = accelEnv(inner);
        if (inner?.runInBackground === true) {
          return runBashBackground(cwd, command, secrets, accel, envelopeOwner, sandbox);
        }
        const timeoutMs =
          typeof inner?.timeout === "number" && Number.isFinite(inner.timeout)
            ? Math.max(1_000, Math.min(Math.trunc(inner.timeout), MAX_BASH_TIMEOUT_MS))
            : DEFAULT_BASH_TIMEOUT_MS;
        return runBash(cwd, command, timeoutMs, guard, secrets, accel, envelopeOwner, sandbox);
      }
      case "task_output":
        return handleTaskOutput(inner, envelopeOwner);
      case "task_stop":
        return handleTaskStop(inner, envelopeOwner);
      case "read":
        return handleRead(inner, sandbox);
      case "write":
        return handleWrite(inner, sandbox);
      case "edit":
        return handleEdit(inner, sandbox);
      case "http":
        return handleHttp(inner, sandbox);
      case "screenshot":
        return handleScreenshot(inner);
      case "browser_navigate":
      case "browser_snapshot":
      case "browser_resize":
      case "browser_click":
      case "browser_type":
      case "browser_press":
      case "browser_hover":
      case "browser_scroll":
      case "browser_select":
      case "browser_check":
      case "browser_drag":
      case "browser_evaluate":
      case "browser_wait_for":
      case "browser_state":
      case "browser_dialog":
      case "browser_back":
      case "browser_forward":
      case "browser_reload": {
        const mod = await import("./browser");
        return mod.runTool(name, inner, envelopeOwner, guard);
      }
      case "browser_shot": {
        const mod = await import("./browser");
        return mod.captureLive(inner, envelopeOwner, guard);
      }
      default:
        throw new Error(`unknown host tool: ${name}`);
    }
    })();
    return redactToolResult(result, activeThreadSecrets(envelopeOwner));
  } finally {
    guard.release();
  }
}
