import { describe, expect, it } from "bun:test";
import { tokenizeInline } from "./inline";

describe("更新日志行内 Markdown", () => {
  it("拆分粗体、行内代码与链接", () => {
    expect(
      tokenizeInline(
        "支持 **JSON 配置** 与 `resultsPath`，见 [文档](https://example.com/a)",
      ),
    ).toEqual([
      { kind: "text", value: "支持 " },
      { kind: "strong", value: "JSON 配置" },
      { kind: "text", value: " 与 " },
      { kind: "code", value: "resultsPath" },
      { kind: "text", value: "，见 " },
      {
        kind: "link",
        value: "文档",
        href: "https://example.com/a",
      },
    ]);
  });

  it("只接受 http(s) 链接，其他协议原样保留", () => {
    expect(tokenizeInline("[点我](javascript:alert(1))")).toEqual([
      { kind: "text", value: "[点我](javascript:alert(1))" },
    ]);
  });

  it("没有标记时原样返回一段文本", () => {
    expect(tokenizeInline("纯文本，没有格式")).toEqual([
      { kind: "text", value: "纯文本，没有格式" },
    ]);
  });
});
