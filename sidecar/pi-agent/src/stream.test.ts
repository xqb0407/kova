import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { onAgentEvent, setCurrentReqId, beginRun } from "./stream";
import type { Running } from "./types";

/** 捕获协议流（stream.send 写 process.stdout） */
const lines: string[] = [];
let origWrite: typeof process.stdout.write;

beforeAll(() => {
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (
    c: unknown,
  ) => {
    lines.push(String(c));
    return true;
  };
});

afterAll(() => {
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
    origWrite as unknown as (c: unknown) => boolean;
});

const run = {
  agent: { state: { messages: [] } },
  sessionId: "s",
  cwd: ".",
  persistedSeq: 0,
} as unknown as Running;

const ev = (e: Record<string, unknown>) => e as unknown as AgentEvent;
const last = () => JSON.parse(lines[lines.length - 1]);

describe("onAgentEvent", () => {
  let textId = "";
  let reasoningId = "";

  beforeAll(() => {
    setCurrentReqId("r1");
    beginRun();
  });

  afterAll(() => {
    setCurrentReqId(null);
  });

  test("text_start allocates a stable content id", () => {
    onAgentEvent(
      ev({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
      run,
    );
    const chunk = last().chunk as { type: string; id: string };
    expect(last().id).toBe("r1");
    expect(chunk.type).toBe("text-start");
    expect(chunk.id).toMatch(/^text-\d+-0$/);
    textId = chunk.id;
  });

  test("text_delta reuses the same content id", () => {
    onAgentEvent(
      ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } }),
      run,
    );
    expect(last()).toEqual({ id: "r1", chunk: { type: "text-delta", id: textId, delta: "hi" } });
  });

  test("text_end closes the content", () => {
    onAgentEvent(
      ev({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } }),
      run,
    );
    expect(last()).toEqual({ id: "r1", chunk: { type: "text-end", id: textId } });
  });

  test("thinking events use reasoning ids", () => {
    onAgentEvent(
      ev({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } }),
      run,
    );
    const chunk = last().chunk as { type: string; id: string };
    expect(chunk.type).toBe("reasoning-start");
    expect(chunk.id).toMatch(/^reasoning-\d+-1$/);
    reasoningId = chunk.id;
    onAgentEvent(
      ev({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 1 } }),
      run,
    );
    expect(last()).toEqual({ id: "r1", chunk: { type: "reasoning-end", id: reasoningId } });
  });

  test("message_end with error stopReason emits an error chunk", () => {
    onAgentEvent(
      ev({ type: "message_end", message: { stopReason: "error", errorMessage: "boom" } }),
      run,
    );
    expect(last()).toEqual({ id: "r1", chunk: { type: "error", errorText: "boom" } });
  });

  test("tool events carry call id and output", () => {
    onAgentEvent(
      ev({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { file_path: "a" } }),
      run,
    );
    expect(last()).toEqual({
      id: "r1",
      chunk: { type: "tool-input-available", toolCallId: "call-1", toolName: "read", input: { file_path: "a" } },
    });
    onAgentEvent(
      ev({ type: "tool_execution_end", toolCallId: "call-1", result: { content: [{ type: "text", text: "out" }] } }),
      run,
    );
    expect(last()).toEqual({
      id: "r1",
      chunk: { type: "tool-output-available", toolCallId: "call-1", output: "out" },
    });
  });

  test("no output when no active request", () => {
    setCurrentReqId(null);
    const before = lines.length;
    onAgentEvent(
      ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } }),
      run,
    );
    expect(lines.length).toBe(before);
    setCurrentReqId("r1");
  });
});
