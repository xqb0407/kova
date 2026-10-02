import { describe, expect, test } from "bun:test";
import { buildTriggerInsert } from "./cm-directive";

const TOKEN = ":skill[anxin-ppt]{name=skill:anxin-ppt}";

/** 按 CM changes 语义还原替换后的整篇文档 */
const apply = (
  text: string,
  match: { offset: number; endOffset: number },
  replace: string,
) => text.slice(0, match.offset) + replace + text.slice(match.endOffset);

describe("buildTriggerInsert", () => {
  test("前面已打的字原样保留，不会被复制到芯片之后（历史 bug）", () => {
    const text = "前面打的一段内容 /ski";
    const match = { offset: 9, endOffset: 13 };
    const { replace, caret } = buildTriggerInsert(text, match, TOKEN);

    expect(replace).toBe(TOKEN);
    expect(apply(text, match, replace)).toBe(`前面打的一段内容 ${TOKEN}`);
    expect(caret).toBe(match.offset + TOKEN.length);
  });

  test("芯片后紧贴非空白：补一个空格，不黏连", () => {
    const text = "/ski内容";
    const match = { offset: 0, endOffset: 4 };
    const { replace } = buildTriggerInsert(text, match, TOKEN);
    expect(replace).toBe(`${TOKEN} `);
    expect(apply(text, match, replace)).toBe(`${TOKEN} 内容`);
  });

  test("芯片后已是空白：不重复补空格", () => {
    const text = "a /ski b";
    const match = { offset: 2, endOffset: 6 };
    const { replace } = buildTriggerInsert(text, match, TOKEN);
    expect(replace).toBe(TOKEN);
    expect(apply(text, match, replace)).toBe(`a ${TOKEN} b`);
  });

  test("光标在文档末尾：不补尾空格", () => {
    const text = "/";
    const match = { offset: 0, endOffset: 1 };
    const { replace, caret } = buildTriggerInsert(text, match, TOKEN);
    expect(replace).toBe(TOKEN);
    expect(caret).toBe(TOKEN.length);
  });
});
