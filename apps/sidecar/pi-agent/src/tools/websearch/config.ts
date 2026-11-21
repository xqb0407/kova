/**
 * 网页搜索配置（设置 → 智能体 → 网页搜索），kv key = pi.websearch。
 *
 * 只维护**一个**搜索服务：provider 选预置或自定义，单次请求超时兜底；
 * 不做多服务兜底链（服务超时/报错就返回明确错误，由用户换服务或重试）。
 * 工具侧每次调用实时读这份内存配置；总开关翻转走 reloadCapabilityTools
 * 重建活动会话工具表（关闭 = WebSearch 不进工具表，子代理/计划模式/run_code
 * 同步失去它）。
 *
 * 预置 provider 的端点/鉴权在 providers.ts；API key 不进这份 JSON
 * （存加密凭据表，命名空间 websearch:<kind>）。
 */
import { kvGet, kvSet } from "../../storage/hostdb";
import { logErr } from "../../log";

export const WEBSEARCH_KV_KEY = "pi.websearch";

export type WebSearchProviderKind =
  | "deepseek"
  | "tavily"
  | "brave"
  | "exa"
  | "searxng"
  | "custom";

export const WEBSEARCH_PROVIDER_KINDS: readonly WebSearchProviderKind[] = [
  "deepseek",
  "tavily",
  "brave",
  "exa",
  "searxng",
  "custom",
];

/** 预置 provider 的默认端点与展示名（custom 不在表内）。
 *  只预置各家官方 API 端点；不内置任何第三方代理/聚合服务——
 *  那类服务由用户在设置页选 custom 自行填写。 */
export const WEBSEARCH_PRESETS: Record<
  Exclude<WebSearchProviderKind, "custom">,
  { label: string; baseUrl: string; needsKey: boolean }
> = {
  deepseek: {
    label: "DeepSeek Search",
    baseUrl: "https://api.deepseek.com/v1/tools/search",
    needsKey: true,
  },
  tavily: { label: "Tavily", baseUrl: "https://api.tavily.com/search", needsKey: true },
  brave: {
    label: "Brave Search",
    baseUrl: "https://api.search.brave.com/res/v1/web/search",
    needsKey: true,
  },
  exa: { label: "Exa", baseUrl: "https://api.exa.ai/search", needsKey: true },
  searxng: { label: "SearXNG", baseUrl: "", needsKey: false },
};

/** 当前使用的搜索服务。id 稳定 = kind（custom 固定 "custom"）：
 *  凭据命名空间 websearch:<id>，切换服务再切回来仍能命中已保存的 key。 */
export type WebSearchProvider = {
  id: string;
  kind: WebSearchProviderKind;
  label: string;
  /** 空 = 用预置默认端点；SearXNG / custom 必填（设置页校验） */
  baseUrl: string;
  /** 仅 custom 使用；预置在 providers.ts 里按 kind 构造请求 */
  method: "GET" | "POST";
  /** header 值支持 {{apiKey}}（custom） */
  headers: Record<string, string>;
  /** JSON 文本，支持 {{query}} {{count}} {{apiKey}}（custom） */
  bodyTemplate: string;
  /** custom 响应映射：点路径（如 "web.results"），空 = 根数组 */
  resultsPath: string;
  titlePath: string;
  urlPath: string;
  snippetPath: string;
  sourcePath: string;
};

export type WebSearchConfig = {
  /** 总开关：关闭时 WebSearch 不注册（主代理/子代理/计划模式/run_code 均不可用） */
  enabled: boolean;
  /** 当前搜索服务（单一） */
  provider: WebSearchProvider;
  /** 单次请求超时（ms） */
  requestTimeoutMs: number;
  /** 结果条数上限 */
  maxResults: number;
};

export const DEFAULT_WEBSEARCH_TIMEOUT_MS = 8_000;
export const DEFAULT_WEBSEARCH_MAX_RESULTS = 8;
const MAX_HEADERS = 32;
const MAX_TEMPLATE_CHARS = 20_000;
const MAX_PATH_CHARS = 200;
const MAX_URL_CHARS = 2_048;
const MAX_LABEL_CHARS = 80;

/** 协议面：预置清单（设置页服务选择与 needsKey 提示用；后端唯一事实源） */
export const WEBSEARCH_PRESET_LIST = (
  Object.keys(WEBSEARCH_PRESETS) as Array<Exclude<WebSearchProviderKind, "custom">>
).map((kind) => ({ kind, ...WEBSEARCH_PRESETS[kind] }));

export const WEBSEARCH_DEFAULTS = {
  requestTimeoutMs: DEFAULT_WEBSEARCH_TIMEOUT_MS,
  maxResults: DEFAULT_WEBSEARCH_MAX_RESULTS,
} as const;

const clampInt = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : fallback;
  return Math.min(max, Math.max(min, n));
};

const str = (value: unknown, max = 2_000): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

export function defaultCustomProvider(): WebSearchProvider {
  return {
    id: "custom",
    kind: "custom",
    label: "Custom",
    baseUrl: "",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    bodyTemplate: '{"query":"{{query}}","count":{{count}}}',
    resultsPath: "results",
    titlePath: "title",
    urlPath: "url",
    snippetPath: "snippet",
    sourcePath: "",
  };
}

/** 预置 provider 的默认条目（设置页切换服务用） */
export function makePresetProvider(
  kind: WebSearchProviderKind,
): WebSearchProvider {
  if (kind === "custom") return defaultCustomProvider();
  const preset = WEBSEARCH_PRESETS[kind];
  return {
    id: kind,
    kind,
    label: preset.label,
    baseUrl: "",
    method: "POST",
    headers: {},
    bodyTemplate: "",
    resultsPath: "",
    titlePath: "",
    urlPath: "",
    snippetPath: "",
    sourcePath: "",
  };
}

export const DEFAULT_WEBSEARCH_CONFIG: WebSearchConfig = {
  enabled: true,
  // 默认指向官方 API 预置（需用户自配 key）；绝不内置第三方代理端点
  provider: makePresetProvider("tavily"),
  requestTimeoutMs: DEFAULT_WEBSEARCH_TIMEOUT_MS,
  maxResults: DEFAULT_WEBSEARCH_MAX_RESULTS,
};

/** 预置 provider 的默认端点（暴露给协议层做「测试目标是否仍是已保存服务」判断） */
export function webSearchEffectiveEndpoint(
  provider: WebSearchProvider,
): string {
  const override = provider.baseUrl.trim().replace(/\/+$/, "");
  if (override) return override;
  if (provider.kind === "custom") return "";
  return WEBSEARCH_PRESETS[provider.kind].baseUrl.replace(/\/+$/, "");
}

/**
 * 设置页「测试」能否使用已保存的 key。
 *
 * 安全边界：协议层的测试允许传草稿配置，若「已保存 key + 任意 URL」都放行，
 * 一个被攻破的渲染进程就能把密钥发到第三方。因此只有两种目标允许读凭据表：
 *  - 与已保存配置的同一服务、同一端点（常规：改超时/条数/未改端点）；
 *  - 该服务的官方端点（预置默认值；换服务但没改端点，key 按 kind 存放，仍安全）。
 * 自定义 API / SearXNG 自建实例没有「官方端点」，必须与已保存端点一致。
 */
export function allowsStoredWebSearchKey(
  draft: WebSearchProvider,
  saved: WebSearchProvider,
): boolean {
  const draftEndpoint = webSearchEffectiveEndpoint(draft);
  if (
    draft.kind === saved.kind &&
    draftEndpoint === webSearchEffectiveEndpoint(saved)
  ) {
    return true;
  }
  if (draft.kind === "custom") return false;
  const official = WEBSEARCH_PRESETS[draft.kind].baseUrl.replace(/\/+$/, "");
  return !!official && draftEndpoint === official;
}

function isKind(value: string): value is WebSearchProviderKind {
  return (WEBSEARCH_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** header 表：只收字符串值；键/值去空白并截断，空键丢弃 */
function normalizeHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_HEADERS) break;
    if (typeof value !== "string") continue;
    const name = key.trim().slice(0, 256);
    if (!name) continue;
    out[name] = value.trim().slice(0, 2_048);
    count += 1;
  }
  return out;
}

/** 任意来源（kv JSON / 协议消息）的宽松规整；缺/非法 provider 回落默认预置服务 */
export function normalizeWebSearchConfig(raw: unknown): WebSearchConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const p = (
    r.provider && typeof r.provider === "object" ? r.provider : {}
  ) as Record<string, unknown>;
  const kindRaw = str(p.kind, 32);
  const kind = isKind(kindRaw) ? kindRaw : "tavily";
  const preset = kind === "custom" ? null : WEBSEARCH_PRESETS[kind];
  const custom = kind === "custom";
  const bodyTemplate = custom
    ? str(p.bodyTemplate, MAX_TEMPLATE_CHARS) ||
      defaultCustomProvider().bodyTemplate
    : "";
  const provider: WebSearchProvider = {
    id: custom ? "custom" : kind,
    kind,
    label:
      str(p.label, MAX_LABEL_CHARS) ||
      preset?.label ||
      (custom ? "Custom" : kind),
    baseUrl: str(p.baseUrl, MAX_URL_CHARS),
    method: str(p.method, 8).toUpperCase() === "GET" ? "GET" : "POST",
    headers: custom ? normalizeHeaders(p.headers) : {},
    bodyTemplate,
    resultsPath: custom ? str(p.resultsPath, MAX_PATH_CHARS) || "results" : "",
    titlePath: custom ? str(p.titlePath, MAX_PATH_CHARS) || "title" : "",
    urlPath: custom ? str(p.urlPath, MAX_PATH_CHARS) || "url" : "",
    snippetPath: custom ? str(p.snippetPath, MAX_PATH_CHARS) || "snippet" : "",
    sourcePath: custom ? str(p.sourcePath, MAX_PATH_CHARS) : "",
  };
  return {
    enabled: bool(r.enabled, DEFAULT_WEBSEARCH_CONFIG.enabled),
    provider,
    requestTimeoutMs: clampInt(
      r.requestTimeoutMs,
      DEFAULT_WEBSEARCH_TIMEOUT_MS,
      1_000,
      30_000,
    ),
    maxResults: clampInt(r.maxResults, DEFAULT_WEBSEARCH_MAX_RESULTS, 1, 20),
  };
}

function cloneConfig(config: WebSearchConfig): WebSearchConfig {
  return {
    ...config,
    provider: { ...config.provider, headers: { ...config.provider.headers } },
  };
}

let current: WebSearchConfig = cloneConfig(DEFAULT_WEBSEARCH_CONFIG);

export function getWebSearchConfig(): WebSearchConfig {
  return current;
}

/** 启动恢复：kv 里的整包 JSON 载入内存；失败保持默认（不阻断启动） */
export async function initWebSearchConfig(): Promise<void> {
  try {
    const row = await kvGet(WEBSEARCH_KV_KEY);
    if (row?.value) current = normalizeWebSearchConfig(JSON.parse(row.value));
  } catch (err) {
    logErr("websearch-config: load failed:", err);
  }
}

/** 测试辅助：仅清内存不落 kv；可传覆盖片段 */
export function resetWebSearchConfigForTest(
  next?: Partial<WebSearchConfig>,
): void {
  current = normalizeWebSearchConfig({
    ...DEFAULT_WEBSEARCH_CONFIG,
    ...(next ?? {}),
  });
}

/** 测试辅助：在现有配置上覆盖（不落 kv） */
export function setWebSearchConfigForTest(
  next: Partial<WebSearchConfig>,
): void {
  current = normalizeWebSearchConfig({ ...current, ...next });
}

/** 应用新设置：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落） */
export async function applyWebSearchConfig(
  raw: unknown,
): Promise<WebSearchConfig> {
  const next = normalizeWebSearchConfig(raw);
  current = next;
  try {
    await kvSet(WEBSEARCH_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("websearch-config: persist failed:", err);
  }
  return next;
}
