import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { createTraceRunRecorder, readTraceRuns, type TraceRunRecord } from "./trace";
import { initStorage } from "../storage/storage";
import { resetStorageForTest } from "../storage/hostdb";

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
    expect(llm.detail?.request).toContain("[user] 你好");
    expect(llm.detail?.request).toContain("[tool_call] bash(");
    expect(llm.detail?.request).toContain("[图片]");
    expect(llm.detail?.response).toBe("这是回复正文");
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
