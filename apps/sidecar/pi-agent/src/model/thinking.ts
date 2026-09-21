/**
 * thinkingLevelMap 前端覆盖（set_thinking_maps 下发）与 OpenAI 兼容端点的
 * 会话缓存路由辅助。目录本体见 catalog.ts。
 */
import {
  type Api,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import { getModels } from "./catalog";

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

export function applyThinkingMapToModel(key: string, model: Model<Api>): void {  if (!thinkingMapBaselines.has(key)) {
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

/** 自定义 provider 重建模型后登记基线（重建对象不带覆盖，先抹平再统一叠加） */
export function setThinkingMapBaseline(
  key: string,
  map: ThinkingLevelMap | undefined,
): void {
  thinkingMapBaselines.set(key, map);
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
