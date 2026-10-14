/**
 * ZCode 配置解析（纯函数）：`provider_config.json` 的
 * `config.providerConfigRules.providerRules[]` → 归一化候选服务。
 *
 * 抽取口径（对照真实配置核对）：
 *   providerName                  → 服务名（缺失时用 host 兜底）
 *   config.access.apiKey          → 明文 key（access.type 不是 api-key 时不取）
 *   config.api.baseUrl             → baseUrl
 *   config.api.type                → openai-chat-completions / openai-responses /
 *                                   anthropic-messages，与 Kova 接口格式一一对应
 *   config.personalModelIds        → 模型列表（无 name 信息，id 即展示名）
 *   config.modelOrder              → personalModelIds 缺失时的回退（同为 id 数组）
 *
 * 密文形态的 credentials.json 不读：那里的值是 `enc:v1:…`，密钥由 ZCode 自己的
 * 主密钥加密，Kova 没有它的主密钥，既解不开也不该去解。provider_config.json 里
 * 存的是明文 api-key，那才是可导入的来源。
 */
import type { CustomApiKind } from "../../types";
import {
  clean,
  isUsableBaseUrl,
  nameFromBaseUrl,
  normalizeImportedBaseUrl,
  type ImportedProvider,
} from "./types";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** ZCode 的 api.type → Kova 接口格式。认不出一律按 OpenAI Chat 兼容（最常见） */
function apiFromType(type: string): CustomApiKind {
  if (type === "openai-responses") return "openai-responses";
  if (type === "anthropic-messages") return "anthropic-messages";
  return "openai-chat";
}

/** id 数组 → 归一化模型列表；去重且保持原顺序（用户排过序） */
function readModelIds(value: unknown): { id: string }[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: { id: string }[] = [];
  for (const raw of value) {
    const id = clean(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id });
  }
  return out;
}

/**
 * 解析 ZCode 的 provider_config.json。文件不存在/为空返回空数组；
 * JSON 语法错误抛 Error（与 opencode 同一口径，不静默吞掉）。
 */
export function parseZcodeConfig(
  configText?: string,
  sourceLabel = "zcode provider_config.json",
): ImportedProvider[] {
  if (!configText?.trim()) return [];
  const root = asRecord(JSON.parse(configText));
  if (!root) return [];
  const rules = asRecord(asRecord(root.config)?.providerConfigRules)?.providerRules;
  if (!Array.isArray(rules)) return [];

  const out: ImportedProvider[] = [];
  for (const raw of rules) {
    const rule = asRecord(raw);
    const config = asRecord(rule?.config);
    if (!rule || !config) continue;
    const rawBaseUrl = clean(asRecord(config.api)?.baseUrl);
    if (!isUsableBaseUrl(rawBaseUrl)) continue;

    const api = apiFromType(clean(asRecord(config.api)?.type));
    const baseUrl = normalizeImportedBaseUrl(rawBaseUrl, api);
    const name = clean(rule.providerName) || nameFromBaseUrl(baseUrl);
    // 只有 api-key 形态的 access 能搬：oauth / 外部登录的凭据 Kova 用不了
    const access = asRecord(config.access);
    const accessType = clean(access?.type);
    const apiKey = accessType === "api-key" ? clean(access?.apiKey) : "";

    const models = readModelIds(config.personalModelIds);
    if (models.length === 0) models.push(...readModelIds(config.modelOrder));

    out.push({
      source: "zcode",
      sourceKey: clean(rule.providerId) || name,
      sourceLabel,
      name,
      baseUrl,
      api,
      ...(apiKey ? { apiKey } : {}),
      models,
      disabled: false,
    });
  }
  return out;
}