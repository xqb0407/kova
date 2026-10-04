/**
 * 文档快照载入归一的测试：Univer 文档模型要求 dataStream 以 \r\n 结尾（\n=节分隔符）
 * 且 sectionBreaks 指向该 \n，缺了引擎静默渲染空白页。归一器补齐这些、对已合法
 * 快照零改动（面板 save 回读的档不再被扰动）。
 */
import { describe, expect, test } from "bun:test";
import { normalizeDocSnapshot } from "../src/doc/normalize";

describe("normalizeDocSnapshot 收尾归一", () => {
  test("空 body 补成 \\r\\n + 单段 + 末尾节", () => {
    const out = normalizeDocSnapshot({ id: "d1", title: "空" });
    expect(out.body?.dataStream).toBe("\r\n");
    expect(out.body?.paragraphs).toHaveLength(1);
    expect(out.body?.paragraphs?.[0]?.startIndex).toBe(0);
    expect(out.body?.sectionBreaks?.[0]?.startIndex).toBe(1);
  });

  test("缺 \\n：\\r 结尾补 \\n；无 \\r 结尾连 \\r 一起补", () => {
    const a = normalizeDocSnapshot({ body: { dataStream: "甲\r乙\r", paragraphs: [{ startIndex: 0 }, { startIndex: 2 }] } });
    expect(a.body?.dataStream).toBe("甲\r乙\r\n");
    const b = normalizeDocSnapshot({ body: { dataStream: "甲\r乙", paragraphs: [{ startIndex: 0 }, { startIndex: 2 }] } });
    expect(b.body?.dataStream).toBe("甲\r乙\r\n");
  });

  test("dataStream 缺失按空处理", () => {
    const out = normalizeDocSnapshot({ body: {} });
    expect(out.body?.dataStream).toBe("\r\n");
  });
});

describe("normalizeDocSnapshot 节兜底", () => {
  test("缺 sectionBreaks 补一条指向末尾 \\n", () => {
    const out = normalizeDocSnapshot({ body: { dataStream: "甲\r乙\r\n", paragraphs: [{ startIndex: 0 }, { startIndex: 2 }] } });
    expect(out.body?.sectionBreaks).toEqual([{ startIndex: 4, sectionId: expect.any(String) }]);
  });

  test("指向非 \\n 的节被过滤，仍保证末尾节存在", () => {
    const out = normalizeDocSnapshot({
      body: { dataStream: "甲\r乙\r\n", paragraphs: [{ startIndex: 0 }, { startIndex: 2 }], sectionBreaks: [{ startIndex: 1 }] },
    });
    // startIndex 1 处是 \r（非 \n）→ 过滤；末尾 \n（下标 4）补上
    expect(out.body?.sectionBreaks).toHaveLength(1);
    expect(out.body?.sectionBreaks?.[0]?.startIndex).toBe(4);
  });

  test("已合法快照零改动（dataStream/段落/节原样保留）", () => {
    const legal = {
      body: {
        dataStream: "甲\r乙\r\n",
        textRuns: [{ st: 0, ed: 1 }],
        paragraphs: [
          { startIndex: 0, paragraphId: "para_a" },
          { startIndex: 2, paragraphId: "para_b" },
        ],
        sectionBreaks: [{ startIndex: 4, sectionId: "section_x" }],
      },
    };
    const out = normalizeDocSnapshot(legal);
    expect(out).toEqual(legal);
  });
});

describe("normalizeDocSnapshot id 补齐", () => {
  test("缺 paragraphId 补 para_ 前缀且唯一；已有 id 保留", () => {
    const out = normalizeDocSnapshot({
      body: {
        dataStream: "甲\r乙\r\n",
        paragraphs: [{ startIndex: 0, paragraphId: "para_keep" }, { startIndex: 2 }],
      },
    });
    const ps = out.body?.paragraphs ?? [];
    expect(ps[0]?.paragraphId).toBe("para_keep");
    expect(ps[1]?.paragraphId).toMatch(/^para_/);
    expect(ps[0]?.paragraphId).not.toBe(ps[1]?.paragraphId);
  });

  test("重复 paragraphId 视同缺失重新生成", () => {
    const out = normalizeDocSnapshot({
      body: {
        dataStream: "甲\r乙\r\n",
        paragraphs: [{ startIndex: 0, paragraphId: "para_dup" }, { startIndex: 2, paragraphId: "para_dup" }],
      },
    });
    const ps = out.body?.paragraphs ?? [];
    expect(ps[0]?.paragraphId).not.toBe(ps[1]?.paragraphId);
    expect(ps[0]?.paragraphId).toBe("para_dup");
  });
});
