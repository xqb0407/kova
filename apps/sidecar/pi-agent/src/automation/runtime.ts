/**
 * 本地文件（非 vendored，见 index.ts 溯源头）：调度器的 sidecar 装配层。
 *
 * Mode 2（宿主控制）：生命周期归 sidecar 入口（index.ts），
 * 任务定义存 <sessionsDir>/automation/tasks.json（原子写 + .bak 自愈），
 * 单实例锁 <sessionsDir>/automation/scheduler.lock（PID 文件锁，防多进程双触发）。
 * scope 传 {}：自动化是应用级资产，不按来源会话隔离（上游 CLI 语义的刻意差异）。
 *
 * 本地扩展（见 NOTICE.md 差异清单）：启动补跑 —— 上游对停机期间错过的运行
 * 不补偿（cron 只排未来 tick；过期 once 直接被 markScheduleError 停用），
 * 这里在 start 前按"上次触发时刻 vs 排期"判定错过，错过的 enabled 任务经
 * 公开 API runNow 合并补跑一次（多个错过的 tick 只补一次）。
 * 注意：不能用持久化的 nextRunAt 判定错过 —— store 的 normalizeScheduledTask
 * 在每次 create/update/load 都把它重算到未来时点（cron 取下一个 tick、
 * interval 取 now+周期），错过的历史事实活不到 start 前的快照里。
 */
import path from "node:path";
import { Cron } from "croner";
import { logErr } from "../log";
import { send } from "../protocol/stream";
import {
  FileSchedulerLock,
  JsonScheduledTaskStore,
  PersistentTaskScheduler,
  scheduleExpressionForCroner,
  type ScheduledTask,
  type ScheduledTaskRunner,
  type TaskScheduler,
} from "./index";
import { getAutomationRunSession } from "./runner";

let scheduler: PersistentTaskScheduler | null = null;

// initAutomation 完成（或失败）时结算：automation_* 命令据此等待 start() 后
// 再动作（runNow 在 !active 的 execute 里会静默 no-op，失败路径也必须放行，
// 否则命令永久挂起）
let readyResolve: () => void = () => {};
const readyPromise = new Promise<void>((resolve) => {
  readyResolve = resolve;
});

/** initAutomation 已走完（含失败）；协议命令在操作调度器前 await 它 */
export function whenAutomationReady(): Promise<void> {
  return readyPromise;
}

/** 补跑上限：长时间停机也最多一次性拉起 N 个（其余留待下次启动，防惊群） */
const CATCHUP_LIMIT = 5;

function isExpiredAt(iso: string | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t <= nowMs;
}

/**
 * 上次触发时刻（epoch ms）：runHistory 最新一条在 execute 进入时即以
 * startedAt 落库（成败都有），故比 lastRunAt（仅成功更新）更贴合"最后
 * 一次真正开跑"；都没有则退回 createdAt（建任务后从未跑过）。
 * 这三组字段 normalize 都原样保留，跨进程重启可信。
 * 注意跳过 paused/resumed 记账条（开关排期会追加，不是"触发过"——
 * 否则停机前刚 resume 的任务会被误判为刚跑过而漏补）。
 */
function lastFiredAtMs(task: ScheduledTask): number {
  const entries = task.runHistory ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || (e.status !== "running" && e.status !== "success" && e.status !== "error")) {
      continue;
    }
    const t = new Date(e.createdAt).getTime();
    if (Number.isFinite(t)) return t;
  }
  const lr = new Date(task.lastRunAt ?? "").getTime();
  if (Number.isFinite(lr)) return lr;
  // 从未跑过：以 max(createdAt, updatedAt) 起排 —— 刚建/刚启用/刚编辑的
  // 任务视为"从该时刻起才开始有期望格"，不补更老的 tick
  const c = new Date(task.createdAt).getTime();
  const u = new Date(task.updatedAt ?? "").getTime();
  return Math.max(Number.isFinite(c) ? c : 0, Number.isFinite(u) ? u : 0);
}

/**
 * 错过判定的核心（返回"最早被错过的那个 tick 时刻"，未错过返回 undefined）。
 * 判据 = 上次触发之后存在已经到点的 tick：
 * - cron: croner 无 prevRun，等价用 nextRun(lastFired) ≤ now —— 上次触发
 *   之后的下一格排期已过期 = 停机期间至少错过一格（失败触发的格子也算
 *   "已触发过"，故运行失败不会被重复补偿，下个 tick 照常）
 * - interval: now - lastFired ≥ 周期 —— 停机跨过了一格即视为错过
 *   （可防"每日整点报表"类任务在长停机后整日静默）
 * 已 disabled 不补；once 不走这里（由 repairMissedOnce 改写触发点处理）；
 * 非法 cron 表达式不补（start 自家 schedule() 会 markScheduleError）。
 */
export function missedTickDueMs(task: ScheduledTask, nowMs: number): number | undefined {
  if (!task.enabled || task.type === "once") return undefined;
  const last = lastFiredAtMs(task);
  if (task.type === "interval") {
    const due = last + task.intervalSeconds * 1000;
    return due <= nowMs ? due : undefined;
  }
  try {
    const cron = new Cron(scheduleExpressionForCroner(task.schedule), { paused: true });
    const next = cron.nextRun(new Date(last));
    cron.stop();
    return next && next.getTime() <= nowMs ? next.getTime() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * start 前快照 → 应补跑的任务 id 列表。错过的格子不重放历史（那是
 * 上游语义），合并为现在 runNow 补跑一次；按错过时刻升序（最"陈旧"先补，
 * 超上限的留到下次启动）。
 */
export function missedTaskIds(snapshot: ScheduledTask[], nowMs: number): string[] {
  const withDue = snapshot
    .map((task) => ({ id: task.id, due: missedTickDueMs(task, nowMs) }))
    .filter((x): x is { id: string; due: number } => x.due !== undefined);
  withDue.sort((a, b) => a.due - b.due);
  return withDue.slice(0, CATCHUP_LIMIT).map((x) => x.id);
}

/**
 * M4.2 死任务 GC：成功完成的 once（成功后调度器自动 disable）自最后一次
 * 成功运行起保留 ONCE_RETENTION_MS，超时在启动装配时删除，列表不堆积死任务。
 * 从未跑过/失败停用（无 lastRunAt）的 once 不动 —— 那是用户显式创建的意图。
 */
const ONCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function onceTasksToPurge(
  snapshot: ScheduledTask[],
  nowMs: number,
  retentionMs: number = ONCE_RETENTION_MS,
): string[] {
  return snapshot
    .filter(
      (task) =>
        task.type === "once" &&
        !task.enabled &&
        isExpiredAt(task.lastRunAt, nowMs - retentionMs),
    )
    .map((task) => task.id);
}

/**
 * 过期 once 修复：enabled 且计划时刻已过 = 从未成功（成功后自动 disable）。
 * start 前把 schedule 改写到"马上"（各自错开一点），复用上游自家 once 定时器
 * 即时开跑；若不修，schedule() 会对过期 once 直接 markScheduleError——
 * 停用任务还先发一帧假"运行失败"通知。超上限的留待原行为停用。
 */
export async function repairMissedOnce(
  scheduler: TaskScheduler,
  snapshot: ScheduledTask[],
  nowMs: number,
): Promise<string[]> {
  const missed = snapshot
    .filter((task) => task.enabled && task.type === "once" && isExpiredAt(task.schedule, nowMs))
    .sort((a, b) => new Date(a.schedule).getTime() - new Date(b.schedule).getTime())
    .slice(0, CATCHUP_LIMIT);
  for (let i = 0; i < missed.length; i++) {
    await scheduler.update(missed[i].id, {
      schedule: new Date(nowMs + 250 + i * 150).toISOString(),
    });
  }
  return missed.map((t) => t.id);
}

/** 装配并启动调度器；runner 由上层注入（触发时如何跑 agent，见 runner.ts） */
export async function initAutomation(
  sessionsDir: string,
  runner: ScheduledTaskRunner,
): Promise<TaskScheduler> {
  if (scheduler) return scheduler;
  try {
    return await initAutomationInner(sessionsDir, runner);
  } finally {
    readyResolve();
  }
}

async function initAutomationInner(
  sessionsDir: string,
  runner: ScheduledTaskRunner,
): Promise<TaskScheduler> {
  const dir = path.join(sessionsDir, "automation");
  scheduler = new PersistentTaskScheduler({
    store: new JsonScheduledTaskStore(path.join(dir, "tasks.json")),
    lock: new FileSchedulerLock(path.join(dir, "scheduler.lock")),
    runner,
    scope: {},
    // M4.3 边界：全局并发闸 2（超出触发排队，runHistory 记 queued 条目）；
    // 任务数帽 30（超限的 create —— 表单或对话工具同一入口 —— 直接报错）
    maxConcurrentRuns: 2,
    maxTasks: 30,
    hooks: {
      onSchedulerStarted: ({ status }) => {
        logErr("automation: scheduler started, tasks:", status.taskCount);
      },
      // 无 id 自发通知帧（协议头"自发通知"节）：Rust 原样广播，前端
      // pi-channel.subscribeAutomationEvents 消费 → 运行徽标 / agent-events
      // 通知（帧只带调度器侧信息；真实 agent sessionId 在 runner 建会话后
      // 才可知，完成/失败帧经 getAutomationRunSession 附上）
      onTaskStarted: ({ task, run, timestamp }) => {
        send({
          type: "automation_fired",
          taskId: task.id,
          taskName: task.name ?? "",
          taskType: task.type,
          runId: run.historyEntryId,
          firedAt: timestamp,
        });
      },
      onTaskCompleted: ({ task, run, timestamp }) => {
        send({
          type: "automation_run_done",
          taskId: task.id,
          taskName: task.name ?? "",
          runId: run.historyEntryId,
          ok: true,
          sessionId: getAutomationRunSession(run.historyEntryId),
          finishedAt: timestamp,
        });
      },
      onTaskFailed: ({ task, run, error, timestamp }) => {
        send({
          type: "automation_run_done",
          taskId: task.id,
          taskName: task.name ?? "",
          runId: run.historyEntryId,
          ok: false,
          error: String(error).slice(0, 400),
          sessionId: getAutomationRunSession(run.historyEntryId),
          finishedAt: timestamp,
        });
      },
    },
  });
  // 错过判定（lastFired vs 排期）对 start 前后都成立，快照统一取一次即可
  const nowMs = Date.now();
  const preStart = await scheduler.list();
  const purged = onceTasksToPurge(preStart, nowMs);
  for (const id of purged) {
    await scheduler.delete(id);
  }
  if (purged.length > 0) {
    logErr(`automation: purged ${purged.length} completed once task(s) past 30d retention`);
  }
  const repairedOnce = await repairMissedOnce(scheduler, preStart, nowMs);
  const missed = missedTaskIds(preStart, nowMs);
  await scheduler.start();
  // 锁被别的进程持有（如并存第二个 sidecar）时 start 静默不激活：如实记录，
  // 本侧任务 CRUD 仍走同一 store，仅定时器归属持锁进程
  if (!scheduler.isActive()) {
    logErr("automation: scheduler idle (lock held elsewhere)");
  } else if (missed.length > 0) {
    logErr(`automation: catch-up run for ${missed.length} missed task(s)`);
    // runNow 与常规触发同一 execute 通道（钩子帧/历史记账/防重入全生效）；
    // 本身 fire-and-forget，并发规模由 CATCHUP_LIMIT 封顶（全局并发帽见 M4）
    for (const id of missed) {
      try {
        await scheduler.runNow(id);
      } catch (err) {
        logErr(`automation: catch-up run ${id} failed:`, err);
      }
    }
  }
  if (repairedOnce.length > 0) {
    logErr(`automation: catch-up once task(s) re-armed: ${repairedOnce.join(", ")}`);
  }
  return scheduler;
}

export function getAutomationScheduler(): TaskScheduler | null {
  return scheduler;
}

export async function stopAutomation(): Promise<void> {
  await scheduler?.stop();
}
