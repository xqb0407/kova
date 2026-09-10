import { describe, test, expect } from "bun:test";
import {
  cleanSummarizedTitle,
  sessionTitleSummarizeContext,
  summarizeSessionTitle,
  SESSION_TITLE_SUMMARIZE_SYSTEM_PROMPT,
} from "./session-title-summarize";

describe("cleanSummarizedTitle", () => {
  test("去掉包裹引号与代码标记", () => {
    expect(cleanSummarizedTitle('"调试 WebSocket 重连"')).toBe("调试 WebSocket 重连");
    expect(cleanSummarizedTitle("`fix bug`")).toBe("fix bug");
    expect(cleanSummarizedTitle("「重构用户模块」")).toBe("重构用户模块");
  });

  test("去掉 Title 前缀", () => {
    expect(cleanSummarizedTitle("Title: Fix login")).toBe("Fix login");
    expect(cleanSummarizedTitle("标题：修复登录")).toBe("修复登录");
  });

  test("折叠空白并去尾部标点", () => {
    expect(cleanSummarizedTitle("  fix   the  bug.  ")).toBe("fix the bug");
    expect(cleanSummarizedTitle("查询数据？")).toBe("查询数据");
  });

  test("截断到 80 字符", () => {
    expect(cleanSummarizedTitle("x".repeat(120)).length).toBe(80);
  });
});

describe("sessionTitleSummarizeContext", () => {
  test("systemPrompt 与消息组装", () => {
    const ctx = sessionTitleSummarizeContext("帮我修复登录", "已修复");
    expect(ctx.systemPrompt).toBe(SESSION_TITLE_SUMMARIZE_SYSTEM_PROMPT);
    expect(ctx.messages).toHaveLength(1);
    const content = ctx.messages[0].content as string;
    expect(content.includes("帮我修复登录")).toBe(true);
    expect(content.includes("已修复")).toBe(true);
  });

  test("无回复时只带 prompt；超长截断", () => {
    const ctx = sessionTitleSummarizeContext("p".repeat(2000));
    const content = ctx.messages[0].content as string;
    expect(content.length).toBeLessThan(1100);
    expect(content).not.toContain("Assistant Response");
  });
});

describe("summarizeSessionTitle", () => {
  const fakeModel = { id: "m", provider: "p" } as Parameters<
    typeof summarizeSessionTitle
  >[1];

  const fakeStream = (deltas: unknown[]) => async function* () {
    for (const d of deltas) yield d;
  };

  test("累积 text_delta 并清洗", async () => {
    const title = await summarizeSessionTitle(
      fakeStream([
        { type: "text_delta", delta: '"修复' },
        { type: "text_delta", delta: '登录。"' },
      ]),
      fakeModel,
      "帮我修复登录",
      "已修复",
    );
    expect(title).toBe("修复登录");
  });

  test("流内 error 事件返回 undefined", async () => {
    const title = await summarizeSessionTitle(
      fakeStream([{ type: "error", error: { message: "boom" } }]),
      fakeModel,
      "p",
    );
    expect(title).toBeUndefined();
  });

  test("流抛异常返回 undefined（非致命）", async () => {
    const title = await summarizeSessionTitle(
      async function* () {
        throw new Error("network down");
      },
      fakeModel,
      "p",
    );
    expect(title).toBeUndefined();
  });

  test("空输出返回 undefined", async () => {
    const title = await summarizeSessionTitle(fakeStream([]), fakeModel, "p");
    expect(title).toBeUndefined();
  });

  test("abort 立即放弃", async () => {
    const controller = new AbortController();
    controller.abort();
    const title = await summarizeSessionTitle(
      fakeStream([{ type: "text_delta", delta: "long title" }]),
      fakeModel,
      "p",
      undefined,
      { signal: controller.signal },
    );
    expect(title).toBeUndefined();
  });
});
