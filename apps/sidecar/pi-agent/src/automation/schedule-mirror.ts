/**
 * 排期触发器 ↔ task.schedule 双向镜像（P1 统一触发模型）。
 *
 * 事实源是 triggers.json 的 schedule 触发器；task.schedule 是调度引擎的
 * 镜像字段——调度核心是 vendored 的 PersistentTaskScheduler / 独立调度器
 * 二进制，只认任务记录上的 schedule（NOTICE.md：不把新字段硬塞进 vendored
 * ScheduledTask），镜像层让引擎完全无感。
 *
 * 方向与调用点：
 * - trigger → task：triggerSavePayload（编辑排期）/ triggerSetEnabledPayload
 *   （排期启停 = 任务启停，P1 语义）；
 * - task → trigger：automationSavePayload（表单创建/旧路径保存后反向落
 *   trigger 记录）与 migrateScheduleTriggers（启动/清单加载时的幂等迁移）。
 *
 * 镜像失败只记日志不打断调用方：触发器 CRUD 是事实源操作，必须成功；
 * 镜像字段短暂滞后可由下次任一方向的同步收敛（两个方向都幂等）。
 */
import { logErr } from "../log";
import { resolveScheduledTaskDefinition } from "./index";
import {
  deleteTrigger,
  getTrigger,
  listTriggers,
  saveTrigger,
  scheduleTriggerIdForTask,
} from "./triggers";

/** 镜像层需要的最小调度器面（避免反向依赖 runtime：调用方传 readyScheduler） */
export type MirrorScheduler = {
  update(
    taskId: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
};

/**
 * 纯事件任务（P2）：删掉排期触发器后任务不再按时间运行，但事件触发仍要能跑。
 * 调度引擎只认任务记录上的 type/schedule（vendored，不可加字段），所以用一条
 * 永不命中的 cron 当哨兵（2 月 31 日不存在）；任务保持 enabled —— execute 的
 * enabled 闸门对事件触发同样生效，不能置 false。
 */
export const EVENT_ONLY_CRON = "0 0 31 2 *";

export function isEventOnlySchedule(schedule: string | undefined): boolean {
  return (schedule ?? "").trim() === EVENT_ONLY_CRON;
}

type TaskLike = {
  id: string;
  type: "cron" | "once" | "interval";
  schedule: string;
  enabled: boolean;
};

/** 任务记录 → schedule 触发器（确定性 id，幂等 upsert）。纯事件任务跳过。 */
export async function upsertScheduleTriggerForTask(
  task: TaskLike,
): Promise<void> {
  if (!task.schedule?.trim()) return;
  if (isEventOnlySchedule(task.schedule)) {
    // 纯事件任务：确保没有残留排期触发器（删排期 → 镜像为哨兵 → 这里收敛）
    const stale = getTrigger(scheduleTriggerIdForTask(task.id));
    if (stale) deleteTrigger(stale.id);
    return;
  }
  try {
    const id = scheduleTriggerIdForTask(task.id);
    const prev = getTrigger(id);
    const config = {
      type: "schedule" as const,
      scheduleType: task.type,
      schedule: task.schedule,
    };
    if (
      prev?.config.type === "schedule" &&
      prev.config.scheduleType === task.type &&
      prev.config.schedule === task.schedule &&
      prev.enabled === task.enabled
    ) {
      return;
    }
    await saveTrigger(
      {
        id,
        type: "schedule",
        taskId: task.id,
        enabled: task.enabled,
        config,
      },
      // 引用完整性由调用方保证（任务刚 create/update 过），不再查一遍清单
      async () => true,
    );
  } catch (err) {
    logErr(
      "schedule-mirror: upsert from task failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * schedule 触发器 → task.schedule 镜像（把触发器上的排期写回调度引擎）。
 * once 排期已过期时 resolveScheduledTaskDefinition 会抛错：捕获记日志，
 * 引擎保留旧排期，等下一次同步收敛。
 */
export async function mirrorScheduleToTask(
  scheduler: MirrorScheduler,
  taskId: string,
): Promise<void> {
  const t = getTrigger(scheduleTriggerIdForTask(taskId));
  if (!t || t.config.type !== "schedule") return;
  try {
    const definition = resolveScheduledTaskDefinition({
      type: t.config.scheduleType,
      schedule: t.config.schedule,
    });
    await scheduler.update(taskId, definition);
  } catch (err) {
    logErr(
      "schedule-mirror: mirror to task failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * 幂等迁移：tasks.json 里每个带排期的任务补齐 schedule 触发器记录
 * （老数据升级 + 自愈）。调度器就绪后调用；失败不抛，清单下次加载时
 * （automationListPayload 的搭车迁移）会再收敛。
 */
export async function migrateScheduleTriggers(
  scheduler: { list(): Promise<TaskLike[]> },
): Promise<number> {
  let migrated = 0;
  try {
    for (const task of await scheduler.list()) {
      // 纯事件任务（P2）：不应有排期触发器，顺手收掉历史残留
      if (isEventOnlySchedule(task.schedule)) {
        await upsertScheduleTriggerForTask(task);
        continue;
      }
      const id = scheduleTriggerIdForTask(task.id);
      const prev = getTrigger(id);
      if (
        prev?.config.type === "schedule" &&
        prev.config.scheduleType === task.type &&
        prev.config.schedule === task.schedule &&
        prev.enabled === task.enabled
      ) {
        continue;
      }
      if (!task.schedule?.trim()) continue;
      await upsertScheduleTriggerForTask(task);
      migrated += 1;
    }
  } catch (err) {
    logErr(
      "schedule-mirror: migration failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return migrated;
}

/** 任务是否还有排期触发器（UI 约束与测试用） */
export function hasScheduleTriggerForTask(taskId: string): boolean {
  const id = scheduleTriggerIdForTask(taskId);
  return listTriggers().some((x) => x.id === id && x.type === "schedule");
}
