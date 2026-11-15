/**
 * CacheWarmer 单测（fake clock / fake stream / fake timer 注入）：
 * TTL 调度、模式语义（streaming/idle/off）、isReplayable、isCurrent、
 * 健康门控（低命中率停暖、窗口滑出恢复）、成本/规模门槛、重放失败隔离。
 */
import { describe, expect, test } from "bun:test";
import { CacheWarmer, type CacheWarmRequest } from "../../src/agent/cache-warmer";
import type { Model } from "@earendil-works/pi-ai";

type Timer = { fn: () => void; ms: number; cancelled: boolean };

/** 可控时钟 + 可控定时器：测试里手动推进时间、手动触发到期回调 */
function makeClock() {
  let now = 1_000_000;
  const timers: Timer[] = [];
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      for (const t of timers.splice(0)) {
        if (!t.cancelled && t.ms <= now) t.fn();
      }
    },
    timers,
    pending: () => timers.filter((t) => !t.cancelled),
    schedule: (fn: () => void, ms: number) => {
      const t: Timer = { fn, ms: now + ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  };
}

const MODEL: Model<"openai-completions"> = {
  id: "m",
  name: "m",
  api: "openai-completions",
  provider: "p",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  // 单价（每百万）：input 3 / output 12 / cacheRead 0.3 / cacheWrite 6
  cost: { input: 3, output: 12, cacheRead: 0.3, cacheWrite: 6 },
  promptCache: { short: 300 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as Model<"openai-completions">;

const CONTEXT = { messages: [{ role: "user", content: "hi" }] } as unknown as Parameters<
  CacheWarmer["start"]
>[0]["context"];

function makeWarmer(options?: {
  model?: Partial<Model<"openai-completions">>;
  mode?: "off" | "streaming" | "idle";
  streamError?: boolean;
  warmUsage?: { input?: number; cacheRead?: number; cacheWrite?: number };
}) {
  const clock = makeClock();
  const warmCalls: { maxTokens?: number; disableContinuation?: boolean }[] = [];
  const warmer = new CacheWarmer({
    streamSimple: (model, context, opts) => {
      warmCalls.push({
        maxTokens: opts?.maxTokens,
        disableContinuation: opts?.disableContinuation,
      });
      if (options?.streamError) {
        return {
          result: () => Promise.reject(new Error("probe down")),
        } as ReturnType<NonNullable<ConstructorParameters<typeof CacheWarmer>[0]["streamSimple"]>>;
      }
      const message = {
        usage: {
          input: 0,
          output: 1,
          cacheRead: options?.warmUsage?.cacheRead ?? 0,
          cacheWrite: options?.warmUsage?.cacheWrite ?? 0,
        },
      } as AssistantMessageFixture;
      return {
        result: () => Promise.resolve(message as never),
      } as ReturnType<NonNullable<ConstructorParameters<typeof CacheWarmer>[0]["streamSimple"]>>;
    },
    getMode: () => options?.mode ?? "idle",
    now: clock.now,
    scheduleTimer: clock.schedule,
  });
  return { clock, warmCalls, warmer };
}

type AssistantMessageFixture = {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

function makeRequest(
  messages: unknown[] = CONTEXT.messages,
  model: Model<"openai-completions"> = MODEL,
  options: CacheWarmRequest["options"] = { sessionId: "s1" },
): CacheWarmRequest & { isCurrent: () => boolean; isCurrentMessages: unknown[] } {
  const state = { model, messages: [...messages] } as {
    model: Model<"openai-completions">;
    messages: unknown[];
  };
  const request = {
    model,
    context: { messages: [...messages] } as unknown as CacheWarmRequest["context"],
    options,
    isCurrent: () =>
      state.model === model &&
      state.messages.length >= request.context.messages.length &&
      request.context.messages.every((msg, index) => state.messages[index] === msg),
    isCurrentMessages: state.messages,
  };
  return request;
}

describe("CacheWarmer", () => {
  test("TTL 调度：在 90% 时刻安排重放，重放带 maxTokens=1 并循环排程", async () => {
    const { clock, warmCalls, warmer } = makeWarmer();
    const request = makeRequest();
    // 生产时序：首轮 message_end 在触发点（TTL 90%）之前就喂了用量
    warmer.observeUsage({ input: 20_000, cacheRead: 0, cacheWrite: 0 });
    warmer.start(request, request.isCurrent);
    // delay = min(300*0.9, 300-10) = 270s
    expect(clock.pending()).toHaveLength(1);

    clock.advance(270_000);
    // refresh 是 async：重放完成 → 再排程的续链在微任务里
    await new Promise((r) => setTimeout(r, 0));
    expect(warmCalls).toHaveLength(1);
    expect(warmCalls[0].maxTokens).toBe(1);
    // 重放不能消费/替换 Anthropic message threads 的服务端续传状态
    expect(warmCalls[0].disableContinuation).toBe(true);
    // 重放成功后再排下一次
    expect(clock.pending()).toHaveLength(1);
  });

  test("模型未声明 promptCache TTL → 不暖（pi 同款守门）", () => {
    const { clock, warmCalls, warmer } = makeWarmer({
      model: { promptCache: undefined },
    });
    const request = makeRequest(CONTEXT.messages, {
      ...MODEL,
      promptCache: undefined,
    } as unknown as Model<"openai-completions">);
    warmer.start(request, request.isCurrent);
    expect(clock.pending()).toHaveLength(0);
    warmer.start(request, request.isCurrent);
    expect(warmCalls).toHaveLength(0);
    expect(warmer.inactiveReasonText).toContain("promptCache TTL");
  });

  test("模式 off：start 直接不排程", () => {
    const { clock, warmer } = makeWarmer({ mode: "off" });
    const request = makeRequest();
    warmer.start(request, request.isCurrent);
    expect(clock.pending()).toHaveLength(0);
  });

  test("onAgentSettled：streaming 模式停止，idle 模式继续", () => {
    const streaming = makeWarmer({ mode: "streaming" });
    const reqS = makeRequest();
    streaming.warmer.start(reqS, reqS.isCurrent);
    streaming.warmer.onAgentSettled();
    expect(streaming.clock.pending()).toHaveLength(0);

    const idle = makeWarmer({ mode: "idle" });
    const reqI = makeRequest();
    idle.warmer.start(reqI, reqI.isCurrent);
    idle.warmer.onAgentSettled();
    expect(idle.clock.pending()).toHaveLength(1);
  });

  test("idle 模式 30 分钟安全窗：越窗后停", async () => {
    // 贵模型：idle 概率下的期望节省也过得了美元门槛，才能一路暖到安全窗
    const expensive = {
      ...MODEL,
      cost: { input: 30, output: 150, cacheRead: 3, cacheWrite: 60 },
    } as unknown as Model<"openai-completions">;
    const { clock, warmCalls, warmer } = makeWarmer({ mode: "idle" });
    const request = makeRequest(CONTEXT.messages, expensive);
    warmer.observeUsage({ input: 20_000, cacheRead: 0, cacheWrite: 0 });
    warmer.start(request, request.isCurrent);
    warmer.onAgentSettled();
    // 推进 31 分钟：中途的重放与再排程都该被安全窗拦下。
    // refresh 是 async：每步推进后 flush 微任务，让再排程/停止先落地
    for (let i = 0; i < 8; i++) {
      clock.advance(270_000);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(warmCalls.length).toBeLessThan(8);
    expect(warmer.inactiveReasonText).toContain("30-minute");
  });

  test("isReplayable：anthropic + reasoning（非 adaptive）不重放", () => {
    const { clock, warmCalls, warmer } = makeWarmer();
    const anthropicModel = {
      ...MODEL,
      api: "anthropic-messages",
      compat: {},
      reasoning: true,
    } as unknown as Model<"openai-completions">;
    const request = makeRequest(CONTEXT.messages, anthropicModel, {
      sessionId: "s1",
      reasoning: "high",
    } as CacheWarmRequest["options"]);
    warmer.observeUsage({ input: 20_000, cacheRead: 0, cacheWrite: 0 });
    warmer.start(request, request.isCurrent);
    expect(clock.pending()).toHaveLength(0);
    warmer.start(request, request.isCurrent);
    expect(warmCalls).toHaveLength(0);
    expect(warmer.inactiveReasonText).toContain("replay");
  });

  test("isCurrent：模型或消息前缀变化后，挂起的重放被拦下", () => {
    const { clock, warmCalls, warmer } = makeWarmer();
    const request = makeRequest();
    warmer.observeUsage({ input: 20_000, cacheRead: 0, cacheWrite: 0 });
    warmer.start(request, request.isCurrent);
    // 重载（截断重发）改写了首条消息：同长度但对象不同 → 前缀失效。
    // 追加新消息不算失效（pi 语义：旧前缀仍是当前转录的前缀，重放依然有用）
    request.isCurrentMessages[0] = { role: "user", content: "rewritten" };
    clock.advance(270_000);
    expect(warmCalls).toHaveLength(0);
    expect(warmer.inactiveReasonText).toContain("context changed");
  });

  test("健康门控：最近窗口命中率 <50% 停暖；滑出窗口后恢复", () => {
    const { clock, warmCalls, warmer } = makeWarmer();
    const request = makeRequest();
    warmer.start(request, request.isCurrent);
    // 五次真实请求全部 0 命中（冷启动/坏网关形态）→ 门控关闭
    for (let i = 0; i < 5; i++) {
      warmer.observeUsage({ input: 20_000, cacheRead: 0, cacheWrite: 0 });
      warmer.start(request, request.isCurrent);
    }
    clock.advance(270_000);
    expect(warmCalls).toHaveLength(0);
    expect(warmer.inactiveReasonText).toContain("health gate");

    // 窗口滑出：后续请求恢复命中 → 门控放行
    for (let i = 0; i < 5; i++) {
      warmer.observeUsage({ input: 2_000, cacheRead: 18_000, cacheWrite: 0 });
      warmer.start(request, request.isCurrent);
    }
    clock.advance(270_000);
    expect(warmCalls.length).toBeGreaterThan(0);
  });

  test("成本门槛：单价已知且节省达标才暖；小 prompt 不值得暖", () => {
    const { clock, warmCalls, warmer } = makeWarmer();
    const request = makeRequest();
    // 先喂一次大 prompt 的用量（成本门槛看最近一次 prompt）
    warmer.observeUsage({ input: 20_000, cacheRead: 0, cacheWrite: 0 });
    warmer.start(request, request.isCurrent);
    clock.advance(270_000);
    expect(warmCalls).toHaveLength(1);

    // 小 prompt：miss 代价低于阈值 → 停
    const small = makeWarmer();
    const smallRequest = makeRequest();
    small.warmer.observeUsage({ input: 1_000, cacheRead: 0, cacheWrite: 0 });
    small.warmer.start(smallRequest, smallRequest.isCurrent);
    small.clock.advance(270_000);
    expect(small.warmCalls).toHaveLength(0);
  });

  test("单价全 0（自定义端点常态）：退化成规模门槛（prompt ≥ 8K 才暖）", () => {
    const freeModel = {
      ...MODEL,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as unknown as Model<"openai-completions">;
    const { clock, warmCalls, warmer } = makeWarmer();
    const request = makeRequest(CONTEXT.messages, freeModel);
    warmer.observeUsage({ input: 20_000, cacheRead: 0, cacheWrite: 0 });
    warmer.start(request, request.isCurrent);
    clock.advance(270_000);
    expect(warmCalls).toHaveLength(1);

    const small = makeWarmer();
    const smallRequest = makeRequest(CONTEXT.messages, freeModel);
    small.warmer.observeUsage({ input: 1_000, cacheRead: 0, cacheWrite: 0 });
    small.warmer.start(smallRequest, smallRequest.isCurrent);
    small.clock.advance(270_000);
    expect(small.warmCalls).toHaveLength(0);
  });

  test("idle 相位不走美元门槛：便宜模型 + 20K prompt 照样暖（规模门槛兜底）", () => {
    const { clock, warmCalls, warmer } = makeWarmer({ mode: "idle" });
    const request = makeRequest();
    warmer.observeUsage({ input: 20_000, cacheRead: 0, cacheWrite: 0 });
    warmer.start(request, request.isCurrent);
    warmer.onAgentSettled();
    clock.advance(270_000);
    // streaming 相位同一模型会被美元门槛拦下（0.15*0.114-0.006 < $0.05）
    expect(warmCalls).toHaveLength(1);
  });

  test("重放失败：停暖且不抛错（下次真实请求重新 start）", async () => {
    const { clock, warmCalls, warmer } = makeWarmer({ streamError: true });
    const request = makeRequest();
    warmer.observeUsage({ input: 20_000, cacheRead: 0, cacheWrite: 0 });
    warmer.start(request, request.isCurrent);
    clock.advance(270_000);
    // refresh 是 async：让拒绝路径的微任务跑完再断言
    await new Promise((r) => setTimeout(r, 0));
    expect(warmCalls).toHaveLength(1);
    expect(warmer.inactiveReasonText).toContain("failed");
  });

  test("observeUsage 忽略空 usage；cancel 清定时器", () => {
    const { clock, warmer } = makeWarmer();
    const request = makeRequest();
    warmer.observeUsage(undefined);
    warmer.observeUsage({ input: 0, cacheRead: 0, cacheWrite: 0 });
    warmer.start(request, request.isCurrent);
    expect(clock.pending()).toHaveLength(1);
    warmer.cancel();
    expect(clock.pending()).toHaveLength(0);
  });
});
