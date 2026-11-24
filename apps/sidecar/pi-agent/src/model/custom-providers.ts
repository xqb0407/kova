/**
 * 自定义端点 provider 与目录覆盖：把 custom_providers/custom_models 行注册进
 * 目录、models 表属性覆盖应用（快照支持重置）、内置 provider 的目录外新增模型。
 * 目录单例与种子反查见 catalog.ts，thinkingLevelMap 覆盖见 thinking.ts。
 */
import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type ApiKeyAuth,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { logErr } from "../log";
import {
  customProvidersList,
  credentialGet,
  modelsAll,
  modelsList,
} from "../storage/hostdb";
import type { CustomApiKind } from "../types";
import {
  discoveryFingerprint,
  discoveryNeedsFetch,
  fetchDiscoveredModels,
  loadAutoModels,
  loadDiscoveryCache,
  saveDiscoveryCache,
  type DiscoveredModel,
} from "./dynamic-discovery";
import {
  addCustomProviderId,
  clearDefaultedAttrsFor,
  CUSTOM_MODEL_DEFAULTS,
  getModels,
  isCustomProvider,
  lookupCatalogModelSeed,
  noteTrackedDefault,
  parseModelCost,
  parseModelInput,
  type DefaultedAttr,
} from "./catalog";
import {
  applyThinkingMapOverrides,
  applyThinkingMapToModel,
  setThinkingMapBaseline,
} from "./thinking";

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

/* ------------------------------ 自定义请求头 ------------------------------ */

/** 头名合法性（RFC 7230 token）：空格、冒号、换行等一律拒绝 */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** 头值禁止控制字符：\r\n\0 等是头注入的载体，一律不放过 */
const HEADER_VALUE_FORBIDDEN = /[\u0000-\u0008\u000a-\u001f\u007f]/;
/**
 * 头值只允许 Latin-1（HTTP obs-text 的上限）。实测 Bun/undici 的 fetch 会对更高
 * 码位（中文等）抛 native TypeError（`Header 'x' has invalid value`），报错只剩
 * 代码帧、用户看不懂——所以在保存时就说清楚，而不是等"测试连接/对话"才炸。
 */
const HEADER_VALUE_NON_LATIN1 = /[^\u0000-\u00ff]/;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_VALUE_CHARS = 2048;
const MAX_HEADERS_JSON_CHARS = 8192;

/** 单条头校验：合法返回 null，否则返回给用户看的错误文案 */
function headerEntryError(name: string, value: string): string | null {
  if (!HEADER_NAME_RE.test(name)) return `invalid header name: ${name}`;
  if (HEADER_VALUE_FORBIDDEN.test(value)) {
    return `header "${name}" contains control characters`;
  }
  if (HEADER_VALUE_NON_LATIN1.test(value)) {
    return `header "${name}" value must be ASCII/Latin-1 (non-Latin-1 characters like "中" are rejected by the HTTP client)`;
  }
  if (value.length > MAX_HEADER_VALUE_CHARS) return `header "${name}" is too long`;
  return null;
}

/** 协议输入 → 存储用 headers 对象。严格校验：非法直接抛错，让用户在表单上改。 */
export function validateHeaderInput(raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("headers must be an object");
  }
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name) continue; // 表单空行：忽略
    const value = String(rawValue ?? "").trim();
    const err = headerEntryError(name, value);
    if (err) throw new Error(err);
    out[name] = value;
  }
  if (Object.keys(out).length > MAX_HEADER_COUNT) {
    throw new Error(`too many headers (max ${MAX_HEADER_COUNT})`);
  }
  if (JSON.stringify(out).length > MAX_HEADERS_JSON_CHARS) {
    throw new Error("headers payload is too large");
  }
  return out;
}

/** 存储 JSON → headers 对象。宽容：坏 JSON / 非法条目丢弃并记日志，不阻断注册。 */
export function parseStoredHeaders(
  json: string | undefined | null,
  label = "",
): Record<string, string> {
  if (!json || !json.trim() || json.trim() === "{}") return {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [rawName, rawValue] of Object.entries(parsed)) {
      const name = rawName.trim();
      const value = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
      if (!name || headerEntryError(name, value)) {
        logErr("custom-provider headers: dropping invalid entry", label, name);
        continue;
      }
      out[name] = value;
    }
    return out;
  } catch (err) {
    logErr("custom-provider headers: bad JSON, ignoring", label, err);
    return {};
  }
}

/** 把自定义头合并进请求头表：按 HTTP 语义大小写不敏感覆盖（用户填的优先） */
export function applyCustomHeaders(
  target: Record<string, string>,
  extra: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(extra)) {
    for (const key of Object.keys(target)) {
      if (key.toLowerCase() === name.toLowerCase()) delete target[key];
    }
    target[name] = value;
  }
}

/** 无密钥自定义端点的占位 key。pi-ai 的 API 实现要求请求必须带非空 apiKey
 *  或认证头，否则发请求前就抛 "No API key for provider"；而本地/内网端点
 *  （LM Studio、llama.cpp 等）通常不校验密钥。没有存凭据时给一个占位值，
 *  让模型照常可选、可发请求；存了真密钥仍走凭据。 */
const KEYLESS_API_KEY = "unused";

/** 自定义端点的 api-key 认证：有凭据用凭据，没有就不发真密钥（占位）。 */
const customProviderAuth = (name: string): ApiKeyAuth => {
  const base = envApiKeyAuth(`${name} API key`, []);
  return {
    ...base,
    resolve: async (input) => {
      const resolved = await base.resolve(input);
      if (resolved) return resolved;
      input.signal.throwIfAborted();
      return { auth: { apiKey: KEYLESS_API_KEY }, source: "keyless endpoint" };
    },
  };
};

/** 把一行 custom_providers 记录构造成 provider 并注册进模型目录（模型读 models 表）。
 *  autoDiscover 开启时额外合并发现缓存里用户没手写的 AUTO 模型——注册路径只读
 *  缓存不联网，网络发现在保存/启停后的后台刷新、显式刷新与启动扫描三处进行。 */
export async function registerCustomProvider(row: {
  id: string;
  name: string;
  baseUrl: string;
  api?: string;
  /** 自动发现：开启时合并发现缓存中的 AUTO 模型（永不覆盖手写行） */
  autoDiscover?: boolean;
  /** 自定义请求头（JSON 对象字符串）：随该 provider 的每条请求发送 */
  headers?: string;
}) {
  const rows = await modelsList(row.id);
  // baseUrl 语义与 OpenAI SDK 一致：完整前缀，API 实现在其后拼各自端点
  // （openai-chat → /chat/completions，openai-responses → /responses，anthropic-messages → /v1/messages）
  const baseUrl = row.baseUrl.trim().replace(/\/+$/, "");
  const apiKind = normalizeApi(row.api);
  const customHeaders = parseStoredHeaders(row.headers, row.id);
  const enabledRows = rows.filter((m) => m.enabled && m.modelId.trim());
  // 用户手输的 ID 常与官方模型同名：命中内置目录即继承其属性（行内显式值优先），
  // 未命中才落到 CUSTOM_MODEL_DEFAULTS 猜测值
  const seededRows = enabledRows.map((m) => ({
    m,
    seed: lookupCatalogModelSeed(m.modelId),
  }));
  const modelList: Model<Api>[] = seededRows.map(({ m, seed }) => {
    const explicitInput = parseModelInput(m.input);
    const resolvedInput = explicitInput ?? seed?.input;
    return {
      id: m.modelId.trim(),
      name: m.name?.trim() || m.modelId.trim(),
      api: API_ID[apiKind],
      provider: row.id,
      baseUrl,
      reasoning:
        m.reasoning ?? seed?.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning,
      input: resolvedInput ?? CUSTOM_MODEL_DEFAULTS.input,
      // 三态：行内声明/目录命中才算已知；都没有时保持未知，请求侧不预剥图
      supportsImage: resolvedInput ? resolvedInput.includes("image") : null,
      cost:
        parseModelCost(m.cost) ??
        seed?.cost ??
        { ...CUSTOM_MODEL_DEFAULTS.cost },
      contextWindow:
        m.contextWindow ?? seed?.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow,
      maxTokens:
        m.maxTokens ?? seed?.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens,
      promptCache: parseRowPromptCache(m.promptCache),
      ...(seed?.thinkingLevelMap
        ? { thinkingLevelMap: seed.thinkingLevelMap }
        : {}),
      // 未知自定义端点保守禁用 OpenAI 新版 "developer" 系统角色：很多国产兼容
      // 网关不认（实测 sensenova 对 developer 角色一律 400 invalid request），
      // 一律走传统 "system" 角色；reasoning_effort 等思考参数不受影响
      // 同理禁用长缓存保留：`prompt_cache_retention: "24h"` 只有 OpenAI 官方与
      // 少数端点认，未知网关轻则忽略、重则 400——要开就在模型 compat 里显式声明
      compat: {
        supportsDeveloperRole: false,
        supportsLongCacheRetention: false,
      },
    };
  });
  // 动态发现的 AUTO 模型（autoDiscover 开启时）：发现缓存里用户没手写的 id 逐个
  // 注册。属性优先级：网关自报 → 内置目录同名种子 → 缺省猜测值；AUTO 永不覆盖
  // 手写行（loadAutoModels 已按手写 id 集过滤）。cost 网关不报价，走种子/零价。
  // 排除集用全部行（含停用）：显式停用的模型不能被发现结果复活
  if (row.autoDiscover === true) {
    const autos = await loadAutoModels(
      row.id,
      {
        baseUrl,
        api: apiKind,
        apiKey: (await credentialGet(row.id))?.apiKey,
        headers: customHeaders,
      },
      rows.map((m) => m.modelId.trim()),
    ).catch((err) => {
      logErr("dynamic-discovery: load auto models failed for", row.id, err);
      return [] as DiscoveredModel[];
    });
    for (const auto of autos) {
      const seed = lookupCatalogModelSeed(auto.id);
      const resolvedInput = auto.input ?? seed?.input;
      modelList.push({
        id: auto.id,
        name: auto.name ?? auto.id,
        api: API_ID[apiKind],
        provider: row.id,
        baseUrl,
        reasoning: auto.reasoning ?? seed?.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning,
        input: resolvedInput ?? [...CUSTOM_MODEL_DEFAULTS.input],
        supportsImage: resolvedInput?.length ? resolvedInput.includes("image") : null,
        cost: { ...(seed?.cost ?? CUSTOM_MODEL_DEFAULTS.cost) },
        contextWindow:
          auto.contextWindow ?? seed?.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow,
        maxTokens: auto.maxTokens ?? seed?.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens,
        ...(auto.thinkingLevelMap
          ? { thinkingLevelMap: auto.thinkingLevelMap }
          : seed?.thinkingLevelMap
            ? { thinkingLevelMap: seed.thinkingLevelMap }
            : {}),
        compat: {
          supportsDeveloperRole: false,
          supportsLongCacheRetention: false,
        },
      });
    }
  }
  // 重建出的模型对象以种子 map 为基线（同名模型种子变化随重建生效），
  // 前端覆盖由随后的 applyThinkingMapOverrides 叠加到基线上
  for (const m of modelList) {
    setThinkingMapBaseline(`${row.id}/${m.id}`, m.thinkingLevelMap);
  }
  const provider = createProvider({
    id: row.id,
    name: row.name,
    baseUrl,
    // pi-ai 会把 provider.headers 合并进该 provider 的每条请求（可覆盖默认头）
    ...(customHeaders && Object.keys(customHeaders).length
      ? { headers: customHeaders }
      : {}),
    auth: { apiKey: customProviderAuth(row.name) },
    models: modelList,
    api: API_FACTORIES[apiKind](),
  });
  getModels().setProvider(provider);
  // 注册按行重建，缺省归因以行为准整表重算（行 null = 该属性仍是猜测值）
  addCustomProviderId(row.id);
  clearDefaultedAttrsFor(row.id);
  for (const { m, seed } of seededRows) {
    const key = `${row.id}/${m.modelId.trim()}`;
    // 行空但目录种子命中 = 生效值是目录真值，不算"缺省未确认"
    noteTrackedDefault(key, "contextWindow", m.contextWindow == null && seed?.contextWindow == null);
    noteTrackedDefault(key, "maxTokens", m.maxTokens == null && seed?.maxTokens == null);
    noteTrackedDefault(key, "input", m.input == null && seed?.input == null);
  }
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

/* ------------------------------ 动态发现：刷新编排 ------------------------------ */

/** 一次刷新的增删计数（相对上次发现缓存；首次发现 removed=0） */
export type DiscoveryRefreshResult = {
  added: number;
  removed: number;
  /** 本次缓存里的模型总数（手写行不含——那是 models 表的事） */
  total: number;
};

/**
 * 刷新一个 provider 的动态发现并按新缓存重注册（显式刷新与后台扫描共用）。
 * 联网条件见 discoveryNeedsFetch：force 绕过新鲜期与失败冷却；「过期但冷却中」
 * 不重试也不重注册（离线/网关故障时保存、启动不会反复等 15s 超时），返回
 * undefined 表示无事发生。发现失败推进失败时间戳（进入冷却）并把错误抛给
 * 调用方决定提示方式。
 *
 * 注意：重注册会重建全部模型对象。运行中会话若正挂着该 provider 的模型，
 * 由调用方负责把 run.agent.state.model 刷新为新目录对象（与 add_custom_provider
 * 保存路径同款处理；启动扫描时无运行会话可跳过）。
 */
export async function refreshProviderDiscovery(
  row: {
    id: string;
    name: string;
    baseUrl: string;
    api?: string;
    headers?: string;
  },
  opts: { force?: boolean } = {},
): Promise<DiscoveryRefreshResult | undefined> {
  const apiKind = normalizeApi(row.api);
  const headers = parseStoredHeaders(row.headers, row.id);
  const apiKey = (await credentialGet(row.id))?.apiKey;
  const fingerprint = discoveryFingerprint({
    baseUrl: row.baseUrl,
    api: apiKind,
    apiKey,
    headers,
  });
  const previous = await loadDiscoveryCache(row.id, fingerprint);
  if (!discoveryNeedsFetch(previous, opts)) return undefined;
  let cache = previous;
  try {
    const models = await fetchDiscoveredModels({
      baseUrl: row.baseUrl,
      api: apiKind,
      apiKey,
      headers,
    });
    cache = { version: 2, fingerprint, models, fetchedAt: Date.now() };
    await saveDiscoveryCache(row.id, cache);
  } catch (err) {
    // 冷却时间戳随旧缓存落盘（无旧缓存则无处可写，下一次发现仍会立即重试——
    // 没有旧模型可保，冷却没有意义）
    if (previous) {
      await saveDiscoveryCache(row.id, { ...previous, lastFailedUnix: Date.now() });
    }
    throw err;
  }
  const prevIds = new Set((previous?.models ?? []).map((m) => m.id));
  const nextIds = new Set(cache.models.map((m) => m.id));
  const added = cache.models.filter((m) => !prevIds.has(m.id)).length;
  const removed = (previous?.models ?? []).filter((m) => !nextIds.has(m.id)).length;
  await registerCustomProvider({ ...row, api: apiKind, autoDiscover: true });
  return { added, removed, total: cache.models.length };
}

/**
 * 启动后台扫描：启用自动发现的 provider 逐个按需刷新（串行，避免多端点同时
 * 探测）。缓存真的发生变化（有增有删）才回调 onUpdated——调用方负责广播
 * dynamic_models_updated 帧；纯新鲜命中既不联网也不打扰。
 */
export async function sweepStaleDiscoveries(
  onUpdated?: (providerId: string, result: DiscoveryRefreshResult) => void,
): Promise<void> {
  const rows = (await customProvidersList()).filter(
    (r) => r.enabled && r.autoDiscover,
  );
  for (const row of rows) {
    try {
      const result = await refreshProviderDiscovery(row);
      if (result && (result.added > 0 || result.removed > 0)) {
        onUpdated?.(row.id, result);
      }
    } catch (err) {
      logErr("dynamic-discovery: background refresh failed for", row.id, err);
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

/** 清空内置 provider 上挂的目录外模型（models 行被整体删除/过滤清空时调用）。
 *  extras 数组被所有包装层的 getModels 闭包共享，原地清空即可让它们一起消失；
 *  删掉 map 条目后下一次 attach 会建新数组，旧包装层引用空数组无害。 */
export function clearExtraCatalogModels(providerId: string): void {
  const extras = extraModelsByProvider.get(providerId);
  if (!extras) return;
  extras.length = 0;
  extraModelsByProvider.delete(providerId);
}

/** 把目录外新增模型挂到内置 provider 上（已存在时返回 undefined）。
 *  api/baseUrl 取同 provider 现有模型；多 API 的内置服务（如 OpenCode Go 同时有
 *  anthropic/openai/google 三套端点）优先沿用 OpenAI-compatible 兄弟模型——手填
 *  模型绝大多数是 OpenAI 兼容的，直接拿 `getModels()[0]` 会落到 Anthropic 端点。
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
    promptCache?: { short?: number; long?: number } | null;
  },
): Model<Api> | undefined {
  const models = getModels();
  if (models.getModel(providerId, modelId)) return undefined;
  const orig = models.getProvider(providerId);
  if (!orig) return undefined;
  const siblings = orig.getModels();
  if (siblings.length === 0) return undefined;
  // 目录里没有该 ID，但别的内置 provider 可能有同名模型（如把 gpt-5.1 挂到别的厂商下）：
  // 命中即继承其属性，未命中按自定义默认值
  const seed = lookupCatalogModelSeed(modelId);
  // 先认同 provider 里归一化命中（带命名空间前缀）的模型，沿用它的接口/端点；
  // 再优先 OpenAI-compatible；最后才回落到目录首项
  const sibling =
    (seed?.matchedId
      ? siblings.find((m) => m.id === seed.matchedId)
      : undefined) ??
    siblings.find((m) => m.api === "openai-completions") ??
    siblings[0];
  const explicitInput = parseModelInput(attrs.input);
  const resolvedInput = explicitInput ?? seed?.input;
  const model: Model<Api> = {
    id: modelId,
    name: attrs.name?.trim() || modelId,
    api: sibling.api,
    provider: orig.id,
    baseUrl: sibling.baseUrl,
    reasoning:
      attrs.reasoning ?? seed?.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning,
    input: resolvedInput ?? [...CUSTOM_MODEL_DEFAULTS.input],
    supportsImage: resolvedInput ? resolvedInput.includes("image") : null,
    cost:
      parseModelCost(attrs.cost) ??
      seed?.cost ??
      { ...CUSTOM_MODEL_DEFAULTS.cost },
    contextWindow:
      attrs.contextWindow ?? seed?.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow,
    maxTokens:
      attrs.maxTokens ?? seed?.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens,
    promptCache: parseRowPromptCache(attrs.promptCache) ?? sibling.promptCache,
    ...(seed?.thinkingLevelMap
      ? { thinkingLevelMap: seed.thinkingLevelMap }
      : {}),
  };
  const extras = extraModelsByProvider.get(providerId) ?? [];
  extras.push(model);
  extraModelsByProvider.set(providerId, extras);
  // 重新包装 provider：auth/stream 等沿用原实现（闭包不依赖 this），仅扩展 getModels；
  // refreshModels 发布的动态列表仍经 orig.getModels() 生效，包装层在其上追加 extras
  const extended = Object.create(orig) as Provider<Api>;
  // 同 provider 第二次目录外新增时 orig 已是上一轮包装层：其 getModels() 已含
  // extras，按引用去重再追加，避免模型在清单里出现两次
  extended.getModels = () => {
    const inner = orig.getModels();
    return [...inner, ...extras.filter((x) => !inner.includes(x))];
  };
  models.setProvider(extended);
  // 目录外新增且种子未命中的跟踪属性按注册默认值 = 猜测，标未确认
  const extraKey = `${providerId}/${modelId}`;
  noteTrackedDefault(extraKey, "contextWindow", attrs.contextWindow == null && seed?.contextWindow == null);
  noteTrackedDefault(extraKey, "maxTokens", attrs.maxTokens == null && seed?.maxTokens == null);
  noteTrackedDefault(extraKey, "input", attrs.input == null && seed?.input == null);
  return model;
}

/* ------------------------------ 覆盖应用（快照支持重置） ------------------------------ */

/** 目录模型可覆盖属性的原始快照（首次修改前留底，null 覆盖/重置时恢复） */
type ModelAttrSnapshot = Pick<
  Model<Api>,
  | "name"
  | "reasoning"
  | "contextWindow"
  | "maxTokens"
  | "input"
  | "supportsImage"
  | "cost"
  | "promptCache"
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
    supportsImage: model.supportsImage,
    cost: { ...model.cost },
    ...(model.promptCache ? { promptCache: { ...model.promptCache } } : {}),
  });
}

/** 行值 → promptCache（{short?,long?} 秒；非法/空对象 = undefined，恢复继承值） */
function parseRowPromptCache(
  value: { short?: number; long?: number } | null | undefined,
): Model<Api>["promptCache"] {
  if (!value || typeof value !== "object") return undefined;
  const out: { short?: number; long?: number } = {};
  for (const tier of ["short", "long"] as const) {
    const v = value[tier];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[tier] = Math.trunc(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  promptCache?: { short?: number; long?: number } | null;
}): void {
  const key = `${row.provider}/${row.modelId}`;
  let model = getModels().getModel(row.provider, row.modelId);
  if (!model) {
    model = attachExtraCatalogModel(row.provider, row.modelId, row);
    if (!model) return;
  }
  snapshotModelAttrs(key, model);
  const snap = attrSnapshots.get(key)!;
  const custom = isCustomProvider(row.provider);
  const seed = custom ? lookupCatalogModelSeed(row.modelId) : undefined;
  const parsedInput = parseModelInput(row.input);
  model.name = row.name?.trim() || snap.name;
  model.reasoning = row.reasoning ?? snap.reasoning;
  model.contextWindow = row.contextWindow ?? snap.contextWindow;
  model.maxTokens = row.maxTokens ?? snap.maxTokens;
  model.input = parsedInput ?? snap.input;
  // 三态能力：显式行 → 已知；自定义端点无行值且有目录种子 → 已知；自定义端点
  // 两者都没有 → 未知，请求侧不预剥图；内置模型无显式覆盖 → 用自己的目录 input，
  // 不跨 provider 借用同名种子（同名模型能力可能不同）。
  if (parsedInput) {
    model.supportsImage = parsedInput.includes("image");
  } else if (custom) {
    // 无行值：目录种子优先；没有种子时保留发现结果/挂载时的三态（可能是
    // 动态发现刚写回的布尔值），不要用 null 覆盖掉真实能力。
    model.supportsImage = seed
      ? seed.input.includes("image")
      : (typeof snap.supportsImage === "boolean" ? snap.supportsImage : null);
  } else if (snap.supportsImage === null) {
    model.supportsImage = null;
  } else {
    model.supportsImage = snap.supportsImage ?? model.input.includes("image");
  }
  model.cost = parseModelCost(row.cost) ?? snap.cost;
  model.promptCache = parseRowPromptCache(row.promptCache) ?? snap.promptCache;
  // 缺省归因同步：自定义端点行 null = 属性又回到猜测值；内置（含目录外新增）
  // 行 null = 恢复目录真值/保留挂载时归因，非 null = 用户确认过，清除标记
  if (custom) {
    // 行空 = 回落注册值：种子命中过则是目录真值，不算猜测
    noteTrackedDefault(key, "contextWindow", row.contextWindow == null && seed?.contextWindow == null);
    noteTrackedDefault(key, "maxTokens", row.maxTokens == null && seed?.maxTokens == null);
    noteTrackedDefault(key, "input", row.input == null && seed?.input == null);
  } else {
    if (row.contextWindow != null) noteTrackedDefault(key, "contextWindow", false);
    if (row.maxTokens != null) noteTrackedDefault(key, "maxTokens", false);
    if (row.input != null) noteTrackedDefault(key, "input", false);
  }
  applyThinkingMapToModel(key, model);
}
