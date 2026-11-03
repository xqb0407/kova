/**
 * .pptx 导出：pptxgenjs 在浏览器内生成（单文件产物里是静态打进来的模块）。
 * 坐标换算：画板 px / 96 = 英寸；字号 px × 0.75 = pt。
 * 只导出 type:"slide" 的页框（数组序=页序）；画布级 objects 不进 pptx。
 * 有损项（面板导出按钮提示）：字体由 PowerPoint 就近替换、渐变背景降级为
 * 首个色、文本不透明度近似、手绘/mermaid 转位图。
 */
import PptxGenJS from "pptxgenjs";
import { jsPDF } from "jspdf";
import JSZip from "jszip";
import { bridge } from "./bridge";
import { chartRender } from "./chart/render";
import { autoTheme } from "./chart/option";
import { CHART_META, categoryAxisOf, normalizeChart } from "./chart/spec";
import { assetDataUrl } from "./render";
import { currentMermaidTheme, renderMermaid, svgToPng } from "./mermaid";
import { PROVIDER_LABELS, resolveEmbed } from "./providers";
import { drawNaturalBox, isDarkColor, slideFrames, type CanvasDoc, type ChartEl, type DrawEl, type EmbedEl, type Frame, type ImageEl, type MermaidEl, type ShapeEl, type SlideTransition, type SvgEl, type TableEl, type TextEl } from "./doc";
import { rotVec } from "./geometry";
import { tableSpec, textLineHeight } from "./viewspec";
import { frameToSvg } from "./export-svg";

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
    lineSpacingMultiple: textLineHeight(el),
    isTextBox: true,
    fit: "none" as const,
  };
}

/** 页脚/页码（pptx）：与 DOM/SVG 导出的 chrome 同语义 */
function exportPageChrome(pptx: PptxGenJS, s: PptxGenJS.Slide, frame: Frame, meta: CanvasDoc["meta"], index: number, total: number): void {
  void pptx;
  const color = isDarkColor(frame.background) ? "E5E7EB" : "6B7280";
  const y = px2in(frame.h - 46);
  const h = px2in(24);
  if (meta.footer) {
    s.addText(meta.footer, {
      x: px2in(24),
      y,
      w: px2in(frame.w * 0.68),
      h,
      fontSize: 10,
      color,
      align: "left",
      valign: "middle",
      isTextBox: true,
      fit: "none",
    });
  }
  if (meta.pageNumber) {
    s.addText(`${index} / ${total}`, {
      x: px2in(frame.w * 0.68),
      y,
      w: px2in(frame.w * 0.32 - 48),
      h,
      fontSize: 10,
      color,
      align: "right",
      valign: "middle",
      isTextBox: true,
      fit: "none",
    });
  }
}

export async function exportPptx(doc: CanvasDoc, fileRel: string | null): Promise<void> {
  const slides = slideFrames(doc);
  if (slides.length === 0) throw new Error("文档没有页面");
  const pptx = new PptxGenJS();
  const first = slides[0];
  pptx.defineLayout({ name: "KOVA", width: px2in(first.w), height: px2in(first.h) });
  pptx.layout = "KOVA";
  pptx.title = doc.meta.name;

  for (let pi = 0; pi < slides.length; pi++) {
    const slide = slides[pi]!;
    const s = pptx.addSlide();
    s.background = { color: colorOf(slide.background) ?? "FFFFFF" };
    const dark = isDarkColor(slide.background);
    for (const el of slide.elements) {
      if (el.kind === "text") exportText(s, el);
      else if (el.kind === "shape") exportShape(pptx, s, el);
      else if (el.kind === "mermaid") await exportMermaid(pptx, s, el);
      else if (el.kind === "draw") await exportDraw(pptx, s, el);
      else if (el.kind === "image") await exportImage(pptx, s, el);
      else if (el.kind === "svg") await exportSvgEl(pptx, s, el);
      else if (el.kind === "embed") exportEmbed(pptx, s, el);
      else if (el.kind === "table") exportTable(pptx, s, el);
      else if (el.kind === "chart") await exportChart(pptx, s, autoTheme(el, dark));
    }
    if (doc.meta.pageNumber || doc.meta.footer) {
      exportPageChrome(pptx, s, slide, doc.meta, pi + 1, slides.length);
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

/* ---------------- PDF 导出（SVG 光栅化 → jsPDF，逐页一页） ---------------- */

/** SVG 字符串 → PNG dataURL（2x 取样，打印级清晰度） */
function svgToPngDataUrl(svg: string, w: number, h: number, scale = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(2, Math.round(w * scale));
        canvas.height = Math.max(2, Math.round(h * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("canvas 不可用"));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error("页面光栅化失败（SVG 内含不支持的外部资源）"));
    img.src = url;
  });
}

/** 导出 PDF：每页 = 一页 PDF（页码/页脚与放映/pptx/svg 一致） */
export async function exportPdf(doc: CanvasDoc, fileRel: string | null): Promise<void> {
  const slides = slideFrames(doc);
  if (slides.length === 0) throw new Error("文档没有页面");
  const first = slides[0]!;
  const orient = (w: number, h: number): "landscape" | "portrait" => (w >= h ? "landscape" : "portrait");
  const pdf = new jsPDF({ orientation: orient(first.w, first.h), unit: "px", format: [first.w, first.h] });
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i]!;
    if (i > 0) pdf.addPage([s.w, s.h], orient(s.w, s.h));
    const chrome =
      doc.meta.pageNumber || doc.meta.footer
        ? { index: i + 1, total: slides.length, showNumber: doc.meta.pageNumber, footer: doc.meta.footer }
        : undefined;
    const svg = await frameToSvg(s, chrome);
    const png = await svgToPngDataUrl(svg, s.w, s.h, 2);
    pdf.addImage(png, "PNG", 0, 0, s.w, s.h);
  }
  const base = (fileRel?.replace(/\.canvas\.json$/i, "").split("/").pop() || doc.meta.name || "presentation").replace(
    /[\\/:*?"<>|]/g,
    "",
  );
  const dataUrl = pdf.output("datauristring");
  bridge.exportFile(`${base}.pdf`, dataUrl.replace(/^data:[^,]*,/, ""));
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

/** 有原生支持的类型（其余走图片兜底：像素与画布一致，不缺信息） */
const NATIVE_CHART_KINDS: ReadonlySet<string> = new Set(["bar", "barH", "line", "area", "pie", "doughnut", "radar", "scatter", "bubble"]);

/** 散点/气泡的共享 X 值：pptx 原生只支持所有系列共用一组 X，x 不一致就退回位图 */
function sharedXY(el: ChartEl): { xs: number[]; series: { name: string; ys: number[]; sizes?: number[] }[] } | null {
  const pts = el.series.map((s) => s.points ?? []);
  if (!pts.some((p) => p.length > 0)) return null;
  const xs = pts[0]!.map((p) => p.x);
  const same = pts.every((p) => p.length === xs.length && p.every((q, i) => q.x === xs[i]));
  if (!same) return null;
  return {
    xs,
    series: el.series.map((s, i) => ({
      name: s.name,
      ys: pts[i]!.map((p) => p.y),
      ...(el.chart === "bubble" ? { sizes: pts[i]!.map((p) => Math.max(0, p.size ?? Math.abs(p.y))) } : {}),
    })),
  };
}

/** 图片兜底：ECharts SSR SVG → 2x PNG（透明底，与画布像素同源） */
async function exportChartImage(s: PptxGenJS.Slide, el: ChartEl): Promise<void> {
  const png = await svgToPng(chartRender(el).svg, el.w, el.h, "transparent", 2);
  if (png) s.addImage({ data: png, ...geo(el), altText: `${CHART_META[el.chart ?? "bar"].label}（位图，数据保留在画布中）` });
  else s.addText(CHART_META[el.chart ?? "bar"].label, { ...geo(el), align: "center", valign: "middle", fontSize: 10, color: "71717A" });
}

/** 图表导出：标准类型走 pptx 原生（可继续编辑）；组合/漏斗/树图/热力/甘特走位图 */
async function exportChart(pptx: PptxGenJS, s: PptxGenJS.Slide, el: ChartEl): Promise<void> {
  const kind = el.chart ?? "bar";
  if (!NATIVE_CHART_KINDS.has(kind)) return exportChartImage(s, el);
  if ((kind === "scatter" || kind === "bubble") && !sharedXY(el)) return exportChartImage(s, el);

  const c = normalizeChart(el);
  const text = colorOf(c.ink.sub) ?? "71717A";
  const label = colorOf(c.ink.text) ?? "1D1D1F";
  const color = (v: string | undefined, fb: string) => colorOf(v) ?? fb;
  const colors = c.colors.map((v) => color(v, "166534"));
  // 轴标题按「屏幕上看到的轴」映射：barH 的类目轴是 y
  const cat = categoryAxisOf(kind);
  const catTitle = cat === "y" ? c.axes.y.title : c.axes.x.title;
  const valTitle = cat === "y" ? c.axes.x.title : c.axes.y.title;
  const valAxis = cat === "y" ? c.axes.x : c.axes.y;
  const common: PptxGenJS.IChartOpts = {
    ...geo(el),
    chartColors: colors,
    catAxisLabelColor: text,
    valAxisLabelColor: text,
    catAxisLabelFontSize: 10,
    valAxisLabelFontSize: 10,
    catGridLine: { style: "none" },
    valGridLine: { style: "solid", size: 1, color: color(c.ink.grid, "E4E4E7") },
    showLegend: c.legend.show,
    legendPos: ({ top: "t", bottom: "b", left: "l", right: "r" } as const)[c.legend.position],
    legendFontSize: Math.max(8, Math.round(c.size * 0.75)),
    legendColor: text,
    showValue: c.dataLabels.show,
    dataLabelColor: label,
    dataLabelFontSize: Math.max(8, Math.round(c.size * 0.75)),
    ...(catTitle ? { catAxisTitle: catTitle, catAxisTitleColor: text, catAxisTitleFontSize: 10 } : {}),
    ...(valTitle ? { valAxisTitle: valTitle, valAxisTitleColor: text, valAxisTitleFontSize: 10 } : {}),
    ...(typeof valAxis.min === "number" ? { valAxisMinVal: valAxis.min } : {}),
    ...(typeof valAxis.max === "number" ? { valAxisMaxVal: valAxis.max } : {}),
  };

  if (kind === "pie" || kind === "doughnut") {
    const data = el.series[0]?.data ?? [];
    const n = Math.min(el.labels.length, data.length);
    s.addChart(
      kind === "pie" ? pptx.ChartType.pie : pptx.ChartType.doughnut,
      [{ name: el.series[0]?.name ?? "数据", labels: el.labels.slice(0, n), values: data.slice(0, n) }],
      { ...common, showValue: false, showPercent: c.dataLabels.show, ...(kind === "doughnut" ? { holeSize: 55 } : {}) },
    );
    return;
  }

  if (kind === "scatter" || kind === "bubble") {
    const xy = sharedXY(el)!;
    // pptxgenjs 约定：data[0] 是共享 X 值，其余每项是一个 Y 系列
    const data: PptxGenJS.OptsChartData[] = [
      { name: "X", values: xy.xs },
      ...xy.series.map((sr) => ({ name: sr.name, values: sr.ys, ...(sr.sizes ? { sizes: sr.sizes } : {}) })),
    ];
    s.addChart(kind === "bubble" ? pptx.ChartType.bubble : pptx.ChartType.scatter, data, common);
    return;
  }

  const rows = (data: number[]) => Array.from({ length: el.labels.length }, (_, i) => data[i] ?? 0);
  const series = (kind === "radar" ? el.series : c.series).map((sr) => ({
    name: sr.name,
    labels: el.labels,
    values: rows(sr.data),
  }));
  if (kind === "radar") {
    s.addChart(pptx.ChartType.radar, series, { ...common, radarStyle: "marker" });
    return;
  }
  // pptxgenjs 的 area 只认 stacked/standard；百分比堆叠位图兜底，避免导出后语义丢失
  if (kind === "area" && c.variant === "percent") return exportChartImage(s, el);
  const type = kind === "bar" || kind === "barH" ? pptx.ChartType.bar : kind === "area" ? pptx.ChartType.area : pptx.ChartType.line;
  const grouping = c.variant === "stacked" ? "stacked" : c.variant === "percent" ? "percentStacked" : "clustered";
  s.addChart(type, series, {
    ...common,
    ...(kind === "bar" || kind === "barH" ? { barDir: kind === "bar" ? "col" : "bar", barGrouping: grouping, barGapWidthPct: 60 } : {}),
    ...(kind === "area" ? { barGrouping: c.variant === "stacked" ? "stacked" : "standard" } : {}),
    ...(kind === "line" ? { lineSize: 2, lineSmooth: c.smooth, lineDataSymbol: "circle" } : {}),
  });
}
