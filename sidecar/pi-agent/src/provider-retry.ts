/**
 * Provider 请求自动重试（移植自 PI-Desktop agent-runtime，pi-ai 同为 0.85.1）。
 *
 * 只消费「流建立前」的失败（未收到 start 事件的 error）：429/5xx/网络抖动/超时
 * 按退避重发同一请求；流已经开始后出错仍按现状上报（手动 Reload 兜底）。
 * SDK 内置重试（OpenAI/Anthropic 客户端默认 2 次）由本层以 maxRetries: 0 关闭，
 * 换成本控制器可记账、可发 UI 事件的显式重试。
 *
 * 相对参考项目的扩展：controller 增加 onSettled 钩子 + 会话级 claim/事件控制器
 * （makeUiRetryController），重试过程以 data-retry chunk 推给前端渲染倒计时卡片。
 */
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type FetchFunction,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  classifyAgentError,
  type ClassifiedAgentError,
} from "./agent-errors";
import { sendEventChunk } from "./stream";
import type { Running } from "./types";

/** 一个逻辑轮次内共享的重试预算上限（429 与瞬时错误各自一条）。 */
export const PROVIDER_RETRY_MAX_RETRIES = 10;

/**
 * 生效的重试预算上限。`PI_PROVIDER_RETRY_MAX` 环境变量可下调（0 = 完全关闭，
 * 恢复单次失败即报错的旧行为），供测试与用户兜底用；缺省 10。
 */
export function providerRetryMaxRetries(): number {
  const raw = Number(process.env.PI_PROVIDER_RETRY_MAX);
  if (!Number.isFinite(raw) || raw < 0) return PROVIDER_RETRY_MAX_RETRIES;
  return Math.min(PROVIDER_RETRY_MAX_RETRIES, Math.floor(raw));
}
export const PROVIDER_RATE_LIMIT_MAX_RETRIES = PROVIDER_RETRY_MAX_RETRIES;
export const PROVIDER_RATE_LIMIT_INITIAL_DELAY_MS = 2_000;
export const PROVIDER_RATE_LIMIT_JITTER_FACTOR = 0.25;
/** provider 给出离谱的 Retry-After 时也要给故障封顶，别把一轮挂死。 */
export const PROVIDER_RATE_LIMIT_MAX_DELAY_MS = 30_000;
/**
 * 非限流的瞬时失败按 1s、2s、4s、8s 等待；后续重试停在 8s 封顶，
 * 十次预算的总时长因此可预期。
 */
export const PROVIDER_SETUP_RETRY_INITIAL_DELAY_MS = 1_000;
export const PROVIDER_SETUP_MAX_RETRY_DELAY_MS = 8_000;
export const PROVIDER_TRANSIENT_MAX_RETRIES = PROVIDER_RETRY_MAX_RETRIES;

export type ProviderRetryPhase = "request" | "stream";

/**
 * 允许认领「非 429 瞬时预算」的错误码。集合之外的码即使 retriable 也保持终止，
 * 因为它们要靠别的恢复路径修，而不是重发同一请求。
 */
const TRANSIENT_RETRY_CODES = new Set([
  "NETWORK_ERROR",
  "TIMEOUT",
  "STREAM_FAILED",
  "PROVIDER_ERROR",
]);

/** 该错误码可否认领共享瞬时预算。 */
export function isTransientProviderRetryCode(code: string): boolean {
  return TRANSIENT_RETRY_CODES.has(code);
}

/**
 * 哪些响应的头里可能带可用的重试延迟。网关 5xx 与 408/409 常发 `Retry-After`，
 * 留住这些头，瞬时重试就能按服务端节奏等，而不是瞎猜退避。
 */
export function carriesRetryDelayHeaders(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 429 || status === 408 || status === 409 || status >= 500;
}

/** OpenAI 风格 SDK 客户端把读不出来的失败归纳成 "<status> status code (no body)"。 */
const OPAQUE_ERROR_BODY_PATTERN = /\(\s*no\s+body\s*\)\s*$/i;

/**
 * 流建立前的 400/422 且 body 为空，调用方拿不到任何可行动信息。分类器把这类
 * status 判为终止，正因为重发同一请求没用——但请求本身是按目录推导值拼出来的
 * （尤其自动填充的 output limit），OpenAI 兼容网关完全可能一言不发地拒掉。
 * 识别出这个不透明形状，重试环就能做一次有依据的修补，而不是抛
 * "400 status code (no body)" 这种死路。
 */
export function isOpaqueBadRequest(error: ClassifiedAgentError): boolean {
  const providerStatus = error.details?.providerStatus;
  return (
    error.code === "PROVIDER_ERROR" &&
    !error.retriable &&
    (providerStatus === 400 || providerStatus === 422) &&
    OPAQUE_ERROR_BODY_PATTERN.test(error.message)
  );
}

const OUTPUT_LIMIT_FIELDS = [
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
] as const;

/** 去掉自动推导的 output-limit 字段，让 provider 用自家默认值。 */
export function stripOutputLimitFields(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const rest = { ...(payload as Record<string, unknown>) };
  for (const field of OUTPUT_LIMIT_FIELDS) delete rest[field];
  return rest;
}

/**
 * 那次修补请求的选项：出发的 payload 保留调用方与目录推导的全部字段、只去掉
 * output limit；调用方的 `onPayload` 钩子照常执行（以其结果为基础做剥离）。
 */
export function withoutDerivedOutputLimit(
  options: SimpleStreamOptions,
): SimpleStreamOptions {
  return {
    ...options,
    onPayload: async (payload, model) => {
      const rewritten = await options.onPayload?.(payload, model);
      return stripOutputLimitFields(rewritten ?? payload);
    },
  };
}

export type ProviderResponseSnapshot = {
  status: number;
  headers: Record<string, string>;
};

/** 每次 provider 调用开始时清掉的上一次响应捕获位。 */
export type ProviderRetryCapture = {
  status?: number;
  headers?: Readonly<Record<string, string>>;
};

export type ProviderRetryController = {
  /** 从逻辑轮共享预算里认领一次重试；返回第几次尝试，undefined = 不重试 */
  claim: (
    error: ClassifiedAgentError,
    phase: ProviderRetryPhase,
  ) => number | undefined;
  /** 失败响应上捕获到的头（若有）。 */
  headers: () => Readonly<Record<string, string>> | undefined;
  /** provider body 不带 HTTP code 时也要能捕获到 status。 */
  status?: () => number | undefined;
  /** 决定重试、开始退避之前。 */
  onRetry?: (input: {
    error: ClassifiedAgentError;
    phase: ProviderRetryPhase;
    attempt: number;
    delayMs: number;
  }) => void;
  /**
   * 本轮重试周期结束：新请求成功建立流（start）、终态错误被转发、或等待被中止。
   * 每次重试周期恰好触发一次（本项目扩展，用于收起前端重试卡片）。
   */
  onSettled?: () => void;
  /** 测试钩子；生产走下面的可中止定时器。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * 在依赖 provider 错误措辞之前，先按捕获到的 HTTP 429 定性。有些 adapter
 * 明明响应是限流，却返回笼统 body（或 `fetch failed`）。认证、上下文这类
 * 明确不可重试的分类保持终止。
 */
export function classifyProviderError(
  error: unknown,
  providerStatus?: number,
): ClassifiedAgentError {
  const classified = classifyAgentError(error);
  if (
    providerStatus === 429 &&
    classified.code !== "PROVIDER_RATE_LIMITED" &&
    classified.retriable
  ) {
    return {
      ...classified,
      code: "PROVIDER_RATE_LIMITED",
      retriable: true,
      details: {
        ...classified.details,
        providerStatus,
      },
    };
  }
  return classified;
}

function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  );
  return entry?.[1];
}

function boundedServerDelay(
  value: number,
  maxDelayMs = PROVIDER_RATE_LIMIT_MAX_DELAY_MS,
): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maxDelayMs, Math.max(0, Math.ceil(value)));
}

/**
 * 按 OpenCode 的优先序读服务端要求的延迟：provider 毫秒头 → `Retry-After`
 * 秒数 → `Retry-After` HTTP-date。没有可用头时返回 undefined。
 */
function serverRetryDelayMs(
  headers: Readonly<Record<string, string>> | undefined,
  maxDelayMs: number,
  now: number,
): number | undefined {
  const retryAfterMs = headerValue(headers, "retry-after-ms");
  if (retryAfterMs !== undefined && retryAfterMs.trim() !== "") {
    const parsed = Number.parseFloat(retryAfterMs);
    if (!Number.isNaN(parsed)) return boundedServerDelay(parsed, maxDelayMs);
  }

  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter !== undefined && retryAfter.trim() !== "") {
    const seconds = Number.parseFloat(retryAfter);
    if (!Number.isNaN(seconds)) {
      return boundedServerDelay(seconds * 1_000, maxDelayMs);
    }
    const dateMs = Date.parse(retryAfter) - now;
    if (!Number.isNaN(dateMs)) {
      return boundedServerDelay(dateMs, maxDelayMs);
    }
  }
  return undefined;
}

/**
 * OpenCode 的优先序：provider 毫秒 → Retry-After 秒 → HTTP-date → 带正向抖动的
 * 指数退避。头值会被封顶，坏掉或服务端过期的响应头不能把一轮挂死。
 */
export function providerRateLimitDelayMs(
  attempt: number,
  headers?: Readonly<Record<string, string>>,
  now = Date.now(),
  random = Math.random(),
): number {
  const serverDelay = serverRetryDelayMs(
    headers,
    PROVIDER_RATE_LIMIT_MAX_DELAY_MS,
    now,
  );
  if (serverDelay !== undefined) return serverDelay;

  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = PROVIDER_RATE_LIMIT_INITIAL_DELAY_MS * 2 ** (safeAttempt - 1);
  const jitter = Math.min(1, Math.max(0, random));
  return Math.min(
    PROVIDER_RATE_LIMIT_MAX_DELAY_MS,
    Math.ceil(base + base * PROVIDER_RATE_LIMIT_JITTER_FACTOR * jitter),
  );
}

/**
 * 纯翻倍：每次尝试 1s、2s、4s、8s。自报 `Retry-After` 的网关直接说了算，
 * 上游 502/503 抖动按服务端要求等（封顶防挂死）就能清掉。
 *
 * `random` 只为与限流延迟保持签名兼容而保留，故意不使用：单条失败请求用可预测
 * 的节奏更好推理，这类重试也不像限流那样跨会话齐发。
 */
export function providerSetupRetryDelayMs(
  attempt: number,
  random?: number,
  headers?: Readonly<Record<string, string>>,
  now = Date.now(),
): number {
  void random;
  const serverDelay = serverRetryDelayMs(
    headers,
    PROVIDER_SETUP_MAX_RETRY_DELAY_MS,
    now,
  );
  // 服务端自报的延迟无条件生效，哪怕短于调用方下限：网关知道自己何时恢复。
  if (serverDelay !== undefined) return serverDelay;
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = PROVIDER_SETUP_RETRY_INITIAL_DELAY_MS * 2 ** (safeAttempt - 1);
  return Math.min(PROVIDER_SETUP_MAX_RETRY_DELAY_MS, base);
}

function requestAbortedError(): Error {
  return Object.assign(new Error("Request aborted"), { name: "AbortError" });
}

export function delayWithAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(requestAbortedError());
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 捕获 HTTP status/headers，包括失败 429 的响应（pi-ai 的 onResponse 回调
 * 故意不暴露这些）。
 */
export function captureProviderResponse(
  fetchFn: FetchFunction | undefined,
  onResponse: (response?: ProviderResponseSnapshot) => void,
): FetchFunction {
  const baseFetch = fetchFn ?? globalThis.fetch;
  // Bun 的 typeof fetch 带 preconnect 等平台扩展成员，包装函数只实现调用形状
  const wrapped = async (
    input: Parameters<FetchFunction>[0],
    init?: Parameters<FetchFunction>[1],
  ) => {
    // 新请求开始前先清掉上一次的响应。若本次在收到头之前就失败，
    // 不能被上一条 429 带偏分类。
    onResponse();
    const response = await baseFetch(input as never, init as never);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    onResponse({ status: response.status, headers });
    return response;
  };
  return wrapped as unknown as FetchFunction;
}

function normalizeRateLimitMessage(message: AssistantMessage): AssistantMessage {
  const errorMessage = message.errorMessage ?? "";
  if (/^\s*429\b/.test(errorMessage)) return message;
  return {
    ...message,
    errorMessage: `429: ${errorMessage || "provider rate limited"}`,
  };
}

function setupErrorMessage(
  model: Model<Api>,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

type StreamFactory = (
  options: SimpleStreamOptions,
) => AssistantMessageEventStream;

/* ------------------------------ 预算与认领 ------------------------------ */

/** 一个逻辑轮次的重试记账（429 与瞬时各自封顶 PROVIDER_RETRY_MAX_RETRIES）。 */
export type RetryBudget = { rateLimit: number; transient: number };

export function createRetryBudget(): RetryBudget {
  return { rateLimit: 0, transient: 0 };
}

/**
 * 从预算里认领一次重试（移植自 PI-Desktop 的 claimProviderRetry）。
 * 流建立前的失败与（若接管的）流中断共用同一套预算。
 */
export function claimRetry(
  budget: RetryBudget,
  error: ClassifiedAgentError,
): number | undefined {
  const max = providerRetryMaxRetries();
  if (max <= 0) return undefined;
  if (!error.retriable) return undefined;
  if (error.code === "PROVIDER_RATE_LIMITED") {
    if (budget.rateLimit >= max) return undefined;
    return ++budget.rateLimit;
  }
  if (!isTransientProviderRetryCode(error.code)) return undefined;
  if (budget.transient >= max) return undefined;
  return ++budget.transient;
}

/**
 * 主代理的控制器：认领 run 上的预算，并把重试过程以 data-retry chunk 发到当前
 * 请求的消息流（同一 part id 原地更新，参照 data-compaction 生命周期）。
 * Stop 之后（stopRequested）不再打扰用户；卡片以 phase resolved 收起。
 */
export function makeUiRetryController(run: Running): ProviderRetryController {
  const settle = () => {
    if (!run.providerRetryActive) return;
    run.providerRetryActive = false;
    sendEventChunk({
      type: "data-retry",
      id: run.providerRetryChunkId,
      data: { phase: "resolved" },
    });
  };
  return {
    claim: (error) => claimRetry(run.providerRetry, error),
    headers: () => run.retryCapture.headers,
    status: () => run.retryCapture.status,
    onRetry: ({ error, attempt, delayMs }) => {
      run.providerRetryActive = true;
      if (run.stopRequested) return;
      sendEventChunk({
        type: "data-retry",
        id: run.providerRetryChunkId,
        data: {
          phase: "retrying",
          attempt,
          maxRetries: providerRetryMaxRetries(),
          delayMs,
          code: error.code,
          error: error.message,
        },
      });
    },
    onSettled: settle,
  };
}

/* ------------------------------- 重试流包装 ------------------------------- */

/**
 * pi-ai 把建立期失败作为 error 事件返回而非抛出。这层适配只消费那些流建立前的
 * 失败，经共享控制器重试，其余事件原样转发——流已开始后的失败交给现状路径上报。
 */
export function createProviderRetryStream(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  createStream: StreamFactory,
  controller: ProviderRetryController,
): AssistantMessageEventStream {
  // context 留在签名里：防止调用方把重试流错包到与 provider 调用不同的请求上。
  void context;
  const outer = createAssistantMessageEventStream();
  const sleep = controller.sleep ?? delayWithAbort;

  void (async () => {
    // 一个逻辑轮只修补一次：不透明的 400/422 之后，下一次尝试剥掉推导的
    // output limit。修补不消耗共享瞬时预算，第二次不透明失败原样上浮。
    let limitRepairTried = false;
    for (;;) {
      if (options.signal?.aborted) throw requestAbortedError();
      const inner = createStream({
        ...(limitRepairTried ? withoutDerivedOutputLimit(options) : options),
        maxRetries: 0,
      });
      let sawStart = false;
      let retry:
        | { error: ClassifiedAgentError; attempt: number }
        | undefined;
      let opaqueLimitRejection: ClassifiedAgentError | undefined;

      for await (const event of inner) {
        if (event.type === "start") {
          sawStart = true;
          // 新请求真的开始出流了：收起可能挂着倒计时的重试卡片
          controller.onSettled?.();
        }
        if (
          !sawStart &&
          event.type === "error" &&
          event.reason === "error"
        ) {
          const errorMessage =
            typeof event.error.errorMessage === "string"
              ? event.error.errorMessage
              : event.error;
          const error = classifyProviderError(
            errorMessage,
            controller.status?.(),
          );
          if (!limitRepairTried && isOpaqueBadRequest(error)) {
            opaqueLimitRejection = error;
            break;
          }
          const attempt = controller.claim(error, "request");
          if (attempt !== undefined) {
            retry = { error, attempt };
            break;
          }
        }
        const forwardedEvent =
          event.type === "error" &&
          event.reason === "error" &&
          controller.status?.() === 429
            ? { ...event, error: normalizeRateLimitMessage(event.error) }
            : event;
        if (event.type === "error") controller.onSettled?.();
        outer.push(forwardedEvent);
      }

      if (opaqueLimitRejection) {
        // 排空已结束的流，避免带延迟清理的 provider 与修补请求重叠，
        // 与下面的重试路径同理。
        await inner.result();
        if (options.signal?.aborted) throw requestAbortedError();
        limitRepairTried = true;
        continue;
      }

      if (!retry) {
        const result = await inner.result();
        const finalResult =
          result.stopReason === "error" && controller.status?.() === 429
            ? normalizeRateLimitMessage(result)
            : result;
        outer.end(finalResult);
        return;
      }

      // 失败事件已经结束了这个内层流。await 它的 result，让带延迟清理的
      // provider 不与重试重叠。
      await inner.result();
      const delayMs =
        retry.error.code === "PROVIDER_RATE_LIMITED"
          ? providerRateLimitDelayMs(
              retry.attempt,
              controller.headers(),
            )
          : providerSetupRetryDelayMs(
              retry.attempt,
              undefined,
              controller.headers(),
            );
      controller.onRetry?.({
        error: retry.error,
        phase: "request",
        attempt: retry.attempt,
        delayMs,
      });
      try {
        await sleep(delayMs, options.signal);
      } catch (err) {
        // 退避等待被 Stop 打断：卡片不能再留着倒计时（外层 catch 里也有
        // onSettled 兜底，这里先行结算，保证顺序在 abort 错误事件之前）
        controller.onSettled?.();
        throw err;
      }
    }
  })().catch((error) => {
    const aborted =
      options.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError");
    const message = setupErrorMessage(model, error, Boolean(aborted));
    controller.onSettled?.();
    outer.push({
      type: "error",
      reason: message.stopReason === "aborted" ? "aborted" : "error",
      error: message,
    });
    outer.end(message);
  });

  return outer;
}
