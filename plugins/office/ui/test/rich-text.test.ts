/**
 * 富文本 runs 工具测试：默认值归一、样式补丁保真、HTML 序列化转义/缩放、
 * 颜色归一与字体标签。DOM 读写（readRuns/applyStyleToSelection）需要浏览器环境，
 * 这里只覆盖可离线验证的纯函数。
 */
import { describe, expect, test } from "bun:test";
import {
  FONT_OPTIONS,
  applyStyleToRuns,
  fontLabel,
  fontStack,
  normalizeHex,
  round1,
  runFromStyle,
  runsToHtml,
  styleOfRun,
  toolbarStyleOf,
  type RunStyle,
} from "../src/editor/richText";
import type { TextRun } from "../src/doc";
import { parseDoc } from "../src/doc";
import { DEFAULT_TEXT_COLOR, DEFAULT_TEXT_SIZE, FONT_STACK, TEXT_LINE_HEIGHT, textLineHeight } from "../src/viewspec";

const style = (p: Partial<RunStyle> = {}): RunStyle => ({
  bold: false,
  italic: false,
  underline: false,
  color: "#111111",
  size: 24,
  font: "",
  ...p,
});

describe("richText", () => {
  test("styleOfRun：缺省字段补全为默认样式", () => {
    const s = styleOfRun({ text: "a" });
    expect(s).toEqual({ bold: false, italic: false, underline: false, color: DEFAULT_TEXT_COLOR, size: DEFAULT_TEXT_SIZE, font: "" });
    expect(styleOfRun({ text: "b", bold: true, color: "#FF0000", size: 32, font: "Songti SC" })).toEqual({
      bold: true,
      italic: false,
      underline: false,
      color: "#ff0000",
      size: 32,
      font: "Songti SC",
    });
  });

  test("runFromStyle：默认值省略，非默认值保留", () => {
    expect(runFromStyle(style(), "x")).toEqual({ text: "x", color: "#111111" });
    expect(runFromStyle(style({ bold: true, size: 32.04, italic: true, font: "Songti SC" }), "x")).toEqual({
      text: "x",
      bold: true,
      italic: true,
      color: "#111111",
      size: 32,
      font: "Songti SC",
    });
  });

  test("applyStyleToRuns：逐段套样式，文字与其余样式不变；空 runs 也能长出样式 run", () => {
    const runs: TextRun[] = [
      { text: "a", bold: true, size: 32 },
      { text: "b", color: "#ff0000" },
    ];
    const next = applyStyleToRuns(runs, { underline: true, color: "#00ff00", size: 20 });
    expect(next.map((r) => r.text)).toEqual(["a", "b"]);
    for (const r of next) {
      expect(r.underline).toBe(true);
      expect(r.color).toBe("#00ff00");
      expect(r.size).toBe(20);
    }
    expect(next[0]!.bold).toBe(true);
    const grown = applyStyleToRuns([], { bold: true });
    expect(grown).toHaveLength(1);
    expect(grown[0]).toMatchObject({ text: "", bold: true });
  });

  test("toolbarStyleOf：粗/斜/下划线按全部 run 点亮，字号/颜色/字体取首 run", () => {
    const el = {
      kind: "text" as const,
      id: "t",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      runs: [
        { text: "a", bold: true, size: 18, color: "#112233" },
        { text: "b", bold: true },
      ],
    };
    expect(toolbarStyleOf(el)).toMatchObject({ bold: true, italic: false, size: 18, color: "#112233" });
    expect(toolbarStyleOf({ ...el, runs: [{ text: "a", bold: true }, { text: "b" }] })).toMatchObject({ bold: false });
  });

  test("runsToHtml：转义文本、逐 run 写样式、字号按缩放换算", () => {
    const html = runsToHtml(
      [
        { text: 'a<b>&"', bold: true, size: 30, color: "#112233" },
        { text: "\n第二行", italic: true },
      ],
      2,
    );
    expect(html).toContain("a&lt;b&gt;&amp;&quot;");
    expect(html).toContain("font-weight:700");
    expect(html).toContain("font-size:60px");
    expect(html).toContain("color:#112233");
    expect(html).toContain("font-style:italic");
    expect(html).toContain("\n第二行");
    expect(html.match(/<span/g)?.length).toBe(2);
  });

  test("normalizeHex：短 hex 展开、rgb() 归一、非法返回 null", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#aabbcc")).toBe("#aabbcc");
    expect(normalizeHex("rgb(17, 34, 51)")).toBe("#112233");
    expect(normalizeHex("rgba(255,0,0,0.5)")).toBe("#ff0000");
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
  });

  test("字体栈/标签：默认回退全局栈，已知族给中文名", () => {
    expect(fontStack("")).toBe(FONT_STACK);
    expect(fontStack("Songti SC")).toContain("'Songti SC'");
    expect(fontLabel("")).toBe("系统默认");
    expect(fontLabel("PingFang SC")).toBe("苹方");
    expect(fontLabel("Unknown Font")).toBe("Unknown Font");
    expect(FONT_OPTIONS.length).toBeGreaterThan(4);
    expect(round1(12.34)).toBe(12.3);
  });

  test("textLineHeight：元素级行距，缺省/越界回退全局值", () => {
    expect(textLineHeight({})).toBe(TEXT_LINE_HEIGHT);
    expect(textLineHeight({ lineHeight: 1.5 })).toBe(1.5);
    expect(textLineHeight({ lineHeight: 0.1 })).toBe(TEXT_LINE_HEIGHT);
    expect(textLineHeight({ lineHeight: 99 })).toBe(TEXT_LINE_HEIGHT);
  });

  test("parseDoc：text.lineHeight 合法值收编、越界丢弃", () => {
    const raw = {
      version: 2,
      meta: { kind: "deck", name: "lh" },
      frames: [
        {
          id: "f1",
          type: "slide",
          x: 0,
          y: 0,
          w: 1280,
          h: 720,
          background: "#ffffff",
          elements: [
            { kind: "text", id: "t1", x: 0, y: 0, w: 100, h: 40, runs: [{ text: "a" }], lineHeight: 1.8 },
            { kind: "text", id: "t2", x: 0, y: 60, w: 100, h: 40, runs: [{ text: "b" }], lineHeight: 42 },
            { kind: "text", id: "t3", x: 0, y: 120, w: 100, h: 40, runs: [{ text: "c" }] },
          ],
        },
      ],
    };
    const doc = parseDoc(raw);
    const els = doc.frames[0]!.elements.filter((e): e is Extract<typeof e, { kind: "text" }> => e.kind === "text");
    expect(els[0]!.lineHeight).toBe(1.8);
    expect(els[1]!.lineHeight).toBeUndefined();
    expect(els[2]!.lineHeight).toBeUndefined();
  });
});
