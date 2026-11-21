import { describe, expect, test } from "bun:test";
import {
  formatImGroupPrompt,
  isImGroupPromptText,
  parseImGroupPrompt,
  stripImGroupPrompt,
} from "../src/index";

describe("IM 群聊发言人哨兵", () => {
  test("format/parse/strip 往返一致", () => {
    const text = formatImGroupPrompt("张三", "代码审查");
    expect(text).toBe("[[im-group:张三]] 代码审查");
    expect(parseImGroupPrompt(text)).toEqual({ sender: "张三", body: "代码审查" });
    expect(stripImGroupPrompt(text)).toBe("代码审查");
    expect(isImGroupPromptText(text)).toBe(true);
  });

  test("保留正文里的方括号与换行", () => {
    const text = formatImGroupPrompt("wooEpV…boDw", "[紧急] 看下\n第二行");
    expect(stripImGroupPrompt(text)).toBe("[紧急] 看下\n第二行");
  });

  test("旧版落盘前缀（[群聊 · 张三] 正文）同样剥离，存量会话刷新后不再裸显", () => {
    expect(stripImGroupPrompt("[群聊 · wooEpV…boDw] 代码审查")).toBe("代码审查");
    expect(parseImGroupPrompt("[群聊 · 张三] 你好")).toEqual({
      sender: "张三",
      body: "你好",
    });
  });

  test("普通文本与畸形前缀原样返回，避免误吃用户输入", () => {
    expect(stripImGroupPrompt("你好 [[im-group:张三]]")).toBe("你好 [[im-group:张三]]");
    expect(stripImGroupPrompt("[[im-group:张三] 你好")).toBe("[[im-group:张三] 你好");
    expect(stripImGroupPrompt("[[im-group:]] 你好")).toBe("[[im-group:]] 你好");
    expect(isImGroupPromptText("[[im-group:张三]] 你好")).toBe(true);
    expect(isImGroupPromptText("[[im-group:张三] 你好")).toBe(false);
  });
});
