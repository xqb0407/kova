import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { onAgentEvent, setActiveReqId, beginRun } from "./stream";
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
