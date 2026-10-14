/**
 * cc-switch 配置解析（纯函数）：providers 表的行 → 归一化候选服务。
 *
 * cc-switch 是管理 Claude Code / Codex / opencode / Gemini 配置的切换器，它的
 * `providers.settings_config` 按 app_type 存的就是各家自己的配置形状，所以这里
 * 全部走复用而不是重写一份字段口径：
 *   app_type=opencode → 节点与 opencode.json 的 provider 节点同构，直接喂
 *                       readOpencodeProviderNode
 *   app_type=codex    → settings_config.config 就是一整份 config.toml 字符串，
 *                       settings_config.auth 就是 auth.json，连去重都不用
 *   app_type=claude   → settings_config.env 里的 ANTHROPIC_BASE_URL +
 *                       ANTHROPIC_AUTH_TOKEN/API_KEY 拼出 Anthropic Messages 服务，
 *                       模型列表从 ANTHROPIC_MODEL 与 ANTHROPIC_DEFAULT_*_MODEL 取
 *   gemini / claude-desktop → 官方条目只有空的 env/config，天然产不出候选
 *
 * cc-switch 的独有增益是 `modelCatalog`：它记了真实的 contextWindow，比任何
 * 猜出来的默认值都准，直接带到 Kova（缺失时仍走内置目录种子继承）。
 *
 * settings_config 传字符串而非对象：本模块与文件系统/SQLite 无关，DB 读取在
 * scan.ts，单测直接喂行数组即可。
 */
import { parseCodexConfig } from "./codex";
import { readOpencodeProviderNode } from "./opencode";
import { clean, isUsableBaseUrl, type ImportedModel, type ImportedProvider } from "./types";

/** providers 表的一行（只取用得到的列）；settings_config 是 JSON 文本 */
export type CcswitchProviderRow = {
  id: string;
  app_type: string;
  name: string;
  settings_config: string;
};

/** claude 分支的模型环境变量，按"档位从大到小"排——用户填的默认模型在前，
 *  与 Claude Code 自己的优先级观感一致 */
const CLAUDE_MODEL_ENV = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
] as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const SOURCE_LABEL = "cc-switch";

/** 一行 → 候选列表。一行理论上只产出一条，返回数组是为了让三类分支形状统一 */
function fromRow(row: CcswitchProviderRow): ImportedProvider[] {
  let settings: Record<string, unknown>;
  try {
    settings = asRecord(JSON.parse(row.settings_config)) ?? {};
  } catch {
    // 单行坏 JSON 不该掀掉整次扫描
    return [];
  }

  const key = `${row.app_type}:${row.id}`;

  if (row.app_type === "opencode") {
    const one = readOpencodeProviderNode(key, settings, false, SOURCE_LABEL);
    if (!one) return [];
    // 节点读取器把来源写死成 opencode（它本就是照 opencode.json 设计的），
    // 这里必须改写成 cc-switch：否则这 4 行会被归到 opencode 分组下、
    // 与用户真正在 opencode.json 里配的服务混在一起，分不清谁是谁
    return [{ ...one, source: "ccswitch", sourceKey: key, sourceLabel: SOURCE_LABEL }];
  }

  if (row.app_type === "codex") {
    // config 字段就是 config.toml 原文，auth 就是 auth.json —— 整段交给既有的
    // Codex 解析器，抽完把来源标识改写成 cc-switch（sourceKey 会撞：所有行的
    // model_providers 键都叫 "custom"）
    const auth = asRecord(settings.auth);
    const authText = auth ? JSON.stringify(auth) : undefined;
    const configText = typeof settings.config === "string" ? settings.config : "";
    return parseCodexConfig(configText, authText, {}, SOURCE_LABEL).map((p) => ({
      ...p,
      source: "ccswitch" as const,
      sourceKey: key,
      sourceLabel: SOURCE_LABEL,
      // cc-switch 存了模型目录，比 Codex 顶层那一个 model 全，补上
      models: mergeModelCatalog(p.models, settings.modelCatalog),
    }));
  }

  if (row.app_type === "claude") {
    const env = asRecord(settings.env) ?? {};
    const baseUrl = clean(env.ANTHROPIC_BASE_URL);
    if (!isUsableBaseUrl(baseUrl)) return [];
    // AUTH_TOKEN 是 ANTHROPIC_AUTH_TOKEN 优先、API_KEY 兜底：Claude Code 自己
    // 两个都认，部分中转只认其中一个
    const apiKey = clean(env.ANTHROPIC_AUTH_TOKEN) || clean(env.ANTHROPIC_API_KEY);
    const models: ImportedModel[] = [];
    const seen = new Set<string>();
    for (const envKey of CLAUDE_MODEL_ENV) {
      const id = clean(env[envKey]);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id });
    }
    return [
      {
        source: "ccswitch",
        sourceKey: key,
        sourceLabel: SOURCE_LABEL,
        // 行名是用户自己起的（"联通"、"阿里"、"火山"），比 host 有信息量
        name: clean(row.name) || baseUrl,
        baseUrl,
        api: "anthropic-messages",
        ...(apiKey ? { apiKey } : {}),
        models,
        disabled: false,
      },
    ];
  }

  // gemini / claude-desktop：官方条目只有空 env/config，别的形状不在导入范围
  return [];
}

/** cc-switch 的 modelCatalog.models（带 contextWindow）补进 Codex 解析出的列表。
 *  已有的条目保留解析结果，目录里独有的补在后面。
 *  models 是**数组** [{ model, displayName, contextWindow }]，不是字典 */
function mergeModelCatalog(
  base: ImportedModel[],
  catalog: unknown,
): ImportedModel[] {
  const models = asRecord(catalog)?.models;
  if (!Array.isArray(models)) return base;
  const out = [...base];
  const seen = new Set(out.map((m) => m.id));
  for (const raw of models) {
    const spec = asRecord(raw);
    const id = clean(spec?.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = clean(spec?.displayName);
    const ctx = spec?.contextWindow;
    out.push({
      id,
      ...(name ? { name } : {}),
      ...(typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0
        ? { contextWindow: Math.floor(ctx) }
        : {}),
    });
  }
  return out;
}

/** 全部行 → 候选。坏行静默跳过（每行独立收敛） */
export function parseCcswitchProviders(rows: CcswitchProviderRow[]): ImportedProvider[] {
  const out: ImportedProvider[] = [];
  for (const row of rows) out.push(...fromRow(row));
  return out;
}