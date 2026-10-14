/**
 * .pptx 导出：pptxgenjs 在浏览器内生成（单文件产物里是静态打进来的模块）。
 * 坐标换算：画板 px / 96 = 英寸；字号 px × 0.75 = pt。
 * 只导出 type:"slide" 的页框（数组序=页序）；画布级 objects 不进 pptx。
 * 有损项（面板导出按钮提示）：字体由 PowerPoint 就近替换、渐变背景降级为
 * 首个色、文本不透明度近似、手绘/mermaid 转位图。
 */
import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { bridge } from "./bridge";
import { assetDataUrl } from "./render";
import { currentMermaidTheme, renderMermaid, svgToPng } from "./mermaid";
import { PROVIDER_LABELS, resolveEmbed } from "./providers";
import { CHART_PALETTE, drawNaturalBox, slideFrames, type CanvasDoc, type ChartEl, type DrawEl, type EmbedEl, type ImageEl, type MermaidEl, type ShapeEl, type SlideTransition, type SvgEl, type TableEl, type TextEl } from "./doc";
import { rotVec } from "./geometry";
import { tableSpec } from "./viewspec";

const IN = 96;
const px2in = (v: number) => v / IN;
const px2pt = (v: number) => Math.round(v * 0.75 * 10) / 10;

/** 从任意 CSS 颜色串提取首个 #rgb/#rrggbb → pptx 无井号大写十六进制 */
function colorOf(css: string | undefined | null): string | null {
  if (!css || css === "none") return null;
  const m = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(css);
  if (!m) return null;
  const h = m[1];
  return (h.length === 3 ? h.split("").map((c) => c + c).join("") : h).toUpperCase();
}

const transparencyOf = (opacity?: number): number | undefined =>
  opacity !== undefined && opacity < 1 ? Math.round((1 - opacity) * 100) : undefined;

function geo(el: { x: number; y: number; w: number; h: number }) {
  return { x: px2in(el.x), y: px2in(el.y), w: px2in(el.w), h: px2in(el.h) };
}

function textOpts(el: TextEl) {
  return {
    ...geo(el),
    align: (el.align ?? "left") as "left" | "center" | "right",
    valign: (el.vAlign === "middle" ? "middle" : el.vAlign === "bottom" ? "bottom" : "top") as "top" | "middle" | "bottom",
    rotate: el.rotation ?? 0,
    lineSpacingMultiple: 1.35,
    isTextBox: true,
    fit: "none" as const,
  };
}

export async function exportPptx(doc: CanvasDoc, fileRel: string | null): Promise<void> {
  const slides = slideFrames(doc);
  if (slides.length === 0) throw new Error("文档没有页面");
  const pptx = new PptxGenJS();
  const first = slides[0];
  pptx.defineLayout({ name: "KOVA", width: px2in(first.w), height: px2in(first.h) });
  pptx.layout = "KOVA";
  pptx.title = doc.meta.name;

  for (const slide of slides) {
    const s = pptx.addSlide();
    s.background = { color: colorOf(slide.background) ?? "FFFFFF" };
    for (const el of slide.elements) {
      if (el.kind === "text") exportText(s, el);
      else if (el.kind === "shape") exportShape(pptx, s, el);
      else if (el.kind === "mermaid") await exportMermaid(pptx, s, el);
      else if (el.kind === "draw") await exportDraw(pptx, s, el);
      else if (el.kind === "image") await exportImage(pptx, s, el);
      else if (el.kind === "svg") await exportSvgEl(pptx, s, el);
      else if (el.kind === "embed") exportEmbed(pptx, s, el);
      else if (el.kind === "table") exportTable(pptx, s, el);
      else if (el.kind === "chart") exportChart(pptx, s, el);
    }
  }

  const b64 = (await pptx.write({ outputType: "base64" })) as unknown as string;
  const clean = b64.replace(/^data:[^,]*,/, "");
  const out = await injectTransitions(clean, slides.map((s) => s.transition ?? "slide"));
  const base = (fileRel?.replace(/\.canvas\.json$/i, "").split("/").pop() || doc.meta.name || "presentation").replace(
    /[\\/:*?"<>|]/g,
    "",
  );
  bridge.exportFile(`${base}.pptx`, out);
}

/**
 * 页切换动画注入：pptxgenjs 不支持 transition，直接在成品 zip 的
 * ppt/slides/slideN.xml（与 addSlide 序 1:1）补 CT_SlideTransition 节点——
 * slide=推入(push) / fade=淡入 / zoom≈淡入（基础转移集无缩放，PowerPoint 降级实现）/ none=不写。
 */
async function injectTransitions(b64: string, trans: SlideTransition[]): Promise<string> {
  const zip = await JSZip.loadAsync(b64, { base64: true });
  for (let i = 0; i < trans.length; i++) {
    const tr = trans[i]!;
    if (tr === "none") continue;
    const path = `ppt/slides/slide${i + 1}.xml`;
    const f = zip.file(path);
    if (!f) continue;
    const xml = await f.async("string");
    if (xml.includes("<p:transition")) continue; // 防御：已有转场不重复注入
    const tag = `<p:transition spd="med">${tr === "slide" ? '<p:push dir="r"/>' : "<p:fade/>"}</p:transition>`;
    // CT_Slide 序列：cSld → clrMapOvr → transition → timing；插到 timing 前（无 timing 则跟 clrMapOvr 后）
    const next = xml.includes("<p:timing")
      ? xml.replace("<p:timing", tag + "<p:timing")
      : xml.includes("</p:clrMapOvr>")
        ? xml.replace("</p:clrMapOvr>", "</p:clrMapOvr>" + tag)
        : xml.replace("</p:sld>", tag + "</p:sld>");
    zip.file(path, next);
  }
  return zip.generateAsync({ type: "base64" });
}

function exportText(s: PptxGenJS.Slide, el: TextEl): void {
  const tr = transparencyOf(el.opacity);
  s.addText(
    el.runs.map((r) => ({
      text: r.text,
      options: {
        bold: r.bold || undefined,
        italic: r.italic || undefined,
        underline: r.underline ? {} : undefined,
        color: colorOf(r.color) ?? "1D1D1F",
        fontSize: px2pt(r.size ?? 24),
        fontFace: r.font || undefined,
        transparency: tr,
      },
    })),
    textOpts(el),
  );
}

function exportShape(pptx: PptxGenJS, s: PptxGenJS.Slide, el: ShapeEl): void {
  const tr = transparencyOf(el.opacity);
  const lineColor = colorOf(el.stroke);
  const hasLine = lineColor !== null || el.fill === "none" || el.fill === undefined;
  const isLineKind = el.shape === "line" || el.shape === "arrow" || el.shape === "double-arrow";
  // 折线线类（pts≥3）：pptx 无折线图元 → 逐段 line 分解；线自身 rotation 烘焙进各段端点
  // （每段按世界坐标重算独立轴对齐 bbox，rotate 归零），箭头头只落首/末段端点。
  if (isLineKind && el.pts && el.pts.length >= 3) {
    const lineBase = {
      color: lineColor ?? "1D1D1F",
      width: Math.max(0.75, px2pt(el.strokeWidth ?? 2)),
      transparency: tr,
      ...dashType(el.strokeStyle),
    };
    const deg = el.rotation ?? 0;
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const abs = el.pts.map(([px, py]) => {
      const dx = el.x + px - cx;
      const dy = el.y + py - cy;
      const v = deg ? rotVec(dx, dy, deg) : { x: dx, y: dy };
      return { x: cx + v.x, y: cy + v.y };
    });
    for (let i = 0; i + 1 < abs.length; i++) {
      const a = abs[i];
      const b2 = abs[i + 1];
      const segLine: Record<string, unknown> = { ...lineBase };
      if (el.shape === "double-arrow" && i === 0) segLine.beginArrowType = "arrow";
      if (el.shape === "arrow" && i === abs.length - 2) segLine.endArrowType = "arrow";
      if (el.shape === "double-arrow" && i === abs.length - 2) segLine.endArrowType = "arrow";
      s.addShape(pptx.ShapeType.line, {
        x: px2in(Math.min(a.x, b2.x)),
        y: px2in(Math.min(a.y, b2.y)),
        w: px2in(Math.max(1, Math.abs(b2.x - a.x))),
        h: px2in(Math.max(1, Math.abs(b2.y - a.y))),
        rotate: 0,
        // "/"向段（↗/↙）：pptx line 几何恒左上→右下，用 flipV 镜像（与 dir 1/3 同规则）
        ...(Math.sign(b2.x - a.x) !== Math.sign(b2.y - a.y) ? { flipV: true } : {}),
        fill: undefined,
        line: segLine,
      });
    }
    return;
  }
  // line/arrow 方向：pptx 线几何恒为左上→右下，dir 1/3 用 flipV 镜像，dir≥2（↖/↙，头在起点）改用 beginArrowType
  const headAtStart = el.shape === "arrow" && (el.dir ?? 0) >= 2;
  const line = isLineKind
    ? {
        color: lineColor ?? "1D1D1F",
        width: Math.max(0.75, px2pt(el.strokeWidth ?? 2)),
        transparency: tr,
        ...(el.shape === "arrow"
          ? headAtStart
            ? { beginArrowType: "arrow" as const }
            : { endArrowType: "arrow" as const }
          : el.shape === "double-arrow"
            ? { beginArrowType: "arrow" as const, endArrowType: "arrow" as const }
            : {}),
        ...dashType(el.strokeStyle),
      }
    : hasLine && lineColor
      ? { color: lineColor, width: Math.max(0.5, px2pt(el.strokeWidth ?? 1)), transparency: tr, ...dashType(el.strokeStyle) }
      : undefined;
  const fill = !isLineKind
    ? { color: colorOf(el.fill) ?? "FFFFFF", transparency: colorOf(el.fill) ? tr : 100 }
    : undefined;
  const common = { ...geo(el), rotate: el.rotation ?? 0, fill, line };
  if (el.shape === "rect") {
    if (el.radius && el.radius > 0) s.addShape(pptx.ShapeType.roundRect, { ...common, rectRadius: px2in(el.radius) });
    else s.addShape(pptx.ShapeType.rect, common);
  } else if (el.shape === "diamond") {
    // PowerPoint 预设几何里的菱形（bbox 四中点），与 DOM/leafer 轨同几何
    s.addShape(pptx.ShapeType.diamond, common);
  } else if (el.shape === "triangle") {
    s.addShape(pptx.ShapeType.triangle, common);
  } else if (el.shape === "trapezoid") {
    s.addShape(pptx.ShapeType.trapezoid, common);
  } else if (el.shape === "pentagon") {
    s.addShape(pptx.ShapeType.pentagon, common);
  } else if (el.shape === "hexagon") {
    s.addShape(pptx.ShapeType.hexagon, common);
  } else if (el.shape === "star") {
    s.addShape(pptx.ShapeType.star5, common);
  } else if (isLineKind && (el.curve ?? 0) !== 0) {
    // 带弧度的线类 → PowerPoint arc preset（近似映射：curve<0 垂直镜像，dir 沿用镜像规则；直线头方向为近似）
    s.addShape(pptx.ShapeType.arc, {
      ...geo(el),
      rotate: 0,
      ...(el.dir === 1 || el.dir === 3 ? { flipV: true } : {}),
      ...(el.dir === 2 || el.dir === 3 ? { flipH: true } : {}),
      ...(el.curve! < 0 ? { flipV: !(el.dir === 1 || el.dir === 3) } : {}),
      fill: undefined,
      line: {
        color: lineColor ?? "1D1D1F",
        width: Math.max(0.75, px2pt(el.strokeWidth ?? 2)),
        transparency: tr,
        ...(el.shape === "double-arrow" ? { beginArrowType: "arrow" as const, endArrowType: "arrow" as const } : el.shape === "arrow" ? { endArrowType: "arrow" as const } : {}),
        ...dashType(el.strokeStyle),
      },
    });
  } else if (el.shape === "ellipse") {
    s.addShape(pptx.ShapeType.ellipse, common);
  } else {
    s.addShape(pptx.ShapeType.line, {
      ...geo(el),
      rotate: 0,
      ...(el.dir === 1 || el.dir === 3 ? { flipV: true } : {}),
      line: common.line,
    });
  }
}

/** 边框样式 → pptx dashType；solid 缺省不写字段（PowerPoint 默认实线） */
function dashType(style: "solid" | "dashed" | "dotted" | undefined): { dashType?: "dash" | "sysDot" } {
  if (style === "dashed") return { dashType: "dash" };
  if (style === "dotted") return { dashType: "sysDot" };
  return {};
}

async function exportImage(pptx: PptxGenJS, s: PptxGenJS.Slide, el: ImageEl): Promise<void> {
  const url = await assetDataUrl(el.src);
  if (!url) {
    // 资产取不到（缺失/独立开发态）：占位灰块，导出永不因此中断
    s.addShape(pptx.ShapeType.rect, { ...geo(el), fill: { color: "E5E7EB" } });
    return;
  }
  const fit = el.fit ?? "cover";
  const g = geo(el);
  s.addImage({
    data: url.replace(/^data:/, ""),
    ...(fit === "stretch"
      ? g
      : { x: g.x, y: g.y, w: g.w, h: g.h, sizing: { type: fit, w: g.w, h: g.h } }),
  });
}

/** mermaid 元素导出：渲染 SVG → 2× PNG 位图贴入；渲染失败降级为占位灰块 */
async function exportMermaid(pptx: PptxGenJS, s: PptxGenJS.Slide, el: MermaidEl): Promise<void> {
  const theme = currentMermaidTheme(el.theme);
  const r = await renderMermaid(el.code, theme);
  const png = r.svg
    ? await svgToPng(r.svg, el.w, el.h, theme === "dark" ? "#1e1e1e" : "#ffffff")
    : null;
  if (!png) {
    s.addShape(pptx.ShapeType.rect, { ...geo(el), fill: { color: "E5E7EB" } });
    return;
  }
  s.addImage({ data: png.replace(/^data:/, ""), ...geo(el) });
}

/** 手绘导出：点集拼 SVG polyline → 2× PNG 贴图（透明底）；失败降级占位。
 *  viewBox 用自然点盒拉伸到元素尺寸 + non-scaling-stroke，与画布渲染（DrawElView）一致 */
async function exportDraw(pptx: PptxGenJS, s: PptxGenJS.Slide, el: DrawEl): Promise<void> {
  const color = el.stroke && el.stroke !== "none" ? el.stroke : "#1d1d1f";
  const sw = el.strokeWidth ?? 2;
  const pts = el.points.map(([x, y]) => `${x},${y}`).join(" ");
  const nb = drawNaturalBox(el);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${el.w}" height="${el.h}" viewBox="0 0 ${nb.w} ${nb.h}" preserveAspectRatio="none">` +
    `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  const png = await svgToPng(svg, el.w, el.h, "transparent");
  if (!png) {
    s.addShape(pptx.ShapeType.rect, { ...geo(el), fill: { color: "E5E7EB" } });
    return;
  }
  s.addImage({ data: png.replace(/^data:/, ""), ...geo(el) });
}

/** svg 源码元素导出：源码 → 2× 透明底 PNG 贴入（svgToPng 内部 retag 根标签适配元素盒）；
 *  含 foreignObject 等光栅化失败的源码降级占位灰块（与画布轨兜底一致） */
async function exportSvgEl(pptx: PptxGenJS, s: PptxGenJS.Slide, el: SvgEl): Promise<void> {
  const png = await svgToPng(el.code, el.w, el.h, "transparent");
  if (!png) {
    s.addShape(pptx.ShapeType.rect, { ...geo(el), fill: { color: "E5E7EB" } });
    return;
  }
  s.addImage({ data: png.replace(/^data:/, ""), ...geo(el) });
}

/** embed 元素导出：pptx 无活网页能力 → 圆角占位框 + provider 名 + 可点击原文链接 */
function exportEmbed(pptx: PptxGenJS, s: PptxGenJS.Slide, el: EmbedEl): void {
  const g = geo(el);
  s.addShape(pptx.ShapeType.roundRect, {
    ...g,
    rectRadius: 0.08,
    fill: { color: "F6F7F4" },
    line: { color: "E5E7EB", width: 1 },
  });
  const label = el.title || PROVIDER_LABELS[resolveEmbed(el.url).provider];
  s.addText(
    [
      { text: label, options: { bold: true, color: "6B7280", fontSize: 12, breakLine: true } },
      { text: el.url, options: { hyperlink: { url: el.url, tooltip: label }, color: "0A84FF", fontSize: 10 } },
    ],
    {
      ...g,
      align: "center",
      valign: "middle",
      margin: 8,
      fit: "none",
      isTextBox: true,
    },
  );
}

/** 表格导出：pptx 原生表格（可继续编辑）；列宽权重 → 英寸，首行表头样式 */
function exportTable(pptx: PptxGenJS, s: PptxGenJS.Slide, el: TableEl): void {
  const t = tableSpec(el);
  const rows = t.rows.map((row, r) => {
    const isHead = r === 0 && t.header;
    return Array.from({ length: t.cols }, (_, c) => ({
      text: row[c] ?? "",
      options: {
        bold: isHead || undefined,
        color: colorOf(t.color) ?? "1D1D1F",
        fontSize: px2pt(t.size),
        fill: { color: colorOf(isHead ? t.headerFill : t.fill) ?? "FFFFFF" },
        align: "center" as const,
        valign: "middle" as const,
      },
    }));
  });
  const colW = Array.from({ length: t.cols }, (_, c) => px2in((t.colX[c + 1] ?? el.w) - (t.colX[c] ?? 0)));
  s.addTable(rows, {
    ...geo(el),
    colW,
    rowH: px2in(t.rowH),
    border: { type: "solid", color: colorOf(t.stroke) ?? "D4D4D8", pt: 0.75 },
  });
}

/** 图表导出：pptx 原生图表（可继续编辑）。柱状纵向（barDir:"col"）；饼/环取 series[0] */
function exportChart(pptx: PptxGenJS, s: PptxGenJS.Slide, el: ChartEl): void {
  const kind = el.chart ?? "bar";
  const palette = el.colors && el.colors.length > 0 ? el.colors : CHART_PALETTE;
  const chartColors = palette.map((c) => colorOf(c) ?? "166534");
  const axis = {
    catAxisLabelColor: "71717A",
    valAxisLabelColor: "71717A",
    catAxisLabelFontSize: 10,
    valAxisLabelFontSize: 10,
    valGridLine: { style: "solid" as const, size: 1, color: "E4E4E7" },
    catGridLine: { style: "none" as const },
  };
  if (kind === "pie" || kind === "doughnut") {
    const data = el.series[0]?.data ?? [];
    const n = Math.min(el.labels.length, data.length);
    s.addChart(
      kind === "pie" ? pptx.ChartType.pie : pptx.ChartType.doughnut,
      [{ name: el.series[0]?.name ?? "数据", labels: el.labels.slice(0, n), values: data.slice(0, n) }],
      {
        ...geo(el),
        chartColors,
        showLegend: el.showLegend === true,
        legendPos: "b",
        legendFontSize: 10,
        showPercent: true,
        dataLabelFontSize: 10,
        ...(kind === "doughnut" ? { holeSize: 55 } : {}),
      },
    );
    return;
  }
  s.addChart(
    kind === "bar" ? pptx.ChartType.bar : pptx.ChartType.line,
    el.series.map((sr) => ({ name: sr.name, labels: el.labels, values: sr.data.slice(0, el.labels.length) })),
    {
      ...geo(el),
      ...(kind === "bar" ? { barDir: "col" as const } : { lineSize: 2, lineSmooth: false }),
      chartColors,
      showLegend: el.showLegend === true,
      legendPos: "b",
      legendFontSize: 10,
      ...axis,
    },
  );
}
