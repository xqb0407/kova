/**
 * Provider/模型错误的分类（移植自 PI-Desktop agent-runtime）。
 *
 * pi-ai 把 provider 失败折叠成 `errorMessage` 字符串（常见形态 "<status>: <body>"），
 * SDK 错误对象的 HTTP status 又藏在各自形状不同的字段里，所以分类先探结构化字段、
 * 再退回消息关键字。流失败路径（stopReason "error"）与 promise reject 路径共用这里。
 */

export type ClassifiedAgentError = {
  code: string;
  message: string;
  retriable: boolean;
  /** 安全、低基数的诊断字段（日志与错误详情用） */
  details?: Record<string, unknown>;
};

/** 信封/落盘行保持小体积；provider body 可能非常长 */
const MAX_ERROR_MESSAGE_CHARS = 600;

const NETWORK_PATTERN =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR|fetch failed|socket hang up|network error|connection error|connection refused|dns/i;

const CONTEXT_PATTERN =
  /context[ _-]?length|maximum context|context window|too many tokens|prompt is too long|input token count|exceeds the (?:maximum|model)|token limit/i;

const STREAM_TERMINATION_PATTERN =
  /\bterminated\b|stream ended without finish_reason|premature(?:ly)?\s+(?:closed|ended)|(?:stream|response).*(?:closed|interrupted)/i;

function redactSensitiveErrorText(message: string): string {
  return message
    .replace(
      /(["']?authorization["']?\s*[:=]\s*["']?\s*bearer\s+)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|password)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/**
 * HTTP status 在各类 SDK 错误形状里的位置不一：先走 `status`/`statusCode`
 * 字段（沿 `cause` 链上溯），再探消息里的 "<status>:" / "(status)" /
 * "status code NNN" 标记。
 */
function extractStatus(err: unknown, message: string): number | undefined {
  let current: any = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current.statusCode === "number") return current.statusCode;
    if (typeof current.status === "number") return current.status;
    current = current.cause;
  }
  const patterns = [
    /^\s*(\d{3})\s*:/,
    /^\s*(\d{3})\b/,
    /\((\d{3})\)/,
    /status(?: code)?[ :]+(\d{3})\b/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      const status = Number(match[1]);
      if (status >= 400 && status < 600) return status;
    }
  }
  return undefined;
}

function hasNetworkCause(err: unknown, message: string): boolean {
  if (NETWORK_PATTERN.test(message)) return true;
  let current: any = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = typeof current.code === "string" ? current.code : "";
    const msg = current instanceof Error ? current.message : "";
    if (NETWORK_PATTERN.test(code) || NETWORK_PATTERN.test(msg)) return true;
    current = current.cause;
  }
  return false;
}

function extractErrorCode(err: unknown): string | number | undefined {
  let current: any = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current.code === "number") {
      return Number.isSafeInteger(current.code) ? current.code : undefined;
    }
    if (
      typeof current.code === "string" &&
      /^[A-Za-z0-9_.:-]{1,64}$/.test(current.code)
    ) {
      return current.code;
    }
    current = current.cause;
  }
  return undefined;
}

export function classifyAgentError(err: unknown): ClassifiedAgentError {
  const rawMessage =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : String(err);
  const safeMessage = redactSensitiveErrorText(rawMessage);
  const message =
    safeMessage.length > MAX_ERROR_MESSAGE_CHARS
      ? `${safeMessage.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
      : safeMessage;
  const status = extractStatus(err, rawMessage);
  const providerCode = extractErrorCode(err);
  const details = {
    ...(status !== undefined ? { providerStatus: status } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
  };
  const result = (code: string, retriable: boolean): ClassifiedAgentError => ({
    code,
    message,
    retriable,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  });

  // 中止优先于一切分类：用户 Stop 恰好落在压缩摘要中途时，
  // 该轮必须呈现为「已停止」而不是摘要失败。
  if (
    (err instanceof Error && err.name === "AbortError") ||
    /\babort/i.test(rawMessage)
  ) {
    return result("TURN_ABORTED", false);
  }
  if (/CONTEXT_COMPACTION_FAILED/i.test(rawMessage)) {
    return result("CONTEXT_COMPACTION_FAILED", false);
  }
  // 网络失败不带 HTTP status：先于 status 逻辑探一遍，
  // 免得 "fetch failed" 之类落到通用桶里。
  if (hasNetworkCause(err, rawMessage)) {
    return result("NETWORK_ERROR", true);
  }

  if (status !== undefined) {
    if (status === 401 || status === 403) return result("PROVIDER_UNAUTHORIZED", false);
    if (status === 408) return result("TIMEOUT", true);
    if (status === 413) return result("CONTEXT_TOO_LARGE", false);
    if (status === 429) return result("PROVIDER_RATE_LIMITED", true);
    if (status === 404) return result("MODEL_NOT_CONFIGURED", false);
    if (status >= 500) return result("PROVIDER_ERROR", true);
    if (status === 400 || status === 422) {
      if (CONTEXT_PATTERN.test(rawMessage)) return result("CONTEXT_TOO_LARGE", false);
      // 请求本身不合法（apiStyle 错、参数坏）——重试无用。
      return result("PROVIDER_ERROR", false);
    }
    return result("PROVIDER_ERROR", true);
  }

  if (/invalid[ _]api[ _]key|api key not valid|unauthorized|authentication|permission denied/i.test(rawMessage)) {
    return result("PROVIDER_UNAUTHORIZED", false);
  }
  if (/rate.?limit|too many requests|quota|overloaded/i.test(rawMessage)) {
    return result("PROVIDER_RATE_LIMITED", true);
  }
  if (CONTEXT_PATTERN.test(rawMessage)) {
    return result("CONTEXT_TOO_LARGE", false);
  }
  if (/model.{0,20}(not found|does not exist|unknown)|unknown model/i.test(rawMessage)) {
    return result("MODEL_NOT_CONFIGURED", false);
  }
  if (/timeout|timed out/i.test(rawMessage)) {
    return result("TIMEOUT", true);
  }
  if (STREAM_TERMINATION_PATTERN.test(rawMessage) || /stream/i.test(rawMessage)) {
    return result("STREAM_FAILED", true);
  }
  return result("PROVIDER_ERROR", true);
}
