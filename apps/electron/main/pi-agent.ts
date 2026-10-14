/**
 * pi-agent sidecar 桥（对齐 pi_agent.rs 全契约）：spawn bun 编译产物、
 * NDJSON stdio、host_cancel/host_query/请求配对/chunk 合帧（20ms/64 行）、
 * stderr 脱敏落盘、退出清场、shutdown 宽限。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { appDataDir, sessionsDir } from "./paths";
import { emitToWindows } from "./ipc";
import { logError, logInfo, logWarn, writeSidecarLine } from "./logging";
import { getDb } from "./store";
import { dispatchHostQuery } from "./data";
import { cancelAllTools, cancelTool, cancelToolsByOwner } from "./tool-exec";

let child: ChildProcessWithoutNullStreams | null = null;
let spawning: Promise<void> | null = null;
const pending = new Map<string, (line: string) => void>();

let nextReqSeq = 1;
function newRequestId(): string {
  return `pi-${nextReqSeq++}`;
}

const CHUNK_BATCH_WINDOW_MS = 20;
const CHUNK_BATCH_MAX = 64;
let chunkBatch: { l: string }[] = [];
let chunkWindowTimer: NodeJS.Timeout | null = null;

function flushChunks(): void {
  if (chunkBatch.length === 0) return;
  const lines = chunkBatch;
  chunkBatch = [];
  if (chunkWindowTimer) {
    clearTimeout(chunkWindowTimer);
    chunkWindowTimer = null;
  }
  emitToWindows("pi-chunk-batch", lines);
}

/** 对齐 is_flush_line：finish/error chunk、非 chunk 行、裸行走立即冲刷；thread_event 走合帧 */
function isFlushLine(parsed: any): boolean {
  if (parsed == null) return true;
  if (parsed.type === "thread_event") return false;
  const ct = parsed.chunk?.type;
  if (ct === "finish" || ct === "error") return true;
  return ct === undefined;
}

/** sidecar stderr 脱敏（对齐 redact_secrets）：sk- 长 token 与 Bearer 打码 */
export function redactSecrets(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input.startsWith("sk-", i)) {
      let j = i + 3;
      while (j < input.length && /[A-Za-z0-9_\-]/.test(input[j])) j++;
      if (j - i > 10) {
        out += "sk-***";
        i = j;
        continue;
      }
    }
    if (input.startsWith("Bearer ", i)) {
      let j = i + 7;
      while (j < input.length && !/[\s",]/.test(input[j])) j++;
      out += "Bearer ***";
      i = j;
      continue;
    }
    out += input[i];
    i += 1;
  }
  return out;
}

function sidecarBinaryPath(): string {
  // 打包环境：resources/binaries/；开发环境：apps/electron/binaries/
  const here = __dirname;
  // Windows 产物带 .exe 后缀（构建脚本在 win 上输出 kova-worker.exe）
  const names = process.platform === "win32" ? ["kova-worker.exe", "kova-worker"] : ["kova-worker"];
  const candidates = [
    process.env.KOVA_WORKER_BIN ?? "",
    ...(process.resourcesPath ? names.map((n) => join(process.resourcesPath, "binaries", n)) : []),
    ...names.map((n) => join(here, "..", "binaries", n)),
    ...names.map((n) => join(here, "..", "..", "binaries", n)),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`kova-worker sidecar binary not found (looked: ${candidates.join(", ")})`);
}

function dirnameOf(p: string): string {
  return p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
}

/** 行序写入队列：stdin 写完整行并按序 flush，杜绝并发交织
 *（对齐 Rust child Mutex 行原子性） */
const writeQueue: { line: string; resolve: () => void; reject: (e: any) => void }[] = [];
let writing = false;
function queueWrite(line: string): Promise<void> {
  if (!child) return Promise.reject(new Error("pi-agent is not running"));
  return new Promise<void>((resolve, reject) => {
    writeQueue.push({ line, resolve, reject });
    if (!writing) void drainWrites();
  });
}
async function drainWrites(): Promise<void> {
  writing = true;
  try {
    while (writeQueue.length > 0) {
      const item = writeQueue.shift()!;
      const proc = child;
      if (!proc) {
        item.reject(new Error("pi-agent is not running"));
        continue;
      }
      try {
        await new Promise<void>((res, rej) => {
          const ok = proc.stdin.write(item.line + "\n", (err) => (err ? rej(err) : res()));
          if (!ok) {
            /* 背压：等 drain 由 write 回调兜底（回调在 flush 完成时触发） */
          }
        });
        item.resolve();
      } catch (e: any) {
        // 管道破裂 = 子进程已死：清句柄，剩余队列全部拒绝，下次 ensureSpawned 自动重启
        if (child === proc) child = null;
        item.reject(new Error(`failed to write to pi-agent stdin: ${e?.message ?? e}`));
        while (writeQueue.length > 0) writeQueue.shift()!.reject(new Error("pi-agent is not running"));
        break;
      }
    }
  } finally {
    writing = false;
  }
}

export async function ensureSpawned(): Promise<void> {
  if (child) return;
  if (spawning) return spawning;
  spawning = (async () => {
    const bin = sidecarBinaryPath();
    const dataDir = appDataDir();
    const proc = spawn(bin, [], {
      env: {
        ...process.env,
        PI_DB_PATH: join(dataDir, "state.db"),
        PI_SESSIONS_DIR: sessionsDir(),
        PI_TASK_CWD: join(dataDir, "task-workspace"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc as ChildProcessWithoutNullStreams;
    logInfo("[worker] sidecar spawned");

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => void handleLine(line));

    const rlErr = createInterface({ input: proc.stderr });
    rlErr.on("line", (line) => {
      const text = redactSecrets(line);
      writeSidecarLine(text);
    });

    proc.on("error", (e) => {
      logError(`[worker] ${e.message}`);
      flushChunks();
      emitToWindows("pi-chunk-batch", [
        { l: `{"id":null,"chunk":{"type":"error","errorText":${JSON.stringify(String(e.message))}}}` },
      ]);
    });

    proc.on("close", (code) => {
      if (child !== proc) return; // 被新句柄顶替：本次 close 不管全局状态
      flushChunks();
      cancelAllTools();
      const leftover = [...pending.values()];
      pending.clear();
      for (const cb of leftover) cb('{"type":"error","errorText":"pi-agent terminated"}');
      const remote = safeRemote();
      remote?.notifyTerminated();
      emitToWindows("pi-exit", String(code ?? -1));
      child = null;
      logWarn(`[worker] terminated ${code}`);
    });
  })();
  try {
    await spawning;
  } finally {
    spawning = null;
  }
}

function safeRemote(): typeof import("./remote") | null {
  try {
    // remote 是 P2 模块：未装配时静默跳过（对齐 Rust 中远程广播的可选性）
    return requireRemote();
  } catch {
    return null;
  }
}
let remoteMod: typeof import("./remote") | null = null;
function requireRemote(): typeof import("./remote") {
  if (remoteMod === null) throw new Error("remote not ready");
  return remoteMod;
}
/** remote.ts 装配后注册（避免循环依赖） */
export function setRemoteModule(m: typeof import("./remote")): void {
  remoteMod = m;
}

async function handleLine(line: string): Promise<void> {
  let parsed: any = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = null;
  }
  const msgType = parsed?.type;
  if (msgType === "host_cancel") {
    const id = typeof parsed?.id === "string" ? parsed.id : "";
    // 可观测性：取消链路（sidecar abort → host_cancel → 杀进程树）此前无日志，
    // 排查"中断后工具进程还在"时无从判断是本侧没杀还是对端没发
    logInfo(`[tool-cancel] host_cancel id=${id || "<empty>"}`);
    if (id) cancelTool(id);
    return;
  }
  if (msgType === "host_query") {
    const kind = typeof parsed?.kind === "string" ? parsed.kind : "?";
    if (process.env.KOVA_LOG_HOST_QUERY) logInfo(`[host_query] recv ${kind} id=${parsed?.id ?? ""}`);
    try {
      const reply = await dispatchHostQuery(getDb(), parsed);
      if (process.env.KOVA_LOG_HOST_QUERY) logInfo(`[host_query] reply ${kind} bytes=${reply.length}`);
      if (child) queueWrite(reply).catch(() => undefined);
    } catch (e: any) {
      // 绝不能静默：无回帧时侧车要干等满 15s 超时（初始化里几十步串起来=界面几分钟空白）
      logError(`[host_query] ${kind} failed before reply: ${e?.message ?? e}`);
      if (child) {
        const id = typeof parsed?.id === "string" ? parsed.id : "";
        queueWrite(
          JSON.stringify({ type: "host_result", id, ok: false, error: String(e?.message ?? e) }),
        ).catch(() => undefined);
      }
    }
    return;
  }
  const reqId = typeof parsed?.id === "string" ? parsed.id : null;
  if (reqId && pending.has(reqId)) {
    pending.get(reqId)!(line);
    pending.delete(reqId);
    return;
  }
  // 无 id 自发通知：远程广播；rem- 路由（远程响应回程）
  const remote = safeRemote();
  remote?.broadcastNotification(parsed);
  if (remote?.tryRoute(parsed)) return;

  if (chunkBatch.length === 0) {
    chunkWindowTimer = setTimeout(() => {
      flushChunks();
    }, CHUNK_BATCH_WINDOW_MS);
    chunkWindowTimer.unref?.();
  }
  const flushNow = isFlushLine(parsed) || chunkBatch.length + 1 >= CHUNK_BATCH_MAX;
  chunkBatch.push({ l: line });
  if (flushNow) flushChunks();
}

/* ------------------------------ commands ------------------------------ */

async function writeLine(line: string): Promise<void> {
  await ensureSpawned();
  await queueWrite(line);
}

export async function piPrompt(args: {
  requestId: string;
  text: string;
  threadId?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  attachments?: unknown;
  steer?: boolean | null;
  goalMaxAutoTurns?: number | null;
}): Promise<null> {
  await ensureSpawned();
  const payload = {
    type: "prompt",
    id: args.requestId,
    text: args.text,
    threadId: args.threadId ?? null,
    sessionId: args.sessionId ?? null,
    cwd: args.cwd ?? null,
    attachments: args.attachments ?? null,
    steer: args.steer ?? null,
    goalMaxAutoTurns: args.goalMaxAutoTurns ?? null,
  };
  await writeLine(JSON.stringify(payload));
  return null;
}

export async function piAbort(args: { threadId?: string | null }): Promise<null> {
  const threadId = args.threadId ?? null;
  await writeLine(JSON.stringify({ type: "abort", threadId }));
  // 联动取消宿主内在该线程跑的（前台）工具：否则用户点了"停止"，bash 还会跑到超时
  const cancelled = cancelToolsByOwner(threadId);
  if (cancelled > 0) {
    logInfo(`[tool-cancel] abort(thread=${threadId ?? "all"}) killed ${cancelled} in-flight tool(s)`);
  }
  return null;
}

export async function piReset(): Promise<null> {
  await ensureSpawned();
  await writeLine(JSON.stringify({ type: "new_session", id: newRequestId() }));
  return null;
}

/** 管理类请求-响应：宿主注入 id，stdout 匹配行原样返回 */
export async function piRequest(args: { payload: any }): Promise<string> {
  await ensureSpawned();
  const reqId = `mgr-${newRequestId()}`;
  const msg = { ...(args.payload && typeof args.payload === "object" ? args.payload : {}) };
  if (args.payload && typeof args.payload === "object") msg.id = reqId;
  const line = new Promise<string>((resolve, reject) => {
    pending.set(reqId, resolve);
    queueWrite(JSON.stringify(msg)).catch((e) => {
      pending.delete(reqId);
      reject(e);
    });
  });
  return line;
}

const SHUTDOWN_GRACE_MS = 6000;

/** 优雅终止（对齐 kill_on_exit）：stdin 写 shutdown，轮询句柄清空（close 回调）最多 6s，兜底 SIGKILL */
export async function killOnExit(): Promise<void> {
  if (!child) return;
  const proc = child;
  let sent = false;
  try {
    if (proc.stdin.writable) {
      proc.stdin.write('{"type":"shutdown"}\n');
      sent = true;
    }
  } catch {
    sent = false;
  }
  if (sent) {
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (child === proc && Date.now() < deadline) {
      await sleep(50);
    }
  }
  if (child === proc) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    child = null;
  }
}

export function piAgentRunning(): boolean {
  return child !== null;
}

/** 原始行写入（远程网关透传 authed 消息用；与 pi_* 命令同一条队列） */
export async function writeRawLine(line: string): Promise<void> {
  await writeLine(line);
}

export function piAgentChildPid(): number | null {
  return child?.pid ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
