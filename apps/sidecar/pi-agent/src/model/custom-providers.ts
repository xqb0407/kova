/**
 * 自定义端点 provider 与目录覆盖：把 custom_providers/custom_models 行注册进
 * 目录、models 表属性覆盖应用（快照支持重置）、内置 provider 的目录外新增模型。
 * 目录单例与种子反查见 catalog.ts，thinkingLevelMap 覆盖见 thinking.ts。
 */
import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { logErr } from "../log";
import { customProvidersList, modelsAll, modelsList } from "../storage/hostdb";
import type { CustomApiKind } from "../types";
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
  const enabledRows = rows.filter((m) => m.enabled && m.modelId.trim());
  // 用户手输的 ID 常与官方模型同名：命中内置目录即继承其属性（行内显式值优先），
  // 未命中才落到 CUSTOM_MODEL_DEFAULTS 猜测值
  const seededRows = enabledRows.map((m) => ({
    m,
    seed: lookupCatalogModelSeed(m.modelId),
  }));
  const modelList: Model<Api>[] = seededRows.map(({ m, seed }) => {
    return {
      id: m.modelId.trim(),
      name: m.name?.trim() || m.modelId.trim(),
      api: API_ID[apiKind],
      provider: row.id,
      baseUrl,
      reasoning:
        m.reasoning ?? seed?.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning,
      input:
        parseModelInput(m.input) ??
        seed?.input ??
        CUSTOM_MODEL_DEFAULTS.input,
      cost:
        parseModelCost(m.cost) ??
        seed?.cost ??
        { ...CUSTOM_MODEL_DEFAULTS.cost },
      contextWindow:
        m.contextWindow ?? seed?.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow,
      maxTokens:
        m.maxTokens ?? seed?.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens,
      ...(seed?.thinkingLevelMap
        ? { thinkingLevelMap: seed.thinkingLevelMap }
        : {}),
      // 未知自定义端点保守禁用 OpenAI 新版 "developer" 系统角色：很多国产兼容
      // 网关不认（实测 sensenova 对 developer 角色一律 400 invalid request），
      // 一律走传统 "system" 角色；reasoning_effort 等思考参数不受影响
      compat: { supportsDeveloperRole: false },
    };
  });
  // 重建出的模型对象以种子 map 为基线（同名模型种子变化随重建生效），
  // 前端覆盖由随后的 applyThinkingMapOverrides 叠加到基线上
  for (const m of modelList) {
    setThinkingMapBaseline(`${row.id}/${m.id}`, m.thinkingLevelMap);
  }
  const provider = createProvider({
    id: row.id,
    name: row.name,
    baseUrl,
    auth: { apiKey: envApiKeyAuth(`${row.name} API key`, []) },
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
  // 目录里没有该 ID，但别的内置 provider 可能有同名模型（如把 gpt-5.1 挂到别的厂商下）：
  // 命中即继承其属性，未命中按自定义默认值
  const seed = lookupCatalogModelSeed(modelId);
  const model: Model<Api> = {
    id: modelId,
    name: attrs.name?.trim() || modelId,
    api: sibling.api,
    provider: orig.id,
    baseUrl: sibling.baseUrl,
    reasoning:
      attrs.reasoning ?? seed?.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning,
    input:
      parseModelInput(attrs.input) ??
      seed?.input ??
      [...CUSTOM_MODEL_DEFAULTS.input],
    cost:
      parseModelCost(attrs.cost) ??
      seed?.cost ??
      { ...CUSTOM_MODEL_DEFAULTS.cost },
    contextWindow:
      attrs.contextWindow ?? seed?.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow,
    maxTokens:
      attrs.maxTokens ?? seed?.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens,
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
  // 缺省归因同步：自定义端点行 null = 属性又回到猜测值；内置（含目录外新增）
  // 行 null = 恢复目录真值/保留挂载时归因，非 null = 用户确认过，清除标记
  if (isCustomProvider(row.provider)) {
    // 行空 = 回落注册值：种子命中过则是目录真值，不算猜测
    const seed = lookupCatalogModelSeed(row.modelId);
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
