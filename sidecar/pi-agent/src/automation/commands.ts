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
import { getAutomationScheduler, whenAutomationReady } from "./runtime";
import { AUTOMATION_TEMPLATES } from "./templates";
import {
  resolveScheduledTaskDefinition,
  type ScheduledTask,
  type ScheduledTaskType,
  type TaskScheduler,
} from "./index";

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

async function listPayload(scheduler: TaskScheduler) {
  return { type: "automation_list", tasks: await scheduler.list() } as const;
}

export async function automationListPayload() {
  return listPayload(await readyScheduler());
}

/**
 * 表单整存（无 id 建、有 id 全量覆盖）。task 形状见 lib/pi-bridge 的
 * PiAutomationTaskDraft；model 留空 = 运行时跟随默认模型（runner 判空跳过）。
 */
export async function automationSavePayload(msg: Record<string, unknown>) {
  const t = (msg.task ?? {}) as Record<string, unknown>;
  const prompt = String(t.prompt ?? "").trim();
  if (!prompt) throw new Error("automation_save: prompt is required");
  const scheduler = await readyScheduler();
  const definition = resolveScheduledTaskDefinition({
    type: t.type as ScheduledTaskType,
    schedule: t.schedule as string,
  });
  const modelRaw = (t.model ?? {}) as Record<string, unknown>;
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
    workspaceDir: str(t.workspaceDir),
    ...(typeof t.timeoutMs === "number" && t.timeoutMs > 0
      ? { timeoutMs: Math.floor(t.timeoutMs) }
      : {}),
  };
  const id = str(t.id);
  if (id) {
    const updated = await scheduler.update(id, record);
    if (!updated) throw new Error(`automation_save: task not found: ${id}`);
  } else {
    await scheduler.create({ ...record, sessionId: str(t.sessionId) ?? "automation-manual" });
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
  return listPayload(scheduler);
}

export async function automationSetEnabledPayload(msg: Record<string, unknown>) {
  const id = str(msg.taskId);
  if (!id) throw new Error("automation_set_enabled: taskId is required");
  const enabled = msg.enabled === true;
  const scheduler = await readyScheduler();
  const updated = await scheduler.update(id, { enabled });
  if (!updated) throw new Error(`automation_set_enabled: task not found: ${id}`);
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
