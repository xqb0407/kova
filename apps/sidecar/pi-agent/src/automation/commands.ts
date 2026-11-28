/**
 * 本地文件（非 vendored）：协议 automation_* 命令的载荷层（protocol.ts 的
 * 薄 case 调这里）。校验/落盘/调度全走 vendored TaskScheduler 公开 API；
 * 错误直接 throw，由 handleLine 统一转 {type:"error"} 应答。
 *
 * 变更命令（save/delete/set_enabled/run_now）成功后都回最新清单
 * （automation_list 形状，沿用 subagents/skills 的"变更后全量应答"惯例，
 * 前端不比对 diff）；run_now 的运行结果另经 automation_run_done 自发帧通知。
 */
import { normalizeToolPolicyProfile } from "./policy";
import { previewSchedule } from "./preview";
import { logErr } from "../log";
import { getAutomationScheduler, whenAutomationReady } from "./runtime";
import { AUTOMATION_TEMPLATES } from "./templates";
import {
  resolveScheduledTaskDefinition,
  type ScheduledTask,
  type ScheduledTaskType,
  type TaskScheduler,
} from "./index";
import {
  primaryFolder,
  projectById,
  projectHasFolder,
  projectIdForCwd,
} from "../agent/projects";
import {
  removeInboxItemsForAutomationRuns,
  resolveInboxItemsForAutomationTask,
} from "../inbox/store";
import {
  deleteTriggersForTask,
  deleteTrigger,
  generateWebhookSecret,
  getTrigger,
  listTriggers,
  regenerateTriggerSecret,
  saveTrigger,
  scheduleTriggerIdForTask,
  setTriggerEnabled,
} from "./triggers";
import {
  EVENT_ONLY_CRON,
  migrateScheduleTriggers,
  mirrorScheduleToTask,
  upsertScheduleTriggerForTask,
} from "./schedule-mirror";

/** start() 前 runNow 会被静默 no-op、list 也未经崩溃恢复：命令统一等就绪 */
async function readyScheduler(): Promise<TaskScheduler> {
  await whenAutomationReady();
  const s = getAutomationScheduler();
  if (!s) throw new Error("automation: scheduler unavailable (init failed?)");
  return s;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * 新建任务时随表单一起提交的事件触发器草稿（webhook/file/git/im）：
 * 任务 id 建完才有，这里补写。单条失败只记日志——触发器是附加项，
 * 不该让整个任务保存失败（排期由 upsertScheduleTriggerForTask 负责）。
 */
async function saveDraftTriggers(
  drafts: Record<string, unknown>[],
  taskId: string,
): Promise<void> {
  for (const raw of drafts) {
    const type = raw.type;
    if (type === "schedule") continue;
    const config = { ...((raw.config ?? {}) as Record<string, unknown>) };
    // webhook 密钥由 sidecar 生成，不接受外部传入（空串同样视为未生成）
    if (type === "webhook" && !config.secret) {
      config.secret = generateWebhookSecret();
    }
    try {
      await saveTrigger(
        { type, taskId, enabled: raw.enabled !== false, config },
        async (tid) => tid === taskId,
      );
    } catch (err) {
      logErr("automation_save: draft trigger skipped", err);
    }
  }
}

async function listPayload(scheduler: TaskScheduler) {
  return { type: "automation_list", tasks: await scheduler.list() } as const;
}

export async function automationListPayload() {
  const scheduler = await readyScheduler();
  // 搭车迁移：老任务/被外部改动过的任务在每次清单加载时幂等补齐 schedule
  // 触发器（启动迁移失败的自愈路径；新保存的任务在 automation_save 里同步）
  await migrateScheduleTriggers(scheduler);
  return listPayload(scheduler);
}

/**
 * 表单整存（无 id 新建、有 id 只覆盖任务字段）。task 形状见 lib/pi-bridge 的
 * PiAutomationTaskDraft；model 留空 = 运行时跟随默认模型（runner 判空跳过）。
 * 已有任务的排期不在表单里改（排期归 schedule 触发器管），因此有 id 时忽略
 * 载荷里的 type/schedule，沿用任务记录上的镜像值。
 */
export async function automationSavePayload(msg: Record<string, unknown>) {
  const t = (msg.task ?? {}) as Record<string, unknown>;
  const prompt = String(t.prompt ?? "").trim();
  if (!prompt) throw new Error("automation_save: prompt is required");
  const scheduler = await readyScheduler();
  const id = str(t.id);
  // 排期事实源在 triggers.json 的 schedule 触发器（镜像在 task 记录上）：
  // 已有任务保存只改其它字段，排期一律沿用记录。既避免把已触发 once 的过期
  // 时间按"现在"重解析报错，也避免表单旧快照在排期被触发器改过/删过后把它写回。
  // 新建任务仍按表单（触发器草稿）里的排期解析。
  const existing = id ? await scheduler.get(id) : undefined;
  if (id && !existing) throw new Error(`automation_save: task not found: ${id}`);
  const definition = existing
    ? {
        type: existing.type,
        schedule: existing.schedule,
        intervalSeconds: existing.intervalSeconds,
      }
    : resolveScheduledTaskDefinition({
        type: t.type as ScheduledTaskType,
        schedule: t.schedule as string,
      });
  const modelRaw = (t.model ?? {}) as Record<string, unknown>;
  // 项目归属：保存时固化（否则共享目录下每次触发都按 cwd 重新推断，
  // 项目改名/目录调整会让历史运行漂移）。显式 projectId 校验目录一致性；
  // 未显式给定时只在 workspaceDir 唯一归属一个项目时自动落库。
  const requestedProjectId = str(t.projectId);
  let workspaceDir = str(t.workspaceDir);
  let projectId = requestedProjectId;
  if (projectId) {
    const project = projectById(projectId);
    if (!project) {
      throw new Error(`automation_save: project not found: ${projectId}`);
    }
    if (workspaceDir && !projectHasFolder(project, workspaceDir)) {
      throw new Error(
        "automation_save: workspaceDir is not one of the project folders",
      );
    }
    workspaceDir = workspaceDir || primaryFolder(project) || undefined;
  } else if (workspaceDir) {
    projectId = projectIdForCwd(workspaceDir);
  }
  const record = {
    prompt,
    ...definition,
    enabled: t.enabled !== false,
    model: {
      provider: str(modelRaw.provider) ?? "",
      model: str(modelRaw.model) ?? "",
    },
    toolPolicyProfile: normalizeToolPolicyProfile(t.toolPolicyProfile),
    name: str(t.name),
    description: str(t.description),
    workspaceDir,
    projectId,
    ...(typeof t.timeoutMs === "number" && t.timeoutMs > 0
      ? { timeoutMs: Math.floor(t.timeoutMs) }
      : {}),
  };
  const draftTriggers = Array.isArray(t.triggers)
    ? (t.triggers as Record<string, unknown>[])
    : [];
  if (id) {
    const updated = await scheduler.update(id, record);
    if (!updated) throw new Error(`automation_save: task not found: ${id}`);
    // 保存为停用态 = 用户把任务放下：收掉它仍待处理的历史失败项
    if (record.enabled === false) resolveInboxItemsForAutomationTask(id);
    // 排期事实源在 triggers.json 的 schedule 触发器：表单/对话工具走 task
    // 侧保存后，反向落一条确定性的 sched-<taskId> 记录（幂等）
    await upsertScheduleTriggerForTask(updated);
  } else {
    const created = await scheduler.create({
      ...record,
      sessionId: str(t.sessionId) ?? "automation-manual",
    });
    await upsertScheduleTriggerForTask(created);
    // 新建时随表单提交的事件触发器：此刻才有任务 id，建完补写
    await saveDraftTriggers(draftTriggers, created.id);
  }
  return listPayload(scheduler);
}

export async function automationDeletePayload(msg: Record<string, unknown>) {
  // 任务 id 走 taskId：msg.id 是请求关联 id（handleLine 占用的协议惯例）
  const id = str(msg.taskId);
  if (!id) throw new Error("automation_delete: taskId is required");
  const scheduler = await readyScheduler();
  if (!(await scheduler.delete(id))) {
    throw new Error(`automation_delete: task not found: ${id}`);
  }
  // 任务删了：它残留的待处理失败项也不该继续挂着；悬挂触发器一并清
  resolveInboxItemsForAutomationTask(id);
  deleteTriggersForTask(id);
  return listPayload(scheduler);
}

/** 删运行记录条目：entryIds 单/多条，或 all:true 清空。只动日志，
 *  关联会话由前端确认后另行走 delete_session（见 lib/automations 注释） */
export async function automationHistoryDeletePayload(msg: Record<string, unknown>) {
  const id = str(msg.taskId);
  if (!id) throw new Error("automation_history_delete: taskId is required");
  const clearAll = msg.all === true;
  const entryIds = Array.isArray(msg.entryIds)
    ? (msg.entryIds.filter((v) => typeof v === "string") as string[])
    : [];
  if (!clearAll && entryIds.length === 0) {
    throw new Error("automation_history_delete: entryIds or all=true is required");
  }
  const scheduler = await readyScheduler();
  if (!(await scheduler.deleteHistory(id, clearAll ? "all" : entryIds))) {
    throw new Error(`automation_history_delete: task not found: ${id}`);
  }
  // 运行记录删了，对应收件箱条目物理移除，避免“记录页没有、收件箱还在”
  removeInboxItemsForAutomationRuns(id, clearAll ? undefined : new Set(entryIds));
  return listPayload(scheduler);
}

/**
 * 任务启停（唯一写入口）：任务记录 + 名下所有触发器的 enabled 一起变。
 * 两处必须同源，否则触发器清单会出现"任务已暂停但 webhook 仍显示启用"的假状态。
 * 暂停时收掉待处理的失败项；恢复不复活旧失败项。
 */
async function setTaskEnabled(
  scheduler: TaskScheduler,
  taskId: string,
  enabled: boolean,
): Promise<ScheduledTask | undefined> {
  const updated = await scheduler.update(taskId, { enabled });
  if (!updated) return undefined;
  for (const t of listTriggers()) {
    if (t.taskId === taskId && t.enabled !== enabled) setTriggerEnabled(t.id, enabled);
  }
  if (!enabled) resolveInboxItemsForAutomationTask(taskId);
  return updated;
}

export async function automationSetEnabledPayload(msg: Record<string, unknown>) {
  const id = str(msg.taskId);
  if (!id) throw new Error("automation_set_enabled: taskId is required");
  const enabled = msg.enabled === true;
  const scheduler = await readyScheduler();
  if (!(await setTaskEnabled(scheduler, id, enabled))) {
    throw new Error(`automation_set_enabled: task not found: ${id}`);
  }
  return listPayload(scheduler);
}

export async function automationRunNowPayload(msg: Record<string, unknown>) {
  const id = str(msg.taskId);
  if (!id) throw new Error("automation_run_now: taskId is required");
  const scheduler = await readyScheduler();
  const task: ScheduledTask | undefined = await scheduler.runNow(id);
  if (!task) throw new Error(`automation_run_now: task not found: ${id}`);
  return listPayload(scheduler);
}

/** 预览不需调度器（纯排期计算），不等就绪闸门。排期类型走 scheduleType：
 *  msg.type 是命令名（协议惯例），不能复用 */
export function automationPreviewPayload(msg: Record<string, unknown>) {
  const p = previewSchedule({ type: msg.scheduleType, schedule: msg.schedule, count: msg.count });
  return "error" in p
    ? { type: "automation_preview" as const, error: p.error }
    : { type: "automation_preview" as const, runs: p.runs };
}

/** 预置模板清单（管理页"从模板新建"数据源）：静态表，无需调度器 */
export function automationTemplatesPayload() {
  return { type: "automation_templates" as const, templates: AUTOMATION_TEMPLATES };
}

/* ------------------------------ 事件触发器（L1） ------------------------------ */

/** 触发器清单应答（与 automation_list 同款"改后即见"惯例） */
export function triggersPayload() {
  return { type: "triggers" as const, triggers: listTriggers() };
}

/** 触发器所在任务的校验（保存时引用完整性） */
async function triggerTaskValidator(): Promise<(taskId: string) => Promise<boolean>> {
  const scheduler = await readyScheduler();
  return async (taskId: string) => {
    const tasks = await scheduler.list();
    return tasks.some((t) => t.id === taskId);
  };
}

export async function triggerSavePayload(msg: Record<string, unknown>) {
  const validate = await triggerTaskValidator();
  const input = (msg.trigger ?? {}) as Record<string, unknown>;
  // 新建 webhook：secret 由 sidecar 生成（不接受外部传入），落在 config 里
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : "";
  const type = input.type;
  let enriched = input;
  if (type === "schedule") {
    // 写边界先校验排期（cron 语法 / once 未过期 / interval 可解析）：镜像失败只记
    // 日志，而清单加载时的迁移方向是 task → trigger —— 非法排期一旦落盘，下次
    // 刷新就会把触发器"回滚"成旧排期（静默吞掉用户的编辑）。这里直接拒绝更清楚。
    const cfg = (input.config ?? {}) as Record<string, unknown>;
    // 形状不完整的交给 saveTrigger 报原有错误（bad scheduleType / 空 schedule）
    if (cfg.scheduleType && typeof cfg.schedule === "string" && cfg.schedule.trim()) {
      resolveScheduledTaskDefinition({
        type: cfg.scheduleType as ScheduledTaskType,
        schedule: cfg.schedule,
      });
    }
  }
  if (type === "webhook" && !id) {
    const config = {
      ...((input.config ?? {}) as Record<string, unknown>),
      secret: generateWebhookSecret(),
    };
    enriched = { ...input, config };
  }
  if (type === "schedule" && !id) {
    // 排期触发器用确定性 id：编辑已有排期 = 同 id 覆盖；不带 id 的新建
    // 也落到 sched-<taskId>（幂等 upsert），不会长出第二条
    const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
    if (taskId) enriched = { ...input, id: scheduleTriggerIdForTask(taskId) };
  }
  const saved = await saveTrigger(enriched, validate);
  if (saved.type === "schedule") {
    // 触发器是排期事实源：编辑后立即镜像回 task.schedule；启停沿用
    // "排期启停 = 任务启停"语义，保证两边开关一致
    const scheduler = await readyScheduler();
    await mirrorScheduleToTask(scheduler, saved.taskId);
    try {
      await scheduler.update(saved.taskId, { enabled: saved.enabled });
      if (saved.enabled === false) resolveInboxItemsForAutomationTask(saved.taskId);
    } catch (err) {
      logErr(
        "trigger_save: schedule enable mirror failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { type: "triggers" as const, triggers: listTriggers(), saved };
}

export async function triggerDeletePayload(msg: Record<string, unknown>) {
  const id = str(msg.triggerId);
  if (!id) throw new Error("trigger_delete: triggerId is required");
  const prev = getTrigger(id);
  if (!prev) throw new Error(`trigger_delete: not found: ${id}`);
  if (prev.type === "schedule") {
    // P2：允许删除排期触发器 → 任务转为纯事件任务。任务记录必须有排期
    // （vendored 引擎），把排期镜像成永不触发的哨兵 cron（intervalSeconds 一并
    // 归零，不留旧 interval 残留）；任务保持 enabled，事件触发器照常执行。
    // update 对已删除任务返回 undefined 而不抛错：悬挂触发器照常清理；
    // 其它写盘失败会抛出，此时不删触发器（避免旧排期继续 tick）。
    const scheduler = await readyScheduler();
    await scheduler.update(
      prev.taskId,
      resolveScheduledTaskDefinition({ type: "cron", schedule: EVENT_ONLY_CRON }),
    );
    if (!deleteTrigger(id)) throw new Error(`trigger_delete: not found: ${id}`);
    return triggersPayload();
  }
  if (!deleteTrigger(id)) throw new Error(`trigger_delete: not found: ${id}`);
  return triggersPayload();
}

export async function triggerSetEnabledPayload(msg: Record<string, unknown>) {
  const id = str(msg.triggerId);
  if (!id) throw new Error("trigger_set_enabled: triggerId is required");
  const t = setTriggerEnabled(id, msg.enabled === true);
  if (!t) throw new Error(`trigger_set_enabled: not found: ${id}`);
  if (t.type === "schedule") {
    // P1 语义：排期启停 = 任务启停（与编辑器头部的总开关同一状态）。
    // 走统一入口同步任务与其余触发器，避免开关状态在两边分叉。
    const scheduler = await readyScheduler();
    try {
      const updated = await setTaskEnabled(scheduler, t.taskId, t.enabled);
      // 任务已被删：悬挂触发器一并收掉（任务删除路径会清，这里是兜底）
      if (!updated) deleteTrigger(id);
    } catch (err) {
      logErr(
        "trigger_set_enabled: schedule mirror failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return triggersPayload();
}

/** webhook 密钥重置（旧密钥立即失效） */
export async function triggerRegenerateSecretPayload(msg: Record<string, unknown>) {
  const id = str(msg.triggerId);
  if (!id) throw new Error("trigger_regenerate_secret: triggerId is required");
  const { secret } = regenerateTriggerSecret(id);
  return { type: "trigger_secret" as const, triggerId: id, secret, triggers: listTriggers() };
}

/** 手动触发一次（设置页「测试」）：manual 上下文，进 Inbox/标题 */
export async function triggerTestPayload(msg: Record<string, unknown>) {
  const id = str(msg.triggerId);
  if (!id) throw new Error("trigger_test: triggerId is required");
  const t = getTrigger(id);
  if (!t) throw new Error(`trigger_test: not found: ${id}`);
  const scheduler = await readyScheduler();
  const task = await scheduler.runWithContext(t.taskId, {
    type: "manual",
    ...(id ? { id } : {}),
    summary: "手动测试触发",
  });
  if (!task) throw new Error(`trigger_test: task not found: ${t.taskId}`);
  return triggersPayload();
}

/**
 * 宿主事件触发入口（L1b）：Electron main 的 webhook/watcher 在调度器
 * 进程内模式（dev）下走这里。runWithContext 在生产是 RemoteTaskScheduler →
 * 独立调度进程，与 host RPC 的 run_with_trigger 同一语义；type 在这里守门，
 * 不让 RPC 层把任意字段塞进 runHistory/Inbox。
 */
export async function automationTriggerFirePayload(msg: Record<string, unknown>) {
  const taskId = str(msg.taskId);
  if (!taskId) throw new Error("automation_trigger_fire: taskId is required");
  const raw = (msg.trigger ?? {}) as Record<string, unknown>;
  const type = raw.type;
  if (
    type !== "webhook" &&
    type !== "file" &&
    type !== "git" &&
    type !== "im" &&
    type !== "connector"
  ) {
    throw new Error("automation_trigger_fire: invalid trigger.type");
  }
  const scheduler = await readyScheduler();
  const task = await scheduler.runWithContext(taskId, {
    type,
    ...(typeof raw.id === "string" && raw.id ? { id: raw.id } : {}),
    ...(typeof raw.summary === "string" && raw.summary
      ? { summary: raw.summary.slice(0, 200) }
      : {}),
  });
  return { type: "automation_trigger_fired" as const, task: task ?? null };
}
