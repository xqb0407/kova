/**
 * kova-automation 进程监督器。
 *
 * 调度器独立于 sidecar：本文件只负责 spawn、请求配对、崩溃重启，以及把
 * scheduler 的 automation_run_request 转给 sidecar（piRequest）执行。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { sessionsDir } from "./paths";
import { logError, logInfo, logWarn } from "./logging";
import {
  clearInheritedProxyEnv,
  resolveSidecarProxy,
} from "./system-proxy";
import { readNetworkProxyConfig } from "./network-proxy-config";
import { piAbort, piRequestInternal, redactSecrets } from "./pi-agent";
import { guardStreamErrors } from "./child-stream";
import { resetTrayRunning } from "./tray-status";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, Pending>();
/** requestId -> sidecar automation threadId：scheduler 进程死亡时中止仍在跑的 turn。 */
const activeRuns = new Map<string, string>();
let child: ChildProcessWithoutNullStreams | null = null;
let spawning: Promise<void> | null = null;
let readyResolve: (() => void) | null = null;
let readyReject: ((error: Error) => void) | null = null;
let readyTimer: NodeJS.Timeout | null = null;
let ready = false;
let shuttingDown = false;
let nextId = 1;

function automationBinaryPath(): string {
  const names =
    process.platform === "win32"
      ? ["kova-automation.exe", "kova-automation"]
      : ["kova-automation"];
  const candidates = [
    process.env.KOVA_AUTOMATION_BIN ?? "",
    ...(process.resourcesPath
      ? names.map((name) => join(process.resourcesPath, "binaries", name))
      : []),
    ...names.map((name) => join(__dirname, "..", "binaries", name)),
    ...names.map((name) => join(__dirname, "..", "..", "binaries", name)),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `kova-automation binary not found (looked: ${candidates.join(", ")})`,
  );
}

function settle(id: string, ok: boolean, value: unknown): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (ok) entry.resolve(value);
  else entry.reject(new Error(String(value ?? "automation request failed")));
}

function rejectAll(reason: string): void {
  for (const [id, entry] of pending) {
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
}

/** scheduler 不在了：中止 sidecar 仍在跑的 automation turn，避免 UI 与历史分叉。 */
function abortActiveRuns(reason: string): void {
  if (activeRuns.size === 0) return;
  const threads = [...activeRuns.values()];
  activeRuns.clear();
  for (const threadId of threads) {
    void piAbort({ threadId }).catch((error) =>
      logWarn(`[automation] abort run failed (${reason}): ${error}`),
    );
  }
}

async function handleRunRequest(message: Record<string, unknown>): Promise<void> {
  const requestId =
    typeof message.requestId === "string" ? message.requestId : "";
  if (!requestId) return;
  // App 正在退出：不要再向 sidecar 投递新的 agent turn。
  if (shuttingDown) return;
  const task = message.task as { id?: unknown } | undefined;
  const run = message.run as { historyEntryId?: unknown } | undefined;
  const threadId =
    typeof task?.id === "string" && typeof run?.historyEntryId === "string"
      ? `automation:${task.id}:${run.historyEntryId}`
      : null;
  if (threadId) activeRuns.set(requestId, threadId);
  const timeoutMs =
    typeof message.timeoutMs === "number" && message.timeoutMs > 0
      ? message.timeoutMs
      : 10 * 60 * 1000;
  try {
    const line = await piRequestInternal({
      payload: {
        type: "automation_run",
        task: message.task,
        run: message.run,
      },
      // scheduler 侧的 runner 等待是 task.timeoutMs + 30s；这里再传 +30s、
      // 加上 piRequest 的 5s slack，让 sidecar 的最终 result 一定先到。
      timeoutMs: timeoutMs + 30_000,
      // 自动化默认 timeout 是 10 分钟，高于 piRequest 的 5 分钟管理命令上限。
      maxTimeoutMs: timeoutMs + 60_000,
    });
    const parsed = JSON.parse(line) as {
      ok?: unknown;
      sessionId?: unknown;
      error?: unknown;
    };
    sendSafe({
      type: "automation_run_result",
      requestId,
      ok: parsed.ok === true,
      sessionId:
        typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      error:
        parsed.ok === true
          ? undefined
          : typeof parsed.error === "string"
            ? parsed.error
            : "automation run failed",
    });
  } catch (error) {
    sendSafe({
      type: "automation_run_result",
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    activeRuns.delete(requestId);
  }
}

function send(message: unknown): void {
  if (!child) throw new Error("automation service is not running");
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** 回执给调度器：进程可能刚好退出，不能因为 EPIPE 变成未处理 rejection。 */
function sendSafe(message: unknown): void {
  try {
    send(message);
  } catch (error) {
    logWarn(
      `[automation] failed to reply scheduler: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function handleLine(line: string): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    logWarn(`[automation] ignored non-JSON line: ${line.slice(0, 200)}`);
    return;
  }
  if (message.type === "automation_service_ready") {
    logInfo("[automation] scheduler ready");
    ready = true;
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    readyResolve?.();
    readyResolve = null;
    readyReject = null;
    return;
  }
  if (message.type === "automation_run_request") {
    void handleRunRequest(message).catch((error) =>
      logError(`[automation] run request failed: ${error}`),
    );
    return;
  }
  if (message.type === "pong") return;
  const id = typeof message.id === "string" ? message.id : "";
  if (id) settle(id, message.ok === true, message.ok === true ? message.data : message.error);
}

/** 启动前探测：二进制缺失时 main 先切 in-process，避免 sidecar 远程超时后
 *  本地/远程两套调度器短暂并存。 */
export function automationBinaryAvailable(): boolean {
  try {
    automationBinaryPath();
    return true;
  } catch {
    return false;
  }
}

/**
 * 任务是否正在执行（L1b：文件触发器防自触）。
 * 调度器把每次运行作为 automation_run_request 发来，activeRuns 记着
 * `automation:<taskId>:<historyEntryId>`；运行期间跳过同任务的文件触发，
 * 避免 agent 写工作区文件 → 再触发自己。
 * dev 进程内模式 main 看不到 run 请求，返回 false（只剩冷却窗口兜底）。
 */
export function isAutomationTaskRunning(taskId: string): boolean {
  if (!taskId) return false;
  const prefix = `automation:${taskId}:`;
  for (const threadId of activeRuns.values()) {
    if (threadId.startsWith(prefix)) return true;
  }
  return false;
}

export async function ensureAutomationSpawned(): Promise<void> {
  if (process.env.KOVA_AUTOMATION_INPROC === "1") {
    throw new Error("automation service disabled (KOVA_AUTOMATION_INPROC=1)");
  }
  if (shuttingDown) {
    throw new Error("automation service is shutting down");
  }
  if (child && ready) return;
  if (spawning) return spawning;
  spawning = (async () => {
    const bin = automationBinaryPath();
    const proxyPlan = await resolveSidecarProxy(readNetworkProxyConfig());
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (proxyPlan.clearInherited) clearInheritedProxyEnv(childEnv);
    const proc = spawn(bin, [], {
      cwd: process.env.KOVA_WORKER_CWD || undefined,
      env: {
        ...childEnv,
        ...proxyPlan.env,
        KOVA_SESSIONS_DIR: sessionsDir(),
        PI_SESSIONS_DIR: sessionsDir(),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc as ChildProcessWithoutNullStreams;
    ready = false;
    // 换代：旧调度进程的在跑轮已中止，托盘「运行中」清零等新帧
    resetTrayRunning();
    let spawnFailed = false;
    logInfo("[automation] scheduler spawned");

    // 先建 ready promise 再挂 stdout 监听：调度器可能在监听建立后、
    // await 到达前就发出 ready，晚注册 resolver 会把这一帧丢掉。
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
      readyTimer = setTimeout(() => {
        readyTimer = null;
        readyReject = null;
        reject(new Error("automation service did not become ready in 10s"));
      }, 10_000);
      readyTimer.unref?.();
    });

    guardStreamErrors(proc.stdin, (error) =>
      logWarn(`[automation] stdin error: ${error.message}`),
    );
    guardStreamErrors(proc.stdout, (error) =>
      logWarn(`[automation] stdout error: ${error.message}`),
    );
    guardStreamErrors(proc.stderr, (error) =>
      logWarn(`[automation] stderr error: ${error.message}`),
    );

    const stdout = createInterface({ input: proc.stdout });
    stdout.on("line", (line) => {
      // 换代后旧进程残余的 stdout 行不能结算新进程的请求/ready。
      if (child === proc) handleLine(line);
    });
    const stderr = createInterface({ input: proc.stderr });
    stderr.on("line", (line) => {
      if (child === proc) {
        logWarn(`[automation:stderr] ${redactSecrets(line)}`);
      }
    });

    proc.on("error", (error) => {
      logError(`[automation] ${error.message}`);
      // spawn 失败（二进制缺失/不可执行）不要进 1s 重启循环；让下一次 RPC
      // 或 sidecar 的 in-process 回退处理。ready 后运行期错误仍自动重启。
      if (!ready) {
        spawnFailed = true;
        readyReject?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    proc.on("close", (code) => {
      if (child !== proc) return;
      const wasReady = ready;
      child = null;
      ready = false;
      readyResolve = null;
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      const closeError = new Error("automation service terminated");
      readyReject?.(closeError);
      readyReject = null;
      rejectAll("automation service terminated");
      abortActiveRuns("scheduler exited");
      logWarn(`[automation] terminated ${code}${wasReady ? "" : " before ready"}`);
      // 未 ready 就退出通常是二进制/启动阶段不可用：不自动重试，交给 sidecar
      // 进程内回退；已 ready 后崩溃才自动拉起，避免本地/远程两套调度器并存。
      if (!shuttingDown && !spawnFailed && wasReady) {
        setTimeout(() => {
          void ensureAutomationSpawned().catch((error) =>
            logError(`[automation] restart failed: ${error}`),
          );
        }, 1_000).unref?.();
      }
    });

    try {
      proc.stdin.write(
        `${JSON.stringify({ type: "ping", id: "automation-startup" })}\n`,
      );
    } catch (error) {
      readyReject?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    try {
      await readyPromise;
    } catch (error) {
      if (child === proc) child = null;
      ready = false;
      readyResolve = null;
      readyReject = null;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      throw error;
    }
  })();
  try {
    await spawning;
  } finally {
    spawning = null;
  }
}

export async function automationRpc(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<unknown> {
  await ensureAutomationSpawned();
  const id = `automation-${nextId++}`;
  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`automation ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    try {
      send({ id, method, params });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** 资源管理器采样用：当前 scheduler 子进程 pid（未启动/进程内模式为 null）。 */
export function automationChildPid(): number | null {
  return child?.pid ?? null;
}

/** 是否真的拉起了独立调度器（dev 的 KOVA_AUTOMATION_INPROC 模式为 false）。 */
export function automationServiceRunning(): boolean {
  return child !== null;
}

/**
 * 退出确认阶段先关闸：阻止 scheduler 在逐项停止期间再派发新的 automation run。
 * 只置内存位，不杀进程——用户取消退出时必须能恢复，见 endAutomationShutdown。
 */
export function beginAutomationShutdown(): void {
  shuttingDown = true;
}

/** 退出被取消：恢复 scheduler 的派发能力（未杀进程，复位即可）。 */
export function endAutomationShutdown(): void {
  shuttingDown = false;
}

/** 强制退出：不等 2s 优雅关闭，直接收掉调度器与在飞 run。 */
export function killAutomationNow(): void {
  shuttingDown = true;
  const proc = child;
  child = null;
  ready = false;
  readyResolve = null;
  readyReject?.(new Error("automation service killed"));
  readyReject = null;
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
  rejectAll("automation service killed");
  abortActiveRuns("service killed");
  if (!proc) return;
  try {
    proc.kill("SIGKILL");
  } catch {
    /* 已退出：忽略 */
  }
}

export async function stopAutomationService(): Promise<void> {
  shuttingDown = true;
  const proc = child;
  if (!proc) {
    abortActiveRuns("service stopped");
    return;
  }
  try {
    proc.stdin.write('{"type":"shutdown"}\n');
  } catch {
    /* already closed */
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    proc.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child === proc) {
    // close handler 会因 child===null 提前 return：超时强杀时这里自己
    // 结算 ready/pending，否则启动中的 ensure 和 RPC 调用会一直挂到超时。
    ready = false;
    readyResolve = null;
    readyReject?.(new Error("automation service stopped"));
    readyReject = null;
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    rejectAll("automation service stopped");
    abortActiveRuns("service stopped");
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    child = null;
  }
}
