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
import { logAt, logErr } from "../log";
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
  /** 图片能力三态：true/false 已知，null 未声明（注册时保留未知，不预剥图） */
  supportsImage?: boolean | null;
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

const MODEL_ENVELOPE_KEYS = ["data", "models", "items", "result", "list"] as const;

/** 行看起来像模型（非空字符串 id，或带 id/model/model_id 的对象） */
const isModelRow = (row: unknown): boolean => {
  if (typeof row === "string") return row.trim().length > 0;
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const record = row as Record<string, unknown>;
  return ["id", "model", "model_id"].some(
    (key) => typeof record[key] === "string" || typeof record[key] === "number",
  );
};

/** 常见信封收敛：裸数组 / data / models / items / result / list，允许一层嵌套。
 *  同一层有多个模型数组时做**并集**（解析器按 id 去重）——`data[18]` +
 *  `models[27]` 这类网关把清单拆在两个键里的情况，只取其一就会"拉不全"。 */
function extractModelRows(payload: unknown, depth = 0): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object" || depth > 2) return [];
  const record = payload as Record<string, unknown>;
  const entries = MODEL_ENVELOPE_KEYS.map((key) => ({
    key,
    rows: record[key],
  })).filter(
    (entry): entry is { key: (typeof MODEL_ENVELOPE_KEYS)[number]; rows: unknown[] } =>
      Array.isArray(entry.rows),
  );
  if (entries.length > 0) {
    const modelEntries = entries.filter((entry) => entry.rows.some(isModelRow));
    const primary = modelEntries.filter(
      (entry) => entry.key === "data" || entry.key === "models",
    );
    const pool = primary.length > 0 ? primary : modelEntries.length > 0 ? modelEntries : [];
    // 同层多个模型清单做并集，解析器按 id 去重：data/models 可能各带一部分
    const rows = pool.map((entry) => entry.rows).flat();
    if (rows.length > 0) return rows;
  }
  let best: unknown[] = [];
  for (const key of MODEL_ENVELOPE_KEYS) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = extractModelRows(value, depth + 1);
      if (nested.length > best.length) best = nested;
    }
  }
  if (best.length > 0) return best;
  const fallback = entries.length > 0
    ? entries
        .map((entry) => entry.rows)
        .reduce((longest, current) => (current.length > longest.length ? current : longest))
    : [];
  return fallback;
}

/**
 * 单行模型 id：标准 `id` 优先，其次 `model` / `model_id`；数字 id 兜底转字符串。
 * 不拿 `name` 兜底——很多网关的 name 是展示名，不是可调用的模型 ID。
 */
function rowModelId(item: unknown, record?: Record<string, unknown>): string {
  if (typeof item === "string") return item.trim();
  if (!record) return "";
  for (const key of ["id", "model", "model_id"] as const) {
    const value = record[key];
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/** 诊断用的响应形状：顶层键类型/数组长度 + 首行键名（不打印值，避免日志泄漏） */
function describeModelPayload(payload: unknown): string {
  if (Array.isArray(payload)) return `array[${payload.length}]`;
  if (!payload || typeof payload !== "object") return typeof payload;
  const shape = Object.entries(payload as Record<string, unknown>)
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}[${value.length}]`;
      if (value && typeof value === "object") {
        const nested = Object.keys(value as Record<string, unknown>).slice(0, 8);
        return `${key}{${nested.join("|")}}`;
      }
      return `${key}:${typeof value}`;
    })
    .join(", ");
  const first = extractModelRows(payload)[0];
  const rowKeys =
    first && typeof first === "object" && !Array.isArray(first)
      ? Object.keys(first as Record<string, unknown>).slice(0, 24).join("|")
      : typeof first;
  return `${shape}; row keys: ${rowKeys}`;
}

/**
 * /models 载荷 → 模型能力摘要列表。
 * - 裸数组 / {data:[...]} / {models:[...]} / {items|result|list:[...]}，以及
 *   `{data:{models:[...]}}` 这类一层嵌套信封都能识别；其余视为畸形返回 []。
 * - 单行降级：字符串行、`id`/`model`/`model_id` 对象行仍可注册；缺 id 跳过。
 * - 非对话输出（图片、向量）无法在 chat 端点使用：filterNonText 时丢弃该行。
 * - id 去重（保留首次出现，顺序保留）；被过滤的行不占用去重位。
 */
export function parseDiscoveredModels(
  payload: unknown,
  opts: {
    filterNonText?: boolean;
    /** 被 filterNonText 跳过的 id（自动发现用来记录"跳过了哪些图片/向量模型"） */
    onFiltered?: (id: string) => void;
  } = {},
): DiscoveredModel[] {
  const raw = extractModelRows(payload);
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const record =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : undefined;
    const id = rowModelId(item, record);
    if (!id || seen.has(id)) continue;
    if (!record) {
      seen.add(id);
      out.push({ id });
      continue;
    }
    // 输出模态任一层自报且不含 text = 非对话模型（图片/向量）
    const output =
      firstStringArray(record, OUTPUT_MODALITY_KEYS) ??
      firstNestedStringArray(record, "architecture", OUTPUT_MODALITY_KEYS) ??
      firstNestedStringArray(record, "modalities", OUTPUT_MODALITY_KEYS);
    if (opts.filterNonText && output?.length && !output.includes("text")) {
      opts.onFiltered?.(id);
      continue;
    }
    seen.add(id);

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
    if (input?.length) {
      model.input = input;
      // input 是能力事实源之一，三态标记随发现结果同步，避免后续请求仍按旧值判
      model.supportsImage = input.includes("image");
    }
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

/** 日志安全的 URL：去掉 userinfo/hash，query 值统一打码（保留键名便于排查）。 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    if (url.search) {
      const params = new URLSearchParams();
      for (const [key] of url.searchParams) params.append(key, "***");
      url.search = params.toString();
    }
    return url.toString();
  } catch {
    // 无法解析时按 query 形态兜底打码（不改其它部分）
    return raw.replace(/([?&][^=&#]+)=([^&#]*)/g, "$1=***");
  }
}

/** 单次 /models 探测（可能跨多页）的结果 */
export type ModelPageBundle = {
  models: DiscoveredModel[];
  pages: number;
  /** 原始行数（含被去重/过滤掉的行），诊断"网关只回了这些"还是"解析丢了" */
  rawRows: number;
  /** 达到页数上限时端点仍报告有下一页 */
  truncated: boolean;
};

/** 防止分页端点返回循环/无限列表：20 页 × 常见 1000 条/页已经远超实际规模 */
const MAX_MODEL_PAGES = 20;

/** merge 模式下等待较慢候选的时间：够第二个端点/下一页回来，又不让 UI 干等 */
export const MODEL_MERGE_GRACE_MS = 2_000;

/**
 * 从一页响应里推导下一页 URL：
 * - `next` / `next_url` / `next_page_url` 直接给 URL（相对地址按当前 URL 解析）；
 * - Anthropic 风格 `has_more + last_id` → 追加 `after_id`；
 * - `next_page` / `page` 数字 → 追加 `page`。
 * 推不出来或指回当前页时返回 undefined（停止分页）。
 */
export function nextModelPageUrl(currentUrl: string, payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const direct = record.next ?? record.next_url ?? record.next_page_url;
  if (typeof direct === "string" && direct.trim()) {
    try {
      const current = new URL(currentUrl);
      const next = new URL(direct.trim(), currentUrl);
      // 分页 URL 只允许同源：否则网关返回的 next 会把带 API Key 的请求引到别的域名
      if (next.origin !== current.origin) return undefined;
      return next.toString() === current.toString() ? undefined : next.toString();
    } catch {
      return undefined;
    }
  }
  const hasMore = record.has_more;
  if (
    hasMore !== true &&
    hasMore !== "true" &&
    hasMore !== 1 &&
    hasMore !== "1"
  ) {
    return undefined;
  }
  const current = new URL(currentUrl);
  const rawLast = record.last_id;
  const lastId =
    typeof rawLast === "string"
      ? rawLast.trim()
      : typeof rawLast === "number" && Number.isFinite(rawLast)
        ? String(rawLast)
        : "";
  if (lastId) {
    current.searchParams.set("after_id", lastId);
    return current.toString();
  }
  const nextPage = record.next_page;
  if (typeof nextPage === "number" && Number.isFinite(nextPage)) {
    current.searchParams.set("page", String(nextPage));
    return current.toString();
  }
  if (typeof nextPage === "string" && /^\d+$/.test(nextPage.trim())) {
    current.searchParams.set("page", nextPage.trim());
    return current.toString();
  }
  if (typeof record.page === "number" && Number.isFinite(record.page)) {
    current.searchParams.set("page", String(record.page + 1));
    return current.toString();
  }
  return undefined;
}

/**
 * 拉取一个端点的全部分页：非 2xx、响应不是 JSON 都抛错（不带响应体——回显可能
 * 含凭据）；AbortError 统一转成可读超时文案。跨页按 id 去重，顺序保留。
 */
export async function fetchAllModelPages(
  url: string,
  opts: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    filterNonText?: boolean;
    /** 被 filterNonText 跳过的 id（发现路径记录跳过清单，手动获取不传） */
    onFiltered?: (id: string) => void;
    /** 手动「获取模型」路径打开：日志记录响应形状，排查网关只回了一部分 */
    logShape?: boolean;
  } = {},
): Promise<ModelPageBundle> {
  const models: DiscoveredModel[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  let next: string | undefined = url;
  let pages = 0;
  let rawRows = 0;
  while (next) {
    if (pages >= MAX_MODEL_PAGES) {
      return { models, pages, rawRows, truncated: true };
    }
    if (seenUrls.has(next)) break;
    seenUrls.add(next);
    const currentUrl: string = next;
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        headers: Object.keys(opts.headers ?? {}).length ? opts.headers : undefined,
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`${redactUrl(currentUrl)}: request timed out`);
      }
      throw err;
    }
    if (!res.ok) throw new Error(`${redactUrl(currentUrl)}: HTTP ${res.status}`);
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new Error(`${redactUrl(currentUrl)}: response is not a model list`);
    }
    if (opts.logShape) {
      logAt("event", `[fetch_models] payload ${redactUrl(currentUrl)}: ${describeModelPayload(payload)}`);
    }
    for (const model of parseDiscoveredModels(payload, {
      filterNonText: opts.filterNonText,
      onFiltered: opts.onFiltered,
    })) {
      if (seenIds.has(model.id)) continue;
      seenIds.add(model.id);
      models.push(model);
    }
    rawRows += extractModelRows(payload).length;
    pages += 1;
    const nextUrl: string | undefined = nextModelPageUrl(currentUrl, payload);
    if (!nextUrl || nextUrl === currentUrl) break;
    next = nextUrl;
  }
  return { models, pages, rawRows, truncated: false };
}

/** 多个候选端点的模型并集：按 id 去重，保留先出现的顺序 */
export function mergeDiscoveredModels(lists: DiscoveredModel[][]): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const model of list) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      out.push(model);
    }
  }
  return out;
}

/** 合并多个候选端点的分页结果（模型取并集，页数相加，任一截断即截断） */
export function mergeModelPageBundles(bundles: ModelPageBundle[]): ModelPageBundle {
  return {
    models: mergeDiscoveredModels(bundles.map((bundle) => bundle.models)),
    pages: bundles.reduce((total, bundle) => total + bundle.pages, 0),
    rawRows: bundles.reduce((total, bundle) => total + bundle.rawRows, 0),
    truncated: bundles.some((bundle) => bundle.truncated),
  };
}

/** 粘贴完整端点时常见的后缀：先收敛回 baseUrl，避免 /models 被拼两次 */
const MODEL_ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/completions",
  "/responses",
  "/messages",
  "/models",
] as const;

/**
 * baseUrl 归一：去掉已知端点后缀、末尾斜杠与 `#` 片段，保留查询串；协议/主机
 * 交给 URL 统一大小写。无法解析时退回“去尾部斜杠”的旧字符串口径。
 */
export function normalizeModelBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // 保留原样交给 assertBaseUrl 报 "invalid"，不要把 https:// 削成 https:
    return trimmed;
  }
  let path = url.pathname.replace(/\/+$/, "");
  for (const suffix of MODEL_ENDPOINT_SUFFIXES) {
    if (path.toLowerCase().endsWith(suffix)) {
      path = path.slice(0, -suffix.length);
      break;
    }
  }
  url.hash = "";
  url.pathname = path || "/";
  const out = url.toString();
  return url.pathname === "/" && out.endsWith("/") ? out.slice(0, -1) : out;
}

/**
 * `/models` 候选端点（fetch_models 预填与自动发现共用同一口径）：
 * - anthropic：统一补 `/v1`（已带则不加），带 limit=1000；
 * - openai 系：baseUrl 已带 `/v1` 时只请求 `{base}/models`；不带时
 *   `/models` 与 `/v1/models` 都试（用户可能填裸域名，也可能填带前缀的端点）。
 * 完整端点（`/v1/models`、`/v1/chat/completions`）先归一，查询串原样保留。
 */
export function modelListCandidateUrls(baseUrl: string, api: CustomApiKind): string[] {
  const base = normalizeModelBaseUrl(baseUrl);
  if (!base) return [];
  let baseUrlObj: URL;
  try {
    baseUrlObj = new URL(base);
  } catch {
    return [];
  }
  const basePath = baseUrlObj.pathname.replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    const url = new URL(base);
    url.pathname = basePath.toLowerCase().endsWith("/v1")
      ? `${basePath}/models`
      : `${basePath}/v1/models`;
    url.searchParams.set("limit", "1000");
    return [url.toString()];
  }
  const suffixes = basePath.toLowerCase().endsWith("/v1")
    ? ["/models"]
    : ["/models", "/v1/models"];
  return suffixes.map((suffix) => {
    const url = new URL(base);
    url.pathname = `${basePath}${suffix}`;
    return url.toString();
  });
}

/**
 * 候选端点竞速（移植自扩展 firstNonEmpty）：空列表会作为权威结果删除旧
 * AUTO 模型，因此任一候选返回非空即可采用；全部成功且都空才算权威空结果；
 * 存在失败时不得用空列表覆盖缓存（抛错交给 stale-cache 回退）。
 *
 * merge 打开时（/models 预填与自动发现都用）：首个非空结果到达后再等
 * mergeGraceMs，把其它候选的并集一并返回——裸域名的 `/models` 与
 * `/v1/models` 内容可能不同，先到先得会让较全的列表被较快的子集截胡。
 *
 * tolerateEmptyWithFailures 给「用户手动拉列表」的预填路径用：那里空列表是
 * 合法结果（网关确实没有模型），一个端点空、另一个 404 时不该升级成错误。
 */
export type FirstNonEmptyOptions<T> = {
  tolerateEmptyWithFailures?: boolean;
  /** 合并多个非空结果（默认先到先得） */
  merge?: (results: T[][]) => T[];
  /** merge 模式下，首个非空结果后等待其它候选的宽限时间 */
  mergeGraceMs?: number;
};

export const firstNonEmpty = <T>(
  endpoints: string[],
  load: (url: string) => Promise<T[]>,
  opts: FirstNonEmptyOptions<T> = {},
): Promise<T[]> =>
  new Promise((resolve, reject) => {
    if (endpoints.length === 0) {
      reject(new Error("no model endpoint available"));
      return;
    }
    const results: T[][] = [];
    const failures: string[] = [];
    let pending = endpoints.length;
    let empties = 0;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    const clearGrace = (): void => {
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      clearGrace();
      const nonEmpty = results.filter((models) => models.length > 0);
      if (nonEmpty.length > 0) {
        resolve(opts.merge ? opts.merge(nonEmpty) : nonEmpty[0]);
        return;
      }
      if (failures.length > 0 && (!opts.tolerateEmptyWithFailures || empties === 0)) {
        reject(new Error(failures.join("; ")));
        return;
      }
      resolve([]);
    };
    const settle = (index: number, models?: T[], error?: unknown): void => {
      if (done) return;
      pending -= 1;
      if (models) {
        results[index] = models;
        if (models.length === 0) empties += 1;
      } else {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      if (!opts.merge) {
        if (models?.length) {
          done = true;
          clearGrace();
          resolve(models);
          return;
        }
        if (pending === 0) finish();
        return;
      }
      // merge：等全部候选，或首个非空结果后的宽限期（慢端点不能拖死快端点）
      if (models?.length && pending > 0 && graceTimer === undefined) {
        graceTimer = setTimeout(finish, opts.mergeGraceMs ?? 800);
        graceTimer.unref?.();
      }
      if (pending === 0) finish();
    };
    endpoints.forEach((endpoint, index) => {
      load(endpoint).then(
        (models) => settle(index, models),
        (error) => settle(index, undefined, error),
      );
    });
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
  const skippedNonText = new Set<string>();
  try {
    // 候选端点口径与 fetch_models 预填共用（modelListCandidateUrls）；
    // 先拉全每个候选的分页，再按 id 合并——先到先得会让较快的子集截胡较全的列表。
    const bundles = await firstNonEmpty(
      modelListCandidateUrls(baseUrl, opts.api),
      async (url) => {
        const bundle = await fetchAllModelPages(url, {
          headers,
          signal: controller.signal,
          filterNonText: true,
          onFiltered: (id) => skippedNonText.add(id),
        });
        return bundle.models.length > 0 ? [bundle] : [];
      },
      {
        merge: (results) => [mergeModelPageBundles(results.flat())],
        mergeGraceMs: MODEL_MERGE_GRACE_MS,
      },
    );
    const mergedBundle = bundles[0];
    const merged = mergedBundle?.models ?? [];
    if (mergedBundle?.truncated) {
      logAt(
        "event",
        `[dynamic-models] model list truncated at the ${MAX_MODEL_PAGES}-page cap`,
      );
    }
    // 另一个候选可能把同一 id 以文本模型返回；合并后已存在的不算“跳过”
    const mergedIds = new Set(merged.map((model) => model.id));
    const skipped = [...skippedNonText].filter((id) => !mergedIds.has(id));
    if (skipped.length > 0) {
      logAt(
        "event",
        `[dynamic-models] skipped ${skipped.length} non-text model(s): ${skipped
          .slice(0, 20)
          .join(", ")}${skipped.length > 20 ? ", …" : ""}`,
      );
    }
    return merged;
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
