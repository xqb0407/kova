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
import {
  missedTaskIds,
  missedTickDueMs,
  onceTasksToPurge,
  repairMissedOnce,
} from "automation-core";
import { logErr } from "../log";
import { send } from "../protocol/stream";
import { RemoteTaskScheduler } from "./remote";
import {
  FileSchedulerLock,
  JsonScheduledTaskStore,
  PersistentTaskScheduler,
  type ScheduledTaskRunner,
  type TaskScheduler,
} from "./index";
import { getAutomationRunSession } from "./runner";
import { projectIdForCwd } from "../agent/projects";

// 补跑判定只有一份实现，测试继续从本模块导入。
export { missedTaskIds, missedTickDueMs, onceTasksToPurge, repairMissedOnce };

let scheduler: TaskScheduler | null = null;

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


/** 装配并启动调度器；runner 由上层注入（触发时如何跑 agent，见 runner.ts） */
export async function initAutomation(
  sessionsDir: string,
  runner: ScheduledTaskRunner,
): Promise<TaskScheduler> {
  if (scheduler) return scheduler;
  try {
    // 生产（有宿主）：调度器已在独立进程；这里只建代理。
    // 本地模式/回退：仍走进程内实现，保持测试与旧路径可用。
    if (process.env.PI_SESSIONS_DIR && process.env.KOVA_AUTOMATION_INPROC !== "1") {
      // 宿主模式以独立进程为唯一调度器：即便启动时暂时不可用，也不回退
      // in-process——两套调度器共用 tasks.json 会互相覆盖内存快照。
      // 缺失二进制的场景由 main 在 spawn sidecar 前设置 KOVA_AUTOMATION_INPROC。
      const remote = new RemoteTaskScheduler();
      try {
        // 等独立进程就绪（main 会在收到的第一个 RPC 时确保 spawn）。
        await remote.status();
      } catch (err) {
        logErr("automation: remote scheduler not ready; commands will retry:", err);
      }
      scheduler = remote;
      return remote;
    }
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

/** 历史任务项目归属补齐：老任务只有 workspaceDir，启动后按唯一归属固化
 *  projectId，避免每次触发都按 cwd 重新推断、随项目目录调整漂移。 */
export async function backfillAutomationProjectIds(): Promise<number> {
  if (!scheduler) return 0;
  let migrated = 0;
  try {
    for (const task of await scheduler.list()) {
      if (task.projectId || !task.workspaceDir?.trim()) continue;
      const projectId = projectIdForCwd(task.workspaceDir);
      if (!projectId) continue;
      if (await scheduler.update(task.id, { projectId })) migrated += 1;
    }
  } catch (err) {
    logErr("automation: projectId backfill failed:", err);
  }
  return migrated;
}

export async function stopAutomation(): Promise<void> {
  await scheduler?.stop();
}
