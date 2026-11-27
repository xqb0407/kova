/**
 * 事件触发器（L1）桌面客户端：sidecar 协议镜像 + webhook 端点信息。
 *
 * 触发器事实源在 sidecar（<sessionsDir>/automation/triggers.json）；本模块只做
 * 请求封装。webhook 端口由 Electron main 提供（loopback server 可能因占用递增）。
 *
 * P1 统一触发模型：TriggerType 增加 schedule（排期降格为一种触发器，
 * 每任务至多一条、id 固定 sched-<taskId>）；task.schedule 是调度引擎的
 * 镜像字段，镜像方向见 sidecar 的 schedule-mirror.ts。
 */
import { invoke } from "@/desktop-bridge/core";
import { getPiChannel } from "@/lib/pi/pi-channel";

export type TriggerType = "schedule" | "webhook" | "file" | "git" | "im";

/**
 * 纯事件任务（P2）：没有排期触发器时任务不按时间运行，只由事件触发。
 * 任务记录必须有 type/schedule（vendored 引擎），用永不命中的 cron 当哨兵
 * （2 月 31 日不存在）；与 sidecar 的 EVENT_ONLY_CRON 必须保持一致。
 */
export const EVENT_ONLY_CRON = "0 0 31 2 *";

export function isEventOnlySchedule(schedule: string | undefined): boolean {
  return (schedule ?? "").trim() === EVENT_ONLY_CRON;
}

/** schedule 触发器配置（与 sidecar TriggerConfig 的 schedule 分支同构） */
export type ScheduleTriggerConfig = {
  type: "schedule";
  scheduleType: "cron" | "once" | "interval";
  schedule: string;
};

export type EventTrigger = {
  id: string;
  type: TriggerType;
  taskId: string;
  enabled: boolean;
  createdAt: string;
  config: Record<string, unknown>;
};

/** 排期触发器卡片的排期摘要（describeSchedule 的入参形状） */
export function scheduleConfig(trigger: EventTrigger): ScheduleTriggerConfig | null {
  if (trigger.type !== "schedule") return null;
  const c = trigger.config;
  const scheduleType = c.scheduleType;
  if (scheduleType !== "cron" && scheduleType !== "once" && scheduleType !== "interval") {
    return null;
  }
  const schedule = typeof c.schedule === "string" ? c.schedule : "";
  if (!schedule) return null;
  return { type: "schedule", scheduleType, schedule };
}

export type TriggerDraft = {
  id?: string;
  type: TriggerType;
  taskId: string;
  /** 启用态；省略时新建默认启用、更新沿用原值（sidecar 侧决定） */
  enabled?: boolean;
  config: Record<string, unknown>;
};

type TriggersResponse = { type: "triggers"; triggers: EventTrigger[]; saved?: EventTrigger };

/**
 * 触发器应答不在全局 PiResponse 联合里（Inbox 同款处理）：走通道原语并
 * 在出口收窄，避免往联合里加类型导致既有 type 收窄退化。
 */
async function triggerRequest<T>(payload: Record<string, unknown>): Promise<T> {
  const response = await getPiChannel().request(payload);
  if (response.type === "error") throw new Error(response.errorText);
  return response as unknown as T;
}

/**
 * 变更后通知 main 就近重建 watcher（file/git 生效不用等 30s 周期）。
 * 非桌面宿主（浏览器预览）没有该命令：静默跳过，周期同步兜底。
 */
async function requestWatcherSync(): Promise<void> {
  try {
    await invoke("triggers_sync", {});
  } catch {
    /* ignore */
  }
}

export async function fetchTriggers(): Promise<EventTrigger[]> {
  const res = await triggerRequest<TriggersResponse>({ type: "list_triggers" });
  return Array.isArray(res.triggers) ? res.triggers : [];
}

export async function saveTrigger(draft: TriggerDraft): Promise<EventTrigger[]> {
  const res = await triggerRequest<TriggersResponse>({
    type: "save_trigger",
    trigger: draft,
  });
  void requestWatcherSync();
  return Array.isArray(res.triggers) ? res.triggers : [];
}

export async function deleteTrigger(triggerId: string): Promise<EventTrigger[]> {
  const res = await triggerRequest<TriggersResponse>({ type: "delete_trigger", triggerId });
  void requestWatcherSync();
  return Array.isArray(res.triggers) ? res.triggers : [];
}

export async function setTriggerEnabled(
  triggerId: string,
  enabled: boolean,
): Promise<EventTrigger[]> {
  const res = await triggerRequest<TriggersResponse>({
    type: "set_trigger_enabled",
    triggerId,
    enabled,
  });
  void requestWatcherSync();
  return Array.isArray(res.triggers) ? res.triggers : [];
}

export async function regenerateTriggerSecret(
  triggerId: string,
): Promise<{ secret: string; triggers: EventTrigger[] }> {
  const res = await triggerRequest<{
    type: "trigger_secret";
    triggerId: string;
    secret: string;
    triggers: EventTrigger[];
  }>({ type: "regenerate_trigger_secret", triggerId });
  return { secret: res.secret, triggers: res.triggers };
}

export async function testTrigger(triggerId: string): Promise<EventTrigger[]> {
  const res = await triggerRequest<TriggersResponse>({ type: "test_trigger", triggerId });
  return Array.isArray(res.triggers) ? res.triggers : [];
}

/** webhook loopback 端口（Electron main 提供；非桌面端返回 null） */
export async function fetchWebhookPort(): Promise<number | null> {
  try {
    const res = await invoke<{ port: number | null }>("webhook_info", {});
    return typeof res?.port === "number" ? res.port : null;
  } catch {
    return null;
  }
}

/** webhook 完整 URL（端口未知时用默认 8788 提示；UI 在无端口时改显降级提示） */
export function webhookUrl(port: number | null, triggerId: string): string {
  return `http://127.0.0.1:${port ?? 8788}/hook/${triggerId}`;
}
