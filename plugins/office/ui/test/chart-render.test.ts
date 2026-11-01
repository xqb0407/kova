/**
 * 图表 SSR 渲染回归：14 种类型都必须产出真 SVG（不是兜底占位框），
 * 类目轴要展示 labels（曾出现只画 0/1/2 索引的 bug），主题/尺寸/缓存按 key 生效。
 * 这份断言保护的是「画布、导出、MCP 预览共用的唯一像素源」。
 */
import { describe, expect, test } from "bun:test";
import { CHART_KINDS, type ChartEl } from "../src/doc";
import { chartRender } from "../src/chart/render";

const chart = (o: Partial<ChartEl> = {}): ChartEl => ({
  kind: "chart",
  id: "c1",
  x: 0,
  y: 0,
  w: 480,
  h: 320,
  labels: ["一月", "二月", "三月"],
  series: [
    { name: "A", data: [12, 19, 8] },
    { name: "B", data: [6, 10, 14] },
  ],
  ...o,
});

const textsOf = (svg: string): string[] =>
  [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1] ?? "");

/** 兜底占位框（render.ts 渲染失败时输出）：纯色 rect 无文字 */
const isFallback = (svg: string): boolean => svg.includes('fill="#f6f7f4"') && !/<text/.test(svg);

const kindChart = (kind: (typeof CHART_KINDS)[number]): ChartEl => {
  const id = `c-${kind}`;
  if (kind === "scatter" || kind === "bubble") {
    return chart({
      id,
      chart: kind,
      series: [
        { name: "A", data: [], points: [{ x: 1, y: 2, size: 3 }, { x: 2, y: 5, size: 9 }] },
        { name: "B", data: [], points: [{ x: 3, y: 4, size: 5 }] },
      ],
    });
  }
  if (kind === "gantt") {
    return chart({
      id,
      chart: kind,
      tasks: [
        { name: "调研", start: 0, end: 2, progress: 0.5 },
        { name: "开发", start: 2, end: 6, progress: 0.2 },
      ],
    });
  }
  return chart({ id, chart: kind });
};

describe("chartRender：14 种类型都出真图", () => {
  test("每种类型都渲染出带文字的 SVG，不留兜底占位框", () => {
    for (const kind of CHART_KINDS) {
      const r = chartRender(kindChart(kind));
      expect(r.svg.startsWith("<svg")).toBe(true);
      expect(r.svg.length).toBeGreaterThan(1500);
      expect(isFallback(r.svg)).toBe(false);
      expect(textsOf(r.svg).length).toBeGreaterThan(0);
    }
  });

  test("类目轴展示 labels（bar/barH/line/area/combo 不再退化成 0/1/2 索引）", () => {
    for (const kind of ["bar", "barH", "line", "area", "combo"] as const) {
      const texts = textsOf(chartRender(kindChart(kind)).svg);
      for (const label of ["一月", "二月", "三月"]) expect(texts).toContain(label);
      expect(texts).not.toContain("4");
    }
  });

  test("各类型的专属内容：饼百分比 / 甘特任务 / 雷达指标 / 树图与热力标签", () => {
    expect(textsOf(chartRender(kindChart("pie")).svg)).toContain("一月 30.77%");
    expect(textsOf(chartRender(kindChart("gantt")).svg)).toContain("调研");
    expect(textsOf(chartRender(kindChart("radar")).svg)).toContain("一月");
    expect(textsOf(chartRender(kindChart("treemap")).svg)).toContain("二月");
    expect(textsOf(chartRender(kindChart("heatmap")).svg)).toContain("A");
  });

  test("尺寸参数生效：viewBox 按传入盒，data URL 可直接给 <img>/image fill", () => {
    const r = chartRender(kindChart("bar"), 640, 360);
    expect(r.w).toBe(640);
    expect(r.h).toBe(360);
    expect(r.svg).toContain('viewBox="0 0 640 360"');
    expect(r.url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(r.url.split(",")[1] ?? "")).toBe(r.svg);
  });

  test("主题：dark 用浅字深线，light 用深字", () => {
    expect(textsOf(chartRender(kindChart("bar")).svg)).toContain("一月");
    const light = chartRender(chart({ id: "c-light" }));
    const dark = chartRender(chart({ id: "c-dark", theme: "dark" }));
    expect(light.svg).toContain("#71717a"); // light ink.sub
    expect(dark.svg).toContain("#a1a1a6"); // dark ink.sub
  });

  test("同一元素重复渲染结果稳定（命中缓存，不漂移）", () => {
    const el = chart({ id: "c-stable" });
    const a = chartRender(el);
    const b = chartRender(el);
    expect(a.svg).toBe(b.svg);
    const resized = chartRender(el, 320, 240);
    expect(resized.svg).not.toBe(a.svg);
  });
});
