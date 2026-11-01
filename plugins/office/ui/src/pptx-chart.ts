/**
 * pptx 图表部件（ppt/charts/chartN.xml，DrawingML chartSpace）→ ChartSpec v2 片段。
 * 纯函数、XML 解析器注入（浏览器 DOMParser / 测试 @xmldom/xmldom）。
 *
 * 覆盖：bar/barH（barDir）、line、area、pie/doughnut、radar、scatter/bubble、
 * 漏斗/树图（Office 2016 扩展的 funnelChart/treemapChart）；同一 plotArea 下
 * 出现多族 bar+line/area 时按 combo 还原（系列自带 type）。
 * 热力图/甘特图无 OOXML 表达 → 返回 null，由调用方记告警。
 */
import type {
  ChartDataLabels,
  ChartKind,
  ChartLabelPos,
  ChartLegend,
  ChartLegendPos,
  ChartPoint,
  ChartSeries,
  ChartSeriesType,
  ChartVariant,
} from "./doc";

export type XmlDoc = Document;
export type XmlParser = (xml: string) => XmlDoc;

export type PptxChart = {
  chart: ChartKind;
  variant?: ChartVariant;
  labels: string[];
  series: ChartSeries[];
  legend?: ChartLegend;
  dataLabels?: ChartDataLabels;
  smooth?: boolean;
  /** 有损项（例如多绘图族只保留首个）→ 由 pptx-bridge 并入导入告警 */
  warnings?: string[];
};

const localName = (e: Element): string => e.nodeName.replace(/^.*:/, "");

/** 直接子层里第一个匹配局部名的节点（OOXML 前缀随文件而异，按 localName 匹配） */
function childOf(elem: Element | null | undefined, ...names: string[]): Element | null {
  if (!elem) return null;
  for (const c of Array.from(elem.children)) if (names.includes(localName(c))) return c;
  return null;
}

/** 任意后代里第一个匹配局部名的节点 */
function findDeep(elem: Element | null | undefined, name: string): Element | null {
  if (!elem) return null;
  for (const e of Array.from(elem.getElementsByTagName("*"))) if (localName(e) === name) return e;
  return null;
}

/** solidFill 内的颜色：srgbClr@val 优先，schemeClr 查主题色表 */
function readColor(elem: Element | null, theme: Record<string, string>): string | undefined {
  const srgb = findDeep(elem, "srgbClr");
  const v = srgb?.getAttribute("val");
  if (v) return `#${v.replace("#", "").toUpperCase()}`;
  const scheme = findDeep(elem, "schemeClr");
  const sv = scheme?.getAttribute("val");
  return sv ? theme[sv] : undefined;
}

/** 缓存点（strCache/numCache/strLit/numLit）→ 按 idx 归位的字符串数组 */
function readCache(container: Element | null): string[] {
  if (!container) return [];
  const out: string[] = [];
  let last = -1;
  for (const pt of Array.from(container.getElementsByTagName("*"))) {
    if (localName(pt) !== "pt") continue;
    const idx = Number(pt.getAttribute("idx") ?? last + 1);
    if (!Number.isFinite(idx) || idx < 0) continue;
    out[idx] = childOf(pt, "v")?.textContent ?? "";
    last = Math.max(last, idx);
  }
  return Array.from({ length: last + 1 }, (_, i) => out[i] ?? "");
}

const toNum = (s: string): number => {
  const n = Number(s.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};
const readNumbers = (container: Element | null): number[] => readCache(container).map(toNum);

/** 系列名：c:tx/strRef/strCache 首个点，或 c:tx/c:v 字面值 */
function readSeriesName(ser: Element): string {
  const tx = childOf(ser, "tx");
  if (!tx) return "";
  const first = readCache(tx).find((v) => v !== "");
  return first ?? childOf(tx, "v")?.textContent?.trim() ?? "";
}

function readSeriesColor(ser: Element, theme: Record<string, string>): string | undefined {
  const spPr = childOf(ser, "spPr");
  if (!spPr) return undefined;
  return readColor(childOf(spPr, "solidFill") ?? spPr, theme);
}

const FAMILY_KIND: Record<string, ChartKind> = {
  barChart: "bar",
  bar3DChart: "bar",
  lineChart: "line",
  line3DChart: "line",
  areaChart: "area",
  area3DChart: "area",
  pieChart: "pie",
  pie3DChart: "pie",
  ofPieChart: "pie",
  doughnutChart: "doughnut",
  radarChart: "radar",
  scatterChart: "scatter",
  bubbleChart: "bubble",
  funnelChart: "funnel",
  treemapChart: "treemap",
};

type Family = {
  elem: Element;
  kind: ChartKind;
  /** combo 里本族的系列形态 */
  type: ChartSeriesType;
  variant: ChartVariant;
};

function readFamily(elem: Element): Family | null {
  const kind = FAMILY_KIND[localName(elem)];
  if (!kind) return null;
  const horizontal = kind === "bar" && (childOf(elem, "barDir")?.getAttribute("val") ?? "col") === "bar";
  const grouping = childOf(elem, "grouping")?.getAttribute("val") ?? "clustered";
  const variant: ChartVariant =
    grouping === "stacked" ? "stacked" : grouping === "percentStacked" ? "percent" : "clustered";
  const type: ChartSeriesType = kind === "line" ? "line" : kind === "area" ? "area" : "bar";
  return { elem, kind: horizontal ? "barH" : kind, type, variant };
}

function readFamilySeries(fam: Family, theme: Record<string, string>): { series: ChartSeries[]; labels: string[] } {
  const series: ChartSeries[] = [];
  let labels: string[] = [];
  const nodes = Array.from(fam.elem.children).filter((c) => localName(c) === "ser");
  nodes.forEach((ser, i) => {
    const name = readSeriesName(ser) || `系列 ${i + 1}`;
    const color = readSeriesColor(ser, theme);
    if (fam.kind === "scatter" || fam.kind === "bubble") {
      const xs = readNumbers(childOf(ser, "xVal"));
      const ys = readNumbers(childOf(ser, "yVal"));
      const sizes = fam.kind === "bubble" ? readNumbers(childOf(ser, "bubbleSize")) : [];
      const points: ChartPoint[] = ys.map((y, j) => ({
        x: xs[j] ?? j + 1,
        y,
        ...(fam.kind === "bubble" ? { size: Math.max(1, sizes[j] ?? 1) } : {}),
      }));
      series.push({ name, data: [], points, ...(color ? { color } : {}) });
      return;
    }
    const cats = readCache(childOf(ser, "cat"));
    if (labels.length === 0 && cats.length > 0) labels = cats;
    series.push({ name, data: readNumbers(childOf(ser, "val")), ...(color ? { color } : {}) });
  });
  return { series, labels };
}

/** dLbls → 位置（outEnd 在柱图里即顶端，其余按语义近似） */
function readLabelPos(val: string | null): ChartLabelPos {
  if (val === "inEnd" || val === "inBase") return "inside";
  if (val === "ctr") return "center";
  if (val === "t") return "top";
  return "outside";
}

function readLegendPos(val: string | null): ChartLegendPos {
  if (val === "t" || val === "tr") return "top";
  if (val === "l") return "left";
  if (val === "r") return "right";
  return "bottom";
}

function readDataLabels(families: Family[]): ChartDataLabels | undefined {
  for (const fam of families) {
    const d = childOf(fam.elem, "dLbls");
    if (!d) continue;
    const show = childOf(d, "showVal")?.getAttribute("val");
    if (show !== "1" && show !== "true") continue;
    return { show: true, position: readLabelPos(childOf(d, "dLblPos")?.getAttribute("val") ?? null) };
  }
  return undefined;
}

function readSmooth(families: Family[]): boolean {
  for (const fam of families) {
    for (const ser of Array.from(fam.elem.children)) {
      if (localName(ser) !== "ser") continue;
      if (childOf(ser, "smooth")?.getAttribute("val") === "1") return true;
    }
  }
  return false;
}

/** chartSpace XML → ChartSpec v2 片段；无法识别（如曲面图）返回 null */
export function readChartXml(xml: string, parse: XmlParser, theme: Record<string, string>): PptxChart | null {
  const root = parse(xml).documentElement;
  const plotArea = findDeep(root, "plotArea");
  if (!plotArea) return null;

  const families = Array.from(plotArea.children)
    .map(readFamily)
    .filter((f): f is Family => f !== null);
  if (families.length === 0) return null;

  const first = families[0]!;
  // 多族且都能用 combo 表达（bar/line/area）时还原组合图，否则按首个族处理
  const combo =
    families.length > 1 && families.every((f) => f.kind === "bar" || f.kind === "barH" || f.kind === "line" || f.kind === "area");
  const used = combo ? families : [first];
  const dropped = combo ? [] : families.slice(1);

  let labels: string[] = [];
  const series: ChartSeries[] = [];
  for (const fam of used) {
    const r = readFamilySeries(fam, theme);
    if (labels.length === 0) labels = r.labels;
    for (const s of r.series) series.push(combo ? { ...s, type: fam.type } : s);
  }
  if (series.length === 0) return null;

  const chart: ChartKind = combo ? "combo" : first.kind;
  const chartNode = childOf(root, "chart");
  const legendEl = childOf(chartNode, "legend");
  const legend: ChartLegend | undefined = legendEl
    ? { show: true, position: readLegendPos(childOf(legendEl, "legendPos")?.getAttribute("val") ?? null) }
    : undefined;
  const dataLabels = readDataLabels(used);
  const smooth = readSmooth(used);
  const variant = chart === "bar" || chart === "barH" || chart === "area" ? first.variant : undefined;

  return {
    chart,
    ...(variant ? { variant } : {}),
    labels,
    series,
    ...(legend ? { legend } : {}),
    ...(dataLabels ? { dataLabels } : {}),
    ...(smooth ? { smooth: true } : {}),
    ...(dropped.length > 0
      ? { warnings: [`图表含多个绘图族，仅保留「${first.kind}」：${dropped.map((f) => f.kind).join("、")} 未转换`] }
      : {}),
  };
}
