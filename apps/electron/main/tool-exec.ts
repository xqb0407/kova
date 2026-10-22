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

const MAX_TOOL_OUTPUT = 16 * 1024;
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
      killTree(child.pid!);
      break;
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
  const status = cancelled
    ? "\n[cancelled]"
    : exitCode === 0
      ? ""
      : exitCode === null
        ? `\n[timeout after ${Math.floor(timeoutMs / 1000)}s — output above is what was collected before the kill. For long-running commands pass runInBackground:true and poll with task_output, or split the work into shorter steps.]`
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
    slice = buf.toString("utf8") + "\n…[truncated]";
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
  guardJson(filePath, content);
  const full = resolvePath(cwd, filePath);
  const append = inner?.mode === "append";
  let isFile = false;
  try {
    isFile = statSync(full).isFile();
  } catch {
    isFile = false;
  }
  if (isFile) ensureFreshRead(full, filePath, append ? "append to" : "overwrite");
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
      output: `Appended ${contentBytes} bytes to ${filePath}`,
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
    output: `Wrote ${contentBytes} bytes to ${filePath}`,
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
    output: `Replaced ${count} occurrence(s) in ${filePath}`,
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
        return runBash(cwd, command, timeoutMs, guard, secrets, accel, sandbox);
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
      case "browser_scroll":
      case "browser_back": {
        const mod = await import("./browser");
        return mod.runTool(name, inner);
      }
      case "browser_shot": {
        const mod = await import("./browser");
        const url = typeof inner.url === "string" && inner.url.trim() ? inner.url.trim() : await mod.currentUrl();
        const shot = await import("./browser-shot");
        return shot.capture(url, typeof inner.maxDim === "number" ? inner.maxDim : null, typeof inner.quality === "number" ? inner.quality : null, guard);
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
