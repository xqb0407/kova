/**
 * ACP/本地模式的工具执行器（vendored from apps/electron/main/tool-exec.ts）。
 *
 * sidecar 在本地 SQLite 模式下没有 Electron 宿主，`hostToolCall("tool")` 必须
 * 由本进程执行。这里移植桌面端核心路径：bash / task_output / task_stop /
 * read / write / edit / http，保持与宿主完全相同的信封形状与
 * read-state / 超时转后台 / 进程树 kill / 输出脱敏语义。
 *
 * 有意差异（ACP v1）：
 * - screenshot / browser_* 不提供（桌面 UI 专属，工具表已过滤，这里兜底报错）；
 * - 密钥来自本地 SQLite 明文表（见 ./secrets.ts），不经过 Electron 解密；
 * - 沙箱 / shell 解析 / 路径裁决从桌面端同名模块移植（见 ./sandbox.ts 等）。
 *
 * 同步纪律：修改 bash/read/write/edit/http 语义时，必须同时检查
 * apps/electron/main/tool-exec.ts，避免桌面端与 ACP 行为漂移。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolveReal, sep } from "node:path";
import { unavailableMessage, type SandboxPlan } from "pi-sandbox";
import { applyBatchEdits, applyEditMatch, editMatchedNote } from "pi-edit-match";
import { envFromResolved, redact, takeResolved, type SecretPair } from "./secrets";
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
} from "./path-guard";
import {
  activeThreadSecrets,
  redactToolResult,
  rememberThreadSecrets,
} from "./secrets";
import { logErr } from "../log";
import { resolveShellCommand } from "./shell-resolve";

const MAX_TOOL_OUTPUT = 30 * 1024;
/** bash 收集上限 = 杀进程阈值。30KB 只是把给模型的窗口：30KB..10MB 之间的输出
 *  照常收集、进程正常跑完（verbose build/test 不再被误杀），全量落盘供模型
 *  用 read 追读；超过 10MB 才判失控杀进程。 */
const MAX_BASH_COLLECT_BYTES = 10 * 1024 * 1024;
/** 全量落盘文件的保留期（写入时惰性清理） */
const FULL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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

/* --------------------------- 读后写一致性（stale 守卫） --------------------------- */

type ReadStateMap = { hashes: Map<string, string>; order: string[] };
const readState: ReadStateMap = { hashes: new Map(), order: [] };

/** 驱逐容量（生产固定 4096；测试缝可调小以驱动真实驱逐路径） */
let readStateCap = READ_STATE_CAP;

/** 测试缝：缩小 read-state LRU 容量（仅测试使用；用完请恢复默认） */
export function setReadStateCapForTests(cap: number): void {
  readStateCap = Math.max(1, Math.trunc(cap));
}

function contentHash(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function recordContent(full: string, bytes: Buffer): void {
  const fresh = !readState.hashes.has(full);
  readState.hashes.set(full, contentHash(bytes));
  if (fresh) {
    readState.order.push(full);
  } else {
    // 已登记的 key 移到队尾：按最近使用驱逐。热点文件反复 read/write 时
    // 若不刷新位置，会按首次登记顺序被挤掉，后续 write/edit 误报 "read it first"
    const index = readState.order.indexOf(full);
    if (index >= 0) {
      readState.order.splice(index, 1);
      readState.order.push(full);
    }
  }
  while (readState.order.length > readStateCap) {
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

/**
 * 进程退出 / ACP 断开时的整体清理：前台在飞进程与后台任务一并收掉。
 * 后台任务按设计跨回合存活，但进程退出后没有 owner 能再 task_output，
 * 留着只会变成孤儿进程。
 */
export function disposeLocalHost(): void {
  cancelAllTools();
  for (const task of bgTasks.values()) {
    task.killed = true;
    killTree(task.pid);
  }
  bgTasks.clear();
  readState.hashes.clear();
  readState.order.length = 0;
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

/**
 * symlink 越界守卫（与桌面端 tool-exec.ts 同款）：词法路径在工作区**内**、
 * 但 realpath 经 symlink 落到工作区外时拒绝——区内链接写到区外，会绕过
 * 写根审批。词法路径本身就在区外的写入（/tmp 临时脚本、审批放行的区外
 * 目标）不做此判定——那是审批/沙箱的既有管辖。
 */
function assertNoSymlinkEscape(cwd: string, full: string, action: string): void {
  const root = resolveReal(cwd);
  const lexical = resolveReal(full);
  if (!lexical.startsWith(root + sep) && lexical !== root) {
    return; // 词法路径在区外：审批/沙箱的既有管辖，不做 symlink 判定
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return; // cwd 不存在：后续 write 自会失败，这里不做判定
  }
  let probe = lexical;
  for (;;) {
    let real: string;
    try {
      real = realpathSync(probe);
    } catch {
      // 不存在：上溯到最近的现存祖先再判（写入时会沿该祖先创建）
      const parent = dirname(probe);
      if (parent === probe) return;
      probe = parent;
      continue;
    }
    if (real === realRoot || real.startsWith(realRoot + sep)) return;
    throw new Error(
      `${action} refused: ${probe} resolves (through symlinks) to ${real}, which is outside the workspace (${realRoot}). ` +
        "Edit the real path instead, or remove the symlink.",
    );
  }
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

/* ------------------------------ bash 全量输出落盘 ------------------------------ */

// 与 apps/electron/main/tool-exec.ts 的同名段保持逐字同步（同步纪律，
// 见文件头注释）；仅日志出口不同（本侧只有 logErr）。

let toolOutputDir: string | null = null;

/** 配置 bash 截断全量的落盘目录。宿主启动时指向 <userData>/tool-output
 *  （与转录同级敏感度，不放 /tmp）；未配置时回退 KOVA_DATA_DIR 或系统临时目录。
 *  测试用临时目录覆盖。落盘失败绝不影响工具结果。 */
export function configureToolOutputDir(dir: string): void {
  toolOutputDir = dir;
}

function resolveToolOutputDir(): string {
  if (toolOutputDir) return toolOutputDir;
  const dataDir = process.env.KOVA_DATA_DIR?.trim();
  return join(dataDir || tmpdir(), "kova-tool-output");
}

/** 落盘文件名里的线程段：只留文件名安全字符 */
function fileStemOf(owner: string): string {
  const stem = owner.replace(/[^\w.-]/g, "_").slice(0, 80);
  return stem || "unknown";
}

/** 把收集到的完整输出写盘，返回路径；任何失败都返回 null（尽力而为的旁路） */
function saveFullToolOutput(owner: string, text: string): string | null {
  try {
    const dir = resolveToolOutputDir();
    mkdirSync(dir, { recursive: true });
    // 惰性清理：写入时顺带删超过保留期的旧文件
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {}
    for (const name of names) {
      try {
        const path = join(dir, name);
        if (Date.now() - statSync(path).mtimeMs > FULL_OUTPUT_RETENTION_MS) rmSync(path, { force: true });
      } catch {}
    }
    // 随机段防同名：同一并行批次里两个 bash 同毫秒完成会互相覆盖
    const path = join(dir, `bash-${fileStemOf(owner)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
    const buf = Buffer.from(text, "utf8");
    writeFileSync(path, buf.length > MAX_BASH_COLLECT_BYTES ? buf.subarray(0, MAX_BASH_COLLECT_BYTES) : buf);
    return path;
  } catch (e: any) {
    logErr(`save full bash output failed: ${e?.message ?? e}`);
    return null;
  }
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
    // 收集上限 = 杀进程阈值（10MB）：30KB..10MB 之间的输出照常收集，
    // 进程正常跑完，全量落盘供模型 read 追读
    if (totalBytes >= MAX_BASH_COLLECT_BYTES) return;
    chunks.push(buf);
    totalBytes += buf.length;
    if (totalBytes >= MAX_BASH_COLLECT_BYTES && !killedByOverflow) {
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
        child.on("exit", (code, signal) => {
          task.exitCode = code === null ? (signal ? null : -1) : code;
          if (code === null && signal) task.exitCode = null;
          task.running = false;
        });
        const id = registerBgTask(task);
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
        logErr(`bash timeout backgrounding failed, falling back to kill: ${e?.message ?? e}`);
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
  const collectedBytes = outBuf.length;
  let truncated = false;
  let fullOutText: string | null = null;
  if (outBuf.length > MAX_TOOL_OUTPUT) {
    // 全量文本在切片前取出（收集上限 10MB，一次性转字符串可控）
    fullOutText = outBuf.toString("utf8");
    outBuf = outBuf.subarray(0, MAX_TOOL_OUTPUT);
    truncated = true;
  }
  let out = outBuf.toString("utf8");
  const exitCode: number | null = exitState.done ? exitState.code : null;
  // exitCode=null 有三种互斥来源，文案必须与 timedOut 诊断码一致——
  // 旧文案把「信号自杀」也写成 "timeout after Ns"，模型会以为等更久有用
  // （与 killedByOverflow 同类的文案/诊断码矛盾，见下）。
  const elapsedSeconds = Math.floor((Date.now() - start) / 1000);
  const status = cancelled
    ? "\n[cancelled]"
    : exitCode === 0
      ? ""
      : exitCode === null
        ? killedByOverflow
          ? `\n[killed: output exceeded the ${Math.floor(MAX_BASH_COLLECT_BYTES / 1024 / 1024)}MB collection cap — the process was stopped mid-run. Its state is unknown; do not assume it completed. The collected portion is in the full-output file whose path appears at the end of this result; split the work into smaller steps or pass runInBackground:true and poll with task_output.]`
          : timedOut
            ? `\n[timeout after ${Math.floor(timeoutMs / 1000)}s — output above is what was collected before the kill. For long-running commands pass runInBackground:true and poll with task_output, or split the work into shorter steps.]`
            : `\n[terminated by signal after ${elapsedSeconds}s — exit code unavailable. Output above is what was collected. If this was intentional, ignore; otherwise check the command for a stray kill/self-termination.]`
        : `\n[exit code: ${exitCode}]`;
  const sandboxHint =
    backend === "seatbelt" && exitCode !== null && exitCode !== 0
      ? "\n[sandbox] write isolation is active; 'Operation not permitted' means the path is outside the allowed write roots."
      : "";
  out = redact(out, secrets);
  // 全量落盘（先按本次 bash 的密钥表脱敏再写盘；read 工具回读时还会按线程
  // 密钥再脱敏一次）：模型窗口只有 30KB，完整收集输出写进文件并在 suffix 给出
  // 路径，模型用 read 追读——不再只能"缩窄命令重跑"。落盘失败回退旧文案。
  let fullOutputPath: string | null = null;
  let suffix = "";
  if (truncated && fullOutText !== null) {
    fullOutputPath = saveFullToolOutput(owner, redact(fullOutText, secrets));
    const cutKb = Math.max(1, Math.round((collectedBytes - MAX_TOOL_OUTPUT) / 1024));
    const cappedNote = collectedBytes > MAX_BASH_COLLECT_BYTES ? " (first 10MB)" : "";
    suffix = fullOutputPath
      ? `\n…[output truncated at ${cutKb}KB. Full output${cappedNote}: ${fullOutputPath} — read it for the full output]`
      : "\n…[output truncated]";
  }
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
    ...(fullOutputPath ? { fullOutputPath } : {}),
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
}
const bgTasks = new Map<number, BgTask>();
let bgNextId = 1;

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

  const task: BgTask = { command, pid, chunks: [], bytes: 0, killed: false, running: true, exitCode: null, secrets, owner };
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
  child.on("exit", (code, signal) => {
    task.exitCode = code === null ? (signal ? null : -1) : code;
    if (code === null && signal) task.exitCode = null;
    task.running = false;
  });

  const id = registerBgTask(task);
  return {
    output:
      `Started in background (task ${id}). The process keeps running across turns and is NOT killed when this turn is cancelled. Use task_output with taskId=${id} to read collected output and check status; use task_stop with taskId=${id} to kill it. Do not poll in a tight loop — do other work first, then check again.`,
    taskId: id,
    sandbox: sandboxInfo(sandbox, backend),
  };
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
  // offset 防护：非法值（NaN/垃圾字符串）回落 1；越界时不静默给空结果，
  // 显式告知 EOF 位置，模型不至于误判文件为空而重试
  const offsetRaw = Math.trunc(Number(inner?.offset ?? 1));
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 1 ? offsetRaw : 1;
  const limitRaw = inner?.limit;
  // limit 钳到 ≥1：负数/0 会切出空结果且无任何标记（与 offset 越界同类问题）
  const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw)
    ? Math.max(1, Math.trunc(limitRaw))
    : allLines.length;
  const start = Math.max(0, offset - 1);
  if (start >= allLines.length) {
    return {
      output:
        `offset ${offset} is beyond EOF (${allLines.length} total lines). ` +
        "There is no content at or after this line.",
      totalLines: allLines.length,
      sandbox: sandboxMeta,
    };
  }
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
  // symlink 越界守卫：词法路径在区内、真实落点在区外时拒绝（绕过写根审批）
  assertNoSymlinkEscape(cwd, full, append ? "append" : "write");
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

/** edit 参数归一：sidecar 的 prepareEditArguments 已把模型参数规范成 edits[]，
 *  这里兜底直呼本执行器的调用与旧形态。三处执行点共用同一份归一语义
 *  （同步纪律；与 apps/electron/main/tool-exec.ts、tools/remote/remote-tool-call.ts
 *  的同名函数逐字一致，仅参数名不同）。 */
function normalizeEditMembers(inner: any): {
  members: Array<{ oldText: string; newText: string }>;
  replaceAll: boolean;
} {
  const asMember = (value: any): { oldText: string; newText: string } | null => {
    if (!value || typeof value !== "object") return null;
    const oldText =
      typeof value.oldText === "string" ? value.oldText : typeof value.old_string === "string" ? value.old_string : null;
    const newText =
      typeof value.newText === "string" ? value.newText : typeof value.new_string === "string" ? value.new_string : null;
    return oldText !== null && newText !== null ? { oldText, newText } : null;
  };
  let members: Array<{ oldText: string; newText: string }> = [];
  if (Array.isArray(inner?.edits)) {
    members = (inner.edits as unknown[]).map(asMember).filter((m): m is { oldText: string; newText: string } => m !== null);
  } else {
    const single = asMember(inner?.edits);
    if (single) members = [single];
  }
  if (members.length === 0) {
    const legacy = asMember({ old_string: inner?.old_string, new_string: inner?.new_string });
    if (legacy) members = [legacy];
  }
  return { members, replaceAll: inner?.replace_all === true };
}

function handleEdit(inner: any, sandbox?: SandboxPlan): any {
  const filePath = strParam(inner, "file_path");
  const { members, replaceAll } = normalizeEditMembers(inner);
  if (members.length === 0) {
    throw new Error("edit input is invalid: provide edits[] (oldText/newText) or legacy old_string/new_string");
  }
  if (replaceAll && members.length > 1) {
    throw new Error("replace_all applies to single-edit calls only; batch edits must each match uniquely");
  }
  const cwd = typeof inner?.cwd === "string" ? inner.cwd : "";
  assertWriteAllowed(sandbox, cwd, filePath);
  const sandboxMeta = sandboxInfo(sandbox, "host");
  const { raw, full } = readTextFile(cwd, filePath);
  if (raw.subarray(0, Math.min(raw.length, 64 * 1024)).includes(0)) {
    throw new Error(`${filePath} is a binary file and cannot be edited as text`);
  }
  ensureFreshReadBytes(full, filePath, "edit", raw);
  assertNoSymlinkEscape(cwd, full, "edit");
  const text = raw.toString("utf8");
  // 单成员（含 replace_all 语义）走原单条管线：文案与行为逐字节不变；
  // 多成员走批量管线（对同一份原文件独立匹配、整批原子、重叠拒绝）。
  // 宽策略只在 exact 零命中时参与——今天能成功的路径不变
  if (members.length === 1) {
    const { oldText: oldString, newText: newString } = members[0]!;
    const applied = applyEditMatch({ content: text, filePath, oldString, newString, replaceAll });
    if (!applied.ok) throw new Error(applied.error);
    const { updated, count, strategy } = applied;
    guardJson(filePath, updated);
    try {
      writeFileSync(full, updated, "utf8");
    } catch (e: any) {
      throw new Error(`failed to write ${filePath}: ${e?.message ?? e}`);
    }
    recordContent(full, Buffer.from(updated, "utf8"));
    return {
      output: `Replaced ${count} occurrence(s) in ${filePath}${editMatchedNote(strategy)}${FILE_STATE_FRESH_SUFFIX}`,
      sandbox: sandboxMeta,
    };
  }
  const applied = applyBatchEdits({ content: text, filePath, edits: members });
  if (!applied.ok) throw new Error(applied.error);
  guardJson(filePath, applied.updated);
  try {
    writeFileSync(full, applied.updated, "utf8");
  } catch (e: any) {
    throw new Error(`failed to write ${filePath}: ${e?.message ?? e}`);
  }
  recordContent(full, Buffer.from(applied.updated, "utf8"));
  const note = applied.notes.length > 0 ? ` (${applied.notes.join("; ")})` : "";
  return {
    output: `Successfully replaced ${applied.count} block(s) in ${filePath}${note}${FILE_STATE_FRESH_SUFFIX}`,
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

async function handleHttp(
  inner: any,
  sandbox?: SandboxPlan,
  signal?: AbortSignal,
): Promise<any> {
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
  const onExternalAbort = () => ac.abort();
  const cleanupAbort = () => signal?.removeEventListener("abort", onExternalAbort);
  if (signal) {
    // ACP Stop 要能中断在飞的 WebFetch/WebSearch；正常结束/超时后取消监听，
    // 避免同一轮大量请求在 prompt signal 上累积监听。
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  let resp: Response;
  try {
    resp = await fetch(urlS, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body, signal: ac.signal, redirect: "follow" });
  } catch (e: any) {
    clearTimeout(timer);
    cleanupAbort();
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
  cleanupAbort();
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

/* ------------------------------ 总入口 ------------------------------ */

export async function handleTool(
  id: string,
  p: any,
  signal?: AbortSignal,
): Promise<any> {
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
        return handleHttp(inner, sandbox, signal);
      case "screenshot":
        throw new Error("screenshot is not available in ACP/local mode (desktop UI only)");
      default:
        if (name.startsWith("browser_")) {
          throw new Error(
            `browser tool "${name}" is not available in ACP/local mode (desktop UI only)`,
          );
        }
        throw new Error(`unknown host tool: ${name}`);
    }
    })();
    return redactToolResult(result, activeThreadSecrets(envelopeOwner));
  } finally {
    guard.release();
  }
}
