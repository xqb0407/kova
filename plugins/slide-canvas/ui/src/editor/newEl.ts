/**
 * 新建元素工厂 + 选择 kind + 界面模式（自 App.tsx 拆出）。
 * 插入（点工具栏/快捷键）与画线提交共用这里的 newEl 默认几何与配色。
 */
import {
  DEFAULT_CHART_LABELS,
  DEFAULT_CHART_SERIES,
  DEFAULT_EMBED_URL,
  DEFAULT_MERMAID_CODE,
  DEFAULT_SVG_CODE,
  DEFAULT_TABLE_ROWS,
  uid,
  type ChartEl,
  type EmbedEl,
  type MermaidEl,
  type ShapeEl,
  type SvgEl,
  type TableEl,
  type TextEl,
} from "@/doc";
import { DEFAULT_TEXT_SIZE } from "@/render";

/* ---------------- 新建元素工厂 ---------------- */

/** 居中落位参照盒：页框 = 框尺寸；画布级 = 当前页预设尺寸（虚拟框，落在原点）。dark = 目标页背景偏暗，线/字默认色转浅色 */
export function newEl(
  box: { w: number; h: number },
  kind: SelKind,
  dark = false,
): TextEl | ShapeEl | MermaidEl | EmbedEl | SvgEl | TableEl | ChartEl {
  const center = (w: number, h: number) => ({ x: Math.round((box.w - w) / 2), y: Math.round((box.h - h) / 2), w, h });
  if (kind === "mermaid") {
    return { kind: "mermaid", id: uid("m"), ...center(640, 400), code: DEFAULT_MERMAID_CODE };
  }
  if (kind === "embed") {
    return { kind: "embed", id: uid("em"), ...center(640, 400), url: DEFAULT_EMBED_URL };
  }
  if (kind === "svg") {
    return { kind: "svg", id: uid("sv"), ...center(480, 360), code: DEFAULT_SVG_CODE };
  }
  if (kind === "table") {
    return { kind: "table", id: uid("tb"), ...center(480, 220), rows: structuredClone(DEFAULT_TABLE_ROWS) };
  }
  if (kind === "chart") {
    return {
      kind: "chart",
      id: uid("ch"),
      ...center(480, 320),
      labels: [...DEFAULT_CHART_LABELS],
      series: structuredClone(DEFAULT_CHART_SERIES),
      showLegend: true,
    };
  }
  if (kind === "text") {
    return {
      kind: "text",
      id: uid("t"),
      ...center(560, 120),
      runs: [{ text: "双击编辑文本", size: DEFAULT_TEXT_SIZE, color: dark ? "#f5f5f7" : "#111827" }],
      align: "center",
      vAlign: "middle",
    };
  }
  const id = uid("s");
  // 插入元素默认色随 ClickHouse 色板：森林绿 CTA 色 + 淡黄；neon 只做强调不做填充
  if (kind === "rect") return { kind: "shape", id, shape: "rect", ...center(360, 200), fill: "#166534", radius: 8 };
  if (kind === "diamond") return { kind: "shape", id, shape: "diamond", ...center(300, 220), fill: "#166534" };
  if (kind === "ellipse") return { kind: "shape", id, shape: "ellipse", ...center(260, 260), fill: "#f4f692" };
  if (kind === "triangle") return { kind: "shape", id, shape: "triangle", ...center(240, 220), fill: "#166534" };
  if (kind === "trapezoid") return { kind: "shape", id, shape: "trapezoid", ...center(300, 200), fill: "#f4f692" };
  if (kind === "pentagon") return { kind: "shape", id, shape: "pentagon", ...center(260, 250), fill: "#166534" };
  if (kind === "hexagon") return { kind: "shape", id, shape: "hexagon", ...center(300, 240), fill: "#f4f692" };
  if (kind === "star") return { kind: "shape", id, shape: "star", ...center(240, 240), fill: "#f4f692" };
  // 线/箭头默认色随页背景自适应：深色页近白（写死深色在深色封面页上近乎不可见）。
  // 点击插入给 240×140 的 ↘ 斜线（dir 缺省 0），比 360×2 横线更有"箭头"的观感；拖拽绘制（A/L）不走这里。
  const line = { kind: "shape" as const, id, shape: kind, ...center(240, 140), stroke: dark ? "#f5f5f7" : "#1d1d1f", strokeWidth: 3 };
  return line;
}

export type SelKind =
  | "text"
  | "rect"
  | "diamond"
  | "ellipse"
  | "triangle"
  | "trapezoid"
  | "pentagon"
  | "hexagon"
  | "star"
  | "line"
  | "arrow"
  | "double-arrow"
  | "mermaid"
  | "embed"
  | "svg"
  | "table"
  | "chart";

/* ---------------- 模式承载 ---------------- */

/** 界面类型与文档类型同构（见 doc.ts DocKind）：类型在新建时定，打开即按档走 */
export type EditorMode = "board" | "deck";
