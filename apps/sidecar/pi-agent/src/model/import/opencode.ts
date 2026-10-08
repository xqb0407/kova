/**
 * opencode 配置解析（纯函数）：`provider.<slug>` → 归一化候选服务。
 *
 * 读两个文件并浅合并：`opencode.json` 是主配置，`opencode.jsonc` 覆盖它
 * （实测 jsonc 里放 `disabled_providers` 这类补丁项）。合并是**对象级浅合**：
 * 顶层键整个替换，`provider` 下按 slug 逐个合并（只替换出现的那个 slug，
 * 否则 jsonc 里写一个 provider 会把 json 的 provider 全清掉）。
 *
 * 抽取口径（对照真实配置核对）：
 *   provider.<slug>.options.baseURL → baseUrl
 *   provider.<slug>.options.apiKey  → 明文 key
 *   provider.<slug>.models          → { "<modelId>": { name?, … } } 字典
 *   provider.<slug>.npm             → 含 anthropic 走 Anthropic Messages，其余 OpenAI 兼容
 *   disabled_providers              → 标记停用（导入后默认不进目录）
 *
 * 未知字段一律忽略：opencode 配置项在变，认不出的最坏结果是少认一个模型，
 * 不会把无关字段错当成端点。
 */
import type { CustomApiKind } from "../../types";
import {
  clean,
  isUsableBaseUrl,
  nameFromBaseUrl,
  normalizeImportedBaseUrl,
  type ImportedProvider,
} from "./types";

/** 宽容 JSON 解析：容忍文件尾逗号（手改配置的常见痕迹） */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // 去掉对象/数组字面量后的多余逗号再试一次
    const relaxed = trimmed.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(relaxed);
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** npm 包名 → 接口格式。只有 Anthropic 是独立协议，其余 ai-sdk 包都走 OpenAI 兼容 */
function apiFromNpm(npm: string): CustomApiKind {
  return /anthropic/i.test(npm) ? "anthropic-messages" : "openai-chat";
}

/** opencode 的 models 字典 → 归一化模型列表；非对象/空 id 的条目丢掉 */
function readModels(raw: unknown): { id: string; name?: string }[] {
  const dict = asRecord(raw);
  if (!dict) return [];
  const out: { id: string; name?: string }[] = [];
  for (const [id, spec] of Object.entries(dict)) {
    const modelId = clean(id);
    if (!modelId) continue;
    const name = clean(asRecord(spec)?.name);
    // name 与 id 相同时不重复带（Kova 侧会自动回落 id）
    out.push(name && name !== modelId ? { id: modelId, name } : { id: modelId });
  }
  return out;
}

/**
 * 单个 provider 节点 → 候选；缺 baseUrl 或 baseUrl 不是 http(s) 返回 null
 * （用户可以没配 baseUrl 用环境变量，但那不是可导入的服务）。
 *
 * 对外导出：cc-switch 的 opencode 分支存的就是这个形状的节点，直接复用，
 * 免得同一套字段口径在两个文件里各写一遍、日后漂移。
 */
export function readOpencodeProviderNode(
  slug: string,
  raw: unknown,
  disabled: boolean,
  sourceLabel: string,
): ImportedProvider | null {
  const node = asRecord(raw);
  if (!node) return null;
  const options = asRecord(node.options) ?? {};
  const rawBaseUrl = clean(options.baseURL ?? options.baseUrl);
  if (!isUsableBaseUrl(rawBaseUrl)) return null;
  const api = apiFromNpm(clean(node.npm));
  const baseUrl = normalizeImportedBaseUrl(rawBaseUrl, api);
  const apiKey = clean(options.apiKey);
  const name = clean(node.name) || nameFromBaseUrl(baseUrl);
  return {
    source: "opencode",
    sourceKey: slug,
    sourceLabel,
    name,
    baseUrl,
    api,
    ...(apiKey ? { apiKey } : {}),
    models: readModels(node.models),
    disabled,
  };
}

/** 顶层 provider map 逐 slug 合入 base：只覆盖 base 里出现的 slug */
function mergeProviders(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [slug, node] of Object.entries(patch)) {
    const merged = asRecord(out[slug]);
    const incoming = asRecord(node);
    if (merged && incoming) out[slug] = { ...merged, ...incoming };
    else out[slug] = node;
  }
  return out;
}

/**
 * 解析 opencode 配置。参数是**已读入的文本**（可为 undefined 表示文件不存在），
 * 返回候选列表；两个文件都缺失时返回空数组而不是抛错——文件不存在是常态。
 * JSON 语法错误抛 Error，由调用方如实回报给用户（静默返回空会让人以为没配过）。
 */
export function parseOpencodeConfig(
  jsonText?: string,
  jsoncText?: string,
  sourceLabel = "opencode.json",
): ImportedProvider[] {
  const base = (jsonText ? asRecord(parseJsonLoose(jsonText)) : null) ?? {};
  const patch = (jsoncText ? asRecord(parseJsonLoose(jsoncText)) : null) ?? {};
  const providers = mergeProviders(
    asRecord(base.provider) ?? {},
    asRecord(patch.provider) ?? {},
  );
  const disabled = new Set(
    [...(Array.isArray(base.disabled_providers) ? base.disabled_providers : []),
     ...(Array.isArray(patch.disabled_providers) ? patch.disabled_providers : [])]
      .map(clean)
      .filter(Boolean),
  );
  const out: ImportedProvider[] = [];
  for (const [slug, node] of Object.entries(providers)) {
    const candidate = readOpencodeProviderNode(slug, node, disabled.has(slug), sourceLabel);
    if (candidate) out.push(candidate);
  }
  return out;
}