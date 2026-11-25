/**
 * 连接器 HTTP 错误归一：把各平台五花八门的 401/403/429 折成主进程能据此
 * 决定「停止重试 / 按 Retry-After 等待 / 指数退避」的几类。
 */
import type { HttpJsonResponse } from "./types";

export type ConnectorErrorCode =
  | "auth"
  | "rate_limit"
  | "network"
  | "config"
  | "http";

export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export function header(
  res: HttpJsonResponse,
  name: string,
): string | undefined {
  return res.headers[name.toLowerCase()];
}

function parseRetryAfterMs(res: HttpJsonResponse): number | undefined {
  const raw = header(res, "retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** GitHub 用 x-ratelimit-reset（epoch 秒）；其它平台没有就交给退避。 */
function rateLimitResetMs(res: HttpJsonResponse): number | undefined {
  const raw = header(res, "x-ratelimit-reset");
  if (!raw) return undefined;
  const epoch = Number(raw);
  if (!Number.isFinite(epoch)) return undefined;
  return Math.max(0, epoch * 1000 - Date.now());
}

/** 错误详情最多带 240 字：够定位问题，又不会把整页 HTML 灌进 toast。 */
export function errorSnippet(text: string): string {
  const value = text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return "";
  return value.length > 240 ? `${value.slice(0, 240)}…` : value;
}

export function assertOk(
  res: HttpJsonResponse,
  options: {
    authHint?: string;
    configHint?: string;
    /** 详情接口专用：404/410 通常意味着条目被删除或无权访问，而不是地址填错 */
    notFoundHint?: string;
    label?: string;
  } = {},
): void {
  if (res.status >= 200 && res.status < 300) return;
  const label = options.label ? `${options.label}：` : "";
  if (res.status === 429) {
    throw new ConnectorError(
      "rate_limit",
      `${label}请求过于频繁，稍后会自动重试`,
      res.status,
      parseRetryAfterMs(res) ?? rateLimitResetMs(res),
    );
  }
  if (res.status === 401 || res.status === 403) {
    const remaining = header(res, "x-ratelimit-remaining");
    if (remaining === "0") {
      throw new ConnectorError(
        "rate_limit",
        `${label}API 配额已用完，稍后会自动重试`,
        res.status,
        parseRetryAfterMs(res) ?? rateLimitResetMs(res),
      );
    }
    throw new ConnectorError(
      "auth",
      `${label}${options.authHint ?? "Token 无效或权限不足"}`,
      res.status,
    );
  }
  if (res.status === 404 || res.status === 410) {
    throw new ConnectorError(
      "config",
      `${label}${
        options.notFoundHint ??
        options.configHint ??
        "接口不存在，请检查服务器地址"
      }`,
      res.status,
    );
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "http",
      `${label}服务端错误（HTTP ${res.status}），稍后会自动重试`,
      res.status,
    );
  }
  const detail = errorSnippet(res.text);
  throw new ConnectorError(
    "http",
    `${label}${options.configHint ?? "请求失败"}（HTTP ${res.status}）${detail ? `：${detail}` : ""}`,
    res.status,
  );
}

/** 网络层失败（DNS、代理、超时）统一成可重试错误。 */
export function asNetworkError(error: unknown, label: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ConnectorError(
    "network",
    `${label}：网络连接失败${message ? `（${errorSnippet(message)}）` : ""}，请检查网络代理设置`,
  );
}

/** 响应体解析；坏 JSON 归为配置/接口错误，不把原始 HTML 抛给用户。 */
export function parseJson<T>(res: HttpJsonResponse, label: string): T {
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new ConnectorError(
      "config",
      `${label}：接口返回的不是 JSON，请检查服务器地址或代理`,
      res.status,
    );
  }
}
