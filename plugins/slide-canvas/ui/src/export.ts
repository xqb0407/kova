/**
 * .pptx 导出：pptxgenjs 在浏览器内生成（单文件产物里是静态打进来的模块）。
 * 坐标换算：画板 px / 96 = 英寸；字号 px × 0.75 = pt。
 * 只导出 type:"slide" 的页框（数组序=页序）；画布级 objects 不进 pptx。
 * 有损项（面板导出按钮提示）：字体由 PowerPoint 就近替换、渐变背景降级为
 * 首个色、文本不透明度与 line 的反向方向近似、手绘/mermaid 转位图。
 */
import PptxGenJS from "pptxgenjs";
import { bridge } from "./bridge";
import { assetDataUrl } from "./render";
import { currentMermaidTheme, renderMermaid, svgToPng } from "./mermaid";
import { drawNaturalBox, slideFrames, type CanvasDoc, type DrawEl, type ImageEl, type MermaidEl, type ShapeEl, type TextEl } from "./doc";

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
  pptx.defineLayout({ name: "XULUX", width: px2in(first.w), height: px2in(first.h) });
  pptx.layout = "XULUX";
  pptx.title = doc.meta.name;

  for (const slide of slides) {
    const s = pptx.addSlide();
    s.background = { color: colorOf(slide.background) ?? "FFFFFF" };
    for (const el of slide.elements) {
      if (el.kind === "text") exportText(s, el);
      else if (el.kind === "shape") exportShape(pptx, s, el);
      else if (el.kind === "mermaid") await exportMermaid(pptx, s, el);
      else if (el.kind === "draw") await exportDraw(pptx, s, el);
      else await exportImage(pptx, s, el);
    }
  }

  const b64 = (await pptx.write({ outputType: "base64" })) as unknown as string;
  const clean = b64.replace(/^data:[^,]*,/, "");
  const base = (fileRel?.replace(/\.canvas\.json$/i, "").split("/").pop() || doc.meta.name || "presentation").replace(
    /[\\/:*?"<>|]/g,
    "",
  );
  bridge.exportFile(`${base}.pptx`, clean);
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
  const line =
    el.shape === "line" || el.shape === "arrow"
      ? {
          color: lineColor ?? "1D1D1F",
          width: Math.max(0.75, px2pt(el.strokeWidth ?? 2)),
          transparency: tr,
          ...(el.shape === "arrow" ? { endArrowType: "arrow" as const } : {}),
        }
      : hasLine && lineColor
        ? { color: lineColor, width: Math.max(0.5, px2pt(el.strokeWidth ?? 1)), transparency: tr }
        : undefined;
  const fill =
    el.shape !== "line" && el.shape !== "arrow"
      ? { color: colorOf(el.fill) ?? "FFFFFF", transparency: colorOf(el.fill) ? tr : 100 }
      : undefined;
  const common = { ...geo(el), rotate: el.rotation ?? 0, fill, line };
  if (el.shape === "rect") {
    if (el.radius && el.radius > 0) s.addShape(pptx.ShapeType.roundRect, { ...common, rectRadius: px2in(el.radius) });
    else s.addShape(pptx.ShapeType.rect, common);
  } else if (el.shape === "ellipse") {
    s.addShape(pptx.ShapeType.ellipse, common);
  } else {
    // line/arrow：文档几何恒为左上→右下（渲染同方向），无需 flip
    s.addShape(pptx.ShapeType.line, {
      ...geo(el),
      rotate: 0,
      line: common.line,
    });
  }
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
