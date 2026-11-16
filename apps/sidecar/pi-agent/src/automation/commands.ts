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
  setTriggerEnabled,
} from "./triggers";

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
  const id = str(t.id);
  if (id) {
    const updated = await scheduler.update(id, record);
    if (!updated) throw new Error(`automation_save: task not found: ${id}`);
    // 保存为停用态 = 用户把任务放下：收掉它仍待处理的历史失败项
    if (record.enabled === false) resolveInboxItemsForAutomationTask(id);
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

export async function automationSetEnabledPayload(msg: Record<string, unknown>) {
  const id = str(msg.taskId);
  if (!id) throw new Error("automation_set_enabled: taskId is required");
  const enabled = msg.enabled === true;
  const scheduler = await readyScheduler();
  const updated = await scheduler.update(id, { enabled });
  if (!updated) throw new Error(`automation_set_enabled: task not found: ${id}`);
  // 暂停任务时，旧失败项不应继续挂在「待关注」；恢复任务不会复活旧失败项。
  // 触发器随任务启停（暂停的任务不该被 webhook 打醒）。
  for (const t of listTriggers()) {
    if (t.taskId === id) setTriggerEnabled(t.id, enabled);
  }
  if (!enabled) resolveInboxItemsForAutomationTask(id);
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
  if (type === "webhook" && !id) {
    const config = {
      ...((input.config ?? {}) as Record<string, unknown>),
      secret: generateWebhookSecret(),
    };
    enriched = { ...input, config };
  }
  const saved = await saveTrigger(enriched, validate);
  return { type: "triggers" as const, triggers: listTriggers(), saved };
}

export async function triggerDeletePayload(msg: Record<string, unknown>) {
  const id = str(msg.triggerId);
  if (!id) throw new Error("trigger_delete: triggerId is required");
  if (!deleteTrigger(id)) throw new Error(`trigger_delete: not found: ${id}`);
  return triggersPayload();
}

export async function triggerSetEnabledPayload(msg: Record<string, unknown>) {
  const id = str(msg.triggerId);
  if (!id) throw new Error("trigger_set_enabled: triggerId is required");
  const t = setTriggerEnabled(id, msg.enabled === true);
  if (!t) throw new Error(`trigger_set_enabled: not found: ${id}`);
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
  if (type !== "webhook" && type !== "file" && type !== "git" && type !== "im") {
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
