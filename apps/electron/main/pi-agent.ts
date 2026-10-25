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
import { libraryRoot } from "./library";
import { emitChunkBatch, emitToWindows, type ChunkBatchLine } from "./ipc";
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
let chunkBatch: ChunkBatchLine[] = [];
let chunkWindowTimer: NodeJS.Timeout | null = null;

function flushChunks(): void {
  if (chunkBatch.length === 0) return;
  const lines = chunkBatch;
  chunkBatch = [];
  if (chunkWindowTimer) {
    clearTimeout(chunkWindowTimer);
    chunkWindowTimer = null;
  }
  emitChunkBatch(lines);
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
  // 大行留痕：大附件（base64 图）会以一整条巨串走 stdin——渲染层 stringify、
  // IPC 克隆、这里入队、侧车 JSON.parse 各吃几百 ms；超 1MB 告警便于日后
  // 定位"发送后主线程空转"类问题（只记长度，不记内容——prompt 涉隐私）
  if (line.length > 1_000_000) logWarn(`[worker] large stdin line: ${line.length} chars`);
  return new Promise<void>((resolve, reject) => {
    writeQueue.push({ line, resolve, reject });
    if (!writing) void drainWrites();
  });
}
/** 单次 stdin 写入的等待上限。健康的侧车读循环节拍极快，30s 不吃一行 = 卡死；
 * 旧实现无上限：write 回调永不触发时整个写队列挂住，后续 prompt/host_result
 * 全部静默排队（"界面点什么都没反应"的根因之一），只有杀进程能解。 */
const STDIN_WRITE_TIMEOUT_MS = 30000;

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
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            rej(new Error("stdin-write-stalled"));
          }, STDIN_WRITE_TIMEOUT_MS);
          const ok = proc.stdin.write(item.line + "\n", (err) => {
            if (settled) return; // 超时后才到的回调：队列已按卡死处理，忽略
            settled = true;
            clearTimeout(timer);
            err ? rej(err) : res();
          });
          if (!ok) {
            /* 背压：等 drain 由 write 回调兜底（超时看门狗再兜一层） */
          }
        });
        item.resolve();
      } catch (e: any) {
        if (e?.message === "stdin-write-stalled") {
          // 侧车卡死不吃 stdin：杀掉它，让 close 事件走全套清场（冲刷 chunk、
          // 取消工具、pi-exit 换代自愈）——不清 child 句柄，close 里自己清
          logError(`[worker] stdin write stalled >${STDIN_WRITE_TIMEOUT_MS / 1000}s; killing wedged sidecar`);
          item.reject(new Error("pi-agent stdin stalled (killed wedged worker)"));
          while (writeQueue.length > 0) writeQueue.shift()!.reject(new Error("pi-agent stdin stalled"));
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
          break;
        }
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
        // 全局搜索的资料库文件索引用（与 library.ts libraryRoot 同源；
        // 它在 db 未就绪时回退缺省值，两者一致）
        PI_LIBRARY_ROOT: libraryRoot(),
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
      emitChunkBatch([
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

/** IM 回程 tap：无 id 自发帧的旁路消费者（im/router 按 sessionId 聚合回复）。
 *  与 setRemoteModule 同款装配模式——im 模块就绪后注册，未注册时零开销。 */
export type ImRouterTap = (parsed: Record<string, unknown>) => void;
let imRouterTap: ImRouterTap | null = null;
export function setImRouterTap(tap: ImRouterTap | null): void {
  imRouterTap = tap;
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
  // 宿主发起的管理请求（mgr-*）应答迟到了：配对表里已没有它 = 等待方早已超时
  // 摘除表项，这条应答无人认领。旧行为会掉进下面的"自发通知"分支被广播并塞进
  // chunk 流——前端收到一条谁也没等过的 mcp_servers/error 帧，纯噪声。只记日志。
  if (reqId && reqId.startsWith("mgr-")) {
    logWarn(`[worker] late reply dropped: ${reqId} type=${String(parsed?.type ?? "?")}`);
    return;
  }
  // 无 id 自发通知：远程广播；rem- 路由（远程响应回程）；IM 回程聚合
  const remote = safeRemote();
  remote?.broadcastNotification(parsed);
  if (remote?.tryRoute(parsed)) return;
  imRouterTap?.(parsed);

  if (chunkBatch.length === 0) {
    chunkWindowTimer = setTimeout(() => {
      flushChunks();
    }, CHUNK_BATCH_WINDOW_MS);
    chunkWindowTimer.unref?.();
  }
  const flushNow = isFlushLine(parsed) || chunkBatch.length + 1 >= CHUNK_BATCH_MAX;
  // 可裁剪的高频重行目前只有 message_update 这一种：带上会话键，供
  // emitChunkBatch 按窗口订阅裁剪（后台会话的增量不再跨进程送给不看它的
  // 窗口）。两个已知未覆盖项，别把这里当成"已覆盖全部热路径"：
  // - subagent_activity 的 text/thinking delta 也是逐条 send，且行上没有
  //   顶层 sessionId；消费端是全局 store（别的窗口启动的委派也要立条目），
  //   不能简单按父会话裁——需要 delegation 级观看集合，或接受快照补水合；
  // - legacy {id,chunk} token 行（text/reasoning start/delta/end）仍全量
  //   广播，而渲染层只消费 finish/error/start，退役 chunk 流才是干净解法。
  // 其余行（起止/收尾/data-* 旁路）都承载状态语义，必须保持全窗口可达。
  const sid = typeof parsed?.sessionId === "string" ? parsed.sessionId : null;
  const heavy = parsed?.type === "thread_event" && parsed?.event?.type === "message_update";
  chunkBatch.push({ l: line, sid, heavy });
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

/** 配对等待兜底：渲染层没传预算时才用（正常路径一律由渲染层按协议表传值）。
 *  取值 = pi-protocol/timeouts 的「未登记命令通道预算 + PAIR_SLACK_MS」
 *  （15s 地板 + 5s 渲染层余量 + 5s 本层余量），由 timeout-budget 测试钉住，
 *  别在这里改数字——要调就调那张表。 */
const DEFAULT_PAIR_TIMEOUT_MS = 20000;
/** 渲染层传来预算时，本层多等的余量：让渲染层先落定，错误是侧车的明确原因
 *  而非"主进程放弃"的含糊超时（外层必须比内层多等，见 pi-protocol/timeouts） */
const REQUEST_PAIR_SLACK_MS = 5000;
/** 单次请求的配对预算上限：授权流程最长也就几分钟，再多就是泄漏的表项 */
const MAX_REQUEST_PAIR_TIMEOUT_MS = 300000;

/** 管理类请求-响应：宿主注入 id，stdout 匹配行原样返回 */
export async function piRequest(args: { payload: any; timeoutMs?: number }): Promise<string> {
  await ensureSpawned();
  const reqId = `mgr-${newRequestId()}`;
  const msg = { ...(args.payload && typeof args.payload === "object" ? args.payload : {}) };
  if (args.payload && typeof args.payload === "object") msg.id = reqId;
  const waitMs =
    typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? Math.min(Math.max(args.timeoutMs, 1000), MAX_REQUEST_PAIR_TIMEOUT_MS) + REQUEST_PAIR_SLACK_MS
      : DEFAULT_PAIR_TIMEOUT_MS;
  const line = new Promise<string>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      pending.delete(reqId);
      reject(new Error(`pi-agent request ${reqId} unanswered after ${Math.round(waitMs / 1000)}s`));
    }, waitMs);
    const settle = (fn: () => void) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      fn();
    };
    pending.set(reqId, (l) => settle(() => resolve(l)));
    queueWrite(JSON.stringify(msg)).catch((e) =>
      settle(() => {
        pending.delete(reqId);
        reject(e);
      }),
    );
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
