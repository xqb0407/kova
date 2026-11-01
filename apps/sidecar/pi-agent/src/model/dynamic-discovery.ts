/**
 * 自定义端点的动态模型发现（移植自 pi 扩展 pi-dynamic-models，适配 kova 架构）：
 * 拉网关 /models 自报清单，把用户没手写的 id 以 AUTO 模型补进目录——上下文
 * 窗口、输出上限、输入模态、思考档位按网关自报值；缺的字段用内置目录同名
 * 种子（lookupCatalogModelSeed）兜底，不再单独拉 models.dev（pi-ai 内置目录
 * 本身就是 models.dev 数据的整理版，kova 的种子反查已覆盖同一职责）。
 *
 * 与手写模型的边界（扩展语义原样保留）：AUTO 永不覆盖 models 表手写行，只
 * 追加缺失 id。发现结果缓存在 hostdb kv（键 pi.dynamic-models.<providerId>，
 * 按配置指纹绑定），6h 新鲜期 + 失败冷却 10 分钟；缓存只存模型能力摘要，
 * 不存密钥——指纹里只进 apiKey 的 sha256，不进原文。
 *
 * 本模块保持纯函数 + kv 读写，不感知目录注册（合并注册在 custom-providers.ts）。
 */
import { createHash } from "node:crypto";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { logErr } from "../log";
import { credentialGet, kvGet, kvSet } from "../storage/hostdb";
import type { CustomApiKind } from "../types";

/** /models 里解析出的单个模型能力摘要（只保留对注册有用的字段） */
export type DiscoveredModel = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  /** 输入模态；网关没报时不设（注册回落目录种子/缺省 ["text"]） */
  input?: ("text" | "image")[];
};

/* ------------------------------ 响应解析 ------------------------------ */

/** 正整数归一：数字直接过（有限且 >0），字符串支持 "128000" / "128,000" / "128k" / "1M" */
const positiveInt = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }
  if (typeof value !== "string") return undefined;
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

// 网关字段名各家不一：上下文窗口与输出上限的常见别名（含 limits 嵌套）。
const CONTEXT_KEYS = [
  "contextWindow",
  "context_length",
  "context_window",
  "max_context_length",
  "max_context_tokens",
  "max_model_len",
  "input_token_limit",
  "max_input_tokens",
] as const;

const OUTPUT_KEYS = [
  "maxTokens",
  "max_output_tokens",
  "max_completion_tokens",
  "max_tokens",
  "output_token_limit",
  "max_output_token",
] as const;

const LIMIT_CONTEXT_KEYS = [
  "context_window",
  "max_input_tokens",
  "context",
] as const;

const LIMIT_OUTPUT_KEYS = ["max_output_tokens"] as const;

const MODALITY_KEYS = ["input_modalities", "input"] as const;
const OUTPUT_MODALITY_KEYS = ["output_modalities", "output"] as const;

const firstStringArray = (
  record: Record<string, unknown>,
  keys: readonly string[],
): string[] | undefined => {
  for (const key of keys) {
    const v = record[key];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      return v as string[];
    }
  }
  return undefined;
};

const firstNestedStringArray = (
  record: Record<string, unknown>,
  container: string,
  keys: readonly string[],
): string[] | undefined => {
  const nested = record[container];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return undefined;
  return firstStringArray(nested as Record<string, unknown>, keys);
};

/** 思考档位：字符串或 { effort } 对象两种形态；脏值丢弃 */
const readReasoningLevels = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      names.push(item.toLowerCase());
    } else if (
      item &&
      typeof item === "object" &&
      typeof (item as { effort?: unknown }).effort === "string"
    ) {
      names.push((item as { effort: string }).effort.toLowerCase());
    }
  }
  return names.length > 0 ? names : undefined;
};

const THINKING_MAP_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * 网关只列出自带档位，其余必须显式写 null：宿主把「键不存在」当作支持，
 * 稀疏映射会让档位选择器暴露网关不接受的档位。off 不写（kova 的 off 值是
 * 「关闭思考时下发的参数」，网关 /models 不会自报，留空走默认关闭行为）。
 */
const thinkingMapFromLevels = (
  levels: string[] | undefined,
): ThinkingLevelMap | undefined => {
  if (!levels?.length) return undefined;
  const map: ThinkingLevelMap = {};
  for (const level of THINKING_MAP_LEVELS) {
    map[level] = levels.includes(level) ? level : null;
  }
  return map;
};

/**
 * /models 载荷 → 模型能力摘要列表。
 * - 裸数组 / {data:[...]} / {models:[...]} 三种枚举响应；其余整体视为畸形返回 []。
 * - 单行降级：字符串行与只有 id 的对象行仍可注册；缺 id / 非对象的行只跳过该行。
 * - 非对话输出（图片、向量）无法在 chat 端点使用：filterNonText 时丢弃该行。
 * - id 去重（保留首次出现，顺序保留）。
 */
export function parseDiscoveredModels(
  payload: unknown,
  opts: { filterNonText?: boolean } = {},
): DiscoveredModel[] {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown } | null)?.data)
      ? ((payload as { data: unknown[] }).data ?? [])
      : Array.isArray((payload as { models?: unknown } | null)?.models)
        ? ((payload as { models: unknown[] }).models ?? [])
        : [];
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const record =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : undefined;
    const id =
      typeof item === "string"
        ? item.trim()
        : typeof record?.id === "string"
          ? record.id.trim()
          : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!record) {
      out.push({ id });
      continue;
    }
    // 输出模态任一层自报且不含 text = 非对话模型（图片/向量）
    const output =
      firstStringArray(record, OUTPUT_MODALITY_KEYS) ??
      firstNestedStringArray(record, "architecture", OUTPUT_MODALITY_KEYS) ??
      firstNestedStringArray(record, "modalities", OUTPUT_MODALITY_KEYS);
    if (opts.filterNonText && output?.length && !output.includes("text")) continue;

    const model: DiscoveredModel = { id };
    const name =
      typeof record.display_name === "string" && record.display_name.trim()
        ? record.display_name.trim()
        : typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : undefined;
    if (name) model.name = name;

    const inputKinds =
      firstStringArray(record, MODALITY_KEYS) ??
      firstNestedStringArray(record, "architecture", MODALITY_KEYS) ??
      firstNestedStringArray(record, "modalities", MODALITY_KEYS);
    const input = inputKinds?.filter(
      (kind): kind is "text" | "image" => kind === "text" || kind === "image",
    );

    const limits =
      record.limits && typeof record.limits === "object" && !Array.isArray(record.limits)
        ? (record.limits as Record<string, unknown>)
        : undefined;
    const contextWindow =
      readFirst(record, CONTEXT_KEYS) ??
      (limits ? readFirst(limits, LIMIT_CONTEXT_KEYS) : undefined);
    const maxTokens =
      readFirst(record, OUTPUT_KEYS) ??
      (limits ? readFirst(limits, LIMIT_OUTPUT_KEYS) : undefined);

    const levels =
      readReasoningLevels(record.reasoning_levels) ??
      readReasoningLevels(record.supported_reasoning_levels);
    const reasoning =
      typeof record.reasoning === "boolean"
        ? record.reasoning
        : typeof record.supports_reasoning === "boolean"
          ? record.supports_reasoning
          : levels
            ? true
            : undefined;

    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    if (maxTokens !== undefined) model.maxTokens = maxTokens;
    if (reasoning !== undefined) model.reasoning = reasoning;
    if (reasoning) {
      const map = thinkingMapFromLevels(levels);
      if (map) model.thinkingLevelMap = map;
    }
    if (input?.length) model.input = input;
    out.push(model);
  }
  return out;
}

/* ------------------------------ 端点探测 ------------------------------ */

/** 大小写不敏感合并自定义头（用户显式填的覆盖默认 Authorization 等） */
const mergeHeaders = (
  base: Record<string, string>,
  extra: Record<string, string>,
): Record<string, string> => {
  const out = { ...base };
  for (const [name, value] of Object.entries(extra)) {
    for (const key of Object.keys(out)) {
      if (key.toLowerCase() === name.toLowerCase()) delete out[key];
    }
    out[name] = value;
  }
  return out;
};

/**
 * 单个端点探测：非 2xx 或响应不是模型列表都抛错（不带响应体——回显可能含凭据）。
 * signal 是调用方共享的 controller：超时与竞速收尾的 abort 都走这里，
 * AbortError 统一转成可读的超时文案（原始 abort 文案对用户没有信息量）。
 */
const probeModels = async (
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<DiscoveredModel[]> => {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: Object.keys(headers ?? {}).length ? headers : undefined,
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`${url}: request timed out`);
    }
    throw err;
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`${url}: response is not a model list`);
  }
  return parseDiscoveredModels(payload, { filterNonText: true });
};

/**
 * 候选端点竞速（移植自扩展 firstNonEmpty）：空列表会作为权威结果删除旧
 * AUTO 模型，因此任一候选返回非空立即采用；全部成功且都空才算权威空结果；
 * 存在失败时不得用空列表覆盖缓存（抛错交给 stale-cache 回退）。
 */
const firstNonEmpty = (
  endpoints: string[],
  load: (url: string) => Promise<DiscoveredModel[]>,
): Promise<DiscoveredModel[]> =>
  new Promise((resolve, reject) => {
    let pending = endpoints.length;
    let empties = 0;
    const failures: string[] = [];
    const settle = (models?: DiscoveredModel[]): void => {
      pending -= 1;
      if (models?.length) {
        resolve(models);
        return;
      }
      if (models) empties += 1;
      if (pending > 0) return;
      if (failures.length > 0) {
        reject(new Error(failures.join("; ")));
        return;
      }
      if (empties > 0) resolve([]);
      else reject(new Error("no model endpoint available"));
    };
    for (const endpoint of endpoints) {
      load(endpoint).then(
        (models) => settle(models),
        (error) => {
          failures.push(error instanceof Error ? error.message : String(error));
          settle();
        },
      );
    }
  });

/**
 * 按接口格式拉取网关模型清单（发现入口）：
 * - openai-chat / openai-responses → GET {baseUrl}/models，baseUrl 不以 /v1 结尾时
 *   再竞速一个 {baseUrl}/v1/models；Bearer 认证
 * - anthropic-messages → GET {baseUrl}/v1/models?limit=1000；x-api-key + anthropic-version
 * 自定义头最后合并（用户显式填的覆盖默认头）。候选端点共享一个超时 controller：
 * 到点全部掐断；竞速分出胜负后同样掐掉落选请求，不让失败的候选悬挂到自然超时。
 */
export async function fetchDiscoveredModels(opts: {
  baseUrl: string;
  api: CustomApiKind;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<DiscoveredModel[]> {
  const baseUrl = opts.baseUrl.trim().replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const anthropic = opts.api === "anthropic-messages";
  const baseHeaders: Record<string, string> = anthropic
    ? {
        ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}),
        "anthropic-version": "2023-06-01",
      }
    : opts.apiKey
      ? { Authorization: `Bearer ${opts.apiKey}` }
      : {};
  const headers = mergeHeaders(baseHeaders, opts.headers ?? {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (anthropic) {
      const url = `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/models?limit=1000`;
      return await probeModels(url, headers, controller.signal);
    }
    const endpoints = baseUrl.endsWith("/v1")
      ? [`${baseUrl}/models`]
      : [`${baseUrl}/models`, `${baseUrl}/v1/models`];
    return await firstNonEmpty(endpoints, (url) =>
      probeModels(url, headers, controller.signal),
    );
  } finally {
    clearTimeout(timer);
    // 竞速已 settle（或抛错）：掐掉落选/剩余请求，连接不悬挂
    controller.abort();
  }
}

/* ------------------------------ 缓存（hostdb kv） ------------------------------ */

export type DiscoveryCache = {
  version: 2;
  /** 配置指纹：换端点/账户/头后旧缓存视为失效，按新指纹重新发现 */
  fingerprint: string;
  models: DiscoveredModel[];
  /** 最近一次成功发现的时间戳（ms）；新鲜期判断用 */
  fetchedAt: number;
  /** 最近一次发现失败的时间戳（ms）；失败冷却期内不再重试网络 */
  lastFailedUnix?: number;
};

const KV_PREFIX = "pi.dynamic-models.";
export const DISCOVERY_FRESH_MS = 6 * 60 * 60 * 1000;
export const DISCOVERY_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

/** thinkingLevelMap 白名单清洗：未知键与非字符串非 null 值丢弃（与 thinking.ts 同款） */
const cleanThinkingMap = (raw: unknown): ThinkingLevelMap | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: ThinkingLevelMap = {};
  for (const level of THINKING_MAP_LEVELS) {
    const v = src[level];
    if (typeof v === "string" && v.trim()) out[level] = v;
    else if (v === null) out[level] = null;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * 配置指纹：基于配置引用而非密钥值（apiKey 只进 sha256 摘要）——换账户/端点/
 * 协议/头都会失效缓存重新发现，但磁盘上不出现密钥原文。
 */
export function discoveryFingerprint(parts: {
  baseUrl: string;
  api: CustomApiKind;
  apiKey?: string;
  headers?: Record<string, string>;
}): string {
  const apiKeyHash = parts.apiKey
    ? createHash("sha256").update(parts.apiKey).digest("hex")
    : "";
  return createHash("sha256")
    .update(
      JSON.stringify([
        parts.baseUrl.trim().replace(/\/+$/, ""),
        parts.api,
        apiKeyHash,
        Object.entries(parts.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
}

/** 磁盘 JSON 是不可信输入：解析失败/形状不符按缺失处理 */
export function decodeDiscoveryCache(raw: string | null): DiscoveryCache | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const c = parsed as DiscoveryCache | null;
  if (
    !c ||
    c.version !== 2 ||
    typeof c.fingerprint !== "string" ||
    !Array.isArray(c.models) ||
    typeof c.fetchedAt !== "number"
  ) {
    return undefined;
  }
  // 逐条降级：缺 id 的行丢弃，其余字段按需取舍（坏行不拖垮整份缓存）
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const m of c.models) {
    if (!m || typeof m !== "object" || typeof m.id !== "string" || !m.id.trim()) continue;
    const id = m.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const thinkingLevelMap = cleanThinkingMap(m.thinkingLevelMap);
    models.push({
      id,
      ...(typeof m.name === "string" && m.name.trim() ? { name: m.name.trim() } : {}),
      ...(typeof m.contextWindow === "number" && m.contextWindow > 0
        ? { contextWindow: m.contextWindow }
        : {}),
      ...(typeof m.maxTokens === "number" && m.maxTokens > 0
        ? { maxTokens: m.maxTokens }
        : {}),
      ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      ...(Array.isArray(m.input) &&
      m.input.every((x) => x === "text" || x === "image")
        ? { input: m.input }
        : {}),
    });
  }
  return {
    version: 2,
    fingerprint: c.fingerprint,
    models,
    fetchedAt: c.fetchedAt,
    ...(typeof c.lastFailedUnix === "number" ? { lastFailedUnix: c.lastFailedUnix } : {}),
  };
}

const cacheKey = (providerId: string): string => `${KV_PREFIX}${providerId}`;

/** 读指纹匹配的缓存：指纹不匹配（换过配置）返回 undefined */
export async function loadDiscoveryCache(
  providerId: string,
  fingerprint: string,
): Promise<DiscoveryCache | undefined> {
  try {
    const cached = decodeDiscoveryCache((await kvGet(cacheKey(providerId)))?.value ?? null);
    return cached?.fingerprint === fingerprint ? cached : undefined;
  } catch (err) {
    logErr("dynamic-discovery: load cache failed:", providerId, err);
    return undefined;
  }
}

export async function saveDiscoveryCache(providerId: string, cache: DiscoveryCache): Promise<void> {
  await kvSet(cacheKey(providerId), JSON.stringify(cache));
}

/** 缓存是否在新鲜期内（新鲜 = 不需要重新联网） */
export function isDiscoveryFresh(cache: DiscoveryCache, now = Date.now()): boolean {
  return now - cache.fetchedAt < DISCOVERY_FRESH_MS;
}

/** 最近失败是否还在冷却期内（冷却 = 暂不重试网络，用 stale 缓存） */
export function inDiscoveryFailureCooldown(cache: DiscoveryCache, now = Date.now()): boolean {
  return (
    cache.lastFailedUnix !== undefined &&
    now - cache.lastFailedUnix < DISCOVERY_FAILURE_COOLDOWN_MS
  );
}

/**
 * 是否需要联网重新发现：无缓存 / 过期且不在失败冷却里。force 绕过全部判断。
 * 「过期但冷却中」不重试（离线/网关故障时不会每次保存都等超时），继续用旧缓存。
 */
export function discoveryNeedsFetch(
  cache: DiscoveryCache | undefined,
  opts: { force?: boolean } = {},
  now = Date.now(),
): boolean {
  if (opts.force) return true;
  if (!cache) return true;
  return !isDiscoveryFresh(cache, now) && !inDiscoveryFailureCooldown(cache, now);
}

/**
 * 读某 provider 的 AUTO 模型（注册与摘要共用）：缓存存在且指纹匹配时，
 * 过滤掉手写 id（AUTO 永不覆盖手写行）。联网与否调用方决定，这里只读缓存。
 */
export async function loadAutoModels(
  providerId: string,
  parts: {
    baseUrl: string;
    api: CustomApiKind;
    apiKey?: string;
    headers?: Record<string, string>;
  },
  manualIds: Iterable<string>,
): Promise<DiscoveredModel[]> {
  const fingerprint = discoveryFingerprint(parts);
  const cache = await loadDiscoveryCache(providerId, fingerprint);
  if (!cache) return [];
  const manual = new Set(manualIds);
  const seen = new Set<string>();
  const out: DiscoveredModel[] = [];
  for (const model of cache.models) {
    if (manual.has(model.id) || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}
