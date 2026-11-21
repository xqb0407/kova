/**
 * 单服务搜索执行：按配置里的 provider 发一次请求，单次超时兜底。
 * 失败（HTTP 非 2xx / 超时 / 空结果）直接返回明确错误，不做多服务兜底；
 * 调用方 abort（Stop/中止轮）原样抛出。
 *
 * 网络执行走 hostHttpCall → Electron 宿主（RPC 超时 = 请求超时 + 余量）。
 */
import type { SandboxPlan } from "pi-sandbox";
import {
  credentialGet,
  hostHttpCall,
  WEBSEARCH_CREDENTIAL_PREFIX,
  type HostSandboxInfo,
} from "../../storage/hostdb";
import {
  getWebSearchConfig,
  type WebSearchConfig,
  type WebSearchProvider,
} from "./config";
import {
  buildSearchRequest,
  parseSearchResponse,
  type WebSearchResult,
} from "./providers";

export type WebSearchRun =
  | {
      ok: true;
      provider: WebSearchProvider;
      results: WebSearchResult[];
      /** 宿主沙箱信息（命中沙箱时随 details 回给 UI/模型） */
      sandbox?: HostSandboxInfo;
    }
  | { ok: false; error: string };

export type RunWebSearchOptions = {
  cwd: string;
  signal?: AbortSignal;
  sandbox?: SandboxPlan;
  /** 设置页测试时用户刚输入、尚未保存的 key；不落库、不记录 */
  apiKeyOverride?: string;
  /** 设置页测试用的草稿配置（未保存的服务/超时）；缺省读生效配置 */
  config?: WebSearchConfig;
  /** 允许读加密凭据表里的已保存 key（默认 true）。设置页测试改了服务端点时
   *  传 false：防止「已保存 key + 任意端点」把密钥发给第三方。 */
  allowStoredKey?: boolean;
};

/** 该 provider 会不会用 key：预置按官方 API 一律查凭据表；
 *  custom 由 {{apiKey}} 占位符判断 */
function usesApiKey(provider: WebSearchProvider): boolean {
  if (provider.kind !== "custom") return true;
  // 与 substitute 的占位符正则保持一致：允许 {{ apiKey }} 这类带空格的写法
  const placeholder = /\{\{\s*apiKey\s*\}\}/;
  return (
    placeholder.test(provider.baseUrl) ||
    Object.values(provider.headers).some((value) =>
      placeholder.test(value),
    ) ||
    placeholder.test(provider.bodyTemplate)
  );
}

/** 该 provider 的 key：测试覆盖优先，否则读加密凭据表（命名空间 websearch:<id>） */
async function resolveApiKey(
  provider: WebSearchProvider,
  override: string | undefined,
  allowStoredKey: boolean,
): Promise<string | undefined> {
  if (override !== undefined && override.trim()) return override.trim();
  if (!allowStoredKey) return undefined;
  if (!usesApiKey(provider)) return undefined;
  try {
    const row = await credentialGet(WEBSEARCH_CREDENTIAL_PREFIX + provider.id);
    return row?.apiKey?.trim() || undefined;
  } catch {
    // 凭据表不可用时按未配置走：请求构造会给出明确的缺 key 错误
    return undefined;
  }
}

const isAbort = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

/** 宿主错误可能回带完整请求 URL；自定义 GET 把 key 放在 query 里时脱敏 */
function redactSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("***");
}

export async function runWebSearch(
  query: string,
  options: RunWebSearchOptions,
): Promise<WebSearchRun> {
  const config = options.config ?? getWebSearchConfig();
  const provider = config.provider;
  if (isAbort(options.signal)) throw new Error("web search aborted");
  let apiKey: string | undefined;
  try {
    apiKey = await resolveApiKey(
      provider,
      options.apiKeyOverride,
      options.allowStoredKey ?? true,
    );
    const request = buildSearchRequest(provider, query, {
      maxResults: config.maxResults,
      apiKey,
    });
    const data = await hostHttpCall(
      options.cwd,
      {
        url: request.url,
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        timeoutMs: config.requestTimeoutMs,
      },
      options.signal,
      options.sandbox,
    );
    if (isAbort(options.signal)) throw new Error("web search aborted");
    if (!data.ok) {
      return {
        ok: false,
        error: `${provider.id}: HTTP ${data.status}${data.statusText ? ` ${data.statusText}` : ""}`,
      };
    }
    const parsed = parseSearchResponse(provider, data);
    const results = (parsed?.results ?? []).slice(0, config.maxResults);
    if (results.length === 0) {
      return { ok: false, error: `${provider.id}: no search results` };
    }
    return {
      ok: true,
      provider,
      results,
      ...(data.sandbox ? { sandbox: data.sandbox } : {}),
    };
  } catch (error) {
    if (isAbort(options.signal)) throw error;
    return {
      ok: false,
      error: `${provider.id}: ${redactSecret(errorText(error), apiKey)}`,
    };
  }
}
