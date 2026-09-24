/**
 * viewspec：元素 → 渲染无关视觉规格（DOM 与 Leafer 双渲染器的单一事实源）。
 * 所有"怎么画"的派生逻辑（默认值、颜色回退、描边宽度、自然点盒、行高、字体栈）
 * 集中在这里；render.tsx（DOM）与 leafer/scene.ts（canvas）只做 spec → 节点映射，
 * 从源头杜绝双渲染器视觉漂移。纯函数、无 React/DOM 依赖，可单测。
 */
import {
  CHART_PALETTE,
  drawNaturalBox,
  isDarkColor,
  type ChartEl,
  type DrawEl,
  type El,
  type ImageEl,
  type ShapeEl,
  type TableEl,
  type TextEl,
} from "./doc";

export const DEFAULT_TEXT_SIZE = 24;
export const DEFAULT_TEXT_COLOR = "#111827";
/** 文本行高倍数（DOM lineHeight 与 canvas 逐行排版共用） */
export const TEXT_LINE_HEIGHT = 1.35;
export const FONT_STACK =
  "-apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', Arial, sans-serif";

/* ---------------- 通用几何 ---------------- */

export type ElBox = { x: number; y: number; w: number; h: number; opacity?: number; rotation: number };
export function elBox(el: El): ElBox {
  return { x: el.x, y: el.y, w: el.w, h: el.h, opacity: el.opacity, rotation: el.rotation ?? 0 };
}

/* ---------------- 文本 ---------------- */

export type RunSpec = {
  text: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  /** 完整 CSS font-family 串（run 自带字体时前置并回退到全局栈） */
  fontFamily: string;
};

export function resolveRuns(el: TextEl): RunSpec[] {
  return el.runs.map((r) => ({
    text: r.text,
    fontSize: r.size ?? DEFAULT_TEXT_SIZE,
    bold: r.bold === true,
    italic: r.italic === true,
    underline: r.underline === true,
    color: r.color ?? DEFAULT_TEXT_COLOR,
    fontFamily: r.font ? `'${r.font}', ${FONT_STACK}` : FONT_STACK,
  }));
}

export type TextLayout = { align: "left" | "center" | "right"; vAlign: "top" | "middle" | "bottom" };
export function textLayout(el: TextEl): TextLayout {
  return { align: el.align ?? "left", vAlign: el.vAlign ?? "top" };
}

/* ---------------- 形状 ---------------- */

export type ShapeSpec = {
  shape: ShapeEl["shape"];
  strokeWidth: number;
  /** rect/ellipse 描边色；null = 无边 */
  stroke: string | null;
  /** rect/ellipse 填充；null = 透明 */
  fill: string | null;
  radius: number | undefined;
  /** line/arrow 的线色（含回退链） */
  lineColor: string;
};

/** 边框样式 → 虚线步长（DOM border-style / SVG dasharray / leafer dashPattern / pptx dashType 共用同一份语义） */
export function strokeDash(el: { strokeStyle?: "solid" | "dashed" | "dotted"; strokeWidth?: number }): number[] {
  const w = Math.max(1, el.strokeWidth ?? 2);
  if (el.strokeStyle === "dashed") return [w * 4, w * 3];
  if (el.strokeStyle === "dotted") return [w * 0.1, w * 2.2];
  return [];
}

export function shapeSpec(el: ShapeEl): ShapeSpec {
  const isLine = el.shape === "line" || el.shape === "arrow";
  const strokeWidth = el.strokeWidth ?? (isLine ? 2 : 1);
  // DOM 语义原样保留：无显式描边时用填充色描边（视觉即纯色块）
  const stroke =
    el.stroke && el.stroke !== "none"
      ? el.stroke
      : strokeWidth > 0 && el.fill !== "none"
        ? el.fill ?? null
        : null;
  const fill = el.fill && el.fill !== "none" ? el.fill : null;
  const lineColor = (el.stroke && el.stroke !== "none" ? el.stroke : el.fill) ?? DEFAULT_TEXT_COLOR;
  return { shape: el.shape, strokeWidth, stroke, fill, radius: el.radius, lineColor };
}

/**
 * line/arrow 对角端点（bbox 局部坐标，起点→终点；箭头头在终点）。
 * dir: 0=↘（缺省）1=↗ 2=↖ 3=↙ —— DOM/leafer/SVG 导出三轨共用。
 */
export function lineEnds(w: number, h: number, dir?: number): { x1: number; y1: number; x2: number; y2: number } {
  if (dir === 1) return { x1: 0, y1: h, x2: w, y2: 0 };
  if (dir === 2) return { x1: w, y1: h, x2: 0, y2: 0 };
  if (dir === 3) return { x1: w, y1: 0, x2: 0, y2: h };
  return { x1: 0, y1: 0, x2: w, y2: h };
}

/**
 * curve-arrow 二次贝塞尔：端点复用 lineEnds（dir 语义一致），
 * 控制点 = 弦中点 + 法线 × curve × 弦长（curve>0 逆时针弯，水平线默认向上拱；缺省 0.3，范围 [-1,1]）。
 * DOM/leafer/SVG 导出三轨共用；箭头头方向 = 终点切线（终点-控制点）。
 */
export function curveArrow(el: ShapeEl): { ax: number; ay: number; cx: number; cy: number; bx: number; by: number } {
  const e = lineEnds(el.w, el.h, el.dir);
  const curve = typeof el.curve === "number" ? Math.max(-1, Math.min(1, el.curve)) : 0.3;
  const mx = (e.x1 + e.x2) / 2;
  const my = (e.y1 + e.y2) / 2;
  const dx = e.x2 - e.x1;
  const dy = e.y2 - e.y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dy / len;
  const ny = -dx / len;
  return { ax: e.x1, ay: e.y1, cx: mx + nx * curve * len, cy: my + ny * curve * len, bx: e.x2, by: e.y2 };
}

/* ---------------- 图片 ---------------- */

/** fit → 绘制语义（DOM objectFit / canvas 裁剪计算共用同一枚举） */
export function imageFit(el: ImageEl): "cover" | "contain" | "fill" {
  const f = el.fit ?? "cover";
  return f === "stretch" ? "fill" : f;
}

/* ---------------- 钢笔手绘 ---------------- */

export type DrawSpec = {
  color: string;
  strokeWidth: number;
  /** 自然点盒：viewBox/坐标映射的基准（元素 w/h 拉伸填满它） */
  naturalW: number;
  naturalH: number;
  /** SVG polyline points 串（一位小数取整，DOM 渲染与导出共用） */
  points: string;
};

export function drawSpec(el: DrawEl): DrawSpec {
  const color = el.stroke && el.stroke !== "none" ? el.stroke : "#1d1d1f";
  const strokeWidth = el.strokeWidth ?? 2;
  const { w, h } = drawNaturalBox(el);
  const points = el.points.map(([x, y]) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`).join(" ");
  return { color, strokeWidth, naturalW: w, naturalH: h, points };
}

/* ---------------- 多边形形状 ---------------- */

export type PolyShape = "triangle" | "trapezoid" | "pentagon" | "hexagon" | "star";
export const POLY_SHAPES: readonly PolyShape[] = ["triangle", "trapezoid", "pentagon", "hexagon", "star"];

/** 顶点取整到两位小数，三轨数值一致 */
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 多边形顶点（bbox 局部坐标），几何与 OOXML preset 对齐：
 * triangle 顶点朝上；trapezoid 顶边内收 20%；pentagon 五角朝上的正五边形（内切椭圆）；
 * hexagon 左右尖顶、上下平边；star 五角星内半径 0.382（黄金比，同 OOXML star5）。
 */
export function polygonPoints(shape: PolyShape, w: number, h: number): [number, number][] {
  if (shape === "triangle") return [[w / 2, 0], [w, h], [0, h]];
  if (shape === "trapezoid") return [[w * 0.2, 0], [w * 0.8, 0], [w, h], [0, h]];
  if (shape === "hexagon")
    return [[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]];
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const n = shape === "pentagon" ? 5 : 10;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = ((-90 + (i * 360) / n) * Math.PI) / 180;
    const k = shape === "pentagon" ? 1 : i % 2 === 0 ? 1 : 0.382;
    pts.push([r2(cx + rx * k * Math.cos(a)), r2(cy + ry * k * Math.sin(a))]);
  }
  return pts;
}

/* ---------------- 表格 ---------------- */

export type TableSpec = {
  rows: string[][];
  cols: number;
  /** 每列左缘（局部 x，长度 cols+1，末位=总宽） */
  colX: number[];
  rowH: number;
  header: boolean;
  size: number;
  fill: string;
  headerFill: string;
  stroke: string;
  color: string;
};

/** 列宽权重归一化 + 默认样式回退，DOM/leafer/SVG 导出三轨共用 */
export function tableSpec(el: TableEl): TableSpec {
  const cols = Math.max(1, ...el.rows.map((r) => r.length));
  const w0 = el.colWidths;
  const weights = w0 && w0.length === cols && w0.every((v) => v > 0) ? w0 : Array<number>(cols).fill(1);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const colX: number[] = [0];
  for (let i = 0; i < cols; i++) colX.push(colX[i]! + (el.w * weights[i]!) / sum);
  return {
    rows: el.rows,
    cols,
    colX,
    rowH: el.h / el.rows.length,
    header: el.header !== false,
    size: el.size ?? 18,
    fill: el.fill ?? "#ffffff",
    headerFill: el.headerFill ?? "#eef0f2",
    stroke: el.stroke ?? "#d4d4d8",
    color: el.color ?? "#1d1d1f",
  };
}

/* ---------------- 数据图表 ---------------- */

/** 图表中间表示：一次数学，DOM/leafer/SVG 导出三轨消费（pptx 导出走原生 addChart） */
export type ChartPrim =
  | { t: "rect"; x: number; y: number; w: number; h: number; fill: string }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number }
  | { t: "poly"; points: [number, number][]; stroke: string; strokeWidth: number }
  | { t: "path"; d: string; fill: string }
  | { t: "circle"; cx: number; cy: number; r: number; fill: string }
  | {
      t: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      color: string;
      anchor: "start" | "middle" | "end";
      bold?: boolean;
    };

/** 值轴上限取整到"好看"的刻度（1/2/2.5/5 × 10^n） */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const f = v / pow;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * pow;
}

/** 扇区路径（cx,cy 圆心；r0 内半径 0=实心扇形；角度递增顺时针，canvas 坐标系） */
function sectorPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${r2(cx + r * Math.cos(a))} ${r2(cy + r * Math.sin(a))}`;
  if (r0 <= 0.01) return `M ${r2(cx)} ${r2(cy)} L ${p(r1, a0)} A ${r2(r1)} ${r2(r1)} 0 ${large} 1 ${p(r1, a1)} Z`;
  return `M ${p(r1, a0)} A ${r2(r1)} ${r2(r1)} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r2(r0)} ${r2(r0)} 0 ${large} 0 ${p(r0, a0)} Z`;
}

export type ChartLayout = {
  plot: { x: number; y: number; w: number; h: number };
  /** 类目 i 的横向槽位中心（bar/line 用） */
  slots: number[];
  niceMax: number;
  size: number;
  colors: string[];
  legendH: number;
};

/** 图表布局公共部分（绘图区、槽位、值轴上限、色板） */
export function chartLayout(el: ChartEl): ChartLayout {
  const size = el.size ?? 12;
  const labelH = el.chart === "pie" || el.chart === "doughnut" ? 0 : size + 8;
  const legendH = el.showLegend === true ? size + 14 : 0;
  const padLeft = el.chart === "pie" || el.chart === "doughnut" ? 12 : 44;
  const plot = {
    x: padLeft,
    y: 12,
    w: Math.max(10, el.w - padLeft - 12),
    h: Math.max(10, el.h - 12 - labelH - legendH - 6),
  };
  const n = Math.max(1, el.labels.length);
  const slots = Array.from({ length: n }, (_, i) => plot.x + ((i + 0.5) * plot.w) / n);
  const maxVal = Math.max(...el.series.flatMap((s) => s.data), 0);
  return {
    plot,
    slots,
    niceMax: niceMax(maxVal),
    size,
    colors: el.colors && el.colors.length > 0 ? el.colors : [...CHART_PALETTE],
    legendH,
  };
}

/**
 * 图表 → 图元序列。bar 柱状、line 折线（含圆点）、pie/doughnut 扇区（含百分比标注）。
 * 值轴画 4 分度网格线；图例（开启时）横排在底部。
 */
export function chartSpec(el: ChartEl): ChartPrim[] {
  const prims: ChartPrim[] = [];
  const { plot, slots, niceMax: max, size, colors, legendH } = chartLayout(el);
  const kind = el.chart ?? "bar";
  const gridColor = "#e4e4e7";
  const axisColor = "#a1a1aa";
  const labelColor = "#71717a";
  const yAt = (v: number) => plot.y + plot.h - (v / max) * plot.h;

  /* 值轴网格 + 刻度（bar/line） */
  if (kind === "bar" || kind === "line") {
    for (let i = 0; i <= 4; i++) {
      const v = (max * (4 - i)) / 4;
      const y = plot.y + (plot.h * i) / 4;
      prims.push({ t: "line", x1: plot.x, y1: y, x2: plot.x + plot.w, y2: y, stroke: i === 4 ? axisColor : gridColor, strokeWidth: 1 });
      prims.push({ t: "text", x: plot.x - 6, y, text: String(r2(v)), size: Math.max(8, size - 2), color: labelColor, anchor: "end" });
    }
  }

  if (kind === "bar") {
    const n = el.labels.length;
    const m = el.series.length;
    if (n > 0 && m > 0) {
      const groupW = (plot.w / n) * 0.75;
      const barW = Math.max(2, groupW / m);
      el.series.forEach((s, j) => {
        const fill = colors[j % colors.length]!;
        s.data.forEach((v, i) => {
          if (i >= n) return;
          const h = Math.max(0, (v / max) * plot.h);
          if (h <= 0) return;
          const x = plot.x + (i * plot.w) / n + (plot.w / n - groupW) / 2 + barW * j;
          prims.push({ t: "rect", x, y: plot.y + plot.h - h, w: barW, h, fill });
        });
      });
      el.labels.forEach((lb, i) => {
        prims.push({ t: "text", x: slots[i] ?? 0, y: plot.y + plot.h + size + 2, text: lb, size, color: labelColor, anchor: "middle" });
      });
    }
  } else if (kind === "line") {
    const n = el.labels.length;
    el.series.forEach((s, j) => {
      const stroke = colors[j % colors.length]!;
      const pts: [number, number][] = [];
      s.data.forEach((v, i) => {
        if (i >= n) return;
        pts.push([r2(slots[i]!), r2(yAt(v))]);
      });
      if (pts.length >= 2) prims.push({ t: "poly", points: pts, stroke, strokeWidth: 2.5 });
      for (const [cx, cy] of pts) prims.push({ t: "circle", cx, cy, r: 3, fill: stroke });
    });
    el.labels.forEach((lb, i) => {
      prims.push({ t: "text", x: slots[i] ?? 0, y: plot.y + plot.h + size + 2, text: lb, size, color: labelColor, anchor: "middle" });
    });
  } else {
    /* pie / doughnut：只取 series[0]，与 labels 逐位对齐 */
    const data = el.series[0]?.data ?? [];
    const items = el.labels
      .map((name, i) => ({ name, v: data[i] ?? 0 }))
      .filter((d) => d.v !== 0);
    const total = items.reduce((a, d) => a + d.v, 0);
    const cx = plot.x + plot.w / 2;
    const cy = plot.y + plot.h / 2;
    const r = Math.min(plot.w, plot.h) / 2;
    const r0 = kind === "doughnut" ? r * 0.55 : 0;
    const textFill = (fill: string) => (isDarkColor(fill) ? "#ffffff" : "#1d1d1f");
    if (total > 0 && items.length > 0) {
      // 单扇区时拆成两个半圆绘制，回避整圆 arc 的退化路径
      const slices = items.length === 1 ? [{ ...items[0]!, v: items[0]!.v / 2 }, { ...items[0]!, v: items[0]!.v / 2 }] : items;
      let a = -Math.PI / 2;
      slices.forEach((d, i) => {
        const sweep = (d.v / total) * Math.PI * 2;
        const fill = colors[i % colors.length]!;
        prims.push({ t: "path", d: sectorPath(cx, cy, r0, r, a, a + sweep), fill });
        if (r0 <= 0.01 && sweep > 0.35) {
          const mid = a + sweep / 2;
          const lr = r * 0.68;
          const pct = Math.round((d.v / total) * 100);
          prims.push({ t: "text", x: r2(cx + lr * Math.cos(mid)), y: r2(cy + lr * Math.sin(mid)), text: `${pct}%`, size: Math.max(9, size), color: textFill(fill), anchor: "middle", bold: true });
        }
        a += sweep;
      });
    }
  }

  /* 图例：bar/line 列系列名，pie/doughnut 列类目 */
  if (legendH > 0) {
    const entries =
      kind === "pie" || kind === "doughnut"
        ? (el.labels.map((name, i) => ({ name, color: colors[i % colors.length]! })))
        : el.series.map((s, j) => ({ name: s.name, color: colors[j % colors.length]! }));
    const chipY = el.h - legendH + 2;
    let x = plot.x;
    for (const e of entries) {
      if (x > el.w - 30) break;
      prims.push({ t: "rect", x, y: chipY, w: 10, h: 10, fill: e.color });
      prims.push({ t: "text", x: x + 14, y: chipY + 5, text: e.name, size: Math.max(8, size - 1), color: labelColor, anchor: "start" });
      x += 18 + e.name.length * size * 0.9;
    }
  }

  return prims;
}
