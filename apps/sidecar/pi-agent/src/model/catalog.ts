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

/** 模型目录类型（含 provider 注册/删除、模型查询、凭据查询） */
export type ModelCatalog = ReturnType<typeof builtinModels>;

let catalog: ModelCatalog | undefined;

/** 取模型目录单例（首次调用时基于已初始化的凭据存储构建） */
export function getModels(): ModelCatalog {
  if (!catalog) catalog = builtinModels({ credentials: credentialStore });
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

/** 自定义端点模型的兜底属性（行未填且内置目录反查也未命中时才用） */
export const CUSTOM_MODEL_DEFAULTS = {
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as ModelCost,
  contextWindow: 128_000,
  maxTokens: 8_192,
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
 */
export function lookupCatalogModelSeed(
  modelId: string,
): CatalogModelSeed | undefined {
  const wanted = modelId.trim().toLowerCase();
  if (!wanted) return undefined;
  let best:
    | {
        rank: [number, number, string];
        reasoning: boolean;
        thinkingLevelMap?: ThinkingLevelMap;
        contextWindow: number;
        maxTokens: number;
        input: ("text" | "image")[];
        cost: ModelCost;
      }
    | undefined;
  for (const p of getModels().getProviders()) {
    if (customProviderIds.has(p.id)) continue;
    for (const m of p.getModels()) {
      if (m.id.toLowerCase() !== wanted) continue;
      const rank: [number, number, string] = [
        m.thinkingLevelMap ? 0 : 1,
        AGGREGATOR_PROVIDERS.has(p.id) ? 1 : 0,
        p.id,
      ];
      if (best && !rankLess(rank, best.rank)) continue;
      best = {
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
  if (!best) return undefined;
  // getSupportedThinkingLevels 只读 reasoning 与 thinkingLevelMap 两个字段
  const pseudo = {
    reasoning: best.reasoning,
    thinkingLevelMap: best.thinkingLevelMap,
  } as unknown as Model<Api>;
  return {
    reasoning: best.reasoning,
    ...(best.thinkingLevelMap
      ? { thinkingLevelMap: best.thinkingLevelMap }
      : {}),
    supportedThinkingLevels: getSupportedThinkingLevels(pseudo).filter(
      (l) => l !== "off",
    ),
    contextWindow: best.contextWindow,
    maxTokens: best.maxTokens,
    input: best.input,
    cost: best.cost,
  };
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
