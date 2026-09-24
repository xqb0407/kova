/**
 * viewspec 测试：锁定 DOM 与 Leafer 双渲染器共用的视觉派生逻辑
 * （默认值、颜色回退链、描边宽度、自然点盒、fit 映射、run 解析）。
 * 这些是"渲染无关规格"的契约，改动会同时影响两条渲染路径，故须有回归网。
 */
import { describe, expect, test } from "bun:test";
import { mermaidErrorText, retagSvg } from "../src/mermaid";
import type { ChartEl, DrawEl, ImageEl, ShapeEl, TableEl, TextEl } from "../src/doc";
import {
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_SIZE,
  TEXT_LINE_HEIGHT,
  chartSpec,
  curveArrow,
  drawSpec,
  elBox,
  imageFit,
  polygonPoints,
  resolveRuns,
  shapeSpec,
  tableSpec,
  textLayout,
} from "../src/viewspec";

const rect = (o: Partial<ShapeEl> = {}): ShapeEl => ({ kind: "shape", id: "s1", shape: "rect", x: 0, y: 0, w: 10, h: 10, ...o });

describe("shapeSpec", () => {
  test("rect 默认描边宽 1，填充回退链", () => {
    const s = shapeSpec(rect({ fill: "#f00" }));
    expect(s.strokeWidth).toBe(1);
    expect(s.fill).toBe("#f00");
    // 无显式 stroke → 用 fill 描边（DOM 语义：纯色块）
    expect(s.stroke).toBe("#f00");
  });
  test("显式 stroke 覆盖", () => {
    const s = shapeSpec(rect({ fill: "#f00", stroke: "#00f", strokeWidth: 3 }));
    expect(s.stroke).toBe("#00f");
    expect(s.strokeWidth).toBe(3);
  });
  test("stroke:none 且 fill:none → 全空", () => {
    const s = shapeSpec(rect({ fill: "none", stroke: "none" }));
    expect(s.stroke).toBeNull();
    expect(s.fill).toBeNull();
  });
  test("line/arrow 默认描边宽 2 + lineColor 回退", () => {
    const ln = shapeSpec(rect({ shape: "line", fill: "#123" }));
    expect(ln.strokeWidth).toBe(2);
    expect(ln.lineColor).toBe("#123");
    expect(shapeSpec(rect({ shape: "arrow" })).lineColor).toBe(DEFAULT_TEXT_COLOR);
  });
});

describe("text", () => {
  const t = (o: Partial<TextEl> = {}): TextEl => ({ kind: "text", id: "t1", x: 0, y: 0, w: 10, h: 10, runs: [], ...o });
  test("resolveRuns 填默认字号/色/字体栈", () => {
    const runs = resolveRuns(t({ runs: [{ text: "hi" }] }));
    expect(runs[0]!.fontSize).toBe(DEFAULT_TEXT_SIZE);
    expect(runs[0]!.color).toBe(DEFAULT_TEXT_COLOR);
    expect(runs[0]!.fontFamily).toContain("PingFang SC");
  });
  test("run 自带字体前置并回退全局栈", () => {
    const runs = resolveRuns(t({ runs: [{ text: "x", font: "Georgia" }] }));
    expect(runs[0]!.fontFamily.startsWith("'Georgia'")).toBe(true);
  });
  test("textLayout 默认 left/top", () => {
    expect(textLayout(t())).toEqual({ align: "left", vAlign: "top" });
    expect(textLayout(t({ align: "center", vAlign: "middle" }))).toEqual({ align: "center", vAlign: "middle" });
  });
  test("TEXT_LINE_HEIGHT = 1.35", () => expect(TEXT_LINE_HEIGHT).toBe(1.35));
});

describe("drawSpec", () => {
  const d = (o: Partial<DrawEl> = {}): DrawEl => ({ kind: "draw", id: "d1", x: 0, y: 0, w: 100, h: 100, points: [], ...o });
  test("点串一位小数取整 + 默认色/宽", () => {
    const s = drawSpec(d({ points: [[1.23, 4.56], [10, 20]] }));
    expect(s.points).toBe("1.2,4.6 10,20");
    expect(s.color).toBe("#1d1d1f");
    expect(s.strokeWidth).toBe(2);
  });
  test("显式 stroke 覆盖", () => {
    expect(drawSpec(d({ stroke: "#abc", points: [[0, 0]] })).color).toBe("#abc");
  });
});

describe("imageFit / elBox", () => {
  const im = (o: Partial<ImageEl> = {}): ImageEl => ({ kind: "image", id: "i1", x: 0, y: 0, w: 10, h: 10, src: "a.png", ...o });
  test("fit 映射：stretch→fill，默认 cover", () => {
    expect(imageFit(im())).toBe("cover");
    expect(imageFit(im({ fit: "contain" }))).toBe("contain");
    expect(imageFit(im({ fit: "stretch" }))).toBe("fill");
  });
  test("elBox 抽公共几何 + rotation 默认 0", () => {
    const b = elBox(im({ x: 3, y: 4, w: 5, h: 6, opacity: 0.5 }));
    expect(b).toEqual({ x: 3, y: 4, w: 5, h: 6, opacity: 0.5, rotation: 0 });
  });
});

describe("mermaidErrorText（报错文案带出错行）", () => {
  const code = "graph TB\n  A --> B\n  style AI 层 fill:#111\n  C --> D";
  test("抽出行号并附源码行", () => {
    const msg = "Parse error on line 3:\n...style AI 层 fill:#111\n-----------------------^\nExpecting 'EOF', got 'TAGEND'";
    expect(mermaidErrorText(code, msg)).toBe("第 3 行：style AI 层 fill:#111");
  });
  test("长行截断到 80 字符", () => {
    const long = "  " + "x".repeat(200);
    const msg = "Parse error on line 2:\n boom";
    expect(mermaidErrorText(`a\n${long}`, msg).length).toBeLessThanOrEqual("第 2 行：".length + 81);
  });
  test("没有行号时退回消息首行", () => {
    expect(mermaidErrorText(code, "UnknownDiagramError: No diagram type detected")).toBe("UnknownDiagramError: No diagram type detected");
  });
});

describe("polygonPoints（多边形顶点，OOXML preset 对齐）", () => {
  test("triangle 顶点朝上；trapezoid 顶边内收 20%", () => {
    expect(polygonPoints("triangle", 100, 60)).toEqual([[50, 0], [100, 60], [0, 60]]);
    expect(polygonPoints("trapezoid", 100, 60)).toEqual([[20, 0], [80, 0], [100, 60], [0, 60]]);
  });
  test("hexagon 左右尖顶、上下平边（0.25/0.75 顶点）", () => {
    expect(polygonPoints("hexagon", 100, 60)).toEqual([[25, 0], [75, 0], [100, 30], [75, 60], [25, 60], [0, 30]]);
  });
  test("pentagon 首顶点朝上的正五边形；star 10 点内外半径 1/0.382", () => {
    const p = polygonPoints("pentagon", 100, 100);
    expect(p).toHaveLength(5);
    expect(p[0]).toEqual([50, 0]);
    const s = polygonPoints("star", 100, 100);
    expect(s).toHaveLength(10);
    expect(s[0]).toEqual([50, 0]);
    // 内点：i=1 → a=-54°，r=50×0.382=19.1
    expect(s[1]![0]).toBeCloseTo(50 + 19.1 * Math.cos((-54 * Math.PI) / 180), 1);
    expect(s[1]![1]).toBeCloseTo(50 + 19.1 * Math.sin((-54 * Math.PI) / 180), 1);
  });
});

describe("curveArrow（二次贝塞尔：端点 + 法线控制点）", () => {
  test("缺省 curve=0.3：水平弦上拱（控制点 y < 弦 y），端点同 lineEnds", () => {
    const c = curveArrow(rect({ shape: "curve-arrow", w: 100, h: 0 }));
    expect(c.ax).toBe(0);
    expect(c.ay).toBe(0);
    expect(c.bx).toBe(100);
    expect(c.by).toBe(0);
    // 控制点在中点法线方向：cx=50, cy=0-30（上拱）
    expect(c.cx).toBeCloseTo(50, 5);
    expect(c.cy).toBeCloseTo(-30, 5);
  });
  test("curve 范围夹取 [-1,1]，负值反向弯", () => {
    const c1 = curveArrow(rect({ shape: "curve-arrow", w: 100, h: 0, curve: 5 }));
    expect(c1.cy).toBeCloseTo(-100, 5);
    const c2 = curveArrow(rect({ shape: "curve-arrow", w: 100, h: 0, curve: -0.5 }));
    expect(c2.cy).toBeCloseTo(50, 5);
  });
  test("终点切线方向 = 终点 - 控制点（箭头头方向）", () => {
    const c = curveArrow(rect({ shape: "curve-arrow", w: 100, h: 0 }));
    expect(c.bx - c.cx).toBeCloseTo(50, 5);
    expect(c.by - c.cy).toBeCloseTo(30, 5);
  });
});

describe("tableSpec（列宽权重归一化 + 默认样式回退）", () => {
  test("均分列与行高；样式默认值", () => {
    const s = tableSpec({ kind: "table", id: "t1", x: 0, y: 0, w: 300, h: 90, rows: [["A", "B"], ["1", "2"]] });
    expect(s.cols).toBe(2);
    expect(s.colX).toEqual([0, 150, 300]);
    expect(s.rowH).toBe(45);
    expect(s.header).toBe(true);
    expect(s.size).toBe(18);
    expect([s.fill, s.headerFill, s.stroke, s.color]).toEqual(["#ffffff", "#eef0f2", "#d4d4d8", "#1d1d1f"]);
  });
  test("colWidths 与列数不匹配 → 回退均分；匹配时按权重分列", () => {
    const s = tableSpec({ kind: "table", id: "t1", x: 0, y: 0, w: 300, h: 60, rows: [["A", "B", "C"]], colWidths: [2, 1] });
    expect(s.colX).toEqual([0, 100, 200, 300]);
    const s2 = tableSpec({ kind: "table", id: "t2", x: 0, y: 0, w: 300, h: 60, rows: [["A", "B"]], colWidths: [2, 1] });
    expect(s2.colX).toEqual([0, 200, 300]);
  });
  test("header=false 透传", () => {
    expect(tableSpec({ kind: "table", id: "t1", x: 0, y: 0, w: 100, h: 30, rows: [["A"]], header: false }).header).toBe(false);
  });
});

describe("chartSpec（图元中间表示：一次数学，三轨消费）", () => {
  const bar = (o: Partial<ChartEl> = {}): ChartEl => ({
    kind: "chart",
    id: "c1",
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    labels: ["一月", "二月"],
    series: [{ name: "A", data: [10, 20] }],
    ...o,
  });

  test("bar：5 条网格线与刻度、两根柱、类目标签", () => {
    const prims = chartSpec(bar());
    expect(prims.filter((p) => p.t === "rect")).toHaveLength(2);
    expect(prims.filter((p) => p.t === "line")).toHaveLength(5);
    const texts = prims.filter((p) => p.t === "text");
    expect(texts).toHaveLength(7); // 5 刻度 + 2 类目
    expect(texts.some((p) => p.t === "text" && p.text === "20")).toBe(true);
  });

  test("line：每系列一条 poly + 逐点圆点；两系列两种色", () => {
    const prims = chartSpec(bar({ chart: "line", series: [{ name: "A", data: [1, 2] }, { name: "B", data: [2, 1] }] }));
    expect(prims.filter((p) => p.t === "poly")).toHaveLength(2);
    expect(prims.filter((p) => p.t === "circle")).toHaveLength(4);
    expect(new Set(prims.filter((p) => p.t === "poly").map((p) => (p.t === "poly" ? p.stroke : "")))).toHaveLength(2);
  });

  test("pie：扇区 path + 百分比标注；0 值类目剔除", () => {
    const prims = chartSpec(bar({ chart: "pie", labels: ["甲", "乙", "丙"], series: [{ name: "A", data: [1, 3, 0] }] }));
    expect(prims.filter((p) => p.t === "path")).toHaveLength(2);
    const pcts = prims.filter((p) => p.t === "text" && p.text.endsWith("%")).map((p) => (p.t === "text" ? p.text : ""));
    expect(pcts).toContain("75%");
    expect(pcts).toContain("25%");
  });

  test("pie 单扇区拆两个半圆（整圆 arc 退化路径回避）", () => {
    const prims = chartSpec(bar({ chart: "pie", labels: ["甲"], series: [{ name: "A", data: [5] }] }));
    expect(prims.filter((p) => p.t === "path")).toHaveLength(2);
  });

  test("doughnut：内半径扇区、不画内嵌百分比", () => {
    const prims = chartSpec(bar({ chart: "doughnut", labels: ["甲", "乙"], series: [{ name: "A", data: [1, 1] }] }));
    expect(prims.filter((p) => p.t === "path")).toHaveLength(2);
    expect(prims.some((p) => p.t === "text" && p.text.includes("%"))).toBe(false);
  });

  test("图例：bar 列系列名、pie 列类目", () => {
    const p1 = chartSpec(bar({ showLegend: true }));
    const t1 = p1.filter((p) => p.t === "text").map((p) => (p.t === "text" ? p.text : ""));
    expect(t1).toContain("A");
    const p2 = chartSpec(bar({ showLegend: true, chart: "pie", labels: ["甲", "乙"], series: [{ name: "A", data: [1, 2] }] }));
    const t2 = p2.filter((p) => p.t === "text").map((p) => (p.t === "text" ? p.text : ""));
    expect(t2).toContain("甲");
    expect(t2).not.toContain("A");
  });
});

describe("retagSvg（安全改根标签：不重复属性、不误伤嵌套节点）", () => {
  const svg = '<svg id="x" width="100" height="50" preserveAspectRatio="none" style="max-width: 300px;"><rect width="80" height="20"/><image width="8"/></svg>';
  test("根上的旧属性被替换、不重复", () => {
    const out = retagSvg(svg, { width: 200, height: 100, preserveAspectRatio: "xMidYMid meet" });
    expect(out.match(/preserveAspectRatio=/g)!.length).toBe(1);
    expect(out.match(/width=/g)!.length).toBe(3); // 根 200 + rect 80 + image 8
    expect(out).toContain('<rect width="80" height="20"/>');
    expect(out).toContain('width="200" height="100"');
    expect(out).not.toContain("max-width");
  });
  test("不传的属性不写回（导出只改尺寸时不引入 preserveAspectRatio）", () => {
    const out = retagSvg(svg, { width: 10, height: 10 });
    expect(out).not.toContain("preserveAspectRatio");
  });
});
