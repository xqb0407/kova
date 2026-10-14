/**
 * 外部工具模型服务配置的归一化契约：opencode / Codex / ZCode 三个解析器的
 * 统一输出。前端预览弹窗只认这个形状，不认各家原始格式。
 *
 * 解析器是纯函数（文本进、候选出，不碰文件系统），因此格式变动、字段缺失
 * 都只能在单测里复现，不会带着 IO 混进 scan.ts。
 */
import type { CustomApiKind } from "../../types";

/** 来源标识；新增工具在这里加一项即可，scan 与前端按它分组 */
export type ImportSource = "opencode" | "codex" | "zcode" | "ccswitch";

/** 归一化模型条目。contextWindow 只有来源真的记了才有（cc-switch 的
 *  modelCatalog 会给），没有就是 undefined —— 不填猜测值，交给 Kova 侧按
 *  内置目录种子继承 */
export type ImportedModel = {
  id: string;
  name?: string;
  contextWindow?: number;
};

/** 归一化后的一个候选服务（一条 = 前端预览里的一行） */
export type ImportedProvider = {
  /** 来源工具 + 该来源内的稳定标识（opencode 的 provider slug、Codex 的
   *  model_providers 键、ZCode 的 providerId、cc-switch 的 app_type:id），
   *  冲突提示与去重靠它 */
  source: ImportSource;
  sourceKey: string;
  /** 展示用来源名，如 "opencode.json" / "codex config.toml" / "cc-switch" */
  sourceLabel: string;
  /** 服务名；缺失时由解析器用 baseUrl 的 host 兜底 */
  name: string;
  baseUrl: string;
  api: CustomApiKind;
  /** 明文密钥。解析器原样带出，由前端决定是否勾选写入钥匙串 */
  apiKey?: string;
  /** 该来源记录在案的模型；空数组合法（导入后在编辑弹窗点「获取列表」现拉） */
  models: ImportedModel[];
  /** 来源侧已停用（如 opencode 的 disabled_providers）。导入后默认停用，
   *  不进模型目录，用户在设置里启用即可 */
  disabled: boolean;
};

/** 单个来源的扫描结果。文件不存在是常态（大多数用户只装了其中一个工具），
 *  因此 missing 不算错误，只是不展示 */
export type ImportSourceStatus = {
  source: ImportSource;
  /** 尝试过的路径（按优先级） */
  paths: string[];
  /** 实际命中的文件；null = 全部不存在 */
  foundPath: string | null;
  /** 该来源解析出的候选数（foundPath 为 null 时恒为 0） */
  count: number;
  /** 读取或解析失败的原因。文件不存在不算失败，此项为 null */
  error: string | null;
};

/** scan_provider_imports 的完整应答 */
export type ProviderImportScan = {
  candidates: ImportedProvider[];
  sources: ImportSourceStatus[];
};

/** baseUrl 必须是 http(s) 才能当端点用（与 add_custom_provider 同一口径）。
 *  解析器统一走这里，避免各家用不同的宽松判定 */
export const isUsableBaseUrl = (value: string): boolean => /^https?:\/\/\S+$/i.test(value);

/** 服务名兜底：取 baseUrl 的 host，去掉端口与 www.。Codex 常见
 *  name = "custom"，直接用会让用户看到一排同名服务 */
export const nameFromBaseUrl = (baseUrl: string): string => {
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./i, "");
    return host || "导入的服务";
  } catch {
    return "导入的服务";
  }
};

/** 统一 trim：配置里的空串与空白一律当"没配"，不让它一路流到写入层 */
export const clean = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** 末段是否已是版本号（v1 / v2 / v3 / v1beta…） */
const hasVersionSegment = (pathname: string): boolean => {
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  return /^v\d/i.test(last);
};

/**
 * 把来源工具的 baseUrl 归一到 Kova 的拼接约定，否则请求会打到不存在的路径上。
 *
 * Kova 侧是硬约定（见 handlers/providers.ts 的 test_provider/fetch_models 与
 * registerCustomProvider）：baseUrl 之后**直接**接端点路径，不做版本推断——
 *   openai-chat      → baseUrl + /chat/completions
 *   openai-responses → baseUrl + /responses
 *   anthropic-messages → baseUrl + /v1/messages（版本段由 Kova 自己补）
 *
 * 而各家源配置的写法不统一：Codex 的 base_url 恒带版本段，但 ZCode 的
 * `https://api.deepseek.com`、opencode 的 `https://token.sensenova.cn`、某些
 * cc-switch 条目的 `http://127.0.0.1:1234/` 都不带。照抄过来，openai 类就会
 * 少一层 `/v1`（127.0.0.1:1234/responses 直接 404）。
 *
 * 两条规则都只动"必然错"的方向，不猜服务商的私有前缀：
 *   - openai 类：末段不是版本号就补 /v1（`/compatible-mode/v1`、`/api/coding/v3`
 *     这类认得出来，不动）
 *   - anthropic 类：反着来，剥掉尾部 /v1，否则 Kova 会拼成 /v1/v1/messages
 */
export const normalizeImportedBaseUrl = (
  rawBaseUrl: string,
  api: CustomApiKind,
): string => {
  // 去掉尾部斜杠：Kova 写入层也会剥，但预览里要展示最终生效的地址
  let url = rawBaseUrl.trim().replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    return url.replace(/\/v\d+(?=[/?#]|$)/i, "");
  }
  try {
    const parsed = new URL(url);
    if (!hasVersionSegment(parsed.pathname)) {
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/v1`;
      url = parsed.toString().replace(/\/$/, "");
    }
  } catch {
    // URL 解析不了（理论上 isUsableBaseUrl 已挡掉）：保持原样，交给写入层报错
  }
  return url;
};