/**
 * 模型目录本体：pi-ai 内置 catalog 单例 + 属性校验/归因 + 目录种子反查。
 * 自定义 provider 的注册与覆盖应用见 custom-providers.ts，thinkingLevelMap
 * 覆盖见 thinking.ts，当前模型/档位状态见 state.ts。
 */
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelCost,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { logErr } from "../log";
import { credentialStore } from "../storage/storage";
import type { ModelReplaceItem, ModelRow } from "../storage/hostdb";
import { KOVA_CLIENT_IDENTITY } from "./client-identity";
import { normalizeProviderId } from "./provider-id";

/** 模型目录类型（含 provider 注册/删除、模型查询、凭据查询） */
export type ModelCatalog = ReturnType<typeof builtinModels>;

let catalog: ModelCatalog | undefined;

/**
 * 读时 provider 别名：旧存档里的 `azure-openai-responses/...` 仍能解析到
 * `azure/...`。包在 Models 实例方法上，覆盖转录回放、子代理、自动化、
 * imagegen、auto-review 等所有 getModel/getProvider 调用。
 */
function aliasProviderLookups(models: ModelCatalog): void {
  const getModel = models.getModel.bind(models);
  models.getModel = (provider, id) => getModel(normalizeProviderId(provider), id);
  const getProvider = models.getProvider.bind(models);
  models.getProvider = (id) => getProvider(normalizeProviderId(id));
  const getModelsOfProvider = models.getModels.bind(models);
  models.getModels = (provider?: string) =>
    getModelsOfProvider(provider ? normalizeProviderId(provider) : provider);
}

/** 取模型目录单例（首次调用时基于已初始化的凭据存储构建） */
export function getModels(): ModelCatalog {
  if (!catalog) {
    // 目录级请求身份：缓存保活、auto-review、转录摘要、子代理重试等直接调
    // getModels().stream* 的路径不走 Agent options，构造时带上才都发 kova 的 UA
    // （否则它们仍是 pi-ai 的默认身份 `pi/…`）
    catalog = builtinModels({
      credentials: credentialStore,
      identity: KOVA_CLIENT_IDENTITY,
    });
    aliasProviderLookups(catalog);
  }
  return catalog;
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

/**
 * 单行更新合并进整包替换列表。models_replace 是「整包替换」契约（先清空该
 * provider 的全部行再插入），只改一行必须把兄弟行原样带上——单条直塞会把
 * 内置服务的目录外新增行、其他模型的属性覆盖与勾选过滤行全数清掉，同轮多个
 * 单行更新还会互相覆盖只剩最后一个。行 attrs 原样透传（null = 继承，往返无损）。
 */
export function mergeModelRowUpdate(
  rows: ModelRow[],
  item: ModelReplaceItem,
): ModelReplaceItem[] {
  return [
    ...rows
      .filter((r) => r.modelId !== item.modelId)
      .map((r) => ({
        modelId: r.modelId,
        enabled: r.enabled,
        name: r.name,
        reasoning: r.reasoning,
        contextWindow: r.contextWindow,
        maxTokens: r.maxTokens,
        input: r.input,
        cost: r.cost,
        promptCache: r.promptCache,
      })),
    item,
  ];
}

/**
 * 自定义端点模型的兜底属性（行未填且内置目录反查也未命中时才用）。
 * maxTokens 曾兜底 8192：主流 coding 模型真值都在 32k 以上，未命中反查的
 * 自定义端点因此长期按 8k 输出预算跑，长回答/大 write 半截截断。现取 32k：
 * 远够日常回答与分段 write 用，又小于多数端点真值，误配时不会把请求打爆。
 *
 * 已知取舍：对真实输出上限只有 8k 的端点，请求会带 max_tokens=32768，严格端点
 * （OpenAI 系/vLLM）直接 400 报错、宽松端点静默截断。这是刻意的——8192 兜底是
 * 让所有现代模型静默劣化，32768 兜底只让罕见的 8k-only 端点**响亮失败**，错误
 * 文案自带真值（"supports at most 8192"），在模型设置里把最大输出改小即可修复
 * （分类码 MAX_TOKENS_TOO_LARGE，agent-errors.ts）。对未知端点不存在"正确"的
 * 默认值，响亮失败优于静默截断。
 *
 * contextWindow 保持 128k：误估大比误估小安全（压缩阈值按它算）。
 */
export const CUSTOM_MODEL_DEFAULTS = {
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as ModelCost,
  contextWindow: 128_000,
  maxTokens: 32_768,
};

/* ------------------- 目录属性种子（按 modelId 反查内置目录） ------------------- */

/** 目录反查命中的属性种子（自定义端点/目录外新增模型的属性预填与生效值兜底） */
export interface CatalogModelSeed {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  /** 按 pi-ai 同款口径推导的可用档位（不含 off） */
  supportedThinkingLevels: string[];
  /** 同名目录模型的上下文容量 / 最大输出 / 输入模态 / 单价真值 */
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  cost: ModelCost;
  /** 实际命中的目录 id（归一化命中时与传入的 modelId 不同，供界面标注来源） */
  matchedId: string;
  /** exact = 完整 id 精确同名；normalized = 剥掉一层命名空间前缀后同名 */
  source: "exact" | "normalized";
}

/**
 * 聚合/中转型 provider：同名模型散布在多个 provider 时，思考参数以厂商自营为准。
 * 只是排序偏好，不影响命中与否。
 */
const AGGREGATOR_PROVIDERS = new Set([
  "openrouter",
  "vercel-ai-gateway",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "opencode",
  "opencode-go",
  "github-copilot",
  "together",
  "fireworks",
  "groq",
  "huggingface",
  "radius",
]);

/**
 * 按 modelId 反查内置目录，取同名模型的属性当种子（大小写不敏感）。
 * 用户手输的模型 ID 很多就是官方模型名（gpt-5.1、deepseek-chat…），命中即可
 * 继承目录整理好的 reasoning + thinkingLevelMap（含 off 显式关闭值）与
 * contextWindow/maxTokens/input/cost 真值，不必盲猜——思考参数不继承正是
 * "关闭挡位关不掉默认开思考网关"的成因，上下文参数不继承则让自定义端点的
 * 同名模型只能用缺省猜测值回填编辑表单。
 * 多个命中时优先带 thinkingLevelMap 的、其次厂商自营（非聚合商），
 * 再按 provider id 字典序，保证结果稳定。
 *
 * 完整 id 精确同名未命中时，再剥掉一层命名空间前缀（最后一个 ':' 或 '/'
 * 之后）重试一次：cn:deepseek-v4.1-flash → deepseek-v4.1-flash、
 * openai/gpt-5.5-pro → gpt-5.5-pro——网关给模型挂地域/厂商命名空间是常态，
 * 不归一化就白丢一整套目录真值（推理能力、档位、上下文容量一起丢）。
 * 只做这一种收敛的归一化，不放松到子串/编辑距离那类模糊：真正的闸门是
 * "剥离后仍须精确命中目录"，目录里 anthropic.claude-*:0（Bedrock 版本后缀）、
 * ...:batch 这类脏尾名根本没有同名条目，自然回落缺省，不会被张冠李戴。
 * 命中结果带 matchedId/source，供属性弹窗区分"目录命中"与"目录推测"。
 */
export function lookupCatalogModelSeed(
  modelId: string,
): CatalogModelSeed | undefined {
  const wanted = modelId.trim().toLowerCase();
  if (!wanted) return undefined;
  const exact = findBestCatalogEntry(wanted);
  if (exact) return buildCatalogSeed(exact, "exact");
  const tail = catalogTail(wanted);
  if (!tail || tail === wanted) return undefined;
  const normalized = findBestCatalogEntry(tail);
  return normalized ? buildCatalogSeed(normalized, "normalized") : undefined;
}

/** 目录里同名条目中最优的一个（排序规则见 lookupCatalogModelSeed 注释） */
interface CatalogEntryMatch {
  matchedId: string;
  rank: [number, number, string];
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  cost: ModelCost;
}

function findBestCatalogEntry(wantedLower: string): CatalogEntryMatch | undefined {
  let best: CatalogEntryMatch | undefined;
  for (const p of getModels().getProviders()) {
    if (customProviderIds.has(p.id)) continue;
    for (const m of p.getModels()) {
      if (m.id.toLowerCase() !== wantedLower) continue;
      const rank: [number, number, string] = [
        m.thinkingLevelMap ? 0 : 1,
        AGGREGATOR_PROVIDERS.has(p.id) ? 1 : 0,
        p.id,
      ];
      if (best && !rankLess(rank, best.rank)) continue;
      best = {
        matchedId: m.id,
        rank,
        reasoning: m.reasoning,
        ...(m.thinkingLevelMap
          ? { thinkingLevelMap: { ...m.thinkingLevelMap } }
          : {}),
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        input: [...m.input],
        cost: { ...m.cost },
      };
    }
  }
  return best;
}

function buildCatalogSeed(
  match: CatalogEntryMatch,
  source: CatalogModelSeed["source"],
): CatalogModelSeed {
  // getSupportedThinkingLevels 只读 reasoning 与 thinkingLevelMap 两个字段
  const pseudo = {
    reasoning: match.reasoning,
    thinkingLevelMap: match.thinkingLevelMap,
  } as unknown as Model<Api>;
  return {
    reasoning: match.reasoning,
    ...(match.thinkingLevelMap
      ? { thinkingLevelMap: match.thinkingLevelMap }
      : {}),
    supportedThinkingLevels: getSupportedThinkingLevels(pseudo).filter(
      (l) => l !== "off",
    ),
    contextWindow: match.contextWindow,
    maxTokens: match.maxTokens,
    input: match.input,
    cost: match.cost,
    matchedId: match.matchedId,
    source,
  };
}

/** 最后一个 ':' 或 '/' 之后的尾段（命名空间前缀剥离用；无分隔符返回空串） */
function catalogTail(id: string): string {
  const cut = Math.max(id.lastIndexOf(":"), id.lastIndexOf("/"));
  return cut >= 0 ? id.slice(cut + 1).trim() : "";
}

function rankLess(a: [number, number, string], b: [number, number, string]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

/* ------------------- 缺省猜测值归因（属性弹窗"未确认"标记数据源） ------------------- */

/**
 * 生效值仍来自 CUSTOM_MODEL_DEFAULTS（既不是内置目录真值也不是用户填的）
 * 的属性集合。目录不提供这类模型的上下文元数据，128k/8192 只是猜的——
 * 前端属性弹窗据此标记"缺省未确认"，用户填过即消失。
 * 内置 provider 目录内的模型永不进表（行 null = 恢复目录真值，不是猜测）。
 */
export const DEFAULT_TRACKED_ATTRS = ["contextWindow", "maxTokens", "input"] as const;
export type DefaultedAttr = (typeof DEFAULT_TRACKED_ATTRS)[number];
const defaultedAttrs = new Map<string, Set<DefaultedAttr>>();
/** 自定义端点 provider id：applyRow 重放时区分"null=恢复默认(仍是猜测)" */
const customProviderIds = new Set<string>();

/** 自定义端点 provider 登记与查询（custom-providers.ts 维护，目录反查时跳过） */
export function isCustomProvider(id: string): boolean {
  return customProviderIds.has(id);
}

export function addCustomProviderId(id: string): void {
  customProviderIds.add(id);
}

/** 归因以行为准整表重算（注册路径）：清掉该 provider 的旧归因 */
export function clearDefaultedAttrsFor(providerId: string): void {
  for (const key of [...defaultedAttrs.keys()]) {
    if (key.startsWith(`${providerId}/`)) defaultedAttrs.delete(key);
  }
}

function noteDefaulted(key: string, attr: DefaultedAttr, isDefault: boolean): void {
  if (!isDefault) {
    const set = defaultedAttrs.get(key);
    if (!set) return;
    set.delete(attr);
    if (set.size === 0) defaultedAttrs.delete(key);
    return;
  }
  let set = defaultedAttrs.get(key);
  if (!set) {
    set = new Set();
    defaultedAttrs.set(key, set);
  }
  set.add(attr);
}

export function getModelDefaultedAttrs(
  provider: string,
  modelId: string,
): DefaultedAttr[] {
  return [...(defaultedAttrs.get(`${provider}/${modelId}`) ?? [])];
}

/** 归因登记（attachExtraCatalogModel / applyRowToCatalogModel 用） */
export function noteTrackedDefault(
  key: string,
  attr: DefaultedAttr,
  isDefault: boolean,
): void {
  noteDefaulted(key, attr, isDefault);
}

/**
 * 服务端明确上下文上限后的自动校准：更新内存里的模型对象，并清掉
 * contextWindow 的“缺省猜测”归因（下次打开属性弹窗不再标“未确认”）。
 * 模型不在目录里（测试/只读投影的占位）返回 false，由调用方决定是否落库。
 */
export function setModelContextWindow(
  provider: string,
  modelId: string,
  contextWindow: number,
): boolean {
  const model = getModels().getModel(provider, modelId) as
    | (Model<Api> & { contextWindow?: number })
    | undefined;
  if (!model) return false;
  model.contextWindow = contextWindow;
  noteTrackedDefault(`${provider}/${modelId}`, "contextWindow", false);
  return true;
}
