/**
 * kova-automation 进程入口：只负责调度，不跑 agent。
 *
 * 与 sidecar 的边界：
 * - 任务定义、排期、锁、运行历史在本进程；
 * - 到点后向宿主发 automation_run_request，宿主转给 sidecar 执行 turn；
 * - sidecar 回 automation_run_result，本进程据此结算 runHistory。
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  FileSchedulerLock,
  JsonScheduledTaskStore,
  PersistentTaskScheduler,
  missedTaskIds,
  onceTasksToPurge,
  repairMissedOnce,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskRunContext,
  type ScheduledTaskUpdate,
} from "automation-core";
import * as triggers from "../automation/triggers";

const sessionsDir =
  process.env.KOVA_SESSIONS_DIR || process.env.PI_SESSIONS_DIR || "./sessions";
const automationDir = path.join(sessionsDir, "automation");
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

type RunWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const waiters = new Map<string, RunWaiter>();

function out(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** RPC 回执不能因为宿主正好关管道而变成 unhandled rejection。 */
function outSafe(message: unknown): void {
  try {
    out(message);
  } catch (error) {
    log(
      `failed to write stdout: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function log(message: string): void {
  process.stderr.write(`[automation] ${message}\n`);
}

function runTimeoutMs(task: ScheduledTask): number {
  return typeof task.timeoutMs === "number" && task.timeoutMs > 0
    ? task.timeoutMs
    : DEFAULT_RUN_TIMEOUT_MS;
}

/** runner 只发请求并等结果；真正的 agent turn 在 sidecar。 */
async function runViaHost(task: ScheduledTask, run: ScheduledTaskRunContext): Promise<void> {
  const requestId = randomUUID();
  const timeoutMs = runTimeoutMs(task);
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(requestId);
      reject(new Error(`automation run timed out after ${timeoutMs}ms`));
      // +30s：给 sidecar 的 abort/收尾留宽限，避免调度器先记 error、
      // sidecar 随后才把成功的 automation_run_done 发给 UI。
    }, timeoutMs + 30_000);
    timer.unref?.();
    waiters.set(requestId, {
      resolve,
      reject,
      timer,
    });
  });
  try {
    out({
      type: "automation_run_request",
      requestId,
      task,
      run,
      timeoutMs,
    });
  } catch (error) {
    // stdout 已断时不能留下孤儿 waiter，否则要等超时才结算。
    const waiter = waiters.get(requestId);
    if (waiter) {
      waiters.delete(requestId);
      clearTimeout(waiter.timer);
    }
    throw error;
  }
  await done;
}

function settleRun(message: {
  requestId?: unknown;
  ok?: unknown;
  error?: unknown;
}): void {
  const requestId = typeof message.requestId === "string" ? message.requestId : "";
  const waiter = waiters.get(requestId);
  if (!waiter) return;
  waiters.delete(requestId);
  clearTimeout(waiter.timer);
  if (message.ok === true) waiter.resolve();
  else waiter.reject(new Error(String(message.error ?? "automation run failed")));
}

function rejectAllWaiters(reason: string): void {
  for (const [id, waiter] of waiters) {
    waiters.delete(id);
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
  }
}

async function main(): Promise<void> {
  process.title = "Kova Automation";
  const scheduler = new PersistentTaskScheduler({
    store: new JsonScheduledTaskStore(path.join(automationDir, "tasks.json")),
    lock: new FileSchedulerLock(path.join(automationDir, "scheduler.lock")),
    runner: runViaHost,
    scope: {},
    maxConcurrentRuns: 2,
    maxTasks: 30,
    hooks: {
      onSchedulerStarted: ({ status }) => {
        log(`scheduler started, tasks: ${status.taskCount}`);
      },
      onTaskStarted: ({ task, run }) => {
        log(`run start: ${task.id}/${run.historyEntryId}`);
      },
      onTaskCompleted: ({ task, run }) => {
        log(`run done: ${task.id}/${run.historyEntryId}`);
      },
      onTaskFailed: ({ task, run, error }) => {
        log(`run failed: ${task.id}/${run.historyEntryId}: ${error}`);
      },
    },
  });

  // 与 sidecar 旧 initAutomation 相同的启动序列：GC → once 修复 → 补跑。
  const nowMs = Date.now();
  const preStart = await scheduler.list();
  for (const id of onceTasksToPurge(preStart, nowMs)) {
    await scheduler.delete(id);
  }
  await repairMissedOnce(scheduler, preStart, nowMs);
  const missed = missedTaskIds(preStart, nowMs);
  await scheduler.start();
  const active = scheduler.isActive();
  if (!active) {
    log("scheduler idle (lock held elsewhere)");
  }

  // 先报 ready 再补跑：补跑会经宿主请求 sidecar 执行 turn，而 sidecar 启动
  // 又要等 automation RPC 就绪；若在 ready 前 await runNow 会形成启动死锁。
  out({ type: "automation_service_ready", pid: process.pid });

  if (active && missed.length > 0) {
    log(`catch-up run for ${missed.length} missed task(s)`);
    // 等 stdin 监听挂好再触发：否则极快的 run result 可能先于 readline 到达。
    setImmediate(() => {
      void (async () => {
        for (const id of missed) {
          await scheduler.runNow(id).catch((error) => {
            log(
              `catch-up run ${id} failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
      })();
    });
  }

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      log("ignored non-JSON stdin line");
      return;
    }

    if (message.type === "ping") {
      out({ type: "pong", id: message.id });
      return;
    }
    if (message.type === "automation_run_result") {
      settleRun(message);
      return;
    }
    if (message.type === "shutdown") {
      void scheduler.stop().finally(() => {
        rejectAllWaiters("automation service shutting down");
        process.exit(0);
      });
      return;
    }

    const id = typeof message.id === "string" ? message.id : "";
    const method = typeof message.method === "string" ? message.method : "";
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (!id || !method) return;

    void handleRpc(scheduler, method, params)
      .then((data) => outSafe({ id, ok: true, data: data ?? null }))
      .catch((error) => {
        outSafe({
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  rl.on("close", () => {
    void scheduler.stop().finally(() => {
      rejectAllWaiters("automation service stdin closed");
      process.exit(0);
    });
  });
}

/**
 * JSON 无法承载 undefined。远程代理会把“显式要清空”的字段编码成 null；
 * 这里还原成 undefined，让 core.update 的 own-key 语义继续生效。
 */
function decodeScheduledTaskUpdate(raw: unknown, undefinedKeys: unknown): ScheduledTaskUpdate {
  const input = { ...(raw as Record<string, unknown>) } as ScheduledTaskUpdate;
  if (Array.isArray(undefinedKeys)) {
    for (const key of undefinedKeys) {
      if (typeof key === "string" && key in input && input[key as keyof ScheduledTaskUpdate] === null) {
        input[key as keyof ScheduledTaskUpdate] = undefined;
      }
    }
  }
  return input;
}

async function handleRpc(
  scheduler: PersistentTaskScheduler,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "list":
      return scheduler.list();
    case "get":
      return scheduler.get(String(params.taskId ?? ""));
    case "status":
      return scheduler.status();
    case "create":
      return scheduler.create(params.input as ScheduledTaskCreateInput);
    case "update":
      return scheduler.update(
        String(params.taskId ?? ""),
        decodeScheduledTaskUpdate(params.input, params.undefinedKeys),
      );
    case "delete":
      return scheduler.delete(String(params.taskId ?? ""));
    case "delete_history":
      return scheduler.deleteHistory(
        String(params.taskId ?? ""),
        params.entryIds === "all"
          ? "all"
          : Array.isArray(params.entryIds)
            ? params.entryIds.filter((value): value is string => typeof value === "string")
            : [],
      );
    case "run_now":
      return scheduler.runNow(String(params.taskId ?? ""));
    case "get_webhook_trigger": {
      // main 的 webhook 验签查 secret；只回最小字段（secret/enabled/taskId）。
      const t = triggers.getTrigger(String(params.triggerId ?? ""));
      if (!t || t.config.type !== "webhook") return null;
      return {
        enabled: t.enabled,
        secret: t.config.secret,
        taskId: t.taskId,
      };
    }
    case "run_with_trigger": {
      // L1：事件触发入口。trigger 形状在 sidecar 侧校验（core 的 runWithContext
      // 只透传；这里守门防 RPC 层塞任意字段进 runHistory/Inbox）。
      const raw = (params.trigger ?? {}) as Record<string, unknown>;
      const type = raw.type;
      if (
        type !== "webhook" && type !== "file" && type !== "git" && type !== "im" && type !== "manual"
      ) {
        throw new Error("run_with_trigger: invalid trigger.type");
      }
      const summary = typeof raw.summary === "string" ? raw.summary.slice(0, 200) : undefined;
      const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 64) : undefined;
      return scheduler.runWithContext(String(params.taskId ?? ""), {
        type,
        ...(id ? { id } : {}),
        ...(summary ? { summary } : {}),
      });
    }
    case "start":
      await scheduler.start();
      return scheduler.status();
    case "stop":
      await scheduler.stop();
      return scheduler.status();
    default:
      throw new Error(`unknown automation method: ${method}`);
  }
}

void main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
