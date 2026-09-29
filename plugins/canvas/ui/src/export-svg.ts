/**
 * 整画布 SVG 导出（视觉规格与 viewspec 同源）：内容并集包围盒做 viewBox，
 * 矢量直出（形状/文本/图片/手绘；mermaid 以 svg data-url 内嵌）。
 * 文本换算：离屏 canvas measureText 按 runs 逐段测量做贪心折行（近 DOM break-word）；
 * 落盘统一走 bridge.exportFile（doc.export → 宿主写工作区）。
 */
import { bridge } from "./bridge";
import { assetDataUrl } from "./render";
import { currentMermaidTheme, renderMermaid, svgCodeUrl, svgToPng } from "./mermaid";
import { PROVIDER_LABELS, resolveEmbed } from "./providers";
import { chartSpec, curveArrow, drawSpec, elBox, imageFit, isPolyline, lineEnds, pathMidpoint, polygonPoints, resolveRuns, strokeDash, tableSpec, TEXT_LINE_HEIGHT, type ChartPrim, type PolyShape, type RunSpec } from "./viewspec";
import { unionBox } from "./geometry";
import type { CanvasDoc, ChartEl, DrawEl, El, EmbedEl, ImageEl, MermaidEl, ShapeEl, SvgEl, TableEl, TextEl } from "./doc";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
  const labelSvg =
    isLineKind && el.label
      ? (() => {
          const m = pathMidpoint(el);
          return `<text x="${m.x.toFixed(1)}" y="${(m.y - 6).toFixed(1)}" text-anchor="middle" font-size="12" fill="${esc(stroke ?? "#0e0f0c")}" font-family="${SVG_FONT}" paint-order="stroke" stroke="#ffffff" stroke-width="3">${esc(el.label)}</text>`;
        })()
      : "";
  return `<g${opaAttr(el)}${rotAttr(b)}><g transform="translate(${b.x} ${b.y})">${marker}${body}${labelSvg}</g></g>`;
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

/* ---------------- 画布 → SVG 文档 ---------------- */

const baseName = (doc: CanvasDoc, fileRel: string | null) =>
  (fileRel?.replace(/\.canvas\.json$/i, "").split("/").pop() || doc.meta.name || "canvas").replace(
    /[\\/:*?"<>|]/g,
    "",
  );

/** 组装画布 SVG（内容并集包围盒 ±80 padding）；SVG 与 PNG 导出共用。
 *  els 缺省 = 全部 objects；传入子集 = 选区导出 */
async function buildCanvasSvg(doc: CanvasDoc, els?: El[]): Promise<{ svg: string; w: number; h: number }> {
  els = els ?? doc.objects;
  if (els.length === 0) throw new Error("画布还没有内容");
  const PAD = 80;
  const u = unionBox((els as El[]).map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h })));
  if (!u) throw new Error("画布还没有内容");
  const x = u.x - PAD;
  const y = u.y - PAD;
  const w = Math.max(1, u.w + PAD * 2);
  const h = Math.max(1, u.h + PAD * 2);
  const parts: string[] = [];
  for (const el of els as El[]) {
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
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">` +
    parts.join("") +
    `</svg>`;
  return { svg, w, h };
}

/** 导出画布 SVG：els 缺省全档；传选区子集 = 仅选中 */
export async function exportCanvasSvg(doc: CanvasDoc, fileRel: string | null, els?: El[]): Promise<void> {
  const { svg } = await buildCanvasSvg(doc, els);
  bridge.exportFile(`${baseName(doc, fileRel)}.svg`, btoa(unescape(encodeURIComponent(svg))));
}

/** 导出画布 PNG：SVG 光栅化 2×（透明底）；失败抛错由外壳提示 */
export async function exportCanvasPng(doc: CanvasDoc, fileRel: string | null, els?: El[]): Promise<void> {
  const { svg, w, h } = await buildCanvasSvg(doc, els);
  const png = await svgToPng(svg, w, h, "transparent");
  if (!png) throw new Error("PNG 光栅化失败");
  bridge.exportFile(`${baseName(doc, fileRel)}.png`, png.slice(png.indexOf(",") + 1));
}
