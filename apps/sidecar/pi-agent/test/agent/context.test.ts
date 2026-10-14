import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, sessionPath } from "../../src/storage/storage";
import { appendCompactionRow, readCompaction } from "../../src/sessions/transcript";
import {
  checkpointGeneration,
  contextBudget,
  contextInfo,
  estimateTextTokens,
  isSummaryMessage,
  makeSummaryMessage,
  needsCompaction,
  projectRestoreContext,
  runCompaction,
  sessionCacheMissStats,
  type SummarizeFn,
} from "../../src/agent/context";
import { makeMidTurnCompactionHook } from "../../src/protocol/prompt-pipeline";
import { COMPACTION_SUMMARY_PREFIX } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { Running } from "../../src/types";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-context-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
});

const fakeModel = (contextWindow = 128_000, maxTokens = 8_192) =>
  ({
    id: "m",
    name: "m",
    api: "openai-completions",
    provider: "test",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  }) as unknown as Model<Api>;

const userMsg = (text: string): Message =>
  ({ role: "user", content: text, timestamp: 1 }) as unknown as Message;
const assistantMsg = (text: string, stopReason?: string): Message =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 2,
    ...(stopReason ? { stopReason } : {}),
  }) as unknown as Message;

let sessionCounter = 0;
function makeRun(
  messages: Message[],
  model: Model<Api> = fakeModel(),
): Running {
  return {
    agent: { state: { model, messages } },
    sessionId: `ctx-${sessionCounter++}`,
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

describe("contextBudget", () => {
  test("小窗口：reserve 地板被窗口比例夹住", () => {
    const { hardLimit, requestHeadroom } = contextBudget(
      [userMsg("hi")],
      fakeModel(4_000, 1_000),
    );
    // floor = min(16384, 2000) = 2000；output = min(1000, 1000)；5% = 200
    // headroom = 2000，hardLimit = 2000
    expect(requestHeadroom).toBe(2_000);
    expect(hardLimit).toBe(2_000);
  });

  test("大窗口：reserve 地板 16384 生效", () => {
    const { hardLimit, requestHeadroom } = contextBudget(
      [userMsg("hi")],
      fakeModel(200_000, 8_192),
    );
    expect(requestHeadroom).toBe(16_384);
    expect(hardLimit).toBe(200_000 - 16_384);
  });

  test("未配置窗口/输出走兜底常量", () => {
    const budget = contextBudget([], fakeModel(0, 0));
    expect(budget.hardLimit).toBe(128_000 - 16_384);
  });
});

describe("needsCompaction", () => {
  test("上下文越过 hardLimit 触发", () => {
    const run = makeRun([
      userMsg("x".repeat(9_000)), // ~2250 token（4字符/1 token 启发式）
      assistantMsg("ok"),
    ], fakeModel(4_000, 1_000));
    expect(needsCompaction(run)).toBe(true);
  });

  test("余量充足不触发；待发文本计入估计", () => {
    const run = makeRun([userMsg("hi"), assistantMsg("yo")], fakeModel(4_000, 1_000));
    expect(needsCompaction(run)).toBe(false);
    expect(needsCompaction(run, "y".repeat(20_000))).toBe(true);
  });

  test("只有一条消息且无待发文本不触发（无历史可摘）", () => {
    const run = makeRun([userMsg("x".repeat(9_000))], fakeModel(4_000, 1_000));
    expect(needsCompaction(run)).toBe(false);
  });
});

describe("runCompaction", () => {
  test("摘要路径：state 只剩摘要头，落 checkpoint 行，计数推进", async () => {
    const run = makeRun([userMsg("question"), assistantMsg("answer")]);
    const outcome = await runCompaction(run, "threshold", {
      summarize: async () => "THE SUMMARY",
    });
    expect(outcome).toEqual({
      ok: true,
      generation: 1,
      tokensBefore: expect.any(Number),
      summarized: true,
      summary: "THE SUMMARY",
    });
    const messages = run.agent.state.messages as unknown as Message[];
    expect(messages.length).toBe(1);
    expect(isSummaryMessage(messages[0] as never)).toBe(true);
    const text = (messages[0] as unknown as { content: { text: string }[] })
      .content[0].text;
    expect(text.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
    expect(text).toContain("THE SUMMARY");
    expect(run.persistedSeq).toBe(1);

    const cp = readCompaction(run.sessionId)!;
    expect(cp.summary).toBe("THE SUMMARY");
    // 压缩前最后一条消息行是 seq 1；检查点行占 seq 2；jsonlSeq 已推进到 3
    expect(cp.throughSeq).toBe(1);
    expect(cp.seq).toBe(2);
    expect(run.jsonlSeq).toBe(3);
    expect(cp.details).toEqual({ generation: 1, strategy: "summary" });
    // 检查点行确实写进了文件（末行），seq 与消息行共用单调编号
    const lastLine = JSON.parse(
      readFileSync(sessionPath(run.sessionId), "utf8").trim().split("\n").at(-1)!,
    );
    expect(lastLine.type).toBe("compaction");
    expect(lastLine.seq).toBe(cp.seq);
  });

  test("二代压缩：previousSummary 传入且摘要头不再进摘要范围", async () => {
    const run = makeRun([
      makeSummaryMessage("S1") as unknown as Message,
      userMsg("q2"),
      assistantMsg("a2"),
    ]);
    run.compactionGeneration = 1;
    let capturedMessages: unknown[] = [];
    let capturedPrev: string | undefined;
    const summarize: SummarizeFn = async (messages, _reserve, previous) => {
      capturedMessages = messages;
      capturedPrev = previous;
      return "S2";
    };
    const outcome = await runCompaction(run, "threshold", { summarize });
    expect(outcome.ok && outcome.generation).toBe(2);
    expect(capturedPrev).toBe("S1");
    expect(
      capturedMessages.every((m) => !isSummaryMessage(m as never)),
    ).toBe(true);
    expect(capturedMessages.length).toBe(2); // q2 + a2

    const cp = readCompaction(run.sessionId)!;
    expect(cp.summary).toBe("S2");
    expect(cp.details).toEqual({ generation: 2, strategy: "summary" });
  });

  test("溢出路径摘要失败走 fresh_window 兜底", async () => {
    const run = makeRun([userMsg("q"), assistantMsg("a")]);
    const outcome = await runCompaction(run, "overflow", {
      summarize: async () => {
        throw new Error("upstream 500");
      },
    });
    expect(outcome.ok && outcome.summarized).toBe(false);
    const text = (
      run.agent.state.messages[0] as unknown as { content: { text: string }[] }
    ).content[0].text;
    expect(text).toContain("[context rollover");
    const cp = readCompaction(run.sessionId)!;
    expect(cp.details).toMatchObject({ strategy: "fresh_window" });
  });

  test("摘要返回空串不得清空上下文：溢出路径同样走 fresh_window 兜底", async () => {
    // 回归：core 的 generateSummary 对"响应里没有 text 块"返回 ok("") 而不是报错，
    // 放行会把整段历史替换成一条空摘要（线上事故：112k tokens 上下文归零）。
    const run = makeRun([userMsg("q"), assistantMsg("a")]);
    const outcome = await runCompaction(run, "overflow", {
      summarize: async () => "",
    });
    expect(outcome.ok && outcome.summarized).toBe(false);
    const text = (
      run.agent.state.messages[0] as unknown as { content: { text: string }[] }
    ).content[0].text;
    expect(text).toContain("[context rollover");
    const cp = readCompaction(run.sessionId)!;
    expect(cp.summary).not.toBe("");
    expect(cp.details).toMatchObject({ strategy: "fresh_window" });
  });

  test("摘要撞满输出上限（truncated）不得落成 checkpoint：走兜底", async () => {
    // 回归：半截摘要比空摘要更隐蔽——看起来是成功的，实际把不完整上下文写进了
    // 检查点（pi 的 getSummarizationFailure 同判定：length stop 不得成为 checkpoint）
    const run = makeRun([userMsg("q"), assistantMsg("a")]);
    const outcome = await runCompaction(run, "overflow", {
      summarize: async () => ({
        text: "HALF A SUMMARY...",
        truncated: true,
        usage: { input: 100, output: 8_192, cacheRead: 0, cacheWrite: 0 },
      }),
    });
    expect(outcome.ok && outcome.summarized).toBe(false);
    const cp = readCompaction(run.sessionId)!;
    expect(cp.summary).toContain("[context rollover");
    expect(cp.details).toMatchObject({ strategy: "fresh_window" });
  });

  test("摘要用量与尝试次数写进 checkpoint details（观测位）", async () => {
    const run = makeRun([userMsg("q"), assistantMsg("a")]);
    const usage = { input: 100, output: 200, cacheRead: 50, cacheWrite: 0, reasoning: 80 };
    await runCompaction(run, "threshold", {
      summarize: async () => ({ text: "S", usage, attempts: 2 }),
    });
    const cp = readCompaction(run.sessionId)!;
    expect(cp.summary).toBe("S");
    expect(cp.details).toMatchObject({
      strategy: "summary",
      summaryUsage: usage,
      summaryAttempts: 2,
    });
  });

  test("兜底保留最近原文尾部：只丢最老，切点落在合法边界上", async () => {
    // 生产事故（2026-10-05）：摘要失败 → 整段历史换成一条 rollover marker，
    // 模型当场失忆、向用户重新要上下文。改为保留最近 ~24K tokens 原文；
    // 切点走 core 的 findCutPoint（保留 ≥ 预算的那一条，toolResult 不作切点）。
    const sessionId = `ctx-tail-${sessionCounter++}`;
    const recentQuestion = "最近的问题" + "x".repeat(120_000); // ~30K tokens，越过预算
    const rows: { seq: number; agent: Message }[] = [
      { seq: 0, agent: userMsg("老问题") },
      { seq: 1, agent: assistantMsg("老回答") },
      { seq: 2, agent: userMsg(recentQuestion) },
      { seq: 3, agent: assistantMsg("最近的回答") },
    ];
    writeFileSync(
      sessionPath(sessionId),
      rows
        .map((r) => JSON.stringify({ type: "message", seq: r.seq, ui: null, agent: r.agent }))
        .join("\n") + "\n",
    );
    const run = makeRun(rows.map((r) => r.agent));
    run.sessionId = sessionId;
    const outcome = await runCompaction(run, "threshold", {
      summarize: async () => {
        throw new Error("upstream stream dropped");
      },
    });
    expect(outcome.ok && outcome.summarized).toBe(false);
    const state = run.agent.state.messages as unknown as Message[];
    // 摘要头 + 最近两条
    expect(state.length).toBe(3);
    expect(isSummaryMessage(state[0] as never)).toBe(true);
    expect((state[1] as { content: unknown }).content).toBe(recentQuestion);
    expect((state[2] as { content: unknown }).content).toEqual([
      { type: "text", text: "最近的回答" },
    ]);
    const cp = readCompaction(sessionId)!;
    expect(cp.throughSeq).toBe(1); // 丢弃 seq ≤ 1，保留 seq 2/3
    expect(cp.details).toMatchObject({ strategy: "fresh_window", keptTailMessages: 2 });
    // 刷新后的装载必须复原出同一形状（摘要头 + 保留尾部）
    const restored = projectRestoreContext(rows, cp);
    expect(restored.length).toBe(3);
    expect((restored[1] as { content: unknown }).content).toBe(recentQuestion);
    expect((restored[2] as { content: unknown }).content).toEqual([
      { type: "text", text: "最近的回答" },
    ]);
  });

  test("手动压缩拿到空摘要时报错不装填，会话原样", async () => {
    const run = makeRun([userMsg("q"), assistantMsg("a")]);
    const outcome = await runCompaction(run, "manual", {
      summarize: async () => "   ",
    });
    expect(outcome.ok).toBe(false);
    expect(run.agent.state.messages).toHaveLength(2);
    expect(readCompaction(run.sessionId)).toBeUndefined();
  });

  test("手动压缩失败不装填兜底，会话原样", async () => {
    const run = makeRun([userMsg("q"), assistantMsg("a")]);
    const outcome = await runCompaction(run, "manual", {
      summarize: async () => {
        throw new Error("no credentials");
      },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("no credentials");
    expect((run.agent.state.messages as unknown[]).length).toBe(2);
    expect(readCompaction(run.sessionId)).toBeUndefined();
  });

  test("用户 Stop 期间失败：不装填任何 checkpoint", async () => {
    const run = makeRun([userMsg("q"), assistantMsg("a")]);
    run.stopRequested = true;
    const outcome = await runCompaction(run, "overflow", {
      summarize: async () => {
        throw new Error("aborted mid-summary");
      },
    });
    expect(outcome.ok).toBe(false);
    expect(readCompaction(run.sessionId)).toBeUndefined();
  });

  test("除摘要头外没有新内容时拒绝压缩", async () => {
    const run = makeRun([makeSummaryMessage("S1") as unknown as Message]);
    const outcome = await runCompaction(run, "manual", {
      summarize: async () => "unused",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("No new context");
  });

  test("错误/中止的 assistant 消息不进摘要范围", async () => {
    const run = makeRun([
      userMsg("q"),
      assistantMsg("boom", "error"),
      assistantMsg("fine"),
    ]);
    let captured: unknown[] = [];
    await runCompaction(run, "threshold", {
      summarize: async (messages) => {
        captured = messages;
        return "S";
      },
    });
    expect(captured.length).toBe(2);
  });
});

describe("projectRestoreContext", () => {
  test("无检查点：全量消息原样恢复", () => {
    const rows = [
      { seq: 0, agent: userMsg("a") },
      { seq: 1, agent: assistantMsg("b") },
    ];
    const messages = projectRestoreContext(rows, undefined);
    expect(messages.length).toBe(2);
    expect(messages[1]).toBe(rows[1].agent);
  });

  test("有检查点：摘要头覆盖边界前历史，其后消息行保留", () => {
    const rows = [
      { seq: 0, agent: userMsg("old-q") },
      { seq: 1, agent: assistantMsg("old-a") },
      { seq: 3, agent: userMsg("new-q") }, // seq 2 是检查点行
    ];
    const checkpoint = appendFixture(rows.length);
    const messages = projectRestoreContext(rows, checkpoint);
    expect(messages.length).toBe(2);
    expect(isSummaryMessage(messages[0] as never)).toBe(true);
    const text = (messages[0] as unknown as { content: { text: string }[] })
      .content[0].text;
    expect(text).toContain("CHECKPOINT SUMMARY");
    expect(messages[1]).toBe(rows[2].agent);
  });
});

describe("checkpointGeneration", () => {
  test("details 缺省/非法按第 1 代", () => {
    expect(checkpointGeneration(undefined)).toBe(1);
    expect(checkpointGeneration({})).toBe(1);
    expect(checkpointGeneration({ generation: 0 })).toBe(1);
    expect(checkpointGeneration({ generation: 3 })).toBe(3);
  });
});

describe("contextInfo", () => {
  test("无转录文件：零用量、无检查点、未触阈值", () => {
    const run = makeRun([userMsg("hi"), assistantMsg("yo")]);
    const info = contextInfo(run);
    expect(info.model).toEqual({ provider: "test", id: "m", name: "m" });
    expect(info.contextWindow).toBe(128_000);
    expect(info.hardLimit).toBe(128_000 - 16_384);
    expect(info.messageTokens).toBe(
      contextBudget(run.agent.state.messages as never, fakeModel()).tokens,
    );
    expect(info.messageCount).toBe(2);
    expect(info.generation).toBe(0);
    expect(info.lastCompaction).toBeNull();
    expect(info.needsCompaction).toBe(false);
    expect(info.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(info.cacheHitRate).toBeNull();
  });

  test("系统提示词与工具占用按 ceil(chars/4) 估算", () => {
    const run = makeRun([userMsg("hi")]);
    const state = run.agent.state as unknown as Record<string, unknown>;
    state.systemPrompt = "x".repeat(40);
    state.tools = [
      { name: "bash", description: "run", parameters: { type: "object" } },
    ];
    const info = contextInfo(run);
    expect(estimateTextTokens("x".repeat(40))).toBe(10);
    expect(info.systemPromptTokens).toBe(10);
    expect(info.toolTokens).toBe(
      estimateTextTokens(`bash\nrun\n${JSON.stringify({ type: "object" })}`),
    );
  });

  test("缓存命中率聚合全历史 usage，错误/中止轮不计", () => {
    const run = makeRun([userMsg("hi")]);
    const msgLine = (
      seq: number,
      usage: Record<string, number>,
      stopReason: string,
    ) =>
      JSON.stringify({
        type: "message",
        seq,
        ui: null,
        agent: {
          role: "assistant",
          content: [{ type: "text", text: "a" }],
          stopReason,
          usage,
        },
      });
    writeFileSync(
      sessionPath(run.sessionId),
      [
        msgLine(0, { input: 100, output: 5, cacheRead: 300, cacheWrite: 0 }, "stop"),
        msgLine(1, { input: 50, output: 5, cacheRead: 150, cacheWrite: 0 }, "stop"),
        // 错误轮不计入
        msgLine(2, { input: 100000, output: 0, cacheRead: 0, cacheWrite: 0 }, "error"),
      ].join("\n") + "\n",
      "utf8",
    );
    const info = contextInfo(run);
    expect(info.usage).toEqual({
      input: 150,
      output: 10,
      cacheRead: 450,
      cacheWrite: 0,
    });
    // 450 / (150 + 450) = 0.75
    expect(info.cacheHitRate).toBeCloseTo(0.75);
  });

  test("fresh_window 检查点映射为 summarized=false", () => {
    const run = makeRun([userMsg("hi")]);
    run.compactionGeneration = 2;
    appendCompactionRow(run.sessionId, {
      seq: 0,
      summary: "rollover marker",
      tokensBefore: 99_000,
      throughSeq: -1,
      createdAt: "2026-01-01T00:00:00.000Z",
      details: { generation: 2, strategy: "fresh_window" },
    });
    const info = contextInfo(run);
    expect(info.generation).toBe(2);
    expect(info.lastCompaction).toEqual({
      tokensBefore: 99_000,
      summarized: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("占用越过阈值时 needsCompaction 置位", () => {
    const run = makeRun(
      [userMsg("hi"), assistantMsg("x".repeat(40_000))],
      fakeModel(4_000, 1_000),
    );
    const info = contextInfo(run);
    expect(info.hardLimit).toBe(2_000);
    expect(info.messageTokens).toBeGreaterThanOrEqual(2_000);
    expect(info.needsCompaction).toBe(true);
  });
});

describe("makeMidTurnCompactionHook", () => {
  /** 钩子通知 spy：phase 序列 + complete 时的 outcome */
  function spyNotify() {
    const phases: string[] = [];
    let lastOutcome: unknown;
    return {
      phases,
      fn: (phase: "start" | "complete" | "failed", outcome?: unknown) => {
        phases.push(phase);
        if (outcome) lastOutcome = outcome;
      },
      get outcome() {
        return lastOutcome;
      },
    };
  }

  test("越线：就地压缩并返回摘要上下文，checkpoint/state/通知齐全", async () => {
    const run = makeRun(
      [userMsg("x".repeat(9_000)), assistantMsg("ok")],
      fakeModel(4_000, 1_000),
    );
    const spy = spyNotify();
    const hook = makeMidTurnCompactionHook(run, spy.fn, {
      summarize: async () => "MID-TURN SUMMARY",
    });
    const update = await hook({} as never, undefined);
    // 返回替换上下文：下一轮请求只看摘要头
    expect(update).toBeDefined();
    expect(update!.context).toBeDefined();
    const ctxMessages = update!.context!.messages as unknown as Message[];
    expect(ctxMessages.length).toBe(1);
    expect(isSummaryMessage(ctxMessages[0] as never)).toBe(true);
    // state 同步重写 + checkpoint 落盘
    expect((run.agent.state.messages as unknown[]).length).toBe(1);
    expect(run.persistedSeq).toBe(1);
    expect(readCompaction(run.sessionId)!.details).toMatchObject({
      generation: 1,
      strategy: "summary",
    });
    expect(spy.phases).toEqual(["start", "complete"]);
    expect(spy.outcome).toMatchObject({ ok: true, summarized: true });
  });

  test("未越线：返回 undefined，零通知零副作用", async () => {
    const run = makeRun([userMsg("hi"), assistantMsg("yo")], fakeModel(4_000, 1_000));
    const spy = spyNotify();
    const hook = makeMidTurnCompactionHook(run, spy.fn);
    expect(await hook({} as never, undefined)).toBeUndefined();
    expect(spy.phases).toEqual([]);
    expect(readCompaction(run.sessionId)).toBeUndefined();
    expect((run.agent.state.messages as unknown[]).length).toBe(2);
  });

  test("用户 Stop / signal 已中止：直接放行", async () => {
    const stopped = makeRun(
      [userMsg("x".repeat(9_000)), assistantMsg("ok")],
      fakeModel(4_000, 1_000),
    );
    stopped.stopRequested = true;
    const stoppedSpy = spyNotify();
    expect(
      await makeMidTurnCompactionHook(stopped, stoppedSpy.fn)({} as never, undefined),
    ).toBeUndefined();
    expect(stoppedSpy.phases).toEqual([]);

    const aborted = makeRun(
      [userMsg("x".repeat(9_000)), assistantMsg("ok")],
      fakeModel(4_000, 1_000),
    );
    const abortedSpy = spyNotify();
    expect(
      await makeMidTurnCompactionHook(aborted, abortedSpy.fn)(
        {} as never,
        AbortSignal.abort(),
      ),
    ).toBeUndefined();
    expect(abortedSpy.phases).toEqual([]);
  });

  test("摘要请求失败且未 Stop：fresh_window 兜底仍装填并返回替换上下文", async () => {
    const run = makeRun(
      [userMsg("x".repeat(9_000)), assistantMsg("ok")],
      fakeModel(4_000, 1_000),
    );
    // 钩子走 runCompaction 默认 summarize（真实模型请求）→ 无凭据必失败
    const spy = spyNotify();
    const update = await makeMidTurnCompactionHook(run, spy.fn)({} as never, undefined);
    expect(update).toBeDefined();
    expect(spy.phases).toEqual(["start", "complete"]);
    expect(spy.outcome).toMatchObject({ ok: true, summarized: false });
    const text = (
      run.agent.state.messages[0] as unknown as { content: { text: string }[] }
    ).content[0].text;
    expect(text).toContain("[context rollover");
  });
});

describe("usedTokens 口径", () => {
  test("usage 可用：usedTokens 即请求总占用，不再叠加系统提示词/工具", () => {
    const run = makeRun([
      userMsg("hi"),
      {
        role: "assistant",
        content: [{ type: "text", text: "a" }],
        stopReason: "stop",
        usage: { input: 5_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 5_100 },
      } as unknown as Message,
    ]);
    const state = run.agent.state as unknown as Record<string, unknown>;
    state.systemPrompt = "x".repeat(40);
    state.tools = [
      { name: "bash", description: "run", parameters: { type: "object" } },
    ];
    const info = contextInfo(run);
    expect(info.messageTokens).toBe(5_100);
    expect(info.usedTokens).toBe(5_100);
  });

  test("无 usage：usedTokens = 消息 + 系统提示词 + 工具 三项相加", () => {
    const run = makeRun([userMsg("hi")]);
    const state = run.agent.state as unknown as Record<string, unknown>;
    state.systemPrompt = "x".repeat(40); // 10 token
    state.tools = [
      { name: "bash", description: "run", parameters: { type: "object" } },
    ];
    const info = contextInfo(run);
    expect(info.usedTokens).toBe(
      info.messageTokens + info.systemPromptTokens + info.toolTokens,
    );
    expect(info.systemPromptTokens).toBe(10);
  });
});

describe("sessionCacheMissStats", () => {
  test("无转录文件：全零", () => {
    expect(sessionCacheMissStats("no-such-session")).toEqual({
      requests: 0,
      misses: 0,
      rebuilds: 0,
      missedTokens: 0,
      missCount: 0,
      lastMiss: null,
      recent: { requests: 0, hitRate: null },
    });
  });

  const line =
    (at: number, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: "message",
        seq: at,
        ui: null,
        agent: {
          role: "assistant",
          content: [{ type: "text", text: "a" }],
          stopReason: "stop",
          timestamp: 1_000 + at * 1_000,
          model: "m",
          provider: "p",
          usage,
          ...extra,
        },
      });
  const writeSession = (id: string, rows: string[]) =>
    writeFileSync(sessionPath(id), rows.join("\n") + "\n", "utf8");

  test("冷启动/预期重建不计 miss；≥2000 且 ≥5% 记 miss；错误轮不计", () => {
    const id = `miss-${sessionCounter++}`;
    const row = (seq: number, usage: Record<string, number>, stopReason = "stop") =>
      line(seq, usage, { stopReason });
    writeSession(id, [
      // 0：冷启动首轮（全是写入），不计 miss
      row(0, { input: 9000, cacheRead: 0, cacheWrite: 9000, output: 10 }),
      // 1：正常命中
      row(1, { input: 10, cacheRead: 9000, cacheWrite: 100, output: 10 }),
      // 2：重处理 3000/9000=33% 且 ≥2000 → miss
      row(2, { input: 3000, cacheRead: 6000, cacheWrite: 0, output: 10 }),
      // 3：重处理 600 token <2000 → 不计
      row(3, { input: 600, cacheRead: 8400, cacheWrite: 0, output: 10 }),
      // 4：错误轮整行不计
      row(4, { input: 50000, cacheRead: 0, cacheWrite: 0, output: 0 }, "error"),
    ]);
    expect(sessionCacheMissStats(id, null)).toMatchObject({
      requests: 4,
      misses: 1,
      rebuilds: 0,
      // pi 口径只认第 2 轮那次真重算：min(上一轮 9110, 本轮 9000) − 6000 = 3000
      missedTokens: 3_000,
      missCount: 1,
    });
    // 检查点 afterSeq=1：seq>1 的首个请求记为预期重建，miss 相应少一次
    expect(sessionCacheMissStats(id, 1)).toMatchObject({
      requests: 4,
      misses: 0,
      rebuilds: 1,
    });
  });

  test("新增内容不算重算：上一轮 prompt 全命中时 missedTokens = 0", () => {
    // 旧口径会把这轮记成 miss（input 3000 ≥2000 且 ≥5%），但 cacheRead 已经
    // 覆盖了上一轮全部 prompt → 纯新增内容，没有重算。这正是 18/48 里大多数"miss"。
    const id = `miss-new-${sessionCounter++}`;
    writeSession(id, [
      line(0, { input: 20_000, output: 100, cacheRead: 0, cacheWrite: 0 }),
      line(1, { input: 3_000, output: 100, cacheRead: 20_000, cacheWrite: 0 }),
      line(2, { input: 200, output: 100, cacheRead: 23_000, cacheWrite: 0 }),
    ]);
    const stats = sessionCacheMissStats(id);
    expect(stats.misses).toBe(1); // 旧口径仍会记（兼容旧面板分母）
    expect(stats.missCount).toBe(0);
    expect(stats.missedTokens).toBe(0);
    // 近 N 轮命中率（含冷启动轮）：43,000 / 66,200
    expect(stats.recent.requests).toBe(3);
    expect(stats.recent.hitRate).toBeCloseTo(43_000 / 66_200, 4);
  });

  test("整段重算（空闲越过 TTL）计入 missedTokens 并带空闲归因", () => {
    const id = `miss-ttl-${sessionCounter++}`;
    writeSession(id, [
      line(0, { input: 20_000, output: 100, cacheRead: 0, cacheWrite: 0 }),
      // 6 分钟后：上一轮 20,000 的 prompt（input+cacheRead+cacheWrite，不含 output）
      // 只剩 128 命中 → 重算 19,872
      JSON.stringify({
        type: "message",
        seq: 1,
        ui: null,
        agent: {
          role: "assistant",
          content: [{ type: "text", text: "a" }],
          stopReason: "stop",
          timestamp: 1_000 + 6 * 60_000,
          model: "m",
          provider: "p",
          usage: { input: 19_972, output: 100, cacheRead: 128, cacheWrite: 0 },
        },
      }),
    ]);
    const stats = sessionCacheMissStats(id);
    expect(stats.missCount).toBe(1);
    expect(stats.missedTokens).toBe(19_872);
    expect(stats.lastMiss).toMatchObject({
      tokens: 19_872,
      idleMs: 6 * 60_000,
      modelChanged: false,
    });
  });

  test("模型切换：归因走 modelChanged（即使间隔很短）", () => {
    const id = `miss-model-${sessionCounter++}`;
    writeSession(id, [
      // 冷启动要带一次缓存写入：否则整段"从未上报缓存活动"，按 pi 判据不计重算
      line(0, { input: 20_000, output: 100, cacheRead: 0, cacheWrite: 20_000 }, { model: "a" }),
      line(1, { input: 20_000, output: 100, cacheRead: 0, cacheWrite: 0 }, { model: "b" }),
    ]);
    const stats = sessionCacheMissStats(id);
    expect(stats.missCount).toBe(1);
    expect(stats.lastMiss).toMatchObject({ modelChanged: true });
  });

  test("provider 从未上报缓存活动：整段不计重算（reportedCache 判据）", () => {
    const id = `miss-nocache-${sessionCounter++}`;
    writeSession(id, [
      line(0, { input: 20_000, output: 100, cacheRead: 0, cacheWrite: 0 }),
      line(1, { input: 21_000, output: 100, cacheRead: 0, cacheWrite: 0 }),
    ]);
    const stats = sessionCacheMissStats(id);
    expect(stats.missCount).toBe(0);
    expect(stats.missedTokens).toBe(0);
  });
});

// appendCompactionRow 在恢复测试里只当 fixture 用：造一条检查点行
function appendFixture(nextSeq: number) {
  const id = `fixture-${sessionCounter++}`;
  writeFileSync(sessionPath(id), "", "utf8");
  const row = {
    seq: nextSeq,
    summary: "CHECKPOINT SUMMARY",
    tokensBefore: 1234,
    throughSeq: 1,
    createdAt: new Date().toISOString(),
    details: { generation: 1, strategy: "summary" },
  };
  appendCompactionRow(id, row);
  return readCompaction(id)!;
}
