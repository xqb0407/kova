/**
 * 自定义端点 `/models` 响应的元数据抽取。
 *
 * OpenAI 兼容网关的 `/models` 常见返回 `{ data: [{ id, context_length, ... }] }`，
 * 但字段名各家不一；这里按常见别名抽取上下文窗口与输出上限，抽不到就只回 id。
 * 结果用于「添加模型」弹窗预填模型行，避免用户手填 contextWindow / maxTokens。
 */

export type FetchedModelDetail = {
  id: string;
  contextLength?: number;
  maxTokens?: number;
};

const CONTEXT_KEYS = [
  "context_length",
  "context_window",
  "max_context_length",
  "max_context_tokens",
  "max_model_len",
  "input_token_limit",
  "max_input_tokens",
] as const;

const OUTPUT_KEYS = [
  "max_completion_tokens",
  "max_output_tokens",
  "max_tokens",
  "output_token_limit",
  "max_output_token",
] as const;

const positiveInt = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }
  if (typeof value !== "string") return undefined;
  // 常见写法：128000 / "128,000" / "128k" / "1M"
  const match = /^([\d.,]+)\s*([km])?$/.exec(value.trim().toLowerCase());
  if (!match) return undefined;
  const n = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
  const rounded = Math.floor(n * multiplier);
  return rounded > 0 ? rounded : undefined;
};

const readFirst = (
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined => {
  for (const key of keys) {
    const value = positiveInt(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

/**
 * 从 `/models` JSON（`{data:[...]}` 或裸数组）抽取 id 与常见窗口元数据。
 * 顺序保留，id 去重；只有至少带一个元数据字段的条目才进 details。
 */
export function parseFetchedModelList(payload: unknown): {
  models: string[];
  details: FetchedModelDetail[];
} {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown } | null)?.data)
      ? ((payload as { data: unknown[] }).data ?? [])
      : [];
  const models: string[] = [];
  const details: FetchedModelDetail[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const record =
      item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
    const id =
      typeof item === "string"
        ? item.trim()
        : typeof record?.id === "string"
          ? record.id.trim()
          : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
    if (!record) continue;
    const contextLength = readFirst(record, CONTEXT_KEYS);
    const maxTokens = readFirst(record, OUTPUT_KEYS);
    if (contextLength !== undefined || maxTokens !== undefined) {
      details.push({
        id,
        ...(contextLength !== undefined ? { contextLength } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });
    }
  }
  return { models, details };
}
