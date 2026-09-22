/**
 * Provider/模型错误的分类（移植自 PI-Desktop agent-runtime）。
 *
 * pi-ai 把 provider 失败折叠成 `errorMessage` 字符串（常见形态 "<status>: <body>"），
 * SDK 错误对象的 HTTP status 又藏在各自形状不同的字段里，所以分类先探结构化字段、
 * 再退回消息关键字。流失败路径（stopReason "error"）与 promise reject 路径共用这里。
 *
 * 设计文档 §8：分类上线到线协议——`source` 归因维度 + `toWireError` 换算线形，
 * 两个错误出口（handleLine catch / prompt 流 error chunk）随帧带结构化字段，
 * 前端据此渲染 retryable 重试按钮。
 */
import type { ErrorPayload, ErrorSource } from "pi-protocol";

export type ClassifiedAgentError = {
  code: string;
  message: string;
  retriable: boolean;
  /** 错误来源归因（§8）：provider=上游响应、network=连接层、
   *  tool=工具执行（分类器暂不产出，留给出口侧显式构造）、runtime=本地代码/配置 */
  source: ErrorSource;
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

/**
 * 兜底桶（无 status、无网络/关键字命中的裸字符串）的归因：provider 流路径
 * 保持旧语义（含糊串多半是供应商怪话 → PROVIDER_ERROR 可重试）；管理命令/
 * 会话准备路径传 "runtime"——那里的含糊串是本地代码抛的错，重试无用。
 */
export type OpaqueFallback = "provider" | "runtime";

export function classifyAgentError(
  err: unknown,
  opts?: { opaqueFallback?: OpaqueFallback },
): ClassifiedAgentError {
  const opaqueFallback = opts?.opaqueFallback ?? "provider";
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
  const result = (
    code: string,
    retriable: boolean,
    source: ErrorSource = "provider",
  ): ClassifiedAgentError => ({
    code,
    message,
    retriable,
    source,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  });

  // 中止优先于一切分类：用户 Stop 恰好落在压缩摘要中途时，
  // 该轮必须呈现为「已停止」而不是摘要失败。
  if (
    (err instanceof Error && err.name === "AbortError") ||
    /\babort/i.test(rawMessage)
  ) {
    return result("TURN_ABORTED", false, "runtime");
  }
  if (/CONTEXT_COMPACTION_FAILED/i.test(rawMessage)) {
    return result("CONTEXT_COMPACTION_FAILED", false, "runtime");
  }
  // 引擎级内部错误（JS 原生异常类型 = 本地代码 bug，不是供应商话术）：
  // 不带 HTTP status、不带网络签名，落进 provider 兜底会误报可重试。
  if (
    err instanceof Error &&
    /^(TypeError|SyntaxError|ReferenceError|RangeError|EvalError)$/.test(err.name)
  ) {
    return result("RUNTIME_ERROR", false, "runtime");
  }
  // 网络失败不带 HTTP status：先于 status 逻辑探一遍，
  // 免得 "fetch failed" 之类落到通用桶里。
  if (hasNetworkCause(err, rawMessage)) {
    return result("NETWORK_ERROR", true, "network");
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
  // 兜底桶：含糊串按出口路径归因（见 OpaqueFallback 注释）
  if (opaqueFallback === "runtime") {
    return result("RUNTIME_ERROR", false, "runtime");
  }
  return result("PROVIDER_ERROR", true);
}

/**
 * 分类结果 → 线协议 `error` 载荷（§8）。statusCode 只在分类器确实捕获到
 * 合法 HTTP status（100–599 整数）时携带——details.providerStatus 可能来自
 * 消息文本提取，形状不受控，宁缺毋滥。
 */
export function toWireError(c: ClassifiedAgentError): ErrorPayload {
  const providerStatus = c.details?.providerStatus;
  const statusCode =
    typeof providerStatus === "number" &&
    Number.isInteger(providerStatus) &&
    providerStatus >= 100 &&
    providerStatus <= 599
      ? providerStatus
      : undefined;
  return {
    code: c.code,
    source: c.source,
    retryable: c.retriable,
    ...(statusCode !== undefined ? { statusCode } : {}),
  };
}
