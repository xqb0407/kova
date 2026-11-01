/**
 * spec → ECharts option 的绘制语义测试：锁住每种图形「画成什么」的关键字段
 * （轴角色、堆叠方案、色阶、标签位置），防止后续调样式时悄悄改变图表含义。
 */
import { describe, expect, test } from "bun:test";
import type { EChartsOption } from "echarts";
import type { ChartEl } from "../src/doc";
import { autoTheme, chartOption } from "../src/chart/option";

type Rec = Record<string, unknown>;
const rec = (v: unknown) => v as Rec;
const seriesOf = (o: EChartsOption) => (o.series ?? []) as unknown as Rec[];
const axisOf = (o: EChartsOption, key: "xAxis" | "yAxis") => rec(o[key]);

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

describe("直角坐标系", () => {
  test("柱状图：x 类目 / y 数值 / 系列 type=bar", () => {
    const o = chartOption(chart());
    expect(axisOf(o, "xAxis").type).toBe("category");
    expect(axisOf(o, "yAxis").type).toBe("value");
    expect(seriesOf(o)[0]?.type).toBe("bar");
    expect(seriesOf(o)[0]?.data).toEqual([12, 19, 8]);
  });

  test("数据不足类目时补 0（不丢系列也不画断线）", () => {
    const o = chartOption(chart({ series: [{ name: "A", data: [12] }] }));
    expect(seriesOf(o)[0]?.data).toEqual([12, 0, 0]);
  });

  test("堆叠变体：stack=total；簇状无 stack", () => {
    expect(seriesOf(chartOption(chart({ variant: "stacked" })))[0]?.stack).toBe("total");
    expect(seriesOf(chartOption(chart()))[0]?.stack).toBeUndefined();
  });

  test("百分比堆叠：各系列按类目归一到 100", () => {
    const o = chartOption(chart({ variant: "percent" }));
    const a = seriesOf(o)[0]?.data as number[];
    const b = seriesOf(o)[1]?.data as number[];
    for (let i = 0; i < a.length; i++) expect(Math.round((a[i]! + b[i]!) * 10) / 10).toBe(100);
  });

  test("条形图：y 为（倒序）类目轴、x 为数值轴", () => {
    const o = chartOption(chart({ chart: "barH" }));
    expect(axisOf(o, "yAxis").type).toBe("category");
    expect(axisOf(o, "yAxis").inverse).toBe(true);
    expect(axisOf(o, "xAxis").type).toBe("value");
  });

  test("折线/面积：type=line，可平滑；面积带 areaStyle", () => {
    const line = seriesOf(chartOption(chart({ chart: "line" })))[0];
    expect(line?.type).toBe("line");
    const smooth = seriesOf(chartOption(chart({ chart: "line", smooth: true })))[0];
    expect(smooth?.smooth).toBe(true);
    const area = seriesOf(chartOption(chart({ chart: "area" })))[0];
    expect(area?.areaStyle).toBeDefined();
  });

  test("组合图：混合柱与折线，且不堆叠", () => {
    const o = chartOption(chart({ chart: "combo", series: [{ name: "A", data: [1, 2, 3] }, { name: "B", data: [4, 5, 6], type: "line" }] }));
    const s = seriesOf(o);
    expect(s[0]?.type).toBe("bar");
    expect(s[1]?.type).toBe("line");
    expect(s[0]?.stack).toBeUndefined();
  });
});

describe("散点 / 气泡", () => {
  test("散点：双数值轴、点位 [x,y]、固定点径", () => {
    const o = chartOption(chart({ chart: "scatter", series: [{ name: "S", data: [], points: [{ x: 1, y: 2 }, { x: 3, y: 5 }] }] }));
    expect(axisOf(o, "xAxis").type).toBe("value");
    expect(axisOf(o, "yAxis").type).toBe("value");
    expect(seriesOf(o)[0]?.data).toEqual([[1, 2], [3, 5]]);
    expect(seriesOf(o)[0]?.symbolSize).toBe(8);
  });

  test("气泡：点位带 size，点径为函数且夹在 6..52", () => {
    const o = chartOption(
      chart({ chart: "bubble", series: [{ name: "S", data: [], points: [{ x: 1, y: 2, size: 4 }, { x: 3, y: 5, size: 900 }] }] }),
    );
    expect(seriesOf(o)[0]?.data).toEqual([[1, 2, 4], [3, 5, 900]]);
    const size = seriesOf(o)[0]?.symbolSize as (v: unknown) => number;
    expect(size([1, 2, 4])).toBeGreaterThanOrEqual(6);
    expect(size([1, 2, 900])).toBeLessThanOrEqual(52);
  });
});

describe("饼 / 环 / 雷达", () => {
  test("饼图只取首系列且无内半径", () => {
    const o = chartOption(chart({ chart: "pie" }));
    const s = seriesOf(o)[0];
    expect(s?.type).toBe("pie");
    expect(s?.radius).toEqual(["0%", "68%"]);
    expect((s?.data as { value: number }[])[0]?.value).toBe(12);
  });

  test("环形图内半径 40%", () => {
    expect((seriesOf(chartOption(chart({ chart: "doughnut" })))[0]?.radius as string[])[0]).toBe("40%");
  });

  test("饼图缺省隐藏图例、显示标签", () => {
    const o = chartOption(chart({ chart: "pie", series: [{ name: "A", data: [12, 19, 8] }] }));
    expect(rec(o.legend).show).toBe(false);
    expect(rec(seriesOf(o)[0]?.label).show).toBe(true);
  });

  test("雷达图：指标上限为 niceMax，多系列各一数据项", () => {
    const o = chartOption(chart({ chart: "radar" }));
    const radar = rec(o.radar);
    const indicator = radar.indicator as { name: string; max: number }[];
    expect(indicator).toHaveLength(3);
    expect(indicator[0]?.max).toBe(20);
    expect((seriesOf(o)[0]?.data as unknown[]).length).toBe(2);
  });
});

describe("漏斗 / 树图 / 热力 / 甘特", () => {
  test("漏斗：sort=none 保序、标签位置", () => {
    const s = seriesOf(chartOption(chart({ chart: "funnel" })))[0];
    expect(s?.sort).toBe("none");
    expect(rec(s?.label).show).toBe(true);
  });

  test("树图：每项 itemStyle 取色板色", () => {
    const s = seriesOf(chartOption(chart({ chart: "treemap" })))[0];
    const data = s?.data as { name: string; itemStyle: { color: string } }[];
    expect(data[0]?.itemStyle.color).toBe("#166534");
  });

  test("热力图：系列 type=heatmap、三元组、hidden visualMap 提供色阶", () => {
    const o = chartOption(chart({ chart: "heatmap" }));
    expect(seriesOf(o)[0]?.type).toBe("heatmap");
    expect(seriesOf(o)[0]?.data).toEqual([[0, 0, 12], [1, 0, 19], [2, 0, 8], [0, 1, 6], [1, 1, 10], [2, 1, 14]]);
    const vm = rec(o.visualMap);
    expect(vm.show).toBe(false);
    expect(vm.max).toBe(19);
  });

  test("甘特：custom 系列、y 类目=任务名、x 范围盖住全部任务", () => {
    const tasks = [
      { name: "需求", start: 1, end: 3, progress: 1 },
      { name: "开发", start: 3, end: 9, progress: 0.4 },
    ];
    const o = chartOption(chart({ chart: "gantt", tasks }));
    expect(seriesOf(o)[0]?.type).toBe("custom");
    expect(axisOf(o, "yAxis").data).toEqual(["需求", "开发"]);
    expect(axisOf(o, "xAxis").min).toBe(0);
    expect(axisOf(o, "xAxis").max).toBe(9);
  });
});

describe("图例 / 主题 / 轴配置", () => {
  test("图例方位影响网格留白", () => {
    const top = rec(chartOption(chart({ legend: { show: true, position: "top" } })).grid);
    const bottom = rec(chartOption(chart({ legend: { show: true, position: "bottom" } })).grid);
    expect(top.top).toBeGreaterThan(16);
    expect(Number(bottom.bottom)).toBeGreaterThan(6);
  });

  test("深色主题：文字与轴色换深色页配色", () => {
    const o = chartOption(chart({ theme: "dark" }));
    expect(rec(o.textStyle).color).toBe("#f5f5f7");
    expect(rec(axisOf(o, "xAxis").axisLabel).color).toBe("#a1a1a6");
  });

  test("跟随页面：深底且未显式指定主题 → autoTheme 落深色；显式主题不被覆盖", () => {
    expect(autoTheme(chart(), true).theme).toBe("dark");
    expect(autoTheme(chart(), false).theme).toBeUndefined();
    expect(autoTheme(chart({ theme: "light" }), true).theme).toBe("light");
  });

  test("轴标题/旋转/数值格式透传到 option", () => {
    const o = chartOption(chart({ axes: { x: { title: "月份", rotate: 45 }, y: { title: "销量", format: "{value}万" } } }));
    expect(axisOf(o, "xAxis").name).toBe("月份");
    expect(rec(axisOf(o, "xAxis").axisLabel).rotate).toBe(45);
    expect(axisOf(o, "yAxis").name).toBe("销量");
    expect(rec(axisOf(o, "yAxis").axisLabel).formatter).toBe("{value}万");
  });

  test("关闭标签：series.label.show=false", () => {
    const o = chartOption(chart({ chart: "pie", dataLabels: { show: false } }));
    expect(rec(seriesOf(o)[0]?.label).show).toBe(false);
  });
});
