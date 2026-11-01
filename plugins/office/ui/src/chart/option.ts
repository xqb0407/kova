/**
 * ResolvedChart → ECharts option（纯函数）。
 * 只描述「要画什么」，不碰运行时：render.ts 用 SSR 把它变成 SVG，
 * 数据面板/导出复用同一份配置，保证画布、SVG/HTML 导出、MCP 预览三处像素一致。
 */
import type {
  BarSeriesOption,
  CustomSeriesOption,
  EChartsOption,
  FunnelSeriesOption,
  HeatmapSeriesOption,
  LineSeriesOption,
  PieSeriesOption,
  RadarSeriesOption,
  ScatterSeriesOption,
  TreemapSeriesOption,
} from "echarts";
import { isDarkColor, type ChartEl, type ChartKind } from "../doc";
import { FONT_STACK } from "../viewspec";
import { normalizeChart, niceMax, percentRows, seriesColor, type ResolvedChart } from "./spec";

/* ---------------- 色值工具 ---------------- */

const hex = (css: string | undefined, fallback = "#000000"): string => {
  const m = css ? /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(css) : null;
  if (!m) return fallback;
  const h = m[1]!;
  return h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
};

/** 两色线性混合（t=0 → a，t=1 → b） */
function mixColor(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const pa = hex(a);
  const pb = hex(b);
  const ch = (i: number) => {
    const va = parseInt(pa.slice(i, i + 2), 16);
    const vb = parseInt(pb.slice(i, i + 2), 16);
    return Math.round(va + (vb - va) * k)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

/* ---------------- 通用片段 ---------------- */

const fitRow = (data: number[], n: number): number[] =>
  Array.from({ length: n }, (_, i) => {
    const v = data[i];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  });

/** 无标注单位时用 ECharts 值占位符 */
const valueFormatter = (format?: string) => format ?? "{c}";

function gridOf(c: ResolvedChart) {
  const g = { left: 6, right: 16, top: 16, bottom: 6, containLabel: true };
  if (c.legend.show) {
    if (c.legend.position === "top") g.top = 38;
    else if (c.legend.position === "bottom") g.bottom = 36;
    else if (c.legend.position === "left") g.left = 26;
    else if (c.legend.position === "right") g.right = 38;
  }
  if (c.axes.x.title) g.bottom += 20;
  if (c.axes.y.title) g.left += 22;
  return g;
}

function legendOf(c: ResolvedChart): EChartsOption["legend"] {
  if (!c.legend.show) return { show: false };
  const p = c.legend.position;
  return {
    show: true,
    type: "scroll",
    orient: p === "left" || p === "right" ? "vertical" : "horizontal",
    icon: "roundRect",
    itemWidth: 12,
    itemHeight: 8,
    itemGap: 12,
    ...(p === "top" ? { top: 4, left: "center" } : {}),
    ...(p === "bottom" ? { bottom: 4, left: "center" } : {}),
    ...(p === "left" ? { left: 0, top: "middle" } : {}),
    ...(p === "right" ? { right: 0, top: "middle" } : {}),
    textStyle: { color: c.ink.sub, fontSize: c.size },
    pageIconColor: c.ink.sub,
    pageTextStyle: { color: c.ink.sub, fontSize: c.size },
  };
}

/** 非饼图（直角/雷达/散点）的数据标签位置 */
function dataLabelOf(
  c: ResolvedChart,
  kind: ChartKind,
  fallback: string,
): { show: boolean; position: "inside" | "top"; color: string; fontSize: number; formatter: string } {
  const p = c.dataLabels.position;
  const position = kind === "bar" || kind === "barH" ? (p === "inside" || p === "center" ? "inside" : "top") : p === "inside" ? "inside" : "top";
  return { show: c.dataLabels.show, position, color: c.ink.text, fontSize: c.size, formatter: valueFormatter(c.dataLabels.format ?? fallback) };
}

/** 饼/环的数据标签位置（多出 center/outside 两个语义） */
function pieLabelOf(c: ResolvedChart, fallback: string): {
  show: boolean;
  position: "inside" | "center" | "outside";
  color: string;
  fontSize: number;
  formatter: string;
} {
  const p = c.dataLabels.position;
  return {
    show: c.dataLabels.show,
    position: p === "inside" ? "inside" : p === "center" ? "center" : "outside",
    color: c.ink.text,
    fontSize: c.size,
    formatter: valueFormatter(c.dataLabels.format ?? fallback),
  };
}

/* ---------------- 轴 ---------------- */

function axisOf(c: ResolvedChart, axis: "x" | "y", role: "category" | "value", invert: boolean) {
  const a = c.axes[axis];
  const isValue = role === "value";
  return {
    type: role,
    show: a.show,
    ...(a.title ? { name: a.title, nameGap: 24, nameTextStyle: { color: c.ink.sub, fontSize: c.size } } : {}),
    ...(invert ? { inverse: true } : {}),
    axisLine: { show: a.show, lineStyle: { color: c.ink.axis, width: 1 } },
    axisTick: { show: false },
    axisLabel: {
      show: a.show,
      color: c.ink.sub,
      fontSize: c.size,
      ...(isValue ? {} : { rotate: a.rotate, hideOverlap: true }),
      ...(isValue && a.format ? { formatter: a.format } : {}),
    },
    splitLine: { show: a.grid, lineStyle: { color: c.ink.grid, width: 1 } },
    ...(isValue ? { min: a.min, max: a.max } : {}),
  };
}

/** 直角坐标系轴组合：按类型决定谁作类目轴，热力图双类目、scatter/bubble 双数值 */
function cartesianAxes(c: ResolvedChart) {
  const kind = c.kind;
  if (kind === "heatmap") {
    return {
      xAxis: { ...axisOf(c, "x", "category", false), data: c.labels, splitLine: { show: c.axes.x.grid, lineStyle: { color: c.ink.grid } } },
      yAxis: { ...axisOf(c, "y", "category", false), splitLine: { show: c.axes.y.grid, lineStyle: { color: c.ink.grid } } },
    };
  }
  if (kind === "gantt") {
    return {
      xAxis: axisOf(c, "x", "value", false),
      yAxis: axisOf(c, "y", "category", true),
    };
  }
  if (kind === "scatter" || kind === "bubble") {
    return { xAxis: axisOf(c, "x", "value", false), yAxis: axisOf(c, "y", "value", false) };
  }
  if (kind === "barH") {
    return { xAxis: axisOf(c, "x", "value", false), yAxis: { ...axisOf(c, "y", "category", true), data: c.labels } };
  }
  return { xAxis: { ...axisOf(c, "x", "category", false), data: c.labels }, yAxis: axisOf(c, "y", "value", false) };
}

/* ---------------- 逐类型系列 ---------------- */

function cartesianSeries(c: ResolvedChart): (BarSeriesOption | LineSeriesOption)[] {
  const n = c.labels.length;
  const horizontal = c.kind === "barH";
  const stack = c.variant === "clustered" ? undefined : "total";
  const rows = c.variant === "percent" ? percentRows(c) : c.series.map((s) => s.data);
  const kind: ChartKind = c.kind;
  return c.series.map((s, i): BarSeriesOption | LineSeriesOption => {
    const color = seriesColor(c, i);
    const data = fitRow(rows[i] ?? [], n);
    const label = dataLabelOf(c, c.kind === "barH" ? "barH" : c.kind, "{c}");
    if (kind === "line" || kind === "area" || (kind === "combo" && (s.type === "line" || s.type === "area"))) {
      return {
        type: "line",
        name: s.name,
        data,
        ...(stack && kind !== "combo" ? { stack } : {}),
        smooth: c.smooth,
        showSymbol: n <= 30,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { width: 2.5, color },
        itemStyle: { color },
        ...(kind === "area" || s.type === "area" ? { areaStyle: { opacity: 0.18, color } } : {}),
        emphasis: { disabled: true },
        label,
      };
    }
    return {
      type: "bar",
      name: s.name,
      data,
      ...(stack && kind !== "combo" ? { stack } : {}),
      barMaxWidth: 38,
      itemStyle: { color, borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] },
      emphasis: { disabled: true },
      label,
    };
  });
}

function pieSeries(c: ResolvedChart, doughnut: boolean): PieSeriesOption[] {
  const src = c.series[0];
  const data = c.labels.map((name, i) => ({ name, value: src?.data[i] ?? 0 }));
  return [
    {
      type: "pie",
      name: src?.name ?? "数据",
      data,
      radius: doughnut ? ["40%", "68%"] : ["0%", "68%"],
      center: ["50%", c.legend.show && c.legend.position === "bottom" ? "46%" : "50%"],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: "transparent", borderWidth: 0 },
      emphasis: { disabled: true },
      label: {
        ...pieLabelOf(c, "{b} {d}%"),
        ...(c.dataLabels.show ? { lineHeight: c.size * 1.3 } : {}),
      },
      labelLine: { show: c.dataLabels.show && c.dataLabels.position !== "inside", length: 10, length2: 8, smooth: false },
    },
  ];
}

function radarSeries(c: ResolvedChart): RadarSeriesOption[] {
  const n = c.labels.length;
  return [
    {
      type: "radar",
      name: c.series[0]?.name,
      data: c.series.map((s, i) => ({
        name: s.name,
        value: fitRow(s.data, n),
        itemStyle: { color: seriesColor(c, i) },
        lineStyle: { color: seriesColor(c, i), width: 2 },
        areaStyle: { color: seriesColor(c, i), opacity: 0.16 },
        emphasis: { disabled: true },
      })),
      symbol: "circle",
      symbolSize: 4,
      label: dataLabelOf(c, "radar", "{c}"),
    },
  ];
}

function funnelSeries(c: ResolvedChart): FunnelSeriesOption[] {
  const src = c.series[0];
  return [
    {
      type: "funnel",
      name: src?.name ?? "数据",
      sort: "none",
      gap: 2,
      minSize: "10%",
      maxSize: "100%",
      data: c.labels.map((name, i) => ({ name, value: src?.data[i] ?? 0 })),
      label: {
        show: c.dataLabels.show,
        position: c.dataLabels.position === "inside" ? "inside" : "right",
        color: c.ink.text,
        fontSize: c.size,
        formatter: c.dataLabels.format ?? "{b} {c}",
      },
      itemStyle: { borderColor: "transparent", borderWidth: 0 },
      emphasis: { disabled: true },
    },
  ];
}

function treemapSeries(c: ResolvedChart): TreemapSeriesOption[] {
  const src = c.series[0];
  return [
    {
      type: "treemap",
      name: src?.name ?? "数据",
      data: c.labels.map((name, i) => {
        const value = src?.data[i] ?? 0;
        const color = c.colors[i % c.colors.length]!;
        return {
          name,
          value: Math.abs(value),
          itemStyle: { color, borderRadius: 4 },
          label: { color: isDarkColor(color) ? "#ffffff" : c.ink.text },
        };
      }),
      width: "100%",
      height: "100%",
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      roam: false,
      nodeClick: false,
      breadcrumb: { show: false },
      itemStyle: { borderColor: "#ffffff", borderWidth: 2, gapWidth: 2, borderRadius: 4 },
      label: { show: true, position: "inside", fontSize: c.size, formatter: "{b}\n{c}" },
      emphasis: { disabled: true },
    },
  ];
}

function heatmapSeries(c: ResolvedChart): HeatmapSeriesOption[] {
  const values: [number, number, number][] = [];
  c.series.forEach((s, j) => {
    c.labels.forEach((_, i) => {
      const v = s.data[i];
      if (typeof v !== "number" || !Number.isFinite(v)) return;
      values.push([i, j, v]);
    });
  });
  return [
    {
      type: "heatmap",
      name: "数值",
      data: values,
      yAxisIndex: 0,
      label: { show: c.dataLabels.show, color: c.ink.text, fontSize: c.size, formatter: c.dataLabels.format ?? "{c}" },
      itemStyle: { borderColor: "transparent", borderWidth: 1 },
      emphasis: { disabled: true },
    },
  ];
}

/** 热力图色阶：visualMap 隐藏显示，只借用它的颜色映射（ECharts heatmap 强制要求 visualMap） */
function heatmapVisualMap(c: ResolvedChart) {
  const base = c.colors[0] ?? "#166534";
  const max = Math.max(...c.series.flatMap((s) => s.data), 0);
  return {
    show: false,
    type: "continuous" as const,
    min: 0,
    max: max > 0 ? max : 1,
    seriesIndex: 0,
    inRange: { color: [mixColor("#f7f7f5", base, 0.1), base] },
  };
}

function ganttSeries(c: ResolvedChart): CustomSeriesOption[] {
  const tasks = c.tasks;
  return [
    {
      type: "custom",
      name: "任务",
      coordinateSystem: "cartesian2d",
      clip: true,
      encode: { x: [1, 2], y: 0 },
      data: tasks.map((t, i) => [i, t.start, t.end, t.progress ?? 0]),
      renderItem: (params: unknown, api: unknown) => {
        const a = api as {
          value: (i: number) => number;
          coord: (p: [number, number]) => [number, number];
          size: (p: [number, number]) => [number, number];
        };
        const row = a.value(0);
        const p0 = a.coord([a.value(1), row]);
        const p1 = a.coord([a.value(2), row]);
        const thickness = Math.max(6, a.size([0, 1])[1] * 0.42);
        const color = c.colors[Math.trunc(row) % c.colors.length]!;
        const progress = Math.min(1, Math.max(0, a.value(3)));
        const x = p0[0];
        const y = p0[1] - thickness / 2;
        const w = Math.max(2, p1[0] - p0[0]);
        const children: Record<string, unknown>[] = [
          {
            type: "rect",
            shape: { x, y, width: w, height: thickness, r: thickness / 2 },
            style: { fill: mixColor(color, "#ffffff", 0.55) },
          },
        ];
        if (progress > 0) {
          children.push({
            type: "rect",
            shape: { x, y, width: Math.max(2, w * progress), height: thickness, r: thickness / 2 },
            style: { fill: color },
          });
        }
        const num = (v: number) => (Math.round(v * 10) / 10).toString();
        return {
          type: "group",
          children: [
            ...children,
            {
              type: "text",
              style: {
                x: num(x + w + 6),
                y: num(p0[1]),
                text: `${num(progress * 100)}%`,
                fill: c.ink.sub,
                font: `${c.size}px ${FONT_STACK}`,
                verticalAlign: "middle",
              },
            },
          ],
        };
      },
      emphasis: { disabled: true },
      label: { show: false },
    },
  ] as unknown as CustomSeriesOption[];
}

/* ---------------- 入口 ---------------- */

/** ChartEl + 像素盒 → ECharts option（容器宽高由 render.ts 的 SSR 实例控制，option 内只做布局百分比） */
export function chartOption(el: ChartEl): EChartsOption {
  const c = normalizeChart(el);
  const kind = c.kind;
  const base: EChartsOption = {
    animation: false,
    backgroundColor: "transparent",
    color: c.colors,
    textStyle: { fontFamily: FONT_STACK, fontSize: c.size, color: c.ink.text },
    legend: legendOf(c),
  };

  if (kind === "pie" || kind === "doughnut") {
    return { ...base, series: pieSeries(c, kind === "doughnut") };
  }
  if (kind === "radar") {
    const maxVal = c.axes.y.max ?? niceMax(Math.max(...c.series.flatMap((s) => s.data), 0));
    return {
      ...base,
      radar: {
        shape: "polygon",
        indicator: c.labels.map((name) => ({ name, max: maxVal })),
        radius: c.legend.show && c.legend.position === "bottom" ? "62%" : "68%",
        axisName: { color: c.ink.sub, fontSize: c.size },
        axisLine: { lineStyle: { color: c.ink.grid } },
        splitLine: { lineStyle: { color: c.ink.grid } },
        splitArea: { show: false },
      },
      series: radarSeries(c),
    };
  }
  if (kind === "funnel") return { ...base, series: funnelSeries(c) };
  if (kind === "treemap") return { ...base, series: treemapSeries(c) };

  const { xAxis, yAxis } = cartesianAxes(c);
  const grid = gridOf(c);
  const common = { ...base, grid, xAxis, yAxis };

  if (kind === "heatmap") {
    // 热力图 y 轴类目 = 系列名（heatmap 自身不提供类目）；x 轴类目 = labels
    const yAxisWithCats = { ...yAxis, data: c.series.map((s) => s.name || "系列") };
    return {
      ...common,
      yAxis: yAxisWithCats,
      visualMap: heatmapVisualMap(c),
      series: heatmapSeries(c),
    };
  }
  if (kind === "gantt") {
    const all = c.tasks.flatMap((t) => [t.start, t.end]);
    const lo = c.axes.x.min ?? Math.min(...all, 0);
    const hi = c.axes.x.max ?? Math.max(...all, lo + 1);
    return {
      ...common,
      xAxis: { ...xAxis, min: lo, max: hi },
      yAxis: { ...yAxis, data: c.tasks.map((t) => t.name) },
      series: ganttSeries(c),
    };
  }
  if (kind === "scatter" || kind === "bubble") {
    const bubble = kind === "bubble";
    const series: ScatterSeriesOption[] = c.series.map((s, i): ScatterSeriesOption => {
      const color = seriesColor(c, i);
      const pts = (s.points ?? []).map((p) => (bubble ? [p.x, p.y, p.size ?? Math.max(1, Math.abs(p.y))] : [p.x, p.y]));
      return {
        type: "scatter",
        name: s.name,
        data: pts,
        symbolSize: bubble
          ? (val: unknown) => {
              const v = val as number[];
              const size = Math.abs(v[2] ?? 1);
              return Math.max(6, Math.min(52, 5 + Math.sqrt(size) * 3));
            }
          : 8,
        itemStyle: { color, opacity: 0.86 },
        emphasis: { disabled: true },
        label: dataLabelOf(c, "line", "{c}"),
      };
    });
    return { ...common, series };
  }
  return { ...common, series: cartesianSeries(c) };
}

/** 未显式指定 theme 的图表跟随页底色：深底 → 深色主题，浅底保持浅色 */
export function autoTheme(el: ChartEl, dark: boolean): ChartEl {
  if (el.theme) return el;
  return dark ? { ...el, theme: "dark" as const } : el;
}

