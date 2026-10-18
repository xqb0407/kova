import { describe, expect, test } from "vitest";
import { parsePartialJsonObject } from "./partial-json";

describe("parsePartialJsonObject", () => {
  test("字符串未闭合时不产出字段", () => {
    expect(parsePartialJsonObject('{"file_path":"/a/b')).toBeNull();
  });

  test("完整 JSON 直接解析", () => {
    expect(parsePartialJsonObject('{"command":"ls -la"}')).toEqual({
      command: "ls -la",
    });
  });

  test("只取最后一个完整顶层键值对", () => {
    expect(
      parsePartialJsonObject('{"file_path":"/a/b.ts","content":"line1\\nline2'),
    ).toEqual({ file_path: "/a/b.ts" });
  });

  test("末尾字段完整但缺右括号", () => {
    expect(parsePartialJsonObject('{"file_path":"/a/b.ts"')).toEqual({
      file_path: "/a/b.ts",
    });
  });

  test("嵌套对象完整后可以解析", () => {
    expect(parsePartialJsonObject('{"opts":{"a":1},"next":')).toEqual({
      opts: { a: 1 },
    });
  });

  test("数组/首个值未完整时为 null", () => {
    expect(parsePartialJsonObject('{"a":[1,2')).toBeNull();
    expect(parsePartialJsonObject('{"a":tru')).toBeNull();
  });
});
