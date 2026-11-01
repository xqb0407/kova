/**
 * ChartSpec v2 归一化：把「文档里可能缺字段的 ChartEl」解析成渲染层可直接消费的有效规格。
 * 纯函数、无 DOM/ECharts 依赖——option.ts（ECharts 配置）、数据面板、MCP 预览共用同一份默认值，
 * 从源头避免「面板看到的样式」与「导出的样式」漂移。
 */
import {
  CHART_PALETTE,
  DEFAULT_CHART_LABELS,
  DEFAULT_CHART_SERIES,
  type ChartAxis,
  type ChartDataLabels,
  type ChartEl,
  type ChartKind,
  type ChartLegendPos,
  type ChartPoint,
  type ChartSeries,
  type ChartSeriesType,
  type ChartTask,
  type ChartTheme,
  type ChartVariant,
} from "../doc";

/* ---------------- 类型元信息（UI 选择器 / MCP 文档共用） ---------------- */

export type ChartGroup = "rect" | "polar" | "other";

export const CHART_META: Record<ChartKind, { label: string; group: ChartGroup }> = {
  bar: { label: "柱状图", group: "rect" },
  barH: { label: "条形图", group: "rect" },
  line: { label: "折线图", group: "rect" },
  area: { label: "面积图", group: "rect" },
  combo: { label: "组合图", group: "rect" },
  scatter: { label: "散点图", group: "rect" },
  bubble: { label: "气泡图", group: "rect" },
  pie: { label: "饼图", group: "polar" },
  doughnut: { label: "环形图", group: "polar" },
  radar: { label: "雷达图", group: "polar" },
  funnel: { label: "漏斗图", group: "other" },
  treemap: { label: "树图", group: "other" },
  heatmap: { label: "热力图", group: "other" },
  gantt: { label: "甘特图", group: "other" },
};

/** 直角坐标系里「类目轴」的位置（x=底部类目 / y=左侧类目）；无轴的图形返回 null */
export function categoryAxisOf(kind: ChartKind): "x" | "y" | null {
  if (kind === "bar" || kind === "line" || kind === "area" || kind === "combo") return "x";
  if (kind === "barH") return "y";
  if (kind === "heatmap" || kind === "gantt") return "y";
  return null;
}

/** 使用直角坐标系的类型 */
export function usesCartesian(kind: ChartKind): boolean {
  return (
    kind === "bar" || kind === "barH" || kind === "line" || kind === "area" || kind === "combo" || kind === "scatter" || kind === "bubble" || kind === "heatmap" || kind === "gantt"
  );
}

/** 数值轴/类目轴的默认网格线：数值轴开、类目轴关 */
const CATEGORY_GRID_DEFAULT = false;
const VALUE_GRID_DEFAULT = true;

/* ---------------- 主题 ---------------- */

export type ChartInk = {
  /** 主文字（数值标签、图例文字） */
  text: string;
  /** 次级文字（轴标签） */
  sub: string;
  /** 轴线 */
  axis: string;
  /** 分隔网格线 */
  grid: string;
};

const INK: Record<ChartTheme, ChartInk> = {
  light: { text: "#1d1d1f", sub: "#71717a", axis: "#a1a1aa", grid: "#e8e8ec" },
  dark: { text: "#f5f5f7", sub: "#a1a1a6", axis: "#6b6b70", grid: "#303036" },
};

/* ---------------- 归一化 ---------------- */

export type ResolvedAxis = {
  title: string;
  show: boolean;
  grid: boolean;
  rotate: number;
  min?: number;
  max?: number;
  format?: string;
  /** 本轴在该图表里是否承载类目 */
  categorical: boolean;
};

export type ResolvedLabels = { show: boolean; position: "inside" | "outside" | "center" | "top"; format?: string };

export type ResolvedChart = {
  kind: ChartKind;
  variant: ChartVariant;
  labels: string[];
  series: ChartSeries[];
  tasks: ChartTask[];
  colors: string[];
  legend: { show: boolean; position: ChartLegendPos };
  dataLabels: ResolvedLabels;
  axes: { x: ResolvedAxis; y: ResolvedAxis };
  smooth: boolean;
  size: number;
  theme: ChartTheme;
  ink: ChartInk;
};

const numOr = (v: number | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function resolveAxis(raw: ChartAxis | undefined, categorical: boolean): ResolvedAxis {
  return {
    title: raw?.title ?? "",
    show: raw?.show !== false,
    grid: raw?.grid ?? (categorical ? CATEGORY_GRID_DEFAULT : VALUE_GRID_DEFAULT),
    rotate: raw?.rotate ?? 0,
    min: numOr(raw?.min),
    max: numOr(raw?.max),
    format: raw?.format,
    categorical,
  };
}

/** 图例默认：直角坐标系多系列显示；饼/环/漏斗/树图与单系列隐藏（检查器与归一化共用） */
export function chartLegendDefault(kind: ChartKind, seriesCount: number): boolean {
  if (kind === "pie" || kind === "doughnut" || kind === "funnel" || kind === "treemap") return false;
  return seriesCount > 1;
}

/** combo 系列的形态：首系列柱、其余折线（没有显式 type 时） */
function seriesTypeOf(s: ChartSeries, index: number, kind: ChartKind): ChartSeriesType {
  if (s.type) return s.type;
  if (kind === "combo") return index === 0 ? "bar" : "line";
  if (kind === "area") return "area";
  if (kind === "line" || kind === "radar") return "line";
  return "bar";
}

export function normalizeChart(el: ChartEl): ResolvedChart {
  const kind = el.chart ?? "bar";
  const variant: ChartVariant = kind === "bar" || kind === "barH" || kind === "area" ? el.variant ?? "clustered" : "clustered";
  const colors = el.colors && el.colors.length > 0 ? [...el.colors] : [...CHART_PALETTE];
  const series = el.series.map((s, i) => ({ ...s, type: seriesTypeOf(s, i, kind) }));
  const cat = categoryAxisOf(kind);
  const axes = {
    x: resolveAxis(el.axes?.x, cat === "x"),
    y: resolveAxis(el.axes?.y, cat === "y"),
  };
  // 热力图：x 轴为类目（labels），y 轴为系列名——两者都是类目轴
  if (kind === "heatmap") {
    axes.x.grid = el.axes?.x?.grid ?? false;
    axes.x.categorical = true;
    axes.y.grid = el.axes?.y?.grid ?? false;
    axes.y.categorical = true;
  }
  // 散点/气泡：双数值轴
  if (kind === "scatter" || kind === "bubble") {
    axes.x.categorical = false;
    axes.y.categorical = false;
  }
  const theme: ChartTheme = el.theme === "dark" ? "dark" : "light";
  const legend: { show: boolean; position: ChartLegendPos } = {
    show: el.legend?.show ?? el.showLegend ?? chartLegendDefault(kind, series.length),
    position: el.legend?.position ?? "bottom",
  };
  const dataLabels: ResolvedLabels = {
    show: el.dataLabels?.show ?? (kind === "pie" || kind === "doughnut" || kind === "funnel"),
    position: el.dataLabels?.position ?? "outside",
    format: el.dataLabels?.format,
  };
  return {
    kind,
    variant,
    labels: el.labels,
    series,
    tasks: el.tasks ?? [],
    colors,
    legend,
    dataLabels,
    axes,
    smooth: el.smooth === true,
    size: el.size ?? 12,
    theme,
    ink: INK[theme],
  };
}

/** 系列实色：显式 color 优先，否则按序循环色板 */
export function seriesColor(c: ResolvedChart, index: number): string {
  return c.series[index]?.color ?? c.colors[index % c.colors.length]!;
}

/** 值轴上限取整到"好看"的刻度（1/2/2.5/5 × 10^n），雷达/百分比堆叠共用 */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const f = v / pow;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * pow;
}

/** 百分比堆叠：按类目总和归一到 100（总和为 0 的类目补 0） */
export function percentRows(c: ResolvedChart): number[][] {
  const rows = c.series.map((s) => [...s.data]);
  const n = c.labels.length;
  for (let i = 0; i < n; i++) {
    const total = rows.reduce((a, r) => a + Math.abs(r[i] ?? 0), 0);
    for (const r of rows) r[i] = total > 0 ? Math.round(((Math.abs(r[i] ?? 0) / total) * 100 + Number.EPSILON) * 10) / 10 : 0;
  }
  return rows;
}

/* ---------------- 类型切换的数据适配 ---------------- */

const DEFAULT_TASKS: ChartTask[] = [
  { name: "需求分析", start: 1, end: 3, progress: 1 },
  { name: "设计", start: 3, end: 6, progress: 0.6 },
  { name: "开发", start: 6, end: 11, progress: 0.2 },
  { name: "测试上线", start: 11, end: 14 },
];

/**
 * 切图表类型时把现有数据换成目标类型可消费的形状（不丢原有数值）：
 * 散点/气泡由类目序号作 x、原数值作 y；甘特由类目生成时间条；
 * 目标类型需要类目而文档为空时补默认类目。返回可直接 patch 的字段。
 */
export function chartKindPatch(el: ChartEl, kind: ChartKind): Partial<ChartEl> {
  const patch: Partial<ChartEl> = { chart: kind };
  const hasSeriesData = el.series.some((s) => s.data.length > 0);
  if (kind === "scatter" || kind === "bubble") {
    if (!el.series.some((s) => s.points && s.points.length > 0)) {
      const src = hasSeriesData ? el.series : DEFAULT_CHART_SERIES;
      patch.series = src.map((s) => ({
        name: s.name,
        data: [],
        points: s.data.map((y, i): ChartPoint => ({ x: i + 1, y, ...(kind === "bubble" ? { size: Math.max(1, Math.abs(y)) } : {}) })),
      }));
    }
  } else {
    const pointSeries = el.series.filter((s) => s.points && s.points.length > 0);
    if (!hasSeriesData && pointSeries.length > 0) {
      // 从散点图切回类目图：x 当类目、y 当数值
      const n = Math.max(...pointSeries.map((s) => s.points!.length));
      patch.labels = Array.from({ length: n }, (_, i) => {
        const p = pointSeries[0]!.points![i];
        return p ? String(p.x) : `类目 ${i + 1}`;
      });
      patch.series = pointSeries.map((s) => ({ name: s.name, data: s.points!.map((p) => p.y) }));
    }
  }
  if (kind === "gantt" && (!el.tasks || el.tasks.length === 0)) patch.tasks = DEFAULT_TASKS.map((t) => ({ ...t }));
  if (kind !== "gantt" && kind !== "scatter" && kind !== "bubble" && el.labels.length === 0) patch.labels = [...DEFAULT_CHART_LABELS];
  if (kind !== "gantt" && !hasSeriesData && !el.series.some((s) => s.points?.length)) {
    patch.series = DEFAULT_CHART_SERIES.map((s) => ({ name: s.name, data: [...s.data] }));
  }
  return patch;
}

/* ---------------- 缓存键 ---------------- */

/**
 * 渲染缓存键：元素 id + 尺寸 + 影响像素的全部规格。数据/样式任一处改动 → 键变化 → 重渲染。
 * 用 JSON 串做键（图表规格体积小），比手写哈希更不易漏字段。
 */
export function chartRenderKey(el: ChartEl, w: number, h: number): string {
  const payload = {
    k: el.chart ?? "bar",
    v: el.variant,
    l: el.labels,
    s: el.series,
    t: el.tasks,
    c: el.colors,
    le: el.legend,
    sl: el.showLegend,
    ax: el.axes,
    dl: el.dataLabels,
    sm: el.smooth,
    th: el.theme,
    z: el.size,
    w: Math.round(w),
    h: Math.round(h),
  };
  return `${el.id}|${JSON.stringify(payload)}`;
}
