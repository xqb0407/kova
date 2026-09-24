/**
 * SVG / HTML 导出（与 export.ts 的 pptx 导出共用 viewspec 视觉规格）：
 * - SVG：每页一个 .svg，矢量直出（形状/文本/图片/手绘；mermaid 以 svg data-url 内嵌），
 *   渐变背景与 pptx 同策略降级为首色。
 * - HTML：单文件自含放映页（内嵌全部页 SVG + 键盘/点击翻页 + 自适应缩放），零依赖。
 * 文本换算：离屏 canvas measureText 按 runs 逐段测量做贪心折行（近 DOM break-word）；
 * 落盘统一走 bridge.exportFile（doc.export → 宿主写工作区）。
 */
import { bridge } from "./bridge";
import { assetDataUrl } from "./render";
import { currentMermaidTheme, renderMermaid, svgCodeUrl } from "./mermaid";
import { PROVIDER_LABELS, resolveEmbed } from "./providers";
import { chartSpec, curveArrow, drawSpec, elBox, imageFit, isPolyline, lineEnds, polygonPoints, resolveRuns, strokeDash, tableSpec, TEXT_LINE_HEIGHT, type ChartPrim, type PolyShape, type RunSpec } from "./viewspec";
import { slideFrames, type CanvasDoc, type ChartEl, type DrawEl, type El, type EmbedEl, type Frame, type ImageEl, type MermaidEl, type ShapeEl, type SvgEl, type TableEl, type TextEl } from "./doc";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 任意 CSS 颜色/渐变串 → 首个 hex（渐变降级，与 pptx 导出同策略）；none → null */
function firstColor(css: string | undefined | null): string | null {
  if (!css || css === "none") return null;
  const m = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(css);
  if (!m) return null;
  const h = m[1]!;
  return `#${h.length === 3 ? h.split("").map((c) => c + c).join("") : h}`;
}

/** hex 是否偏暗（相对亮度 < .45）：放映页的底部 chrome 颜色随当前页底色切换 */
function isDark(hex: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.45;
}

const dashAttr = (el: { strokeStyle?: "solid" | "dashed" | "dotted"; strokeWidth?: number }) => {
  const d = strokeDash(el);
  return d.length ? ` stroke-dasharray="${d.join(" ")}"` : "";
};

const opaAttr = (el: { opacity?: number }) =>
  el.opacity !== undefined && el.opacity < 1 ? ` opacity="${el.opacity}"` : "";

const rotAttr = (b: { x: number; y: number; w: number; h: number; rotation: number }) =>
  b.rotation ? ` transform="rotate(${b.rotation} ${b.x + b.w / 2} ${b.y + b.h / 2})"` : "";

/* ---------------- 文本：离屏测量 + 贪心折行（近 DOM break-word 语义） ---------------- */

let measureCtx: CanvasRenderingContext2D | null = null;
function mctx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const cv = document.createElement("canvas");
    cv.width = 8;
    cv.height = 8;
    measureCtx = cv.getContext("2d")!;
  }
  return measureCtx;
}

const widthOf = (run: RunSpec, text: string): number => {
  const ctx = mctx();
  ctx.font = `${run.italic ? "italic " : ""}${run.bold ? "700 " : "400 "}${run.fontSize}px ${run.fontFamily}`;
  return ctx.measureText(text).width;
};

/** 可断行单元：CJK/全角逐字、其余连续非空白成词、空白单独（可收缩） */
function tokenize(text: string): string[] {
  return (text.match(/\s+|[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]|[^\s\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]+/g) ?? []).filter((t) => t.length > 0);
}

type TextSeg = { run: RunSpec; text: string; w: number };
type TextLine = { segs: TextSeg[]; w: number };

function wrapRuns(runs: RunSpec[], boxW: number): TextLine[] {
  // 先按显式 \n 分段，再逐段贪心填行
  const paras: { run: RunSpec; text: string }[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) paras.push([]);
      if (part) paras[paras.length - 1]!.push({ run, text: part });
    });
  }
  const lines: TextLine[] = [];
  for (const para of paras) {
    let line: TextLine = { segs: [], w: 0 };
    const push = (seg: TextSeg) => {
      line.segs.push(seg);
      line.w += seg.w;
    };
    for (const { run, text } of para) {
      for (const tok of tokenize(text)) {
        const tw = widthOf(run, tok);
        if (line.w + tw <= boxW || line.segs.length === 0) {
          // 与行尾同 run 的相邻段合并，控制 tspan 数量
          const last = line.segs[line.segs.length - 1];
          if (last && last.run === run && tok.trim()) {
            last.text += tok;
            last.w += tw;
            line.w += tw;
          } else if (!tok.trim() && !line.w) {
            continue; // 行首空白丢弃
          } else {
            push({ run, text: tok, w: tw });
          }
          continue;
        }
        // 超宽：单个词本身比盒宽 → 逐字符硬断；否则换行
        if (tw > boxW) {
          for (const ch of tok) {
            const cw = widthOf(run, ch);
            if (line.w + cw > boxW && line.w > 0) {
              lines.push(line);
              line = { segs: [], w: 0 };
            }
            const last = line.segs[line.segs.length - 1];
            if (last && last.run === run) {
              last.text += ch;
              last.w += cw;
              line.w += cw;
            } else {
              push({ run, text: ch, w: cw });
            }
          }
        } else {
          lines.push(line);
          line = { segs: [], w: 0 };
          if (!tok.trim()) continue;
          push({ run, text: tok, w: tw });
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

function svgText(el: TextEl): string {
  const b = elBox(el);
  const runs = resolveRuns(el);
  const lines = wrapRuns(runs, b.w);
  const lineH = (fs: number) => fs * TEXT_LINE_HEIGHT;
  const totalH = lines.reduce(
    (s, l) => s + lineH(l.segs.length ? Math.max(...l.segs.map((g) => g.run.fontSize)) : 24),
    0,
  );
  const vAlign = el.vAlign ?? "top";
  let top = vAlign === "middle" ? b.y + (b.h - totalH) / 2 : vAlign === "bottom" ? b.y + b.h - totalH : b.y;
  const align = el.align ?? "left";
  const out: string[] = [];
  for (const line of lines) {
    if (!line.segs.length) {
      top += lineH(24);
      continue;
    }
    const fs = Math.max(...line.segs.map((g) => g.run.fontSize));
    const lh = lineH(fs);
    const startX = align === "center" ? b.x + (b.w - line.w) / 2 : align === "right" ? b.x + b.w - line.w : b.x;
    const baseline = top + (lh - fs) / 2 + fs * 0.82;
    let x = startX;
    const spans = line.segs
      .map((g) => {
        const r = g.run;
        const t =
          `<tspan x="${x.toFixed(1)}" y="${baseline.toFixed(1)}" font-size="${r.fontSize}"` +
          (r.bold ? ' font-weight="700"' : "") +
          (r.italic ? ' font-style="italic"' : "") +
          (r.underline ? ' text-decoration="underline"' : "") +
          ` fill="${r.color}"` +
          ` font-family="${esc(r.fontFamily)}">${esc(g.text)}</tspan>`;
        x += g.w;
        return t;
      })
      .join("");
    out.push(`<text${opaAttr(el)}${rotAttr(b)}>${spans}</text>`);
    top += lh;
  }
  return out.join("");
}

/* ---------------- 形状 / 图片 / 手绘 / mermaid ---------------- */

function svgShape(el: ShapeEl): string {
  const b = elBox(el);
  const stroke = el.stroke && el.stroke !== "none" ? el.stroke : null;
  const fill = el.fill && el.fill !== "none" ? el.fill : null;
  const isLineKind = el.shape === "line" || el.shape === "arrow" || el.shape === "double-arrow";
  const sw = el.strokeWidth ?? (isLineKind ? 2 : 1);
  const common = ` stroke-width="${sw}"${dashAttr(el)} stroke="${esc(stroke ?? "none")}"`;
  if (el.shape === "rect") {
    return (
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"` +
      (el.radius ? ` rx="${el.radius}"` : "") +
      ` fill="${esc(fill ?? "none")}"${common}${opaAttr(el)}${rotAttr(b)}/>`
    );
  }
  if (el.shape === "ellipse") {
    return (
      `<ellipse cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" rx="${b.w / 2}" ry="${b.h / 2}"` +
      ` fill="${esc(fill ?? "none")}"${common}${opaAttr(el)}${rotAttr(b)}/>`
    );
  }
  // line / arrow / double-arrow（折线 pts / curve≠0 二次贝塞尔弧 / 对角直线）/ diamond / polygons：与 ShapeElView 同构
  const lineColor = esc((el.stroke && el.stroke !== "none" ? el.stroke : el.fill) ?? "#0e0f0c");
  const ends = lineEnds(b.w, b.h, el.dir);
  const marker =
    isLineKind && el.shape !== "line"
      // 敞口 V 箭头头（Excalidraw 式），与 render.tsx marker 同款：0.7×线宽/单位 → 1.43 单位描边 ≈ 线身同宽
      ? `<defs><marker id="ar-${el.id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10" fill="none" stroke="${lineColor}" stroke-width="1.43" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`
      : "";
  const markerAttrs =
    el.shape === "arrow"
      ? ` marker-end="url(#ar-${el.id})"`
      : el.shape === "double-arrow"
        ? ` marker-start="url(#ar-${el.id})" marker-end="url(#ar-${el.id})"`
        : "";
  const polyPts = (pts: [number, number][]) => pts.map(([x, y]) => `${x},${y}`).join(" ");
  const c = isLineKind && !isPolyline(el) && (el.curve ?? 0) !== 0 ? curveArrow({ ...el, w: b.w, h: b.h }) : null;
  const body = isPolyline(el)
    ? `<polyline points="${polyPts(el.pts as [number, number][])}" fill="none"${common} stroke-linecap="round" stroke-linejoin="round"${markerAttrs}/>`
    : c
    ? `<path d="M ${c.ax} ${c.ay} Q ${c.cx} ${c.cy} ${c.bx} ${c.by}" fill="none"${common} stroke-linecap="round"${markerAttrs}/>`
    : isLineKind
      ? `<line x1="${ends.x1}" y1="${ends.y1}" x2="${ends.x2}" y2="${ends.y2}"${common} stroke-linecap="round"${markerAttrs}/>`
      : el.shape === "diamond"
      ? `<polygon points="${b.w / 2},0 ${b.w},${b.h / 2} ${b.w / 2},${b.h} 0,${b.h / 2}" fill="${esc(fill ?? "none")}"${common} stroke-linejoin="round"/>`
      : `<polygon points="${polyPts(polygonPoints(el.shape as PolyShape, b.w, b.h))}" fill="${esc(fill ?? "none")}"${common} stroke-linejoin="round"/>`;
  return `<g${opaAttr(el)}${rotAttr(b)}><g transform="translate(${b.x} ${b.y})">${marker}${body}</g></g>`;
}

async function svgImage(el: ImageEl): Promise<string> {
  const b = elBox(el);
  const data = await assetDataUrl(el.src);
  if (!data) {
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#e5e7eb"${opaAttr(el)}/>`;
  }
  const fit = imageFit(el);
  const par = fit === "cover" ? "xMidYMid slice" : fit === "contain" ? "xMidYMid meet" : "none";
  const clip = el.radius ? `cl-${el.id}` : null;
  const clipDef = clip ? `<defs><clipPath id="${clip}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${el.radius}"/></clipPath></defs>` : "";
  return (
    `${clipDef}<image href="${esc(data)}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"` +
    ` preserveAspectRatio="${par}"${clip ? ` clip-path="url(#${clip})"` : ""}${opaAttr(el)}${rotAttr(b)}/>`
  );
}

function svgDraw(el: DrawEl): string {
  const b = elBox(el);
  const s = drawSpec(el);
  return (
    `<g${opaAttr(el)}${rotAttr(b)}><svg x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" viewBox="0 0 ${s.naturalW} ${s.naturalH}" preserveAspectRatio="none" overflow="visible">` +
    `<polyline points="${s.points}" fill="none" stroke="${esc(s.color)}" stroke-width="${s.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
    `</svg></g>`
  );
}

async function svgMermaid(el: MermaidEl): Promise<string> {
  const b = elBox(el);
  const theme = currentMermaidTheme(el.theme);
  const r = await renderMermaid(el.code, theme);
  if (!r.svg) {
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#e5e7eb"${opaAttr(el)}/>`;
  }
  const data = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(r.svg)))}`;
  return (
    `<image href="${esc(data)}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"` +
    ` preserveAspectRatio="xMidYMid meet"${opaAttr(el)}${rotAttr(b)}/>`
  );
}

/** svg 源码元素：以 data-url <image> 内嵌——矢量保留、跨查看器沙箱化（内嵌脚本不执行） */
function svgSvgEl(el: SvgEl): string {
  const b = elBox(el);
  return (
    `<image href="${svgCodeUrl(el.code)}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"` +
    ` preserveAspectRatio="xMidYMid meet"${opaAttr(el)}${rotAttr(b)}/>`
  );
}

/** embed 元素：SVG 无活网页 → 占位框 + provider 名 + 原文链接（浏览器里 <a> 可点） */
function svgEmbed(el: EmbedEl): string {
  const b = elBox(el);
  const label = esc(el.title || PROVIDER_LABELS[resolveEmbed(el.url).provider]);
  const fs = Math.min(16, Math.max(9, b.w / 40));
  const fs2 = Math.max(8, fs - 2);
  return (
    `<g${opaAttr(el)}${rotAttr(b)}><a href="${esc(el.url)}" target="_blank">` +
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="#f6f7f4" stroke="#e5e7eb"/>` +
    `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 - fs * 0.3}" text-anchor="middle" font-size="${fs}" fill="#6b7280" font-family="-apple-system,'Segoe UI','PingFang SC',sans-serif">${label} · 网页</text>` +
    `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + fs2 * 1.2}" text-anchor="middle" font-size="${fs2}" fill="#0a84ff" font-family="monospace">${label.length > 0 ? esc(el.url.length > 60 ? el.url.slice(0, 60) + "…" : el.url) : ""}</text>` +
    `</a></g>`
  );
}

const SVG_FONT = "-apple-system,'Segoe UI','PingFang SC',sans-serif";

/** 表格：绝对定位单元格 rect + 居中文本（tableSpec 同源，与 DOM/leafer 轨一致） */
function svgTable(el: TableEl): string {
  const t = tableSpec(el);
  const b = elBox(el);
  const cells: string[] = [];
  t.rows.forEach((row, r) => {
    const isHead = r === 0 && t.header;
    for (let c = 0; c < t.cols; c++) {
      const cx = t.colX[c] ?? 0;
      const cw = (t.colX[c + 1] ?? el.w) - cx;
      const y = r * t.rowH;
      cells.push(
        `<rect x="${cx}" y="${y}" width="${cw}" height="${t.rowH}" fill="${isHead ? t.headerFill : t.fill}" stroke="${t.stroke}" stroke-width="1"/>`,
      );
      const txt = row[c] ?? "";
      if (txt) {
        cells.push(
          `<text x="${cx + cw / 2}" y="${y + t.rowH / 2}" text-anchor="middle" dominant-baseline="central" font-size="${t.size}"${isHead ? ' font-weight="700"' : ""} fill="${t.color}" font-family="${SVG_FONT}">${esc(txt)}</text>`,
        );
      }
    }
  });
  return `<g${opaAttr(el)}${rotAttr(b)}><g transform="translate(${b.x} ${b.y})">${cells.join("")}</g></g>`;
}

/** ChartPrim → SVG 元素（文本语义：y=行垂直中心、x 按 anchor） */
function svgPrim(p: ChartPrim): string {
  switch (p.t) {
    case "rect":
      return `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="${p.fill}"/>`;
    case "line":
      return `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}"/>`;
    case "poly":
      return `<polyline points="${p.points.map(([x, y]) => `${x},${y}`).join(" ")}" fill="none" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>`;
    case "path":
      return `<path d="${p.d}" fill="${p.fill}"/>`;
    case "circle":
      return `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="${p.fill}"/>`;
    case "text":
      return (
        `<text x="${p.x}" y="${p.y}" text-anchor="${p.anchor}" dominant-baseline="central" font-size="${p.size}"${p.bold ? ' font-weight="700"' : ""} fill="${p.color}" font-family="${SVG_FONT}">` +
        esc(p.text) +
        `</text>`
      );
  }
}

/** 图表：chartSpec 图元 → SVG（与 DOM 轨同源） */
function svgChart(el: ChartEl): string {
  const b = elBox(el);
  return `<g${opaAttr(el)}${rotAttr(b)}><g transform="translate(${b.x} ${b.y})">${chartSpec(el).map(svgPrim).join("")}</g></g>`;
}

/* ---------------- 页 → SVG 文档 ---------------- */

export async function frameToSvg(frame: Frame): Promise<string> {
  const parts: string[] = [];
  const bg = firstColor(frame.background) ?? "#ffffff";
  parts.push(`<rect width="${frame.w}" height="${frame.h}" fill="${bg}"/>`);
  for (const el of frame.elements as El[]) {
    if (el.kind === "text") parts.push(svgText(el as TextEl));
    else if (el.kind === "shape") parts.push(svgShape(el as ShapeEl));
    else if (el.kind === "image") parts.push(await svgImage(el as ImageEl));
    else if (el.kind === "draw") parts.push(svgDraw(el as DrawEl));
    else if (el.kind === "mermaid") parts.push(await svgMermaid(el as MermaidEl));
    else if (el.kind === "svg") parts.push(svgSvgEl(el as SvgEl));
    else if (el.kind === "embed") parts.push(svgEmbed(el as EmbedEl));
    else if (el.kind === "table") parts.push(svgTable(el as TableEl));
    else if (el.kind === "chart") parts.push(svgChart(el as ChartEl));
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.w}" height="${frame.h}" viewBox="0 0 ${frame.w} ${frame.h}">` +
    parts.join("") +
    `</svg>`
  );
}

const baseName = (doc: CanvasDoc, fileRel: string | null) =>
  (fileRel?.replace(/\.canvas\.json$/i, "").split("/").pop() || doc.meta.name || "presentation").replace(
    /[\\/:*?"<>|]/g,
    "",
  );

/** 导出 SVG：每页一个 `<名称>-pN.svg` */
export async function exportSvgAll(doc: CanvasDoc, fileRel: string | null): Promise<number> {
  const slides = slideFrames(doc);
  if (slides.length === 0) throw new Error("文档没有页面");
  const base = baseName(doc, fileRel);
  for (let i = 0; i < slides.length; i++) {
    const svg = await frameToSvg(slides[i]!);
    bridge.exportFile(`${base}-p${i + 1}.svg`, btoa(unescape(encodeURIComponent(svg))));
  }
  return slides.length;
}

/**
 * 导出 HTML：单文件自含放映页（anxin-ppt 式）——
 * 全屏舞台：页面顶满视口一个轴，比例不符的边带用该页自身底色填充（深页深边），底部 chrome 随页色明暗自适应；
 * 三种翻页转场（T 键/点击标签循环：横向滑动 / 淡入淡出 / 缩放淡入）、
 * Esc 呼出缩略图索引（点缩略图跳页、当前页高亮）、底部操作提示 + 页码圆点（封面页隐藏）。
 */
export async function exportHtml(doc: CanvasDoc, fileRel: string | null): Promise<void> {
  const slides = slideFrames(doc);
  if (slides.length === 0) throw new Error("文档没有页面");
  const base = baseName(doc, fileRel);
  const W = slides[0]!.w;
  const H = slides[0]!.h;
  const svgs: string[] = [];
  for (const s of slides) svgs.push(await frameToSvg(s));
  const dataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  // 舞台页：inline svg 会把 mermaid 嵌套 svg 的事件带出来，翻页用 <img> 更稳。
  // --sb = 本页背景色：屏幕比例与页面不符时，多余区域由页色铺满（黑页黑边），视觉上即全屏。
  // embed 元素在 <img> 之上叠真活 <iframe>（按页盒百分比定位，随页等比缩放）；
  // iframe 恒浮于本页 svg 之上——元素 z 序中高于 embed 的内容会被盖住，属已知取舍。
  const slidesHtml = svgs
    .map((svg, i) => {
      const sb = firstColor(slides[i]!.background) ?? "#ffffff";
      const tr = slides[i]!.transition ?? "slide";
      const embeds = (slides[i]!.elements.filter((e) => e.kind === "embed") as EmbedEl[])
        .map((el) => {
          const t = resolveEmbed(el.url);
          const pos =
            `left:${((el.x / W) * 100).toFixed(3)}%;top:${((el.y / H) * 100).toFixed(3)}%;` +
            `width:${((el.w / W) * 100).toFixed(3)}%;height:${((el.h / H) * 100).toFixed(3)}%`;
          return (
            `<iframe src="${esc(t.embedUrl)}" title="${esc(el.title || PROVIDER_LABELS[t.provider])}" loading="lazy"` +
            ` sandbox="allow-scripts allow-same-origin allow-popups allow-forms" allow="fullscreen; autoplay"` +
            ` style="position:absolute;border:0;background:#f6f7f4;${pos}"></iframe>`
          );
        })
        .join("");
      return `<section class="slide" style="--sb:${sb}" data-dark="${isDark(sb) ? 1 : 0}" data-tr="${tr}"><span class="sl"><img draggable="false" alt="" src="${dataUrl(svg)}">${embeds}</span></section>`;
    })
    .join("\n");
  const thumbsHtml = svgs
    .map((svg, i) => {
      const thumb = svg.replace("<svg ", `<svg width="480" height="${Math.round((480 * H) / W)}" `);
      return (
        `<button class="th"${i === 0 ? ' data-cur="1"' : ""} data-i="${i}">` +
        `<span class="tw"><img draggable="false" alt="" src="${dataUrl(thumb)}"></span>` +
        `<span class="tl"><span>第 ${i + 1} 页</span><span>${String(i + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}</span></span>` +
        `</button>`
      );
    })
    .join("\n");
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.meta.name || base)}</title>
<style>
  :root{--bg:#0b0b0d;--muted:#6b6e66;--line:rgba(14,15,12,.14)}
  html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);
    font-family:"Inter","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",Arial,sans-serif}
  /* —— 全屏舞台：页面顶满一个轴，剩余边带用本页底色（--sb）铺满，视觉上即无边框 —— */
  #deck{height:100vh;display:flex;transition:transform .55s cubic-bezier(.2,0,.2,1)}
  .slide{flex:0 0 100vw;width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;
    background:var(--sb,#fff)}
  .slide img{width:min(100vw,calc(100vh * ${W} / ${H}));height:auto;display:block}
  /* embed 活 iframe 的定位参照盒：精确包住页面 img（百分比坐标 = 页盒坐标） */
  .slide .sl{position:relative;display:inline-block;font-size:0;line-height:0}
  /* —— 转场：m-auto 按页设置（默认）· m-slide 横向推移 · m-fade 淡入淡出 · m-zoom 缩放淡入 —— */
  /* auto：堆叠渲染，进入页盖在旧页上做入场动画（推入可见下层，与 PPT 语义一致） */
  body.m-auto #deck{transform:none!important;display:block}
  body.m-auto .slide{position:absolute;inset:0;pointer-events:none}
  body.m-auto .slide.on{z-index:2;pointer-events:auto}
  @keyframes in-slide{from{transform:translateX(100vw)}}
  @keyframes in-fade{from{opacity:0}}
  @keyframes in-zoom{from{opacity:0;transform:scale(.92)}}
  body.m-auto .slide.on[data-tr="slide"]{animation:in-slide .55s cubic-bezier(.2,0,.2,1)}
  body.m-auto .slide.on[data-tr="fade"]{animation:in-fade .55s ease}
  body.m-auto .slide.on[data-tr="zoom"]{animation:in-zoom .55s cubic-bezier(.16,1,.3,1)}
  body.m-fade #deck,body.m-zoom #deck{transform:none!important;display:block}
  body.m-fade .slide,body.m-zoom .slide{position:absolute;inset:0;opacity:0;pointer-events:none;
    transition:opacity .55s ease}
  body.m-fade .slide.on,body.m-zoom .slide.on{opacity:1;pointer-events:auto}
  body.m-zoom .slide img{transform:scale(.92);transition:transform .55s cubic-bezier(.16,1,.3,1)}
  body.m-zoom .slide.on img{transform:scale(1)}
  @keyframes sc-rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
  body.m-slide .slide.on img{animation:sc-rise .55s cubic-bezier(.16,1,.3,1)}
  /* —— 底部 chrome：颜色随当前页明暗自适应 —— */
  .footer{position:fixed;left:3vw;right:3vw;bottom:2.2vh;display:flex;justify-content:space-between;
    align-items:center;font-size:12px;z-index:10;transition:opacity .3s,color .3s;color:var(--muted);
    font-variant-numeric:tabular-nums}
  body.ui-dark .footer{color:rgba(255,255,255,.62)}
  body.cover .footer{opacity:0;pointer-events:none}
  .fr{display:flex;align-items:center;gap:14px}
  .md{cursor:pointer;border:1px solid currentColor;background:none;color:inherit;font:inherit;
    font-size:11px;padding:3px 10px;border-radius:999px;opacity:.75;transition:opacity .2s}
  .md:hover{opacity:1}
  .dots{display:flex;gap:8px}
  .dot{width:8px;height:8px;border:0;background:rgba(14,15,12,.25);padding:0;cursor:pointer;border-radius:4px;transition:all .3s}
  body.ui-dark .dot{background:rgba(255,255,255,.32)}
  .dot.on{width:24px;background:#163300}
  body.ui-dark .dot.on{background:#fff}
  #ov{position:fixed;inset:0;z-index:100;background:rgba(15,16,14,.92);backdrop-filter:blur(12px);
    -webkit-backdrop-filter:blur(12px);display:none;overflow-y:auto;padding:4vh 4vw}
  #ov .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:2vh 1.4vw;max-width:92vw;margin:0 auto}
  .th{display:block;width:100%;padding:0;cursor:pointer;overflow:hidden;text-align:left;background:#fff;
    border:2px solid rgba(255,255,255,.16);box-shadow:0 8px 32px rgba(0,0,0,.35);transition:border-color .2s}
  .th:hover{border-color:rgba(255,255,255,.55)}
  .th[data-cur]{border-color:#9fe870}
  .th .tw{display:block;aspect-ratio:${W}/${H};overflow:hidden;pointer-events:none;background:#fff}
  .th .tw img{display:block;width:100%;height:100%}
  .th .tl{display:flex;justify-content:space-between;padding:7px 10px;font-size:12px;color:#a8aa9f;font-variant-numeric:tabular-nums}
</style></head><body class="m-auto">
<main id="deck">
${slidesHtml}
</main>
<div class="footer">
  <div>← → 翻页 · Esc 缩略图 · T 切换动画</div>
  <div class="fr"><span class="md" id="md" title="点击或按 T 切换翻页动画"></span><div class="dots" id="nav"></div></div>
</div>
<div id="ov"><div class="grid">
${thumbsHtml}
</div></div>
<script>
(function(){
  var deck=document.getElementById("deck");
  var slides=[].slice.call(document.querySelectorAll(".slide"));
  var dots=document.getElementById("nav");
  var ov=document.getElementById("ov");
  var md=document.getElementById("md");
  var cur=0,ovOn=false;
  deck.style.width=(slides.length*100)+"vw";
  slides.forEach(function(_,i){
    var b=document.createElement("button");
    b.className="dot";b.setAttribute("aria-label","第 "+(i+1)+" 页");
    b.onclick=function(){go(i)};
    dots.appendChild(b);
  });
  function go(i){
    cur=Math.max(0,Math.min(slides.length-1,i));
    deck.style.transform="translateX(-"+cur*100+"vw)";
    slides.forEach(function(s,n){s.classList.toggle("on",n===cur)});
    [].forEach.call(dots.children,function(d,n){d.classList.toggle("on",n===cur)});
    [].forEach.call(document.querySelectorAll(".th"),function(t){
      if(t.dataset.i==cur)t.setAttribute("data-cur","1");else t.removeAttribute("data-cur");
    });
    document.body.classList.toggle("cover",cur===0);
    document.body.classList.toggle("ui-dark",slides[cur]&&slides[cur].dataset.dark==="1");
  }
  var modes=["auto","slide","fade","zoom"],names={auto:"自动",slide:"滑动",fade:"淡入",zoom:"缩放"},mi=0;
  function setMode(k){
    mi=(k+modes.length)%modes.length;
    document.body.className=document.body.className.replace(/\\bm-\\w+/,"m-"+modes[mi]);
    md.textContent="转场 · "+names[modes[mi]];
    go(cur);
  }
  md.onclick=function(){setMode(mi+1)};
  function toggleOv(){
    ovOn=!ovOn;
    ov.style.display=ovOn?"block":"none";
  }
  [].forEach.call(document.querySelectorAll(".th"),function(t){
    t.onclick=function(){toggleOv();go(Number(t.dataset.i))};
  });
  addEventListener("keydown",function(e){
    if(e.key==="Escape"){e.preventDefault();toggleOv();return;}
    if(e.key==="t"||e.key==="T"){setMode(mi+1);return;}
    if(ovOn)return;
    if(e.key==="ArrowRight"||e.key==="ArrowDown"||e.key===" "||e.key==="PageDown")go(cur+1);
    if(e.key==="ArrowLeft"||e.key==="ArrowUp"||e.key==="PageUp")go(cur-1);
    if(e.key==="Home")go(0);
    if(e.key==="End")go(slides.length-1);
  });
  setMode(0);
  go(0);
})();
</script></body></html>`;
  bridge.exportFile(`${base}.html`, btoa(unescape(encodeURIComponent(html))));
}
