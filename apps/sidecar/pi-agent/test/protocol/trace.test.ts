import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { createTraceRunRecorder, readTraceRuns, type TraceRunRecord } from "../../src/protocol/trace";
import { initStorage } from "../../src/storage/storage";
import { resetStorageForTest } from "../../src/storage/hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-trace-"));

beforeAll(() => {
  // 本地存储模式（storage.initStorage 同时钉 sessionsDir，traces 子目录落这里）
  initStorage(path.join(tmp, "state.db"), tmp);
});

afterAll(() => {
  // bun test 单进程共享模块注册表：清底层连接，避免污染后续文件
  resetStorageForTest();
});

/** 构造 assistant 消息（record 形状，与 pi-ai AssistantMessage 结构对齐） */
const assistantMsg = (over: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [],
  provider: "test-provider",
  model: "test-model",
  stopReason: "endTurn",
  timestamp: Date.now(),
  usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18 },
  ...over,
});

const ev = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, ...extra }) as unknown as AgentEvent;

describe("createTraceRunRecorder", () => {
  test("完整 run：两轮（工具调用 + 收尾）→ 树形/用量/状态", () => {
    const rec = createTraceRunRecorder("sess-1", "ui");
    rec.handle(ev("agent_start"));
    // 第一轮：llm 失败重试无关，一次工具调用后收口
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } }));
    rec.handle(ev("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: {}, isError: false }));
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "toolUse" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    // 第二轮：最终回答
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "endTurn" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));

    expect(rec.settle()).toBe(true);
    const runs = readTraceRuns("sess-1", 10);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe("ok");
    expect(run.source).toBe("ui");
    expect(run.runId).toMatch(/^[0-9a-f]{32}$/);
    expect(run.usage).toEqual({ input: 20, output: 10, cacheRead: 4, cacheWrite: 2 });
    expect(run.spans).toHaveLength(2);
    expect(run.model).toBe("test-provider/test-model");

    const turn1 = run.spans[0]!;
    expect(turn1.kind).toBe("turn");
    expect(turn1.status).toBe("ok");
    expect(turn1.endMs).toBeGreaterThanOrEqual(turn1.startMs);
    const children = turn1.children ?? [];
    expect(children.map((s) => s.kind)).toEqual(["llm_call", "tool_call"]);
    const tool = children.find((s) => s.kind === "tool_call")!;
    expect(tool.name).toBe("bash");
    expect(tool.status).toBe("ok");
    expect(tool.attrs?.args).toContain("ls");
    const llm = children.find((s) => s.kind === "llm_call")!;
    expect(llm.attrs?.model).toBe("test-provider/test-model");
    expect(llm.attrs?.stopReason).toBe("toolUse");
    expect(llm.attrs?.inputTokens).toBe(10);
  });

  test("subagent 来源带 agent 名：随记录落盘；未传则字段缺省", () => {
    const rec = createTraceRunRecorder("sess-agent", "subagent", undefined, "Explorer");
    rec.handle(ev("agent_start"));
    rec.handle(ev("agent_end", { messages: [] }));
    expect(rec.settle()).toBe(true);
    expect(readTraceRuns("sess-agent", 10)[0]?.agent).toBe("Explorer");
    // recorder 自身也暴露（面板在飞 run 的头像解析走它）
    expect(rec.agent).toBe("Explorer");

    const plain = createTraceRunRecorder("sess-agent-plain", "ui");
    plain.handle(ev("agent_start"));
    plain.handle(ev("agent_end", { messages: [] }));
    expect(plain.settle()).toBe(true);
    expect(readTraceRuns("sess-agent-plain", 10)[0]?.agent).toBeUndefined();
  });

  test("retry 打点：两次重试各自成 span，attrs 带 attempt/delayMs/code", () => {
    const rec = createTraceRunRecorder("sess-2", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.noteRetry({ attempt: 1, delayMs: 2000, code: "PROVIDER_RATE_LIMITED", message: "429 too many" });
    rec.noteRetrySettled();
    rec.noteRetry({ attempt: 2, delayMs: 4000, code: "PROVIDER_RATE_LIMITED" });
    rec.noteRetrySettled();
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "endTurn" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const run = readTraceRuns("sess-2")[0]!;
    const retries = (run.spans[0]!.children ?? []).filter((s) => s.kind === "retry");
    expect(retries).toHaveLength(2);
    expect(retries[0]!.name).toBe("PROVIDER_RATE_LIMITED");
    expect(retries[0]!.attrs?.attempt).toBe(1);
    expect(retries[0]!.attrs?.delayMs).toBe(2000);
    expect(retries[0]!.attrs?.message).toContain("429");
    expect(retries[0]!.endMs).toBeGreaterThanOrEqual(retries[0]!.startMs);
    expect(retries[1]!.attrs?.attempt).toBe(2);
  });

  test("error 轮：run status=error、llm span 带错误信息、用量不计入", () => {
    const rec = createTraceRunRecorder("sess-3", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    // 重试未 settle 就收尾：finalize 兜底闭合
    rec.noteRetry({ attempt: 1, delayMs: 1000, code: "NETWORK_ERROR" });
    rec.handle(
      ev("message_end", {
        message: assistantMsg({ stopReason: "error", errorMessage: "boom: network down" }),
      }),
    );
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const run = readTraceRuns("sess-3")[0]!;
    expect(run.status).toBe("error");
    expect(run.usage).toBeUndefined();
    const llm = (run.spans[0]!.children ?? []).find((s) => s.kind === "llm_call")!;
    expect(llm.status).toBe("error");
    expect(llm.attrs?.errorMessage).toContain("network down");
    const retry = (run.spans[0]!.children ?? []).find((s) => s.kind === "retry")!;
    expect(retry.endMs).toBeGreaterThan(0);
  });

  test("aborted 轮：run status=aborted", () => {
    const rec = createTraceRunRecorder("sess-4", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "aborted" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();
    expect(readTraceRuns("sess-4")[0]!.status).toBe("aborted");
  });

  test("内容捕获：noteRequest → detail.request，message_end 记录 response", () => {
    const rec = createTraceRunRecorder("sess-7", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    // streamFn 时序：请求上下文先于 message_start 到达
    rec.noteRequest({
      systemPrompt: "你是测试助手",
      messages: [
        // system 消息是提示词本体（agent-core 把 systemPrompt 折叠进首条 system
        // 消息，streamFn 的 context 只有 messages）：空白不渲染（空镜像跳过），
        // 带正文的（提示词热换后）照常渲染，且截断上限是 32k 不是普通消息的 2k
        { role: "system", content: "" },
        { role: "system", content: "热换后的提示词" },
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: { cmd: "ls" } }],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "工具输出" }, { type: "image", data: "xxx" }],
        },
      ],
    });
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(
      ev("message_end", {
        message: assistantMsg({ content: [{ type: "text", text: "这是回复正文" }] }),
      }),
    );
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const run = readTraceRuns("sess-7")[0]!;
    const llm = (run.spans[0]!.children ?? []).find((s) => s.kind === "llm_call")!;
    expect(llm.detail?.request).toContain("[system] 你是测试助手");
    expect(llm.detail?.request).toContain("[system] 热换后的提示词");
    expect(llm.detail?.request).not.toContain("[system]（空）");
    expect(llm.detail?.request).toContain("[user] 你好");
    expect(llm.detail?.request).toContain("[tool_call] bash(");
    expect(llm.detail?.request).toContain("[图片]");
    expect(llm.detail?.response).toBe("这是回复正文");
    // 运行记录标题：最后一条 user 消息（原始 context，不经渲染截断）
    expect(llm.attrs?.prompt).toBe("你好");
  });

  test("运行记录标题只挂首个 llm_call；请求正文截断不影响标题", () => {
    const rec = createTraceRunRecorder("sess-prompt", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    // 渲染后超过 REQUEST_MAX：标题必须取自原始 context 的尾部消息
    const filler = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `历史消息 ${i} ${"y".repeat(2_000)}`,
    }));
    rec.noteRequest({
      systemPrompt: "你是测试助手",
      messages: [...filler, { role: "user", content: "真正的这一问" }],
    });
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("message_end", { message: assistantMsg() }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));

    rec.handle(ev("turn_start"));
    rec.noteRequest({ systemPrompt: "你是测试助手", messages: [] });
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("message_end", { message: assistantMsg() }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const run = readTraceRuns("sess-prompt")[0]!;
    const llms = run.spans.flatMap((t) =>
      (t.children ?? []).filter((s) => s.kind === "llm_call"),
    );
    expect(llms).toHaveLength(2);
    expect(llms[0]!.attrs?.prompt).toBe("真正的这一问");
    // 同 run 的后续调用不重复带标题（列表/检查器不刷屏）
    expect(llms[1]!.attrs?.prompt).toBeUndefined();
    // 渲染正文确实被总闸截断（证明标题不是从 detail.request 里解析出来的）
    expect(llms[0]!.detail?.request).toContain("请求上下文已截断");
  });

  test("system 消息用 32k 上限（提示词本体），普通消息仍 2k", () => {
    const rec = createTraceRunRecorder("sess-sys-cap", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.noteRequest({
      messages: [
        // 40KB 的系统提示词：保留 32k，截断处带可见标记
        { role: "system", content: "S".repeat(40_000) },
        { role: "user", content: "u".repeat(40_000) },
      ],
    });
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "endTurn" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const run = readTraceRuns("sess-sys-cap")[0]!;
    const llm = (run.spans[0]!.children ?? []).find((s) => s.kind === "llm_call")!;
    const request = llm.detail!.request!;
    const sysLine = request.split("\n\n").find((l) => l.startsWith("[system]"))!;
    const userLine = request.split("\n\n").find((l) => l.startsWith("[user]"))!;
    expect(sysLine.length).toBeGreaterThan(32_000); // "[system] " + 32000 + 尾标
    expect(sysLine).toContain("…[本条已截断]");
    expect(userLine.length).toBeLessThan(2_100); // "[user] " + 2000 + 尾标
    expect(userLine).toContain("…[本条已截断]");
  });

  test("残留 run：新 agent_start 顶替时按 error 暂存，settle 一并落盘", () => {
    const rec = createTraceRunRecorder("sess-5", "automation");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    // 上一 run 没走到 agent_end 就被新 run 顶替
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "endTurn" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const runs = readTraceRuns("sess-5", 10);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.status).toBe("error");
    expect(runs[0]!.source).toBe("automation");
    expect(runs[1]!.status).toBe("ok");
  });

  test("settle 无 run 时 no-op；tool_execution_update 忽略", () => {
    const rec = createTraceRunRecorder("sess-6", "ui");
    expect(rec.settle()).toBe(false);
    rec.handle(ev("agent_start"));
    rec.handle(ev("tool_execution_update", { toolCallId: "t9", toolName: "x", args: {}, partialResult: 1 }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();
    const run = readTraceRuns("sess-6")[0]!;
    // update 不产生 span，也没有隐式 turn（无 turn_start/message/tool 时无子树）
    expect(run.spans).toHaveLength(0);
  });

  test("v2 身份：记录带 traceId，每 span 有唯一 spanId、parentSpanId 指向所属 turn", () => {
    const rec = createTraceRunRecorder("sess-id", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: {} }));
    rec.handle(ev("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: {}, isError: false }));
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "toolUse" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const run = readTraceRuns("sess-id")[0]!;
    expect(run.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(run.traceId).toBe(run.runId); // v1 兼容别名同值
    const turn = run.spans[0]!;
    expect(turn.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(turn.parentSpanId).toBeUndefined(); // turn 挂在 run 根下
    const ids = new Set<string>();
    for (const child of turn.children ?? []) {
      expect(child.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(child.parentSpanId).toBe(turn.spanId);
      ids.add(child.spanId!);
    }
    expect(ids.size).toBe((turn.children ?? []).length); // 同轮子 span id 互不相同
  });

  test("委派回填：traceId/spanIdForToolCall 取到父身份，子 run 带上因果边", () => {
    const rec = createTraceRunRecorder("sess-parent", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("tool_execution_start", { toolCallId: "task-1", toolName: "task", args: {} }));
    const parentTraceId = rec.traceId;
    const parentSpanId = rec.spanIdForToolCall("task-1");
    expect(parentTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(parentSpanId).toMatch(/^[0-9a-f]{16}$/);
    rec.handle(ev("tool_execution_end", { toolCallId: "task-1", toolName: "task", result: {}, isError: false }));
    // 工具收口后仍可查（OpenRun.toolSpanIds 不随 openTools 清理）
    expect(rec.spanIdForToolCall("task-1")).toBe(parentSpanId);
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "endTurn" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    // 子 run 回填父身份（模拟 SubagentRun 构造）
    const child = createTraceRunRecorder("sess-parent", "subagent", {
      parentRunId: parentTraceId,
      parentSpanId,
    });
    child.handle(ev("agent_start"));
    child.handle(ev("turn_start"));
    child.handle(ev("message_start", { message: assistantMsg() }));
    child.handle(ev("message_end", { message: assistantMsg({ stopReason: "endTurn" }) }));
    child.handle(ev("turn_end", { message: {}, toolResults: [] }));
    child.handle(ev("agent_end", { messages: [] }));
    child.settle();

    const runs = readTraceRuns("sess-parent", 10);
    const parentRun = runs.find((r) => r.source === "ui")!;
    const childRun = runs.find((r) => r.source === "subagent")!;
    expect(childRun.parentRunId).toBe(parentRun.traceId);
    expect(childRun.parentSpanId).toBe(parentSpanId);
    const taskSpan = (parentRun.spans[0]!.children ?? []).find((s) => s.name === "task")!;
    expect(taskSpan.spanId).toBe(parentSpanId);
  });

  test("工具收口：错误原因、出参与退出码都进 span", () => {
    const rec = createTraceRunRecorder("sess-tool-detail", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(
      ev("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { cmd: "pnpm i" } }),
    );
    rec.handle(
      ev("tool_execution_end", {
        toolCallId: "t1",
        toolName: "bash",
        isError: true,
        result: {
          content: [{ type: "text", text: "sh: pnpm: command not found" }],
          details: { exitCode: 127 },
        },
      }),
    );
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "endTurn" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const run = readTraceRuns("sess-tool-detail", 1)[0]!;
    const toolSpan = run.spans[0]!.children!.find((s) => s.kind === "tool_call")!;
    expect(toolSpan.status).toBe("error");
    // 失败正文两处都在：attrs 供面板直接显示，detail.response 供检查器展开
    expect(toolSpan.attrs?.errorMessage).toContain("pnpm: command not found");
    expect(toolSpan.detail?.response).toContain("pnpm: command not found");
    expect(toolSpan.attrs?.exitCode).toBe(127);
    // 入参仍在 attrs.args，不被结果挤掉
    expect(toolSpan.attrs?.args).toContain("pnpm i");
  });

  test("工具成功也记出参", () => {
    const rec = createTraceRunRecorder("sess-tool-ok", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("tool_execution_start", { toolCallId: "t1", toolName: "read", args: {} }));
    rec.handle(
      ev("tool_execution_end", {
        toolCallId: "t1",
        toolName: "read",
        isError: false,
        result: { content: [{ type: "text", text: "42 lines" }] },
      }),
    );
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "endTurn" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const run = readTraceRuns("sess-tool-ok", 1)[0]!;
    const toolSpan = run.spans[0]!.children!.find((s) => s.kind === "tool_call")!;
    expect(toolSpan.status).toBe("ok");
    expect(toolSpan.detail?.response).toContain("42 lines");
    // 成功路径不写 errorMessage（面板据此上红，没有就是没有）
    expect(toolSpan.attrs?.errorMessage).toBeUndefined();
  });

  test("终止归因：noteOutcome 上报优先于 stopReason 兜底", () => {
    const rec = createTraceRunRecorder("sess-outcome", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "endTurn" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    // 编排层：长度续跑预算烧完（stream.ts 才拿得到这个信息）
    rec.noteOutcome({ reason: "length-budget-exhausted", detail: "连续 3 次续跑未收尾" });
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const run = readTraceRuns("sess-outcome", 1)[0]!;
    expect(run.outcome?.reason).toBe("length-budget-exhausted");
    expect(run.outcome?.detail).toContain("续跑");
  });

  test("终止归因兜底：未上报时按 stopReason 翻译", () => {
    const rec = createTraceRunRecorder("sess-outcome-fallback", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "aborted" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    // aborted 必须翻成 user-stop 而不是 error：用户取消不是错误
    expect(readTraceRuns("sess-outcome-fallback", 1)[0]!.outcome?.reason).toBe("user-stop");
  });

  test("noteOutcome 无打开中的 run 时 no-op", () => {
    const rec = createTraceRunRecorder("sess-outcome-noop", "ui");
    expect(() => rec.noteOutcome({ reason: "error" })).not.toThrow();
    expect(rec.settle()).toBe(false);
  });
});

describe("readTraceRuns", () => {
  test("撕裂行跳过、limit 取末尾 N 个", () => {
    // sess-1 已有 1 条；追加坏行 + 两条好记录
    const rec = createTraceRunRecorder("sess-1", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "endTurn" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();
    rec.handle(ev("agent_start"));
    rec.settle();

    appendFileSync(path.join(tmp, "traces", "sess-1.jsonl"), "{torn line\n");
    const all = readTraceRuns("sess-1", 200);
    expect(all.length).toBe(3); // 坏行被跳过
    expect(all.every((r: TraceRunRecord) => r.runId)).toBe(true);
    const limited = readTraceRuns("sess-1", 2);
    expect(limited).toHaveLength(2);
    expect(limited[1]!.runId).toBe(all[all.length - 1]!.runId);
  });

  test("文件缺失返回空数组", () => {
    expect(readTraceRuns("no-such-session", 10)).toEqual([]);
  });
});

/* ------------------------- 内存预算 / live 增量落盘 ------------------------- */

import { existsSync, readFileSync, writeFileSync, mkdirSync as mkdirS } from "node:fs";
import { traceLivePath, tracePath } from "../../src/storage/storage";
import { readLiveRun } from "../../src/protocol/trace";

/** 造一轮：1 次 llm（可带 detail）+ n 个工具 */
function oneTurn(i: number, toolCount: number, detailSize = 0) {
  const events: AgentEvent[] = [
    ev("turn_start"),
    ev("message_start", { message: assistantMsg() }),
    ev("message_end", {
      message: assistantMsg({
        stopReason: "toolUse",
        content: detailSize ? [{ type: "text", text: "x".repeat(detailSize) }] : [],
      }),
    }),
  ];
  for (let k = 0; k < toolCount; k++) {
    events.push(
      ev("tool_execution_start", {
        toolCallId: `t${i}-${k}`,
        toolName: "bash",
        args: { cmd: "ls" },
      }),
      ev("tool_execution_end", {
        toolCallId: `t${i}-${k}`,
        toolName: "bash",
        isError: false,
        result: detailSize ? { content: [{ type: "text", text: "y".repeat(detailSize) }] } : {},
      }),
    );
  }
  events.push(ev("turn_end", { message: {}, toolResults: [] }));
  return events;
}

const liveFile = (sid: string) => traceLivePath(sid);

describe("detail 内存预算", () => {
  test("超预算时从最旧摘正文，结构完整保留", () => {
    const rec = createTraceRunRecorder("sess-budget", "ui");
    rec.handle(ev("agent_start"));
    // 每轮 llm 请求上下文：原始 160KB（40 条 × 4000），逐条截断后约 80KB，
    // 40 轮约 3.2MB，远超 1MB 预算
    for (let i = 0; i < 40; i++) {
      // renderRequest 对普通消息 clip 到 2000 字符、system 32k（SYSTEM_TEXT_MAX），
      // 单条 systemPrompt 拉不高总量；凑到 REQUEST_MAX(128KB) 要靠多条消息
      rec.noteRequest({
        systemPrompt: "s",
        messages: Array.from({ length: 40 }, () => ({
          role: "user",
          content: "m".repeat(4_000),
        })),
      });
      for (const e of oneTurn(i, 2)) rec.handle(e);
    }
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const run = readTraceRuns("sess-budget", 1)[0]!;
    const allSpans = run.spans.flatMap((t) => [t, ...(t.children ?? [])]);
    const retained = allSpans.reduce(
      (n, sp) => n + (sp.detail?.request?.length ?? 0) + (sp.detail?.response?.length ?? 0),
      0,
    );
    // 正文总量受预算约束（余量 = 单个 span 最多可超预算的部分：请求 128KB + 回复 8KB）
    expect(retained).toBeLessThanOrEqual(1024 * 1024 + 128_000 + 8_000);
    // 但结构一个不少：40 轮、每轮 1 llm + 2 工具
    expect(run.spans).toHaveLength(40);
    for (const turn of run.spans) {
      expect(turn.children).toHaveLength(3);
      expect(turn.children!.every((c) => typeof c.spanId === "string")).toBe(true);
      expect(turn.children!.every((c) => c.endMs > 0)).toBe(true);
    }
    // 最旧的正文被摘掉，最新的还在（最旧优先）
    expect(run.spans[0]!.children![0]!.detail?.request).toBeUndefined();
    expect(run.spans[39]!.children![0]!.detail?.request).toBeDefined();
  });

  test("预算内不动任何正文", () => {
    const rec = createTraceRunRecorder("sess-budget-small", "ui");
    rec.handle(ev("agent_start"));
    rec.noteRequest({ systemPrompt: "short", messages: [] });
    for (const e of oneTurn(0, 1)) rec.handle(e);
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const run = readTraceRuns("sess-budget-small", 1)[0]!;
    expect(run.spans[0]!.children![0]!.detail?.request).toContain("short");
  });

  test("工具出参：成功截 1.5KB，失败保 8KB", () => {
    const rec = createTraceRunRecorder("sess-caps", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    // 成功：20KB 正文
    rec.handle(ev("tool_execution_start", { toolCallId: "ok1", toolName: "read", args: {} }));
    rec.handle(
      ev("tool_execution_end", {
        toolCallId: "ok1",
        toolName: "read",
        isError: false,
        result: { content: [{ type: "text", text: "a".repeat(20_000) }] },
      }),
    );
    // 失败：20KB stderr
    rec.handle(ev("tool_execution_start", { toolCallId: "bad1", toolName: "bash", args: {} }));
    rec.handle(
      ev("tool_execution_end", {
        toolCallId: "bad1",
        toolName: "bash",
        isError: true,
        result: { content: [{ type: "text", text: "e".repeat(20_000) }] },
      }),
    );
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "endTurn" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const kids = readTraceRuns("sess-caps", 1)[0]!.spans[0]!.children!;
    const ok = kids.find((s) => s.name === "read")!;
    const bad = kids.find((s) => s.name === "bash")!;
    const mark = "…[本条已截断]".length;
    expect(ok.detail!.response!.length).toBe(1_500 + mark);
    expect(ok.detail!.response!).toContain("…[本条已截断]");
    expect(bad.detail!.response!.length).toBe(8_000 + mark);
    expect(bad.detail!.response!).toContain("…[本条已截断]");
    // 面板红字那行另有 2KB 上限且走无标记 clip，短于正文
    expect(String(bad.attrs!.errorMessage).length).toBe(2_000);
  });
});

describe("live 增量落盘", () => {
  test("turn_end 追加轮行；settle 后本 run 的行被清", () => {
    const sid = "sess-live";
    const rec = createTraceRunRecorder(sid, "ui");
    rec.handle(ev("agent_start"));
    for (const e of oneTurn(0, 1)) rec.handle(e);

    // 跑到第 1 轮结束：live 里应有头行 + 1 条轮行
    expect(existsSync(liveFile(sid))).toBe(true);
    const lines = readFileSync(liveFile(sid), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.kind === "run")).toHaveLength(1);
    expect(lines.filter((l) => l.kind === "turn")).toHaveLength(1);
    expect(lines[0].pid).toBe(process.pid);

    // 再跑一轮 → 第 2 条轮行
    for (const e of oneTurn(1, 1)) rec.handle(e);
    const lines2 = readFileSync(liveFile(sid), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines2.filter((l) => l.kind === "turn")).toHaveLength(2);

    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();
    // 完整记录落主文件后 live 清零
    expect(readTraceRuns(sid, 1)).toHaveLength(1);
    expect(existsSync(liveFile(sid))).toBe(false);
  });

  test("readLiveRun：在飞 run 标 partial 且无 outcome", () => {
    const sid = "sess-live-read";
    const rec = createTraceRunRecorder(sid, "ui");
    rec.handle(ev("agent_start"));
    for (const e of oneTurn(0, 2)) rec.handle(e);

    const live = readLiveRun(sid);
    expect(live).toHaveLength(1);
    expect(live[0]!.partial).toBe(true);
    expect(live[0]!.outcome).toBeUndefined();
    expect(live[0]!.spans).toHaveLength(1);
    // live 头在 model 已知之前写；readLiveRun 从已闭合轮行里补 model/usage
    expect(live[0]!.model).toBe("test-provider/test-model");
    expect(live[0]!.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
  });

  test("readLiveRun 不返回异 pid 的空组（只有头没有轮）", () => {
    const sid = "sess-live-empty-read";
    const file = liveFile(sid);
    mkdirS(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        kind: "run",
        pid: 999_999,
        traceId: "dead-empty-read",
        sessionId: sid,
        source: "ui",
        startMs: 1_000,
        model: "dead/model",
      }) + "\n",
    );

    expect(readLiveRun(sid)).toHaveLength(0);
  });

  test("崩溃残留（异 pid）被 promote 成 partial + interrupted，live 被清", () => {
    const sid = "sess-crash";
    const file = liveFile(sid);
    mkdirS(path.dirname(file), { recursive: true });
    // 伪造另一个进程留下的残留：头行 pid 换成不可能的值
    writeFileSync(
      file,
      [
        JSON.stringify({
          kind: "run",
          pid: 999_999,
          traceId: "dead-run",
          sessionId: sid,
          source: "ui",
          startMs: 1_000,
          model: "test/model",
        }),
        JSON.stringify({
          kind: "turn",
          traceId: "dead-run",
          turn: {
            spanId: "abc",
            kind: "turn",
            startMs: 1_000,
            endMs: 2_000,
            status: "ok",
            children: [
              {
                spanId: "dead-llm",
                parentSpanId: "abc",
                kind: "llm_call",
                startMs: 1_100,
                endMs: 1_900,
                status: "ok",
                attrs: {
                  model: "dead/model",
                  inputTokens: 7,
                  outputTokens: 3,
                  cacheRead: 1,
                  cacheWrite: 0,
                },
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );

    // 新 run 起步 → promote 抢救
    const rec = createTraceRunRecorder(sid, "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const runs = readTraceRuns(sid, 10);
    const rescued = runs.find((r) => r.traceId === "dead-run")!;
    expect(rescued.partial).toBe(true);
    expect(rescued.outcome?.reason).toBe("interrupted");
    expect(rescued.spans).toHaveLength(1);
    // 抢救记录也要带上轮行里的模型与用量，不能只剩「未知/0」
    expect(rescued.model).toBe("dead/model");
    expect(rescued.usage).toEqual({ input: 7, output: 3, cacheRead: 1, cacheWrite: 0 });
    // 残留组是唯一内容 → 整个 live 文件被删（正确行为）；文件在不在都要断言不含残留
    const left = existsSync(file) ? readFileSync(file, "utf8") : "";
    expect(left).not.toContain("dead-run");
  });

  test("空的残留组（只有头没有轮）promote 时被清掉", () => {
    const sid = "sess-crash-empty";
    const file = liveFile(sid);
    mkdirS(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        kind: "run",
        pid: 999_999,
        traceId: "dead-empty",
        sessionId: sid,
        source: "ui",
        startMs: 1_000,
        model: "dead/model",
      }) + "\n",
    );

    const rec = createTraceRunRecorder(sid, "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    // 没有可抢救的轮 → 不写 interrupted 记录，但空组不能继续留在 live 里
    expect(readTraceRuns(sid, 10).some((r) => r.traceId === "dead-empty")).toBe(false);
    const left = existsSync(file) ? readFileSync(file, "utf8") : "";
    expect(left).not.toContain("dead-empty");
  });

  test("同 pid 的并发 run 不被误 promote（守住重复记录那个 bug）", () => {
    const sid = "sess-concurrent";
    // 主 run 在飞（同 pid），子代理并发写同一会话
    const main = createTraceRunRecorder(sid, "ui");
    main.handle(ev("agent_start"));
    for (const e of oneTurn(0, 1)) main.handle(e);

    // 此时另起一个 recorder（模拟 automation/子代理的另一个 run）
    const other = createTraceRunRecorder(sid, "subagent");
    other.handle(ev("agent_start"));
    other.handle(ev("agent_end", { messages: [] }));
    other.settle();

    // 主 run 的 live 行必须还在（没被当成残留抢走）
    const live = readLiveRun(sid);
    expect(live.some((r) => r.partial && r.spans.length === 1)).toBe(true);
    // 且主 run 还没进主文件（它还没收尾）
    expect(readTraceRuns(sid, 10).some((r) => r.outcome?.reason === "interrupted")).toBe(false);

    main.handle(ev("agent_end", { messages: [] }));
    main.settle();
    // 主 run 正常落盘为一条完整记录，没有重复
    const uiRuns = readTraceRuns(sid, 10).filter((r) => r.source === "ui");
    expect(uiRuns).toHaveLength(1);
    expect(uiRuns[0]!.partial).toBeUndefined();
  });

  test("反向：live 路径写失败时 handle 不抛、主记录照常落盘", () => {
    const sid = "sess-live-broken";
    // 把 live 路径变成一个目录 → appendFileSync 必然失败
    const file = liveFile(sid);
    mkdirS(file, { recursive: true });

    const rec = createTraceRunRecorder(sid, "ui");
    expect(() => rec.handle(ev("agent_start"))).not.toThrow();
    expect(() => {
      for (const e of oneTurn(0, 2)) rec.handle(e);
    }).not.toThrow();
    expect(() => rec.handle(ev("agent_end", { messages: [] }))).not.toThrow();
    expect(() => rec.settle()).not.toThrow();

    // 关键断言：live 挂了，主文件照常
    const runs = readTraceRuns(sid, 5);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.spans).toHaveLength(1);
    expect(runs[0]!.spans[0]!.children).toHaveLength(3);
  });
});

describe("tool_call 形态标签（模型采纳率观测）", () => {
  test("edit 批量/旧形态与 write 分块：记几字节的形态事实", () => {
    const rec = createTraceRunRecorder("sess-shape", "ui");
    rec.handle(ev("agent_start"));
    rec.handle(ev("turn_start"));
    rec.handle(ev("message_start", { message: assistantMsg() }));
    rec.handle(
      ev("tool_execution_start", {
        toolCallId: "e1",
        toolName: "edit",
        args: {
          file_path: "a.txt",
          edits: [
            { oldText: "x", newText: "y" },
            { oldText: "u", newText: "v" },
            { oldText: "p", newText: "q" },
          ],
        },
      }),
    );
    rec.handle(ev("tool_execution_end", { toolCallId: "e1", toolName: "edit", result: {}, isError: false }));
    rec.handle(
      ev("tool_execution_start", {
        toolCallId: "e2",
        toolName: "edit",
        args: { file_path: "a.txt", old_string: "x", new_string: "y" },
      }),
    );
    rec.handle(ev("tool_execution_end", { toolCallId: "e2", toolName: "edit", result: {}, isError: false }));
    rec.handle(
      ev("tool_execution_start", {
        toolCallId: "w1",
        toolName: "write",
        args: { file_path: "a.txt", content: "…", mode: "append" },
      }),
    );
    rec.handle(ev("tool_execution_end", { toolCallId: "w1", toolName: "write", result: {}, isError: false }));
    rec.handle(ev("message_end", { message: assistantMsg({ stopReason: "toolUse" }) }));
    rec.handle(ev("turn_end", { message: {}, toolResults: [] }));
    rec.handle(ev("agent_end", { messages: [] }));
    rec.settle();

    const run = readTraceRuns("sess-shape", 5)[0]!;
    const tools = (run.spans[0]!.children ?? []).filter((s) => s.kind === "tool_call");
    expect(tools.map((s) => s.attrs?.editForm)).toEqual(["batch-3", "legacy-single", undefined]);
    expect(tools[2]!.attrs?.writeMode).toBe("append");
  });
});
