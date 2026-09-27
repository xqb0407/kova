/**
 * 文档快照 → 纯文本的纯函数测试：\r 段落分隔转 \n、尾段去空、软换行 \n 保留。
 */
import { describe, expect, test } from "bun:test";
import { docToText } from "../src/doc/txt";

describe("docToText", () => {
  test("\\r 段落分隔转 \\n，尾部段落终结符去掉", () => {
    expect(docToText({ body: { dataStream: "甲\r乙\r" } })).toBe("甲\n乙");
  });

  test("段内软换行（\\n）保留；\\r\\n 混入也归一为 \\n", () => {
    expect(docToText({ body: { dataStream: "行一\n行二\r丙\r\n丁\r" } })).toBe(
      "行一\n行二\n丙\n丁",
    );
  });

  test("空 body / 缺 dataStream 给空串", () => {
    expect(docToText({})).toBe("");
    expect(docToText({ body: {} })).toBe("");
    expect(docToText({ body: { dataStream: "" } })).toBe("");
  });
});
