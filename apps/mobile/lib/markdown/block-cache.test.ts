import { describe, expect, test } from "vitest";
import { nextBlockSplit, type MarkdownBlockToken } from "./block-cache";

/** 假词法分析器：按空行切块（真实现是 marked，这里只验证缓存策略）。
 *  记录每次被喂进来的文本，用来断言"只重排了尾部"。 */
function makeLexer() {
  const calls: string[] = [];
  const lex = (text: string): MarkdownBlockToken[] => {
    calls.push(text);
    if (!text) return [];
    return text
      .split(/\n{2,}/)
      .filter((chunk) => chunk.length > 0)
      .map((raw) => ({ raw, type: raw.startsWith("|") ? "table" : "paragraph" }));
  };
  return { lex, calls };
}

describe("流式 markdown 的块切分缓存", () => {
  test("追加式增长：只重排最后一个块，前面的块引用复用", () => {
    const { lex, calls } = makeLexer();
    const a = "# 标题\n\n第一段";
    const b = "# 标题\n\n第一段\n第二行";
    const first = nextBlockSplit(null, a, lex);
    const blocksBefore = first.blocks;
    const second = nextBlockSplit(first, b, lex);

    expect(calls).toEqual([a, "第一段\n第二行"]); // 第二次只喂了尾部
    expect(second.blocks).toHaveLength(2);
    expect(second.blocks[0]).toBe(blocksBefore[0]); // 引用不变 ⇒ MarkdownBlock memo 命中
    expect(second.blocks[1]?.raw).toBe("第一段\n第二行");
  });

  test("尾部又长出新块：更早的块引用复用，重排从上一帧最后一块的起点开始", () => {
    const { lex, calls } = makeLexer();
    const a = "块A\n\n块B";
    const b = "块A\n\n块B\n\n块C";
    const first = nextBlockSplit(null, a, lex);
    const second = nextBlockSplit(first, b, lex);
    // 只喂「块B + 新块」这一段，块A 的原文不再过词法分析
    expect(calls).toEqual([a, "块B\n\n块C"]);
    expect(second.blocks[0]).toBe(first.blocks[0]);
    expect(second.blocks.map((t) => t.raw)).toEqual(["块A", "块B", "块C"]);
  });

  test("单块场景：尾部重排覆盖整块，但结果与全量一致", () => {
    const { lex, calls } = makeLexer();
    const first = nextBlockSplit(null, "第一段", lex);
    const second = nextBlockSplit(first, "第一段\n\n第二段", lex);
    expect(calls).toEqual(["第一段", "第一段\n\n第二段"]);
    expect(second.blocks.map((t) => t.raw)).toEqual(["第一段", "第二段"]);
  });

  test("同一份文本重复渲染：幂等复用，不再跑词法分析", () => {
    const { lex, calls } = makeLexer();
    const first = nextBlockSplit(null, "abc", lex);
    const again = nextBlockSplit(first, "abc", lex);
    expect(again).toBe(first);
    expect(calls).toEqual(["abc"]);
  });

  test("非追加式变更（换消息/编辑）退回全量重排", () => {
    const { lex, calls } = makeLexer();
    const first = nextBlockSplit(null, "第一段\n\n第二段", lex);
    const edited = nextBlockSplit(first, "改了开头的第二段\n\n第二段", lex);
    expect(calls).toEqual(["第一段\n\n第二段", "改了开头的第二段\n\n第二段"]);
    expect(edited.blocks.map((t) => t.raw)).toEqual(["改了开头的第二段", "第二段"]);
  });

  test("末块 raw 不落在文本末尾（尾随空白被裁等）：安全退回全量", () => {
    const { lex, calls } = makeLexer();
    // 手工造一份"最后一个块对不上尾部"的切分
    const weird = { text: "x\n\n  ", blocks: [{ raw: "x", type: "paragraph" }] };
    const next = nextBlockSplit(weird, "x\n\n  新加", lex);
    expect(calls).toEqual(["x\n\n  新加"]);
    expect(next.blocks.map((t) => t.raw)).toEqual(["x", "  新加"]);
  });
});
