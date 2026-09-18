import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { onAgentEvent, setActiveReqId, beginRun } from "./stream";
import { initStorage, sessionPath } from "./storage";
import { sessionInsert } from "./hostdb";
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
  threadId: "th-stream",
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
    setActiveReqId("th-stream", "r1");
    beginRun("th-stream");
  });

  afterAll(() => {
    setActiveReqId("th-stream", null);
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

  test("message_end with error stopReason emits an error chunk", async () => {
    // message_end 现在先 await persist 再发 chunk（落盘在 reqId 短路之前），断言需等 settle
    await onAgentEvent(
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

  test("tool result image blocks emit data-image chunks after output", () => {
    onAgentEvent(
      ev({
        type: "tool_execution_end",
        toolCallId: "call-img",
        toolName: "generate_image",
        result: {
          content: [
            { type: "text", text: "画好了" },
            { type: "image", data: "aGk=", mimeType: "image/png" },
          ],
        },
      }),
      run,
    );
    const out = JSON.parse(lines[lines.length - 2]);
    const img = JSON.parse(lines[lines.length - 1]);
    expect(out).toEqual({
      id: "r1",
      chunk: { type: "tool-output-available", toolCallId: "call-img", output: "画好了\n" },
    });
    expect(img.id).toBe("r1");
    expect(img.chunk.type).toBe("data-image");
    expect(img.chunk.id).toBe("img-call-img-0");
    expect(img.chunk.data).toEqual({
      src: "data:image/png;base64,aGk=",
      mimeType: "image/png",
      // base64 长度 4 ×3/4 ≈ 3（近似值，不精确解码，见 image-parts.ts）
      bytes: 3,
      toolCallId: "call-img",
      toolName: "generate_image",
      alt: "画好了",
    });
  });

  test("oversized image blocks stay off the wire (placeholder appended to output)", () => {
    const big = "A".repeat(4 * 1024 * 1024); // ≈3 MiB 原始
    onAgentEvent(
      ev({
        type: "tool_execution_end",
        toolCallId: "call-big",
        toolName: "screenshot",
        result: {
          content: [
            { type: "text", text: "shot" },
            { type: "image", data: big, mimeType: "image/png" },
          ],
        },
      }),
      run,
    );
    const linesNow = lines.slice(-2);
    expect(JSON.parse(linesNow[1]).chunk.type).toBe("tool-output-available"); // 只有一条，无 data-image
    expect(JSON.parse(linesNow[1]).chunk.output).toContain("图片未展示");
  });

  test("no output when no active request", () => {
    setActiveReqId("th-stream", null);
    const before = lines.length;
    onAgentEvent(
      ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } }),
      run,
    );
    expect(lines.length).toBe(before);
    setActiveReqId("th-stream", "r1");
  });
});

// L0-1 回归：assistant/toolResult 在 message_end 即落盘，不再只有 agent_end 一个提交点
describe("onAgentEvent message_end persistence", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-stream-persist-"));

  beforeAll(() => {
    initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  });

  async function mkRun(id: string): Promise<Running> {
    await sessionInsert(id, tmp);
    writeFileSync(sessionPath(id), "", "utf8");
    beginRun("th-" + id);
    return {
      agent: { state: { messages: [] as unknown[] } },
      threadId: "th-" + id,
      sessionId: id,
      cwd: tmp,
      persistedSeq: 0,
      jsonlSeq: 0,
    } as unknown as Running;
  }
  const msgs = (r: Running) => r.agent.state.messages as unknown[];
  const rows = (id: string) =>
    readFileSync(sessionPath(id), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; agent: { role: string } });

  test("assistant message_end 落盘即使没有 agent_end（旁路 run 无 reqId 也覆盖）", async () => {
    const id = "stream-persist-bypass";
    const r = await mkRun(id);
    // 模拟 agent-core 时序：消息先 push 进 state.messages，监听器才收到 message_end
    const user = { role: "user", content: "写个小游戏" };
    const assistant = { role: "assistant", content: [{ type: "text", text: "好的" }], stopReason: "stop" };
    setActiveReqId(r.threadId, null); // 旁路/automation run：无协议 reqId
    msgs(r).push(user);
    await onAgentEvent(ev({ type: "message_end", message: user }), r);
    const before = lines.length;
    msgs(r).push(assistant);
    await onAgentEvent(ev({ type: "message_end", message: assistant }), r);
    expect(lines.length).toBe(before); // 无 reqId → 不上协议流，但落盘必须发生
    expect(rows(id).map((x) => x.agent.role)).toEqual(["user", "assistant"]);
    expect(r.persistedSeq).toBe(2);
  });

  test("多条消息按 message_end 增量追加，已落盘行不重写", async () => {
    const id = "stream-persist-inc";
    const r = await mkRun(id);
    setActiveReqId(r.threadId, "r-inc");
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { file_path: "a" } }],
      stopReason: "toolUse",
    };
    const toolResult = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "out" }],
      isError: false,
    };
    msgs(r).push(assistant);
    await onAgentEvent(ev({ type: "message_end", message: assistant }), r);
    const first = readFileSync(sessionPath(id), "utf8");
    msgs(r).push(toolResult);
    await onAgentEvent(ev({ type: "message_end", message: toolResult }), r);
    const after = readFileSync(sessionPath(id), "utf8");
    expect(after.startsWith(first)).toBe(true);
    expect(rows(id).map((x) => x.agent.role)).toEqual(["assistant", "toolResult"]);
    // 再次 message_end（persist 增量视图无新消息）文件不变
    await onAgentEvent(ev({ type: "message_end", message: toolResult }), r);
    expect(readFileSync(sessionPath(id), "utf8")).toBe(after);
    setActiveReqId(r.threadId, null);
  });
});
