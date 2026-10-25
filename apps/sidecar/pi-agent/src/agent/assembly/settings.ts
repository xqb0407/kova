/**
 * 能力开关与参数的事实源：SQLite kv（键 pi.capabilities）。
 *
 * 形态：
 *   { "enabled": { "<capability-id>": boolean },
 *     "params":  { "<capability-id>": { ... } } }
 *
 * 宽松规整：坏条目直接剔除，不因为一个字段把整层关掉。启动恢复失败只记日志，
 * 保持默认（全部能力跟随各自的 defaultEnabled），不阻断 sidecar 启动。
 */
import { kvGet, kvSet } from "../../storage/hostdb";
import { logErr } from "../../log";

export const CAPABILITY_KV_KEY = "pi.capabilities";

export type CapabilitySettings = {
  enabled: Record<string, boolean>;
  params: Record<string, Record<string, unknown>>;
};

const EMPTY_SETTINGS: CapabilitySettings = { enabled: {}, params: {} };

let current: CapabilitySettings = { ...EMPTY_SETTINGS };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeCapabilitySettings(raw: unknown): CapabilitySettings {
  const record = isRecord(raw) ? raw : {};
  const enabled: Record<string, boolean> = {};
  if (isRecord(record.enabled)) {
    for (const [id, value] of Object.entries(record.enabled)) {
      if (typeof value === "boolean" && id.trim()) enabled[id.trim()] = value;
    }
  }
  const params: Record<string, Record<string, unknown>> = {};
  if (isRecord(record.params)) {
    for (const [id, value] of Object.entries(record.params)) {
      if (isRecord(value) && id.trim()) params[id.trim()] = { ...value };
    }
  }
  return { enabled, params };
}

/** 启动恢复：kv 读回；失败保持默认（不阻断启动）。 */
export async function initCapabilitySettings(): Promise<CapabilitySettings> {
  try {
    const row = await kvGet(CAPABILITY_KV_KEY);
    if (row?.value) {
      current = normalizeCapabilitySettings(JSON.parse(row.value));
    }
  } catch (err) {
    logErr("capabilities: load failed:", err);
  }
  return current;
}

export function getCapabilitySettings(): CapabilitySettings {
  // 防御性拷贝：调用方（协议响应、诊断）拿到的是快照，原地修改不会污染全局。
  return {
    enabled: { ...current.enabled },
    params: Object.fromEntries(
      Object.entries(current.params).map(([id, params]) => [id, { ...params }]),
    ),
  };
}

export function readCapabilityParams(capabilityId: string): Readonly<Record<string, unknown>> {
  return { ...(current.params[capabilityId] ?? {}) };
}

/** 应用新设置：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落）。 */
export async function applyCapabilitySettings(raw: unknown): Promise<CapabilitySettings> {
  current = normalizeCapabilitySettings(raw);
  try {
    await kvSet(CAPABILITY_KV_KEY, JSON.stringify(current));
  } catch (err) {
    logErr("capabilities: persist failed:", err);
  }
  return current;
}

/** 测试辅助：只改内存不落 kv。 */
export function setCapabilitySettingsForTest(raw: unknown): CapabilitySettings {
  current = normalizeCapabilitySettings(raw);
  return current;
}

/** 测试辅助：恢复默认。 */
export function resetCapabilitySettingsForTest(): void {
  current = { ...EMPTY_SETTINGS };
}
