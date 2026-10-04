/**
 * 效果 → SVG 导出单测：
 * layer-blur 是毛玻璃（背景模糊）口径，SVG 无 backdrop-filter 且对节点自身
 * feGaussianBlur 会把半透卡片糊成一团（画布侧同样不渲染），导出必须跳过；
 * drop-shadow 照常输出 feDropShadow。
 */
import { describe, expect, test } from "bun:test";
import { type DesignDoc, type DesignNode, type Effect } from "../src/doc";
import { buildSvg, type SvgOptions } from "../src/svg";

const measure = () => ({ width: 10, ascent: 8, descent: 2 });
const svgOpts: SvgOptions = { measure, images: new Map() };

const docOf = (nodes: DesignNode[]): DesignDoc => ({
  version: 1,
  meta: { name: "t", kind: "uidesign" },
  activePage: "p1",
  pages: [{ id: "p1", name: "页", nodes }],
});

const card = (effects: Effect[]): DesignNode => ({
  id: "c",
  type: "rect",
  name: "卡",
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  radius: 12,
  fills: [{ type: "solid", color: "#ffffff", opacity: 0.6 }],
  effects,
});

describe("SVG 导出效果", () => {
  test("layer-blur 单独：不产生 filter（与画布一致，卡片保持清晰半透）", () => {
    const svg = buildSvg(docOf([card([{ type: "layer-blur", blur: 24 }])]), ["c"], svgOpts)!.svg;
    expect(svg).not.toContain("<filter");
    expect(svg).not.toContain("filter=");
    expect(svg).not.toContain("feGaussianBlur");
  });

  test("隐藏的 layer-blur 同样跳过", () => {
    const svg = buildSvg(docOf([card([{ type: "layer-blur", blur: 24, visible: false }])]), ["c"], svgOpts)!.svg;
    expect(svg).not.toContain("<filter");
  });

  test("drop-shadow 照常导出；layer-blur 混入时只留投影", () => {
    const drop = buildSvg(docOf([card([{ type: "drop-shadow", color: "#00000033", x: 0, y: 4, blur: 12 }])]), ["c"], svgOpts)!.svg;
    expect(drop).toContain("feDropShadow");
    expect(drop).toContain('filter="url(#');

    const mix = buildSvg(
      docOf([card([{ type: "layer-blur", blur: 24 }, { type: "drop-shadow", color: "#00000033", x: 0, y: 4, blur: 12 }])]),
      ["c"],
      svgOpts,
    )!.svg;
    expect(mix).toContain("feDropShadow");
    expect(mix).not.toContain("feGaussianBlur");
  });
});

/**
 * 回归（WebKit 半透卡整块发黑）：SVG 缺省 fill=黑，描边层若不显式 fill="none"，
 * 黑填充叠在白填充之上。四角不等圆角走 <path>（非原生 <rect rx>），此分支曾漏带；
 * resvg 渲染宽容看不出，必须从 SVG 文本层断言。
 */
const stroked = (over: Partial<DesignNode>): DesignNode => ({
  id: "c",
  type: "rect",
  name: "卡",
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  fills: [{ type: "solid", color: "#ffffff", opacity: 0.93 }],
  strokes: [{ color: "#ffffffb3", width: 1 }],
  ...over,
});

/** 所有带 stroke= 的几何元素都必须同时带 fill="none" */
function assertStrokeFillNone(svg: string) {
  const els = [...svg.matchAll(/<(path|rect|ellipse)\b[^>]*>/g)].filter((m) => m[0].includes('stroke="'));
  expect(els.length).toBeGreaterThan(0);
  for (const m of els) expect(m[0]).toContain('fill="none"');
}

describe("SVG 描边层填充（回归）", () => {
  test("四角不等圆角（rect→path）：描边层带 fill=\"none\"", () => {
    const svg = buildSvg(docOf([stroked({ radius: [28, 28, 0, 0] })]), ["c"], svgOpts)!.svg;
    assertStrokeFillNone(svg);
  });

  test("统一圆角与椭圆：描边层同样带 fill=\"none\"", () => {
    assertStrokeFillNone(buildSvg(docOf([stroked({ radius: 12 })]), ["c"], svgOpts)!.svg);
    assertStrokeFillNone(buildSvg(docOf([stroked({ type: "ellipse" })]), ["c"], svgOpts)!.svg);
  });
});
