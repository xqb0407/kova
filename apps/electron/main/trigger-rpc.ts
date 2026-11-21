/**
 * 触发器宿主侧网关（L1b）：main 的 watcher/webhook 读事实源与触发执行。
 *
 * 两条路径（语义一致，都是 runWithContext）：
 * - 生产：automation dispatcher RPC（main 与调度器直连，跳数最少）；
 * - dev（KOVA_AUTOMATION_INPROC=1）：调度器在 sidecar 进程内，host 的
 *   automationRpc 不可用，改走 sidecar 协议 automation_trigger_fire。
 *
 * 触发器写路径始终只有 sidecar 一个写者；这里是只读 + 触发。
 */
import { automationRpc } from "./automation-service";
import { piRequestInternal, redactSecrets } from "./pi-agent";

export type HostTrigger = {
  id: string;
  type: "webhook" | "file" | "git" | "im";
  taskId: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

export type HostTriggerFire = {
  type: "webhook" | "file" | "git" | "im";
  id?: string;
  summary?: string;
};

/** 每次现读：index 可能在启动早期才把 INPROC 切到 1（二进制缺失回退） */
function inProcMode(): boolean {
  return process.env.KOVA_AUTOMATION_INPROC === "1";
}

async function sidecarRequest<T>(payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const line = await piRequestInternal({
    payload,
    timeoutMs,
    maxTimeoutMs: timeoutMs + 20_000,
  });
  let parsed: { type?: unknown; errorText?: unknown };
  try {
    parsed = JSON.parse(line) as { type?: unknown; errorText?: unknown };
  } catch {
    throw new Error("sidecar: invalid response");
  }
  if (parsed.type === "error") {
    throw new Error(String(parsed.errorText ?? "sidecar request failed"));
  }
  return parsed as T;
}

export async function listHostTriggers(): Promise<HostTrigger[]> {
  if (inProcMode()) {
    const res = await sidecarRequest<{ triggers?: HostTrigger[] }>(
      { type: "list_triggers" },
      10_000,
    );
    return Array.isArray(res.triggers) ? res.triggers : [];
  }
  const res = (await automationRpc("list_triggers", {}, 10_000)) as HostTrigger[] | null;
  return Array.isArray(res) ? res : [];
}

export async function fireHostTrigger(
  taskId: string,
  trigger: HostTriggerFire,
): Promise<{ id?: unknown } | undefined> {
  // 摘要进 runHistory / Inbox / 会话标题：统一在出口脱敏（sk-*/Bearer 打码），
  // 外部 payload 与 IM 消息都可能带密钥
  const safe: HostTriggerFire = {
    ...trigger,
    ...(typeof trigger.summary === "string" ? { summary: redactSecrets(trigger.summary) } : {}),
  };
  if (inProcMode()) {
    const res = await sidecarRequest<{ task?: { id?: unknown } | null }>(
      { type: "automation_trigger_fire", taskId, trigger: safe },
      15_000,
    );
    return res.task ?? undefined;
  }
  return (await automationRpc("run_with_trigger", { taskId, trigger: safe }, 15_000)) as
    | { id?: unknown }
    | undefined;
}

/** webhook 验签查 secret（重置立即生效，不缓存）。传输层失败直接抛：
 *  调用方要回 5xx 让发送方重试，不能伪装成「触发器不存在」（404 会让
 *  多数 webhook 平台停用端点）。 */
export async function lookupWebhookTrigger(
  triggerId: string,
): Promise<{ enabled: boolean; secret: string; taskId: string } | null> {
  if (inProcMode()) {
    const all = await listHostTriggers();
    const t = all.find((x) => x.id === triggerId);
    if (!t || t.type !== "webhook") return null;
    const secret = typeof t.config.secret === "string" ? t.config.secret : "";
    if (!secret) return null;
    return { enabled: t.enabled, secret, taskId: t.taskId };
  }
  const res = (await automationRpc("get_webhook_trigger", { triggerId }, 5_000)) as {
    enabled?: unknown;
    secret?: unknown;
    taskId?: unknown;
  } | null;
  if (!res || typeof res.secret !== "string" || !res.secret) return null;
  return {
    enabled: res.enabled === true,
    secret: res.secret,
    taskId: typeof res.taskId === "string" ? res.taskId : "",
  };
}
