import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "../../src/storage/storage";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { Running } from "../../src/types";
import type { SummaryModels } from "../../src/agent/context";

/**
 * 压缩摘要请求的形状与判定（P1-10）：请求必须复用聊天前缀（同一 messages +
 * 同一 tools + 同一亲和路由/prompt_cache_key），只多一条尾部摘要指令——否则
 * 每次压缩都是一笔整段全价重算（生产实测 112K）。同时用真实 stopReason 做
 * 截断判定（core 的 generateSummary 不透出它，之前只能靠 output>=cap 反推）。
 *
 * 假注册表经参数注入（不是 mock.module：那是进程级的，会把假 registry 泄漏给
 * 同进程的其它测试文件）。
 */
type Captured = {
  context: { messages: Array<Record<string, unknown>>; tools?: unknown[] };
  options: Record<string, unknown>;
};
const calls: Captured[] = [];
let script: Array<Partial<AssistantMessage>> = [];
let scriptIndex = 0;

const fakeModels: SummaryModels = {
  completeSimple: (async (
    _model: unknown,
    context: Captured["context"],
    options: Record<string, unknown>,
  ) => {
    calls.push({ context, options });
    const next = script[Math.min(scriptIndex, script.length - 1)]!;
    scriptIndex += 1;
    return {
      role: "assistant",
      stopReason: "stop",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 1_000,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 1_030,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      ...next,
    };
  }) as unknown as SummaryModels["completeSimple"],
};

const { defaultSummarize, runCompaction } = await import("../../src/agent/context");
const { readCompaction } = await import("../../src/sessions/transcript");

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-summary-req-"));
beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
});

const model = {
  id: "m",
  name: "m",
  api: "openai-completions",
  provider: "test",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as Model<Api>;

let sessionCounter = 0;
function makeRun(messages: unknown[], tools: unknown[] = []): Running {
  return {
    agent: { state: { model, messages, tools } },
    sessionId: `sum-${sessionCounter++}`,
    cwd: ".",
    persistedSeq: messages.length,
    jsonlSeq: messages.length,
    compactionGeneration: 0,
    pendingOverflowRecovery: false,
    delegations: new Map(),
    stopRequested: false,
    mode: "agent",
    approvalLevel: "ask",
    planning: "inactive",
    proposal: null,
    baseTools: [],
    subagentTools: [],
    pendingToolApprovals: new Map(),
  } as unknown as Running;
}

const sys = { role: "system", content: "SYS" };
const user = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});
const asst = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: 2,
});

const reset = (responses: typeof script) => {
  calls.length = 0;
  scriptIndex = 0;
  script = responses;
};

const textOf = (m: unknown): string => {
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return c;
  return Array.isArray(c)
    ? c.map((b) => (b as { text?: string }).text ?? "").join("")
    : "";
};

describe("摘要请求：复用聊天前缀", () => {
  test("同一 messages + 同一 tools + 尾部指令；缓存路由与 key 都带上", async () => {
    reset([{ content: [{ type: "text", text: "SUMMARY" }] }]);
    const messages = [sys, user("干这事"), asst("好")];
    const tools = [{ name: "bash", description: "run" }];
    const summarize = defaultSummarize(model, undefined, fakeModels);
    const run = makeRun(messages, tools);
    // 经 runCompaction 走一遍完整链路：摘要 → checkpoint → 形状重写
    const outcome = await runCompaction(run, "threshold", { summarize });

    expect(outcome.ok && outcome.summarized).toBe(true);
    expect(calls.length).toBe(1);
    const { context, options } = calls[0]!;
    // 前缀 = 完整聊天上下文（含 leading system）+ 唯一追加的尾部指令
    expect(context.messages.slice(0, 3)).toEqual(messages);
    expect(context.tools).toEqual(tools);
    const instruction = context.messages[3]!;
    expect(instruction.role).toBe("user");
    expect(textOf(instruction)).toContain("### In Progress");
    // 不再强制 cacheRetention:"none"（那是 core 独立请求的路子）——缓存要复用
    expect(options.cacheRetention).toBeUndefined();
    expect(options.sessionId).toBe(run.sessionId);
    expect(typeof options.onPayload).toBe("function");
    expect(options.headers).toBeTruthy();
    expect(options.maxTokens).toBe(8_192);
    // 摘要请求的用量落进 checkpoint details（观测位）
    const cp = readCompaction(run.sessionId)!;
    expect(cp.summary).toBe("SUMMARY");
    expect(cp.details).toMatchObject({ summaryAttempts: 1 });
  });

  test("stopReason=length（精确截断）→ 裁剪重试 + 声明未覆盖最早历史", async () => {
    reset([
      // 第一次：撞满输出上限（半截摘要）
      { stopReason: "length", content: [{ type: "text", text: "HALF" }] },
      // 第二次（裁剪后）：完整
      { content: [{ type: "text", text: "FULL SUMMARY" }] },
    ]);
    const messages = [
      sys,
      user("x".repeat(40_000)),
      asst("a1"),
      user("u2"),
      asst("a2"),
      user("u3"),
      asst("a3"),
    ];
    const summarize = defaultSummarize(model, undefined, fakeModels);
    const run = makeRun(messages, [{ name: "bash" }]);
    const outcome = await runCompaction(run, "threshold", { summarize });

    expect(outcome.ok && outcome.summarized).toBe(true);
    expect(calls.length).toBe(2);
    // 第二次请求更小（丢掉最老那段），且指令换成初始措辞（旧摘要可能已被裁掉）
    const second = calls[1]!;
    expect(second.context.messages.length).toBeLessThan(messages.length);
    expect(textOf(second.context.messages.at(-1))).not.toContain("out of date");
    // 不完整视图生成的摘要必须在开头声明这一点
    expect(outcome.ok && outcome.summary).toContain("truncated view of the session");
    expect(outcome.ok && outcome.summary).toContain("FULL SUMMARY");
    expect(readCompaction(run.sessionId)!.details).toMatchObject({ summaryAttempts: 2 });
  });

  test("空响应 / 工具调用响应都不算摘要：一路失败才降级", async () => {
    reset([
      { content: [] }, // 空响应
      { content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] }, // 想调工具
    ]);
    const summarize = defaultSummarize(model, undefined, fakeModels);
    const run = makeRun([sys, user("u1"), asst("a1"), user("u2"), asst("a2")]);
    const outcome = await runCompaction(run, "threshold", { summarize });
    expect(outcome.ok && outcome.summarized).toBe(false);
    const cp = readCompaction(run.sessionId)!;
    expect(cp.summary).toContain("context rollover");
    expect(cp.details).toMatchObject({ strategy: "fresh_window" });
  });

  test("思考档位与聊天同参数下发（部分端点把参数算进缓存键）", async () => {
    reset([{ content: [{ type: "text", text: "SUMMARY" }] }]);
    const reasoningModel = { ...(model as unknown as Record<string, unknown>), reasoning: true } as unknown as Model<Api>;
    const run = makeRun([sys, user("干这事"), asst("好")]);
    (run.agent.state as { thinkingLevel?: string }).thinkingLevel = "max";
    const summarize = defaultSummarize(reasoningModel, undefined, fakeModels);
    await runCompaction(run, "threshold", { summarize });
    expect(calls[0]!.options.reasoning).toBe("max");
    // off 档不下发（与 core/pi 的规则一致）
    reset([{ content: [{ type: "text", text: "SUMMARY" }] }]);
    const run2 = makeRun([sys, user("干这事"), asst("好")]);
    (run2.agent.state as { thinkingLevel?: string }).thinkingLevel = "off";
    await runCompaction(run2, "threshold", {
      summarize: defaultSummarize(reasoningModel, undefined, fakeModels),
    });
    expect(calls[0]!.options.reasoning).toBeUndefined();
  });

  test("可重试的瞬时错误按策略重试（policy 已接上，不是 0 次）", async () => {
    process.env.PI_PROVIDER_RETRY_MAX = "1"; // 测试里把退避压到 1 次 × 1s
    reset([{ stopReason: "error", errorMessage: "503 service unavailable", content: [] }]);
    // 历史要够长，裁剪重试才有可丢的部分（≤3 条时裁剪是恒等变换）
    const summarize = defaultSummarize(model, undefined, fakeModels);
    const run = makeRun([
      sys,
      user("y".repeat(40_000)),
      asst("a1"),
      user("u2"),
      asst("a2"),
      user("u3"),
      asst("a3"),
    ]);
    const outcome = await runCompaction(run, "threshold", { summarize });
    delete process.env.PI_PROVIDER_RETRY_MAX;
    expect(outcome.ok && outcome.summarized).toBe(false);
    // 首次尝试 1 + 重试 1 = 2 次；降级裁剪后再来一轮 = 共 4 次
    expect(calls.length).toBe(4);
  });
});
