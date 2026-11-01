/**
 * ChartSpec v2 归一化测试：锁定默认值、轴语义、色板回退与类型切换的数据适配。
 * 这些契约同时被画布、导出与 MCP 消费，改动会波及四处，故需回归网。
 */
import { describe, expect, test } from "bun:test";
import { CHART_KINDS, CHART_PALETTE, DEFAULT_CHART_LABELS, DEFAULT_CHART_SERIES, type ChartEl } from "../src/doc";
import {
  CHART_META,
  categoryAxisOf,
  chartKindPatch,
  chartLegendDefault,
  chartRenderKey,
  niceMax,
  normalizeChart,
  percentRows,
  seriesColor,
  usesCartesian,
} from "../src/chart/spec";

const chart = (o: Partial<ChartEl> = {}): ChartEl => ({
  kind: "chart",
  id: "c1",
  x: 0,
  y: 0,
  w: 400,
  h: 300,
  labels: ["一月", "二月", "三月"],
  series: [
    { name: "A", data: [12, 19, 8] },
    { name: "B", data: [6, 10, 14] },
  ],
  ...o,
});

describe("类型元信息", () => {
  test("14 种类型全覆盖且都有中文名", () => {
    expect(Object.keys(CHART_META).sort()).toEqual([...CHART_KINDS].sort());
    for (const k of CHART_KINDS) expect(CHART_META[k].label.length).toBeGreaterThan(1);
  });

  test("类目轴归属：barH 在 y、bar/line 在 x、饼图无轴", () => {
    expect(categoryAxisOf("bar")).toBe("x");
    expect(categoryAxisOf("barH")).toBe("y");
    expect(categoryAxisOf("heatmap")).toBe("y");
    expect(categoryAxisOf("pie")).toBeNull();
    expect(categoryAxisOf("scatter")).toBeNull();
  });

  test("直角坐标系类型集合", () => {
    expect(usesCartesian("scatter")).toBe(true);
    expect(usesCartesian("gantt")).toBe(true);
    expect(usesCartesian("radar")).toBe(false);
    expect(usesCartesian("treemap")).toBe(false);
  });
});

describe("normalizeChart 默认值", () => {
  test("缺省类型 bar、变体 clustered、字号 12、浅色主题", () => {
    const c = normalizeChart(chart());
    expect(c.kind).toBe("bar");
    expect(c.variant).toBe("clustered");
    expect(c.size).toBe(12);
    expect(c.theme).toBe("light");
    expect(c.ink.text).toBe("#1d1d1f");
  });

  test("缺省配色 = CHART_PALETTE", () => {
    expect(normalizeChart(chart()).colors).toEqual([...CHART_PALETTE]);
  });

  test("深色主题换 ink", () => {
    const c = normalizeChart(chart({ theme: "dark" }));
    expect(c.ink.text).toBe("#f5f5f7");
    expect(c.ink.grid).toBe("#303036");
  });

  test("图例默认：多系列显示、单扇区图形隐藏；旧 showLegend 生效", () => {
    expect(normalizeChart(chart()).legend.show).toBe(true);
    expect(normalizeChart(chart({ chart: "pie", series: [{ name: "A", data: [1, 2, 3] }] })).legend.show).toBe(false);
    expect(normalizeChart(chart({ showLegend: false })).legend.show).toBe(false);
    expect(normalizeChart(chart({ legend: { show: true, position: "right" } })).legend.position).toBe("right");
    // legend 优先于旧字段
    expect(normalizeChart(chart({ showLegend: true, legend: { show: false } })).legend.show).toBe(false);
    // 检查器复用同一默认值（单系列隐藏，饼/树图恒隐藏）
    expect(chartLegendDefault("bar", 1)).toBe(false);
    expect(chartLegendDefault("bar", 2)).toBe(true);
    expect(chartLegendDefault("treemap", 3)).toBe(false);
  });

  test("数据标签默认：饼/环/漏斗开，柱图关", () => {
    expect(normalizeChart(chart({ chart: "pie" })).dataLabels.show).toBe(true);
    expect(normalizeChart(chart({ chart: "doughnut" })).dataLabels.show).toBe(true);
    expect(normalizeChart(chart({ chart: "funnel" })).dataLabels.show).toBe(true);
    expect(normalizeChart(chart()).dataLabels.show).toBe(false);
  });

  test("轴默认：数值轴网格开、类目轴网格关；数字轴上下限透传", () => {
    const c = normalizeChart(chart({ axes: { y: { max: 25, format: "{value}万" } } }));
    expect(c.axes.x.categorical).toBe(true);
    expect(c.axes.x.grid).toBe(false);
    expect(c.axes.y.grid).toBe(true);
    expect(c.axes.y.max).toBe(25);
    expect(c.axes.y.format).toBe("{value}万");
    // 非有限值被丢弃
    expect(normalizeChart(chart({ axes: { y: { max: Number.NaN } } })).axes.y.max).toBeUndefined();
  });

  test("热力图双类目轴且默认关网格；scatter 双数值轴", () => {
    const h = normalizeChart(chart({ chart: "heatmap" }));
    expect(h.axes.x.categorical && h.axes.y.categorical).toBe(true);
    expect(h.axes.x.grid).toBe(false);
    const s = normalizeChart(chart({ chart: "scatter" }));
    expect(s.axes.x.categorical).toBe(false);
    expect(s.axes.y.categorical).toBe(false);
  });

  test("组合图缺省形态：首系列柱、其余折线", () => {
    const c = normalizeChart(chart({ chart: "combo" }));
    expect(c.series[0]?.type).toBe("bar");
    expect(c.series[1]?.type).toBe("line");
  });

  test("area 缺省系列形态为 area；line 为 line、bar 为 bar", () => {
    expect(normalizeChart(chart({ chart: "area" })).series[0]?.type).toBe("area");
    expect(normalizeChart(chart({ chart: "line" })).series[0]?.type).toBe("line");
    expect(normalizeChart(chart()).series[0]?.type).toBe("bar");
  });

  test("显式 variant 只在柱/条/面积生效", () => {
    expect(normalizeChart(chart({ variant: "stacked" })).variant).toBe("stacked");
    expect(normalizeChart(chart({ chart: "barH", variant: "percent" })).variant).toBe("percent");
    expect(normalizeChart(chart({ chart: "pie", variant: "stacked" })).variant).toBe("clustered");
  });
});

describe("seriesColor / niceMax / percentRows", () => {
  test("显式色优先，否则按色板循环", () => {
    const c = normalizeChart(chart({ colors: ["#111111", "#222222"] }));
    expect(seriesColor(c, 0)).toBe("#111111");
    expect(seriesColor(c, 1)).toBe("#222222");
    expect(seriesColor(c, 2)).toBe("#111111");
    const explicit = normalizeChart(chart({ series: [{ name: "A", data: [1], color: "#abcdef" }] }));
    expect(seriesColor(explicit, 0)).toBe("#abcdef");
  });

  test("niceMax 取 1/2/2.5/5 × 10^n", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
    expect(niceMax(8)).toBe(10);
    expect(niceMax(12)).toBe(20);
    expect(niceMax(2.5)).toBe(2.5);
    expect(niceMax(100)).toBe(100);
  });

  test("percentRows 按类目归一，总和为 0 的类目补 0", () => {
    const c = normalizeChart(
      chart({ labels: ["一", "二", "三"], series: [{ name: "A", data: [12, 0, 0] }, { name: "B", data: [6, 0, 0] }] }),
    );
    const rows = percentRows(c);
    expect(rows[0]?.[0]).toBe(66.7);
    expect(rows[1]?.[0]).toBe(33.3);
    expect(rows[0]?.[1]).toBe(0);
  });
});

describe("chartKindPatch 类型切换数据适配", () => {
  test("柱 → 散点：原数值转 points（x=类目序号）", () => {
    const el = chart();
    const p = chartKindPatch(el, "scatter");
    expect(p.chart).toBe("scatter");
    expect(p.series?.[0]?.points).toEqual([
      { x: 1, y: 12 },
      { x: 2, y: 19 },
      { x: 3, y: 8 },
    ]);
    expect(p.series?.[0]?.data).toEqual([]);
  });

  test("柱 → 气泡：points 带 size（按 |y|）", () => {
    const p = chartKindPatch(chart(), "bubble");
    expect(p.series?.[0]?.points?.[0]).toEqual({ x: 1, y: 12, size: 12 });
  });

  test("散点 → 柱：x 作类目、y 作数值", () => {
    const el = chart({ series: [{ name: "S", data: [], points: [{ x: 1, y: 3 }, { x: 2, y: 5 }] }] });
    const p = chartKindPatch(el, "bar");
    expect(p.labels).toEqual(["1", "2"]);
    expect(p.series?.[0]?.data).toEqual([3, 5]);
  });

  test("切到甘特补默认任务；切到其他类型不动 tasks", () => {
    expect(chartKindPatch(chart(), "gantt").tasks?.length).toBeGreaterThan(0);
    expect(chartKindPatch(chart(), "bar").tasks).toBeUndefined();
  });

  test("空数据切到类目图补默认类目与系列", () => {
    const empty = chart({ labels: [], series: [] });
    const p = chartKindPatch(empty, "bar");
    expect(p.labels).toEqual([...DEFAULT_CHART_LABELS]);
    expect(p.series?.map((s) => s.name)).toEqual(DEFAULT_CHART_SERIES.map((s) => s.name));
    // 已有数据不覆盖
    expect(chartKindPatch(chart(), "bar").labels).toBeUndefined();
  });
});

describe("chartRenderKey", () => {
  test("同规格同尺寸命中；尺寸/数据/主题变化换键", () => {
    const el = chart();
    const k = chartRenderKey(el, 400, 300);
    expect(chartRenderKey(chart(), 400, 300)).toBe(k);
    expect(chartRenderKey(el, 401, 300)).not.toBe(k);
    expect(chartRenderKey(chart({ theme: "dark" }), 400, 300)).not.toBe(k);
    expect(chartRenderKey(chart({ labels: ["a", "b", "c"] }), 400, 300)).not.toBe(k);
  });
});
