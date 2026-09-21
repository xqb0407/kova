import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  captureProviderResponse,
  carriesRetryDelayHeaders,
  claimRetry,
  classifyProviderError,
  createProviderRetryStream,
  createRetryBudget,
  delayWithAbort,
  isOpaqueBadRequest,
  isTransientProviderRetryCode,
  makeUiRetryController,
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  PROVIDER_TRANSIENT_MAX_RETRIES,
  providerRateLimitDelayMs,
  providerSetupRetryDelayMs,
  stripOutputLimitFields,
  withoutDerivedOutputLimit,
} from "./provider-retry";
import { setActiveReqId } from "../protocol/stream";
import type { Running } from "../types";

const model = {
  id: "model",
  api: "openai-completions",
  provider: "provider",
  name: "Model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_000,
  baseUrl: "https://provider.invalid/v1",
} as any;

const context = { messages: [], tools: [] };

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "provider",
    model: "model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "429: too many requests",
    timestamp: Date.now(),
    ...overrides,
  };
}

function failedStream(
  overrides: Partial<AssistantMessage> = {},
): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const error = assistantMessage(overrides);
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error });
    stream.end(error);
  });
  return stream;
}

function successfulStream(): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage({
    content: [{ type: "text", text: "recovered" }],
    stopReason: "stop",
    errorMessage: undefined,
  });
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

describe("provider rate-limit retry", () => {
  it("uses a captured 429 status when the provider body is generic", () => {
    expect(classifyProviderError("upstream unavailable", 429)).toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      retriable: true,
      details: { providerStatus: 429 },
    });
    expect(classifyProviderError("authentication failed", 429)).toMatchObject({
      code: "PROVIDER_UNAUTHORIZED",
      retriable: false,
    });
  });

  it("prefers retry headers and bounds exponential fallback", () => {
    expect(providerRateLimitDelayMs(1, { "retry-after-ms": "1250" }, 0, 0)).toBe(1250);
    expect(providerRateLimitDelayMs(1, { "retry-after": "2" }, 0, 0)).toBe(2000);
    expect(
      providerRateLimitDelayMs(
        1,
        { "retry-after": new Date(5_000).toUTCString() },
        0,
        0,
      ),
    ).toBe(5000);
    expect(
      providerRateLimitDelayMs(
        1,
        { "retry-after": new Date(-5_000).toUTCString() },
        0,
        0,
      ),
    ).toBe(0);
    expect(providerRateLimitDelayMs(1, undefined, 0, 0)).toBe(2000);
    expect(providerRateLimitDelayMs(1, undefined, 0, 1)).toBe(2500);
    expect(providerRateLimitDelayMs(20, { "retry-after": "120" }, 0, 0)).toBe(30_000);
  });

  it("silently retries pre-stream 429s and forwards only the successful stream", async () => {
    let attempts = 0;
    const claims: Array<{ phase: string; attempt: number }> = [];
    const sleeps: Array<{ ms: number; signal: AbortSignal | undefined }> = [];
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return attempts < 3 ? failedStream() : successfulStream();
      },
      {
        claim: (_error, phase) => {
          const attempt = attempts;
          claims.push({ phase, attempt });
          return attempt <= 2 ? attempt : undefined;
        },
        headers: () => ({ "retry-after-ms": "1" }),
        sleep: async (ms, signal) => {
          sleeps.push({ ms, signal });
        },
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(attempts).toBe(3);
    expect(claims).toEqual([
      { phase: "request", attempt: 1 },
      { phase: "request", attempt: 2 },
    ]);
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toEqual({ ms: 1, signal: undefined });
    expect(sleeps[1]).toEqual({ ms: 1, signal: undefined });
    expect(events).toEqual(["start", "done"]);
  });

  it("uses the captured HTTP status when the error body omits rate-limit text", async () => {
    let attempts = 0;
    const claimedCodes: string[] = [];
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        if (attempts === 1) {
          const result = createAssistantMessageEventStream();
          const error = assistantMessage({ errorMessage: "upstream unavailable" });
          queueMicrotask(() => {
            result.push({ type: "error", reason: "error", error });
            result.end(error);
          });
          return result;
        }
        return successfulStream();
      },
      {
        claim: (error) => {
          claimedCodes.push(error.code);
          return 1;
        },
        headers: () => undefined,
        status: () => 429,
        sleep: async () => undefined,
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(attempts).toBe(2);
    expect(claimedCodes).toEqual(["PROVIDER_RATE_LIMITED"]);
    expect(events).toEqual(["start", "done"]);
  });

  it("does not promote known non-retryable errors just because status is 429", async () => {
    const claims: Array<{ code: string; retriable: boolean; phase: string }> = [];
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        const result = createAssistantMessageEventStream();
        const error = assistantMessage({ errorMessage: "authentication failed" });
        queueMicrotask(() => {
          result.push({ type: "error", reason: "error", error });
          result.end(error);
        });
        return result;
      },
      {
        claim: (error, phase) => {
          claims.push({ code: error.code, retriable: error.retriable, phase });
          return undefined;
        },
        headers: () => undefined,
        status: () => 429,
        sleep: async () => undefined,
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(claims.length).toBe(1);
    expect(claims[0]).toMatchObject({
      code: "PROVIDER_UNAUTHORIZED",
      retriable: false,
      phase: "request",
    });
    expect(events).toEqual(["error"]);
  });

  it("clears a captured 429 before a fetch fails without a response", async () => {
    let calls = 0;
    let snapshot: { status: number; headers: Record<string, string> } | undefined;
    const wrapped = captureProviderResponse(
      (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("rate limited", { status: 429 });
        }
        throw new Error("fetch failed");
      }) as unknown as Parameters<typeof captureProviderResponse>[0],
      (response) => {
        snapshot = response;
      },
    );

    await wrapped("https://provider.invalid", {});
    expect(snapshot?.status).toBe(429);
    await expect(wrapped("https://provider.invalid", {})).rejects.toThrow("fetch failed");
    expect(snapshot).toBeUndefined();
  });

  it("rejects an abortable retry delay without waiting for the timer", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = delayWithAbort(30_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // 真等 30s 才会到这里；毫秒级返回证明中止清掉了定时器
    expect(Date.now() - started).toBeLessThan(2_000);

    // 已中止的 signal 立即拒绝
    await expect(delayWithAbort(30_000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("keeps an exhausted setup 429 classified when its body omits status text", async () => {
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        const result = createAssistantMessageEventStream();
        const error = assistantMessage({ errorMessage: "upstream unavailable" });
        queueMicrotask(() => {
          result.push({ type: "error", reason: "error", error });
          result.end(error);
        });
        return result;
      },
      {
        claim: () => undefined,
        headers: () => undefined,
        status: () => 429,
        sleep: async () => undefined,
      },
    );

    const events: Array<{ type: string; error?: AssistantMessage }> = [];
    for await (const event of stream) events.push(event as typeof events[number]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { errorMessage: "429: upstream unavailable" },
    });
  });

  it("does not hide a 429 after a stream has started", async () => {
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        const result = createAssistantMessageEventStream();
        const partial = assistantMessage({ stopReason: "pending" });
        const error = assistantMessage();
        queueMicrotask(() => {
          result.push({ type: "start", partial });
          result.push({ type: "error", reason: "error", error });
          result.end(error);
        });
        return result;
      },
      {
        claim: () => 1,
        headers: () => undefined,
        sleep: async () => undefined,
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(events).toEqual(["start", "error"]);
  });
});

describe("bounded transient provider retry", () => {
  it("admits only the transport/gateway codes into the shared budget", () => {
    for (const code of [
      "NETWORK_ERROR",
      "TIMEOUT",
      "STREAM_FAILED",
      "PROVIDER_ERROR",
    ]) {
      expect(isTransientProviderRetryCode(code)).toBe(true);
    }
    for (const code of [
      "PROVIDER_RATE_LIMITED",
      "PROVIDER_UNAUTHORIZED",
      "CONTEXT_TOO_LARGE",
      "MODEL_NOT_CONFIGURED",
      "EMPTY_MODEL_RESPONSE",
      "TURN_ABORTED",
    ]) {
      expect(isTransientProviderRetryCode(code)).toBe(false);
    }
  });

  it("classifies an upstream gateway 502 as a retryable provider error", () => {
    const classified = classifyProviderError(
      'OpenAI API error (502): {"type":"api_error","message":"Upstream API request failed."}',
    );
    expect(classified).toMatchObject({
      code: "PROVIDER_ERROR",
      retriable: true,
      details: { providerStatus: 502 },
    });
    expect(isTransientProviderRetryCode(classified.code)).toBe(true);
  });

  it("keeps retry headers for every status that can state a delay", () => {
    expect(carriesRetryDelayHeaders(429)).toBe(true);
    expect(carriesRetryDelayHeaders(408)).toBe(true);
    expect(carriesRetryDelayHeaders(409)).toBe(true);
    expect(carriesRetryDelayHeaders(502)).toBe(true);
    expect(carriesRetryDelayHeaders(503)).toBe(true);
    expect(carriesRetryDelayHeaders(400)).toBe(false);
    expect(carriesRetryDelayHeaders(401)).toBe(false);
    expect(carriesRetryDelayHeaders(undefined)).toBe(false);
  });

  it("allows ten transient retries and caps the later waits at 8s", () => {
    expect(PROVIDER_RATE_LIMIT_MAX_RETRIES).toBe(10);
    expect(PROVIDER_TRANSIENT_MAX_RETRIES).toBe(10);
    expect(providerSetupRetryDelayMs(1)).toBe(1_000);
    expect(providerSetupRetryDelayMs(2)).toBe(2_000);
    expect(providerSetupRetryDelayMs(3)).toBe(4_000);
    expect(providerSetupRetryDelayMs(4)).toBe(8_000);
    // 计划表是确定性的：未使用的 random 参数不能平移它
    expect(providerSetupRetryDelayMs(2, 0)).toBe(2_000);
    expect(providerSetupRetryDelayMs(2, 1)).toBe(2_000);
    // 预算之外封顶保持
    expect(providerSetupRetryDelayMs(20)).toBe(8_000);
  });

  it("prefers a gateway Retry-After over the fixed backoff schedule", () => {
    expect(providerSetupRetryDelayMs(1, 0, { "retry-after-ms": "1250" })).toBe(1250);
    expect(providerSetupRetryDelayMs(1, 0, { "retry-after": "2" })).toBe(2_000);
    expect(
      providerSetupRetryDelayMs(1, 0, { "retry-after": new Date(5_000).toUTCString() }, 0),
    ).toBe(5_000);
    // 恶意或陈旧的响应头不能把一轮挂过非 429 的封顶
    expect(providerSetupRetryDelayMs(1, 0, { "retry-after": "600" })).toBe(8_000);
  });

  it("lets a server ask for a shorter wait than the schedule", () => {
    // 自称更快恢复的网关会被直接采信；坏值仍超不过封顶
    expect(providerSetupRetryDelayMs(1, 0, { "retry-after-ms": "100" })).toBe(100);
    expect(providerSetupRetryDelayMs(4, 0, { "retry-after-ms": "250" })).toBe(250);
    expect(providerSetupRetryDelayMs(1, 0, { "retry-after": "600" })).toBe(8_000);
  });

  it("retries repeated pre-stream 502s until the shared budget is spent", async () => {
    let attempts = 0;
    const claims: Array<{ code: string; attempt: number }> = [];
    const delays: number[] = [];
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return attempts <= PROVIDER_TRANSIENT_MAX_RETRIES
          ? failedStream({
              errorMessage:
                'OpenAI API error (502): {"type":"api_error","message":"Upstream API request failed."}',
            })
          : successfulStream();
      },
      {
        claim: (error) => {
          if (!isTransientProviderRetryCode(error.code)) return undefined;
          if (claims.length >= PROVIDER_TRANSIENT_MAX_RETRIES) return undefined;
          const attempt = claims.length + 1;
          claims.push({ code: error.code, attempt });
          return attempt;
        },
        headers: () => undefined,
        status: () => 502,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    // 十次重试加初次尝试，共十一次 provider 请求
    expect(attempts).toBe(PROVIDER_TRANSIENT_MAX_RETRIES + 1);
    expect(claims.map((claim) => claim.attempt)).toEqual(
      Array.from({ length: PROVIDER_TRANSIENT_MAX_RETRIES }, (_, index) => index + 1),
    );
    expect(claims.every((claim) => claim.code === "PROVIDER_ERROR")).toBe(true);
    expect(delays).toEqual([
      1_000,
      2_000,
      4_000,
      ...Array.from({ length: PROVIDER_TRANSIENT_MAX_RETRIES - 3 }, () => 8_000),
    ]);
    // 中间的失败不向消费者发 error 事件
    expect(events).toEqual(["start", "done"]);
    expect((await stream.result()).stopReason).toBe("stop");
  });

  it("surfaces the 502 once the budget refuses a further attempt", async () => {
    let attempts = 0;
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return failedStream({
          errorMessage:
            'OpenAI API error (502): {"type":"api_error","message":"Upstream API request failed."}',
        });
      },
      {
        claim: () =>
          attempts <= PROVIDER_TRANSIENT_MAX_RETRIES ? attempts : undefined,
        headers: () => undefined,
        status: () => 502,
        sleep: async () => undefined,
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(attempts).toBe(PROVIDER_TRANSIENT_MAX_RETRIES + 1);
    expect(events).toEqual(["error"]);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("502");
  });
});

describe("opaque bad-request repair", () => {
  it("detects terminal 400/422s whose body was empty", () => {
    expect(
      isOpaqueBadRequest(classifyProviderError("400 status code (no body)", 400)),
    ).toBe(true);
    expect(
      isOpaqueBadRequest(classifyProviderError("422 status code (no body)", 422)),
    ).toBe(true);
    // 捕获错过响应时，消息里带的 status 仍然生效
    expect(isOpaqueBadRequest(classifyProviderError("400 status code (no body)"))).toBe(
      true,
    );
    // 有描述 body 的与其他 status 一律不动
    expect(
      isOpaqueBadRequest(
        classifyProviderError('400: {"error":{"message":"nope"}}', 400),
      ),
    ).toBe(false);
    expect(
      isOpaqueBadRequest(classifyProviderError("403 status code (no body)", 403)),
    ).toBe(false);
    expect(
      isOpaqueBadRequest(classifyProviderError("upstream unavailable", 429)),
    ).toBe(false);
  });

  it("repairs a pre-stream 400 with no body by dropping the derived output limit", async () => {
    let attempts = 0;
    let repairOptions: { onPayload?: (payload: unknown) => Promise<unknown> } | undefined;
    let claimCalls = 0;
    let sleepCalls = 0;
    const stream = createProviderRetryStream(
      model,
      context,
      {
        onPayload: async (payload: unknown) => ({
          ...(payload as Record<string, unknown>),
          marked: true,
        }),
      } as any,
      (options) => {
        attempts += 1;
        if (attempts === 1) {
          return failedStream({ errorMessage: "400 status code (no body)" });
        }
        repairOptions = options as typeof repairOptions;
        return successfulStream();
      },
      {
        claim: () => {
          claimCalls += 1;
          return undefined;
        },
        headers: () => undefined,
        status: () => 400,
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(attempts).toBe(2);
    expect(events).toEqual(["start", "done"]);
    expect((await stream.result()).stopReason).toBe("stop");
    // 修补既不占重试预算，也不需要等待
    expect(claimCalls).toBe(0);
    expect(sleepCalls).toBe(0);
    // 修补包裹调用方的钩子：其改写保留，limit 被剥掉
    const repaired = await repairOptions?.onPayload?.({
      model: "glm-5.3-flash",
      max_tokens: 4096,
      max_completion_tokens: 1_044_472,
      max_output_tokens: 1_044_472,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(repaired).toEqual({
      marked: true,
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("does not start the repair after the request is aborted", async () => {
    const abortController = new AbortController();
    let attempts = 0;
    const stream = createProviderRetryStream(
      model,
      context,
      { signal: abortController.signal },
      () => {
        attempts += 1;
        const result = createAssistantMessageEventStream();
        const error = assistantMessage({ errorMessage: "400 status code (no body)" });
        queueMicrotask(() => {
          result.push({ type: "error", reason: "error", error });
          abortController.abort();
          result.end(error);
        });
        return result;
      },
      {
        claim: () => undefined,
        headers: () => undefined,
        status: () => 400,
        sleep: async () => undefined,
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(attempts).toBe(1);
    expect(events).toEqual(["error"]);
    expect((await stream.result()).stopReason).toBe("aborted");
  });

  it("surfaces the original error when the repaired attempt fails the same way", async () => {
    let attempts = 0;
    const claims: Array<{ code: string; retriable: boolean; phase: string }> = [];
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return failedStream({ errorMessage: "400 status code (no body)" });
      },
      {
        claim: (error, phase) => {
          claims.push({ code: error.code, retriable: error.retriable, phase });
          return undefined;
        },
        headers: () => undefined,
        status: () => 400,
        sleep: async () => undefined,
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(attempts).toBe(2);
    expect(events).toEqual(["error"]);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("400 status code (no body)");
    // 只有失败的修补进了预算；第一次不透明失败没有
    expect(claims.length).toBe(1);
    expect(claims[0]).toMatchObject({
      code: "PROVIDER_ERROR",
      retriable: false,
      phase: "request",
    });
  });

  it("surfaces descriptive 400 bodies without attempting a repair", async () => {
    let attempts = 0;
    const claims: Array<{ code: string; retriable: boolean; phase: string }> = [];
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return failedStream({
          errorMessage: '400: {"error":{"message":"Model does not exist."}}',
        });
      },
      {
        claim: (error, phase) => {
          claims.push({ code: error.code, retriable: error.retriable, phase });
          return undefined;
        },
        headers: () => undefined,
        status: () => 400,
        sleep: async () => undefined,
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(attempts).toBe(1);
    expect(events).toEqual(["error"]);
    // 有描述的 body 是终止态，预算被问到时也拒绝
    expect(claims.length).toBe(1);
    expect(claims[0]).toMatchObject({
      code: "PROVIDER_ERROR",
      retriable: false,
      phase: "request",
    });
  });

  it("strips only the output-limit fields", () => {
    expect(
      stripOutputLimitFields({
        model: "m",
        max_tokens: 1,
        max_completion_tokens: 2,
        max_output_tokens: 3,
        stream: true,
      }),
    ).toEqual({ model: "m", stream: true });
    expect(stripOutputLimitFields("raw")).toBe("raw");
  });

  it("keeps the repair options otherwise unchanged", () => {
    const options = { maxRetries: 0, fetch: globalThis.fetch } as any;
    const repaired = withoutDerivedOutputLimit(options);
    expect(repaired.maxRetries).toBe(0);
    expect(repaired.fetch).toBe(options.fetch);
    expect(typeof repaired.onPayload).toBe("function");
  });
});

/* ------------------------- 本项目扩展：预算与 UI 事件 ------------------------- */

describe("claimRetry budget", () => {
  const prevMax = process.env.PI_PROVIDER_RETRY_MAX;
  beforeAll(() => {
    process.env.PI_PROVIDER_RETRY_MAX = "10";
  });
  afterAll(() => {
    if (prevMax === undefined) delete process.env.PI_PROVIDER_RETRY_MAX;
    else process.env.PI_PROVIDER_RETRY_MAX = prevMax;
  });

  const error = (code: string, retriable = true) => ({
    code,
    message: code,
    retriable,
  });

  it("gives rate limits and transient faults separate ten-attempt budgets", () => {
    const budget = createRetryBudget();
    for (let i = 1; i <= 10; i++) {
      expect(claimRetry(budget, error("PROVIDER_RATE_LIMITED"))).toBe(i);
    }
    expect(claimRetry(budget, error("PROVIDER_RATE_LIMITED"))).toBeUndefined();
    // 429 预算耗尽不影响另一条瞬时预算
    for (let i = 1; i <= 10; i++) {
      expect(claimRetry(budget, error("NETWORK_ERROR"))).toBe(i);
    }
    expect(claimRetry(budget, error("TIMEOUT"))).toBeUndefined();
  });

  it("refuses non-retriable and out-of-set codes", () => {
    const budget = createRetryBudget();
    expect(claimRetry(budget, error("PROVIDER_UNAUTHORIZED", false))).toBeUndefined();
    expect(claimRetry(budget, error("CONTEXT_TOO_LARGE", false))).toBeUndefined();
    // retriable 但不在瞬时集合里 → 仍归别的恢复路径管
    expect(claimRetry(budget, error("EMPTY_MODEL_RESPONSE"))).toBeUndefined();
    expect(budget).toEqual({ rateLimit: 0, transient: 0 });
  });

  it("PI_PROVIDER_RETRY_MAX=0 disables automatic retries", () => {
    process.env.PI_PROVIDER_RETRY_MAX = "0";
    const budget = createRetryBudget();
    expect(claimRetry(budget, error("PROVIDER_RATE_LIMITED"))).toBeUndefined();
    expect(claimRetry(budget, error("NETWORK_ERROR"))).toBeUndefined();
  });
});

describe("makeUiRetryController", () => {
  const prevMax = process.env.PI_PROVIDER_RETRY_MAX;
  /** 捕获协议流（send 写 process.stdout），同 protocol.test */
  let lines: string[] = [];
  let origWrite: typeof process.stdout.write;

  beforeAll(() => {
    process.env.PI_PROVIDER_RETRY_MAX = "10";
    origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (
      c: unknown,
    ) => {
      lines.push(String(c));
      return true;
    };
  });
  afterAll(() => {
    if (prevMax === undefined) delete process.env.PI_PROVIDER_RETRY_MAX;
    else process.env.PI_PROVIDER_RETRY_MAX = prevMax;
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
      origWrite as unknown as (c: unknown) => boolean;
  });

  function fakeRunning(overrides: Partial<Running> = {}): Running {
    return {
      threadId: "th-retry",
      providerRetry: createRetryBudget(),
      retryCapture: {},
      providerRetryChunkId: "retry-1",
      providerRetryActive: false,
      stopRequested: false,
      ...overrides,
    } as unknown as Running;
  }

  function retryChunks() {
    return lines
      .map((l) => JSON.parse(l) as { id: string; chunk: { type: string; id?: string; data?: Record<string, unknown> } })
      .filter((l) => l.chunk.type === "data-retry")
      .map((l) => l.chunk);
  }

  it("emits a retrying chunk with attempt bookkeeping under the active request", () => {
    lines = [];
    setActiveReqId("th-retry", "rq1");
    const run = fakeRunning();
    const controller = makeUiRetryController(run);
    controller.onRetry?.({
      error: { code: "NETWORK_ERROR", message: "fetch failed", retriable: true },
      phase: "request",
      attempt: 3,
      delayMs: 4_000,
    });
    const chunks = retryChunks();
    expect(chunks.length).toBe(1);
    expect(chunks[0].id).toBe("retry-1");
    expect(chunks[0].data).toMatchObject({
      phase: "retrying",
      attempt: 3,
      maxRetries: 10,
      delayMs: 4_000,
      code: "NETWORK_ERROR",
      error: "fetch failed",
    });
    expect(run.providerRetryActive).toBe(true);
    setActiveReqId("th-retry", null);
  });

  it("settles exactly once, then goes quiet", () => {
    lines = [];
    setActiveReqId("th-retry", "rq2");
    const run = fakeRunning();
    const controller = makeUiRetryController(run);
    controller.onRetry?.({
      error: { code: "TIMEOUT", message: "timeout", retriable: true },
      phase: "request",
      attempt: 1,
      delayMs: 1_000,
    });
    controller.onSettled?.();
    controller.onSettled?.();
    const chunks = retryChunks();
    expect(chunks.length).toBe(2);
    expect(chunks[1].id).toBe("retry-1");
    expect(chunks[1].data).toEqual({ phase: "resolved" });
    expect(run.providerRetryActive).toBe(false);
    setActiveReqId("th-retry", null);
  });

  it("stays silent after Stop and with no active request", () => {
    lines = [];
    setActiveReqId("th-retry", null);
    const stopped = fakeRunning({ stopRequested: true });
    makeUiRetryController(stopped).onRetry?.({
      error: { code: "NETWORK_ERROR", message: "x", retriable: true },
      phase: "request",
      attempt: 1,
      delayMs: 1_000,
    });
    const noReq = fakeRunning();
    makeUiRetryController(noReq).onRetry?.({
      error: { code: "NETWORK_ERROR", message: "x", retriable: true },
      phase: "request",
      attempt: 1,
      delayMs: 1_000,
    });
    expect(retryChunks().length).toBe(0);
  });

  it("retries a pre-stream 429 end to end and closes the card on stream start", async () => {
    lines = [];
    setActiveReqId("th-retry", "rq3");
    const run = fakeRunning();
    let attempts = 0;
    const controller = makeUiRetryController(run);
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return attempts === 1
          ? failedStream({ errorMessage: "429: slow down" })
          : successfulStream();
      },
      { ...controller, sleep: async () => undefined },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(events).toEqual(["start", "done"]);
    const chunks = retryChunks();
    expect(chunks.length).toBe(2);
    expect(chunks[0].data).toMatchObject({
      phase: "retrying",
      attempt: 1,
      code: "PROVIDER_RATE_LIMITED",
    });
    expect(chunks[1].data).toEqual({ phase: "resolved" });
    expect(run.providerRetryActive).toBe(false);
    setActiveReqId("th-retry", null);
  });

  it("settles the card when the retries run out and the error surfaces", async () => {
    lines = [];
    setActiveReqId("th-retry", "rq4");
    const run = fakeRunning();
    // 预算只够一次：第二次失败耗尽预算，终态 error 上浮
    (run.providerRetry as { transient: number }).transient = 9;
    const controller = makeUiRetryController(run);
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => failedStream({ errorMessage: "fetch failed", stopReason: "error" }),
      { ...controller, sleep: async () => undefined },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(events).toEqual(["error"]);
    const chunks = retryChunks();
    expect(chunks.length).toBe(2);
    expect(chunks[0].data).toMatchObject({ phase: "retrying", attempt: 10 });
    // 卡片被终态错误结算，倒计时不会挂在屏幕上
    expect(chunks[1].data).toEqual({ phase: "resolved" });
    expect(run.providerRetryActive).toBe(false);
    setActiveReqId("th-retry", null);
  });
});
