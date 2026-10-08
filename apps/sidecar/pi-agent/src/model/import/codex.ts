/**
 * Codex 配置解析（纯函数）：`config.toml` 的 `[model_providers.*]` + `auth.json`
 * 的密钥 → 归一化候选服务。
 *
 * 抽取口径（对照真实配置核对）：
 *   [model_providers.<key>] base_url     → baseUrl（必需，http(s) 才算候选）
 *                          name         → 服务名（缺失/为 "custom" 时用 host 兜底）
 *                          wire_api     → responses → openai-responses，chat/其它 → openai-chat
 *                          env_key      → 指定从哪个环境变量读 key（优先）
 *   auth.json            OPENAI_API_KEY → env_key 没有时的兜底密钥
 *   顶层 model / model_provider          → 当前选中的模型，只挂给 model_provider 指向的那家
 *
 * 只挂给当前选中那家的原因：Codex 的 config.toml 只记一个 `model`，它必然属于
 * `model_provider` 指向的服务。把它复制给所有 provider 会凭空造出"这家也有这个
 * 模型"的假信息；其余服务模型列表留空，导入后在编辑弹窗点「获取列表」现拉更准。
 *
 * 不读 `model_catalog_json`：本机实测该文件 93KB 且由第三方（cc-switch）生成，
 * 非 Codex 原生结构，读它等于把别人的约定硬编码进来。
 */
import {
  clean,
  isUsableBaseUrl,
  nameFromBaseUrl,
  normalizeImportedBaseUrl,
  type ImportedProvider,
} from "./types";
import { parseTomlScalars, tomlTables } from "./toml-lite";

/** Codex 的 name 常见就是 "custom"——这种占位名不展示给用户，用 host 兜底 */
const PLACEHOLDER_NAMES = new Set(["custom", "default", "provider"]);

function toStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** wire_api → Kova 接口格式。未知值一律按 OpenAI 兼容（Codex 只这两种） */
function apiFromWireApi(wireApi: string) {
  return wireApi === "responses" ? ("openai-responses" as const) : ("openai-chat" as const);
}

/** auth.json → 各口径的密钥候选。结构坏了当作没有 */
function readAuthKeys(authText?: string): string {
  if (!authText?.trim()) return "";
  try {
    const parsed = JSON.parse(authText) as unknown;
    if (!parsed || typeof parsed !== "object") return "";
    const record = parsed as Record<string, unknown>;
    // tokens 是 ChatGPT 登录态，导不进 Kova 的 api-key 凭据；只取 OPENAI_API_KEY
    return clean(record.OPENAI_API_KEY);
  } catch {
    return "";
  }
}

/**
 * 解析 Codex 配置。env 是显式传入而非直接读 process.env 的那一份，便于单测；
 * 运行时由 scan.ts 传 process.env。
 */
export function parseCodexConfig(
  configToml?: string,
  authJson?: string,
  env: Record<string, string | undefined> = {},
  sourceLabel = "codex config.toml",
): ImportedProvider[] {
  if (!configToml?.trim()) return [];
  const scalars = parseTomlScalars(configToml);
  const authKey = readAuthKeys(authJson);
  const activeKey = toStr(scalars.model_provider);
  const activeModel = toStr(scalars.model);

  const out: ImportedProvider[] = [];
  for (const [key, table] of Object.entries(tomlTables(scalars, "model_providers"))) {
    const rawBaseUrl = toStr(table.base_url);
    if (!isUsableBaseUrl(rawBaseUrl)) continue;
    const api = apiFromWireApi(toStr(table.wire_api));
    const baseUrl = normalizeImportedBaseUrl(rawBaseUrl, api);
    const rawName = toStr(table.name);
    const name = !rawName || PLACEHOLDER_NAMES.has(rawName.toLowerCase())
      ? nameFromBaseUrl(baseUrl)
      : rawName;
    // env_key 是 Codex 自己指定的环境变量名，读它比猜 auth.json 更准
    const envKeyName = toStr(table.env_key);
    const apiKey = (envKeyName ? clean(env[envKeyName]) : "") || authKey;
    const isActive = activeKey === key;
    out.push({
      source: "codex",
      sourceKey: key,
      sourceLabel,
      name,
      baseUrl,
      api,
      ...(apiKey ? { apiKey } : {}),
      models: isActive && activeModel ? [{ id: activeModel }] : [],
      disabled: false,
    });
  }
  return out;
}