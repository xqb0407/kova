/**
 * 文本自动增高（注入假度量的纯函数）、locked 解析透传、图形库数据完整性。
 */
import { describe, expect, test } from "bun:test";
import { textNaturalH, fittedTextHeight } from "../src/textfit";
import { DOC_VERSION, parseDoc, type TextEl } from "../src/doc";
import { LIBRARY, librarySvg } from "../src/editor/library";
import type { MeasureFn } from "../src/leafer/scene";

/** 假度量：每字符 10px 宽（CJK/拉丁一视同仁），行高贡献 0.8/0.2 */
const fakeMeasure: MeasureFn = (text, fontCss) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(fontCss)?.[1] ?? 24);
  return { width: text.length * 10, ascent: size * 0.8, descent: size * 0.2 };
};

describe("textNaturalH（文本自然高度）", () => {
  test("单行短文本 = 一行行盒高 + 余量", () => {
    const h = textNaturalH([{ text: "ab", fontSize: 20, color: "#111827", fontFamily: "" }], 400, fakeMeasure);
    expect(h).toBe(Math.round(20 * 1.35 + 2));
  });

  test("超宽折行：行数增加、高度按最大字号行盒累计", () => {
    // 30 字符 × 10px = 300px，盒宽 100 → 至少 3 行
    const h = textNaturalH([{ text: "x".repeat(30), fontSize: 20, color: "#111827", fontFamily: "" }], 100, fakeMeasure);
    expect(h).toBeGreaterThanOrEqual(Math.round(3 * 20 * 1.35 + 2) - 1);
    expect(h).toBeLessThanOrEqual(Math.round(4 * 20 * 1.35 + 2));
  });

  test("显式换行分段", () => {
    const one = textNaturalH([{ text: "a\nb", fontSize: 20, color: "#111827", fontFamily: "" }], 400, fakeMeasure);
    expect(one).toBe(Math.round(2 * 20 * 1.35 + 2));
  });

  test("fittedTextHeight 只增不减", () => {
    const el = (h: number): TextEl => ({
      kind: "text", id: "t", x: 0, y: 0, w: 100, h,
      runs: [{ text: "x".repeat(30), size: 20 }], // 300px 宽 / 100 盒 → ≥3 行
    });
    expect(fittedTextHeight(el(20), fakeMeasure)).toBeGreaterThan(20); // 长高
    expect(fittedTextHeight(el(999), fakeMeasure)).toBe(999); // 手动更大 → 保持
  });
});

describe("locked 解析", () => {
  test("locked:true 透传；缺省不落键；序列化往返保持", () => {
    const doc = parseDoc({
      version: DOC_VERSION, meta: { name: "x" },
      objects: [
        { kind: "shape", id: "a", shape: "rect", x: 0, y: 0, w: 10, h: 10, locked: true },
        { kind: "shape", id: "b", shape: "rect", x: 0, y: 0, w: 10, h: 10, locked: false },
      ],
    })!;
    expect(doc.objects[0]?.locked).toBe(true);
    expect(doc.objects[1]?.locked).toBeUndefined();
    const round = parseDoc(JSON.parse(JSON.stringify(doc)))!;
    expect(round.objects[0]?.locked).toBe(true);
  });
});

describe("图形库数据", () => {
  test("每个条目 body 是合法 svg 片段（有 …）且 librarySvg 组装完整", () => {
    for (const cat of LIBRARY) {
      for (const item of cat.items) {
        expect(item.body.startsWith("<")).toBe(true);
        const { code, w, h } = librarySvg(item, "#1d1d1f");
        expect(code.startsWith("<svg")).toBe(true);
        expect(code.endsWith("</svg>")).toBe(true);
        expect(code.includes("#1d1d1f")).toBe(true);
        expect(w).toBeGreaterThan(0);
        expect(h).toBeGreaterThan(0);
      }
    }
  });
});
