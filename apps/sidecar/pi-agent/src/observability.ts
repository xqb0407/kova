/**
 * 可观测性导出配置（设置 → 系统 → 追踪）：
 * 控制 agent 调用轨迹（trace.ts 的 run 记录）是否经 OTLP/HTTP 导出到外部平台
 * （Langfuse 走其 OTel 端点 /api/public/otel/v1/traces，任意 OTLP 后端通用）。
 * 配置整包存 SQLite kv（key = KV_KEY），前端经协议 get/set_observability 访问；
 * otlp-exporter 在每次 run 结算时实时读这份内存配置门控（与 browser 同款机制）。
 */
import { kvGet, kvSet } from "./hostdb";
import { logErr } from "./log";

export const OBSERVABILITY_KV_KEY = "pi.observability";

/** 可观测性设置整包（kv 与协议共用同一形状） */
export type ObservabilityConfig = {
  /** 总开关：关闭时 run 记录只落本地 traces 文件，不外发 */
  enabled: boolean;
  /** OTLP/HTTP traces 端点（完整 URL，如 https://cloud.langfuse.com/api/public/otel/v1/traces） */
  endpoint: string;
  /** 附加请求头（鉴权等；Langfuse: Authorization: Basic base64(公钥:私钥)） */
  headers: Record<string, string>;
  /** 采样率 0~1，按 run 粒度 */
  sampleRate: number;
  /** 内容脱敏：true = 只上传元数据（耗时/token/模型/工具名），不上传 prompt 与工具正文 */
  redactContent: boolean;
};

export const DEFAULT_OBSERVABILITY_CONFIG: ObservabilityConfig = {
  enabled: false,
  endpoint: "",
  headers: {},
  sampleRate: 1,
  redactContent: true,
};

const clamp01 = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : undefined;

/** 任意来源（kv JSON / 协议消息）的宽松规整：未知字段丢弃，非法值回落默认 */
export function normalizeObservabilityConfig(raw: unknown): ObservabilityConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const headers: Record<string, string> = {};
  if (typeof r.headers === "object" && r.headers !== null) {
    for (const [key, value] of Object.entries(r.headers as Record<string, unknown>)) {
      const k = key.trim();
      if (k && typeof value === "string") headers[k] = value;
    }
  }
  const sampleRate = clamp01(r.sampleRate) ?? DEFAULT_OBSERVABILITY_CONFIG.sampleRate;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_OBSERVABILITY_CONFIG.enabled,
    endpoint: typeof r.endpoint === "string" ? r.endpoint.trim() : DEFAULT_OBSERVABILITY_CONFIG.endpoint,
    headers,
    sampleRate,
    redactContent:
      typeof r.redactContent === "boolean"
        ? r.redactContent
        : DEFAULT_OBSERVABILITY_CONFIG.redactContent,
  };
}

let current: ObservabilityConfig = { ...DEFAULT_OBSERVABILITY_CONFIG };

export function getObservabilityConfig(): ObservabilityConfig {
  return current;
}

/** 启动恢复：kv 里的整包 JSON 载入内存；失败保持默认（不阻断启动） */
export async function initObservability(): Promise<void> {
  try {
    const row = await kvGet(OBSERVABILITY_KV_KEY);
    if (row?.value) current = normalizeObservabilityConfig(JSON.parse(row.value));
  } catch (err) {
    logErr("observability: load failed:", err);
  }
}

/** 测试辅助：仅清内存不落 kv */
export function resetObservabilityConfigForTest(): void {
  current = { ...DEFAULT_OBSERVABILITY_CONFIG };
}

/** 应用新设置：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落） */
export async function applyObservabilityConfig(raw: unknown): Promise<ObservabilityConfig> {
  const next = normalizeObservabilityConfig(raw);
  current = next;
  try {
    await kvSet(OBSERVABILITY_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("observability: persist failed:", err);
  }
  return next;
}
