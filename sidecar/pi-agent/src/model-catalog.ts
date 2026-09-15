/**
 * 模型目录：pi-ai 内置 catalog（39 个 provider） + 本地凭据 + models 统一模型表。
 * - models 表行（provider, model_id 主键）承载启用状态与属性覆盖；
 *   NULL 属性 = 继承内置目录值。内置厂商的过滤（勾选集）与属性修改都写这张表。
 * - 自定义端点的模型同样存 models 表（enabled=1），注册时 NULL 属性取自定义默认值。
 * - 内置厂商的目录外新增模型（手动添加的 modelId）也存 models 表：行存在但目录没有
 *   时按行构造 Model 挂到该 provider 上（auth/stream 沿用原实现）。
 * 目录在 initStorage 之后通过 getModels() 惰性创建。
 */
import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type ModelCost,
  type Provider,
  type SimpleStreamOptions,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import { logErr } from "./log";
import { credentialStore } from "./storage";
import { customProvidersList, kvGet, modelsAll, modelsList } from "./hostdb";
import type { CustomApiKind } from "./types";

/** 模型目录类型（含 provider 注册/删除、模型查询、凭据查询） */
export type ModelCatalog = ReturnType<typeof builtinModels>;

let catalog: ModelCatalog | undefined;

/** 取模型目录单例（首次调用时基于已初始化的凭据存储构建） */
export function getModels(): ModelCatalog {
  if (!catalog) catalog = builtinModels({ credentials: credentialStore });
  return catalog;
}

/** 当前选中的模型（启动时 initCurrentModelKey 从 kv 恢复；运行中由 set_model 维护） */
let currentModelKey: { provider: string; modelId: string } | null = null;

export function getCurrentModelKey(): {
  provider: string;
  modelId: string;
} | null {
  return currentModelKey;
}

export function setCurrentModelKey(key: {
  provider: string;
  modelId: string;
} | null): void {
  currentModelKey = key;
}

/**
 * 启动恢复：从 kv 读「最近一次使用的模型」写入内存键（在目录就绪闸门内调用）。
 * 只写内存键不校验目录/凭据——校验延迟到真正取模型时（resolveCurrentModel 回落），
 * 避免启动早期自定义提供商尚未加载时把有效选择误判为失效。
 * 之前恢复由前端经 set_model 完成，但前端命令可能早于 sidecar 就绪发出而丢失，
 * sidecar 侧自行恢复后该竞态消失（远程网页模式也由此获得恢复）。
 */
export async function initCurrentModelKey(): Promise<void> {
  try {
    const raw = await kvGet("pi.model");
    if (!raw?.value) return;
    const saved = JSON.parse(raw.value) as { provider?: string; modelId?: string };
    if (saved?.provider && saved?.modelId) {
      currentModelKey = { provider: saved.provider, modelId: saved.modelId };
    }
  } catch (err) {
    logErr("model key restore failed:", err);
  }
}

/**
 * 深度思考阶梯（pi-agent-core 的 7 档，xhigh/max 仅部分模型支持，
 * 由 provider adapter 按 model.thinkingLevelMap 落值）。全局一档、
 * 与选模型同款语义：set_thinking 广播到活动 Agent，新会话建 Agent 时取用。
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** 当前思考档位（重启后由前端通过 set_thinking 恢复；深度思考开关置 medium/off） */
let currentThinkingLevel: ThinkingLevel = "off";

export function getCurrentThinkingLevel(): ThinkingLevel {
  return currentThinkingLevel;
}

export function setCurrentThinkingLevel(level: ThinkingLevel): void {
  currentThinkingLevel = level;
}

/** 未选模型时的默认策略：catalog 里第一个有凭据的模型 */
export async function defaultModel(): Promise<Model<Api> | undefined> {
  try {
    const available = await getModels().getAvailable();
    logErr(
      "defaultModel: available =",
      available.length,
      available[0]?.provider,
      available[0]?.id,
    );
    return available[0];
  } catch (err) {
    logErr("defaultModel: getAvailable failed:", err);
    return undefined;
  }
}

/** 自定义提供商支持的接口格式 → pi-ai Api 实现工厂 */
const API_FACTORIES: Record<CustomApiKind, typeof openAICompletionsApi> = {
  "openai-chat": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
};

/** UI 值 → pi-ai Api 标识 */
const API_ID: Record<CustomApiKind, Api> = {
  "openai-chat": "openai-completions",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic-messages",
};

/** 任意输入归一化为 CustomApiKind（缺省 openai-chat） */
export const normalizeApi = (v: unknown): CustomApiKind =>
  v === "openai-responses" || v === "anthropic-messages" ? v : "openai-chat";

/** 校验 models 表行的 input 列（["text"|"image"...]）；非法/为空返回 null */
export function parseModelInput(v: unknown): ("text" | "image")[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter(
    (s): s is "text" | "image" => s === "text" || s === "image",
  );
  return out.length ? out : null;
}

/** 校验 models 表行的 cost 列（input/output/cacheRead/cacheWrite 全为有限数字）；非法返回 null */
export function parseModelCost(v: unknown): ModelCost | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  const num = (x: unknown): number | undefined =>
    typeof x === "number" && Number.isFinite(x) ? x : undefined;
  const input = num(c.input);
  const output = num(c.output);
  const cacheRead = num(c.cacheRead);
  const cacheWrite = num(c.cacheWrite);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite };
}

/** 自定义端点模型的缺省属性（无内置目录可继承） */
export const CUSTOM_MODEL_DEFAULTS = {
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as ModelCost,
  contextWindow: 128_000,
  maxTokens: 8_192,
};

/** 把一行 custom_providers 记录构造成 provider 并注册进模型目录（模型读 models 表） */
export async function registerCustomProvider(row: {
  id: string;
  name: string;
  baseUrl: string;
  api?: string;
}) {
  const rows = await modelsList(row.id);
  // baseUrl 语义与 OpenAI SDK 一致：完整前缀，API 实现在其后拼各自端点
  // （openai-chat → /chat/completions，openai-responses → /responses，anthropic-messages → /v1/messages）
  const baseUrl = row.baseUrl.trim().replace(/\/+$/, "");
  const apiKind = normalizeApi(row.api);
  const modelList: Model<Api>[] = rows
    .filter((m) => m.enabled && m.modelId.trim())
    .map((m) => ({
      id: m.modelId.trim(),
      name: m.name?.trim() || m.modelId.trim(),
      api: API_ID[apiKind],
      provider: row.id,
      baseUrl,
      reasoning: m.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning,
      input: parseModelInput(m.input) ?? CUSTOM_MODEL_DEFAULTS.input,
      cost: parseModelCost(m.cost) ?? { ...CUSTOM_MODEL_DEFAULTS.cost },
      contextWindow: m.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow,
      maxTokens: m.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens,
    }));
  const provider = createProvider({
    id: row.id,
    name: row.name,
    baseUrl,
    auth: { apiKey: envApiKeyAuth(`${row.name} API key`, []) },
    models: modelList,
    api: API_FACTORIES[apiKind](),
  });
  getModels().setProvider(provider);
  // 重建出的新模型对象不带覆盖，补挂前端下发的 thinkingLevelMap
  applyThinkingMapOverrides();
}

/** 启动时把已保存的自定义提供商全部注册（停用的跳过）；入口在存储初始化后调用 */
export async function loadCustomProviders(): Promise<void> {
  const rows = await customProvidersList();
  for (const row of rows) {
    if (!row.enabled) continue;
    try {
      await registerCustomProvider(row);
    } catch (err) {
      logErr("registerCustomProvider failed for", row.id, err);
    }
  }
}

/** 启动/保存过滤后调用：把 models 表的属性覆盖合并进内置目录（原地改 Model 对象）。
 *  自定义 provider 的模型在注册时已按行构建，这里 getModel 找不到即跳过。 */
export async function applyModelOverrides(): Promise<void> {
  for (const row of await modelsAll()) applyRowToCatalogModel(row);
}

/* ------------------------------ 目录外新增模型（内置 provider） ------------------------------ */

/** 内置 provider 的目录外新增模型：models 表行存在但内置目录没有的 modelId。
 *  providerId → 追加的 Model 列表；provider 重新包装后经 setProvider 换入。 */
const extraModelsByProvider = new Map<string, Model<Api>[]>();

/** 把目录外新增模型挂到内置 provider 上（已存在时返回 undefined）。
 *  api/baseUrl 取同 provider 现有模型（内置厂商的模型共享接口实现与端点），
 *  null 属性取自定义默认值；provider 未知或没有任何现有模型时不挂载。 */
export function attachExtraCatalogModel(
  providerId: string,
  modelId: string,
  attrs: {
    name: string | null;
    reasoning: boolean | null;
    contextWindow: number | null;
    maxTokens: number | null;
    input: unknown[] | null;
    cost: Record<string, unknown> | null;
  },
): Model<Api> | undefined {
  const models = getModels();
  if (models.getModel(providerId, modelId)) return undefined;
  const orig = models.getProvider(providerId);
  if (!orig) return undefined;
  const sibling = orig.getModels()[0];
  if (!sibling) return undefined;
  const model: Model<Api> = {
    id: modelId,
    name: attrs.name?.trim() || modelId,
    api: sibling.api,
    provider: orig.id,
    baseUrl: sibling.baseUrl,
    reasoning: attrs.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning,
    input: parseModelInput(attrs.input) ?? [...CUSTOM_MODEL_DEFAULTS.input],
    cost: parseModelCost(attrs.cost) ?? { ...CUSTOM_MODEL_DEFAULTS.cost },
    contextWindow: attrs.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow,
    maxTokens: attrs.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens,
  };
  const extras = extraModelsByProvider.get(providerId) ?? [];
  extras.push(model);
  extraModelsByProvider.set(providerId, extras);
  // 重新包装 provider：auth/stream 等沿用原实现（闭包不依赖 this），仅扩展 getModels；
  // refreshModels 发布的动态列表仍经 orig.getModels() 生效，包装层在其上追加 extras
  const extended = Object.create(orig) as Provider<Api>;
  extended.getModels = () => [...orig.getModels(), ...extras];
  models.setProvider(extended);
  return model;
}

/* ------------------------------ 覆盖应用（快照支持重置） ------------------------------ */

/** 目录模型可覆盖属性的原始快照（首次修改前留底，null 覆盖/重置时恢复） */
type ModelAttrSnapshot = Pick<
  Model<Api>,
  "name" | "reasoning" | "contextWindow" | "maxTokens" | "input" | "cost"
>;
const attrSnapshots = new Map<string, ModelAttrSnapshot>();

function snapshotModelAttrs(key: string, model: Model<Api>): void {
  if (attrSnapshots.has(key)) return;
  attrSnapshots.set(key, {
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: [...model.input],
    cost: { ...model.cost },
  });
}

/** 把 models 表一行覆盖应用到目录模型对象；null 字段恢复原始值（继承内置/注册默认）。
 *  内置 provider 上目录没有的 modelId 视为用户新增模型：先挂载再按行赋值。 */
export function applyRowToCatalogModel(row: {
  provider: string;
  modelId: string;
  name: string | null;
  reasoning: boolean | null;
  contextWindow: number | null;
  maxTokens: number | null;
  input: unknown[] | null;
  cost: Record<string, unknown> | null;
}): void {
  const key = `${row.provider}/${row.modelId}`;
  let model = getModels().getModel(row.provider, row.modelId);
  if (!model) {
    model = attachExtraCatalogModel(row.provider, row.modelId, row);
    if (!model) return;
  }
  snapshotModelAttrs(key, model);
  const snap = attrSnapshots.get(key)!;
  model.name = row.name?.trim() || snap.name;
  model.reasoning = row.reasoning ?? snap.reasoning;
  model.contextWindow = row.contextWindow ?? snap.contextWindow;
  model.maxTokens = row.maxTokens ?? snap.maxTokens;
  model.input = parseModelInput(row.input) ?? snap.input;
  model.cost = parseModelCost(row.cost) ?? snap.cost;
  applyThinkingMapToModel(key, model);
}

/* ------------------- thinkingLevelMap 前端覆盖（set_thinking_maps 下发） ------------------- */

/**
 * 模型级思考参数映射覆盖。事实源在前端 Tauri kv（pi.model_thinking），这里只是
 * 内存副本，启动恢复与编辑保存时经 set_thinking_maps 整包推下来。pi-ai 语义：
 * 档位键字符串值 = 该档可用且按映射值下发（透传档位名即可，如 medium→"medium"）；
 * null = 显式禁用（composer 档位下拉不再出现该档）；off 字符串 = 关闭思考时显式
 * 下发的参数值——"默认开思考"的网关必须靠它才关得掉（常见值 "none"）。
 */
const thinkingMapOverrides = new Map<string, ThinkingLevelMap>();
/** 应用覆盖前模型自身 map 的快照（undefined = 原本没有），防重复推送在覆盖上再叠加 */
const thinkingMapBaselines = new Map<string, ThinkingLevelMap | undefined>();

const THINKING_MAP_KEYS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** 宽松 JSON → 清洗后的 thinkingLevelMap（未知键与非字符串非 null 值丢弃）；空返回 undefined */
export function normalizeThinkingMap(raw: unknown): ThinkingLevelMap | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: ThinkingLevelMap = {};
  for (const key of THINKING_MAP_KEYS) {
    const v = src[key];
    if (typeof v === "string" && v.trim()) out[key] = v;
    else if (v === null) out[key] = null;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 整包替换覆盖表并应用到全目录；返回生效的模型条数 */
export function setThinkingMapOverrides(rawMaps: unknown): number {
  thinkingMapOverrides.clear();
  const src =
    rawMaps && typeof rawMaps === "object" && !Array.isArray(rawMaps)
      ? (rawMaps as Record<string, unknown>)
      : {};
  for (const [key, raw] of Object.entries(src)) {
    const map = normalizeThinkingMap(raw);
    if (map) thinkingMapOverrides.set(key, map);
  }
  applyThinkingMapOverrides();
  return thinkingMapOverrides.size;
}

function applyThinkingMapToModel(key: string, model: Model<Api>): void {
  if (!thinkingMapBaselines.has(key)) {
    thinkingMapBaselines.set(key, model.thinkingLevelMap);
  }
  const override = thinkingMapOverrides.get(key);
  model.thinkingLevelMap = override
    ? { ...(thinkingMapBaselines.get(key) ?? {}), ...override }
    : thinkingMapBaselines.get(key);
}

/** 把内存覆盖逐一把当前目录全部模型盖回 map（自定义 provider 重建完成后也要调用） */
export function applyThinkingMapOverrides(): void {
  for (const p of getModels().getProviders()) {
    for (const m of p.getModels()) {
      applyThinkingMapToModel(`${p.id}/${m.id}`, m);
    }
  }
}

/* ------------------- OpenAI 兼容端点缓存路由（prompt_cache_key 补发） ------------------- */

/**
 * pi-ai 的 openai-completions 实现对 `prompt_cache_key` 有 baseUrl 守门
 * （openai-completions.js：仅 api.openai.com 或显式长缓存才下发），自定义
 * OpenAI 兼容端点（vLLM/网关等）拿不到该字段 → 负载均衡把同会话请求打到不同
 * 节点，服务端前缀缓存整段 miss。Anthropic 用 session-affinity、openai-responses
 * 无条件下发，均不受影响。
 * 经 Agent 的 onPayload 钩子补齐：payload 已带该字段（官方端点/长缓存路径）
 * 则不动；否则注入会话 id 作为 cache key，让兼容端点路由到同一缓存分片。
 */
export function makePromptCacheKeyPayloadHook(
  sessionId: string | undefined,
): NonNullable<SimpleStreamOptions["onPayload"]> {
  const cacheKey = clampOpenAIPromptCacheKey(sessionId);
  return (payload: unknown, model: Model<Api>) => {
    if (!cacheKey || model.api !== "openai-completions") return undefined;
    const params = payload as Record<string, unknown> | null;
    if (!params || params.prompt_cache_key !== undefined) return undefined;
    return { ...params, prompt_cache_key: cacheKey };
  };
}

/**
 * 会话亲和头，无条件补发（参考 opencode：每个请求固定带 x-session-affinity
 * 与 X-Session-Id 两个头做缓存分片路由）。pi-ai 的兼容端点亲和头按
 * compat.sendSessionAffinityHeaders 下发且默认关闭——自定义端点（网关/vLLM/
 * sensenova 等）没有档案就永远不带，负载均衡把同会话请求打到不同节点，
 * 服务端前缀缓存整段 miss。经 stream options.headers 合并进 provider client
 * （openai-completions/anthropic 两路都 Object.assign 该字段）：支持亲和的端点
 * 等效打开 compat 开关；不支持的只多两个无害头。
 */
export function makeSessionAffinityHeaders(
  sessionId: string | undefined,
): Record<string, string> {
  if (!sessionId) return {};
  return { "x-session-affinity": sessionId, "X-Session-Id": sessionId };
}
