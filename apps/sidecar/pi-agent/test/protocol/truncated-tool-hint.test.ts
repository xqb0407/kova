import { describe, test, expect } from "bun:test";
import { augmentTruncatedToolCallErrors } from "../../src/protocol/prompt-pipeline";

const CORE_TRUNCATION_TEXT =
  'Tool call "write" was not executed: the response hit the output token limit, ' +
  "so its arguments may be truncated. Re-issue the tool call with complete arguments.";

const toolResult = (text: string, isError = true) => ({
  role: "toolResult" as const,
  toolCallId: "call-1",
  toolName: "write",
  content: [{ type: "text" as const, text }],
  isError,
  timestamp: 0,
});

describe("augmentTruncatedToolCallErrors", () => {
  test("命中截断错误：追加拆分写入指引", () => {
    const msgs = [toolResult(CORE_TRUNCATION_TEXT)];
    augmentTruncatedToolCallErrors(msgs);
    const text = (msgs[0] as { content: { text: string }[] }).content[0].text;
    expect(text.startsWith(CORE_TRUNCATION_TEXT)).toBe(true);
    expect(text).toContain("split the file into parts");
    expect(text).toContain("do NOT simply re-issue");
  });

  test("幂等：重复调用不重复追加", () => {
    const msgs = [toolResult(CORE_TRUNCATION_TEXT)];
    augmentTruncatedToolCallErrors(msgs);
    const once = (msgs[0] as { content: { text: string }[] }).content[0].text;
    augmentTruncatedToolCallErrors(msgs);
    augmentTruncatedToolCallErrors(msgs);
    expect((msgs[0] as { content: { text: string }[] }).content[0].text).toBe(once);
  });

  test("非错误 / 非截断 / 普通消息一律不动", () => {
    const other = toolResult("old_string not found in a.js", true);
    const notError = toolResult(CORE_TRUNCATION_TEXT, false);
    const user = { role: "user", content: "hi", timestamp: 0 };
    const msgs = [other, notError, user, toolResult(CORE_TRUNCATION_TEXT)];
    const before = JSON.stringify([other, notError, user]);
    augmentTruncatedToolCallErrors(msgs);
    expect(JSON.stringify([other, notError, user])).toBe(before);
    // 只有最后一条（isError 截断错误）被增强
    expect(
      (msgs[0] as { content: { text: string }[] }).content[0].text,
    ).toBe("old_string not found in a.js");
    expect(
      (msgs[3] as { content: { text: string }[] }).content[0].text,
    ).toContain("split the file into parts");
  });

  test("image 内容块与畸形条目不抛错、不改动", () => {
    const msgs = [
      {
        role: "toolResult",
        toolCallId: "c",
        toolName: "read",
        content: [
          { type: "text", text: CORE_TRUNCATION_TEXT },
          { type: "image", data: "iVBORw==", mimeType: "image/png" },
        ],
        isError: true,
        timestamp: 0,
      },
      null,
      { role: "toolResult" },
    ] as unknown[];
    expect(() => augmentTruncatedToolCallErrors(msgs)).not.toThrow();
    expect(
      (msgs[0] as { content: { text: string }[] }).content[0].text,
    ).toContain("split the file into parts");
    expect((msgs[0] as { content: unknown[] }).content[1]).toEqual({
      type: "image",
      data: "iVBORw==",
      mimeType: "image/png",
    });
  });
});
