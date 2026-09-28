/**
 * 设计档 → SVG / PNG 导出（纯序列化，不依赖 leafer 实例）。
 * 几何/文字排版与 leafer/scene.ts 同一套函数（shapePath/lineEnds/layoutText），
 * 保证"所见即所导"。位图资产经 assets 缓存转 dataURL 内嵌。
 */
import { findNode, type DesignDoc, type DesignNode, type Fill, type Stroke, type Effect } from "./doc";
import { unionBox, worldBoxOf, type Box } from "./geometry";
import { arrowHeadPath, layoutText, lineEnds, radiusProp, runsToSpec, shapePath, type MeasureFn } from "./leafer/scene";
import { getAssetState } from "./leafer/assets";
import { bridge, blobToBase64 } from "./bridge";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Ctx = {
  defs: string[];
  uid: number;
  measure: MeasureFn;
  images: Map<string, string | null>; // src → dataURL（null=取不到，画占位）
};

/* ---------------- 涂料 ---------------- */

function fillAttr(f: Fill, ctx: Ctx): string | null {
  if (f.visible === false) return null;
  const op = f.opacity ?? 1;
  const opA = op < 1 ? ` fill-opacity="${op}"` : "";
  if (f.type === "solid") return `fill="${esc(f.color ?? "#000000")}"${opA}`;
  const stops = (f.stops ?? [])
    .map((s) => `<stop offset="${Math.max(0, Math.min(1, s.at))}" stop-color="${esc(s.color)}"/>`)
    .join("");
  if (!stops) return null;
  ctx.uid += 1;
  const id = `p${ctx.uid}`;
  if (f.type === "linear") {
    ctx.defs.push(
      `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1" gradientTransform="rotate(${f.angle ?? 0} .5 .5)">${stops}</linearGradient>`,
    );
  } else {
    const cx = f.center?.x ?? 0.5;
    const cy = f.center?.y ?? 0.5;
    ctx.defs.push(`<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="0.75">${stops}</radialGradient>`);
  }
  return `fill="url(#${id})"${opA}`;
}

function strokeAttr(s: Stroke): string | null {
  if (s.visible === false || s.width <= 0) return null;
  const dash =
    s.style === "dashed"
      ? ` stroke-dasharray="${(s.width * 4).toFixed(1)} ${(s.width * 3).toFixed(1)}"`
      : s.style === "dotted"
        ? ` stroke-dasharray="${Math.max(1, s.width)} ${s.width * 2}" stroke-linecap="round"`
        : "";
  return `stroke="${esc(s.color)}" stroke-width="${s.width}"${dash}`;
}

function filterAttr(effects: Effect[] | undefined, ctx: Ctx): string {
  if (!effects || effects.length === 0) return "";
  const body: string[] = [];
  for (const e of effects) {
    if (e.visible === false) continue;
    if (e.type === "layer-blur") body.push(`<feGaussianBlur stdDeviation="${(e.blur ?? 0) / 2}"/>`);
    // 内投影在 SVG 里近似为外投影（导出场景占比极低，避免 mask 复杂度）
    else body.push(`<feDropShadow dx="${e.x}" dy="${e.y}" stdDeviation="${(e.blur ?? 0) / 2}" flood-color="${esc(e.color)}"/>`);
  }
  if (body.length === 0) return "";
  ctx.uid += 1;
  const id = `e${ctx.uid}`;
  ctx.defs.push(`<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%">${body.join("")}</filter>`);
  return ` filter="url(#${id})"`;
}

/* ---------------- 几何 ---------------- */

/** 四角圆角矩形路径（统一圆角走 rx，四角不等走 path） */
function rectPath(w: number, h: number, r: number[]): string {
  const [tl, tr, br, bl] = r.map((v) => Math.max(0, Math.min(v, w / 2, h / 2)));
  return (
    `M${tl},0 L${w - tr},0 A${tr},${tr} 0 0 1 ${w},${tr} L${w},${h - br} A${br},${br} 0 0 1 ${w - br},${h}` +
    ` L${bl},${h} A${bl},${bl} 0 0 1 0,${h - bl} L0,${tl} A${tl},${tl} 0 0 1 ${tl},0 Z`
  );
}

/** 盒几何的 SVG 元素串（fills 各一遍 + strokes 各一遍，与 leafer 叠绘同序） */
function boxEls(
  node: DesignNode,
  ctx: Ctx,
  kind: "rect" | "ellipse" | "path",
  d?: string,
  extraAttr = "",
): string {
  const { w, h } = node;
  const rad = radiusProp(node);
  let geoAttr = "";
  let geoEl = (attr: string, fillNone = false) => "";
  if (kind === "rect") {
    if (Array.isArray(rad)) {
      geoEl = (attr) => `<path d="${rectPath(w, h, rad)}" ${attr}${extraAttr}/>`;
    } else {
      geoEl = (attr, fillNone) =>
        `<rect width="${w}" height="${h}"${rad !== undefined ? ` rx="${Math.min(rad, w / 2, h / 2)}"` : ""} ${attr}${fillNone ? ' fill="none"' : ""}${extraAttr}/>`;
    }
  } else if (kind === "ellipse") {
    geoEl = (attr, fillNone) =>
      `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" ${attr}${fillNone ? ' fill="none"' : ""}${extraAttr}/>`;
  } else {
    geoEl = (attr, fillNone) => `<path d="${d}" ${attr}${fillNone ? ' fill="none"' : ""}${extraAttr}/>`;
  }
  void geoAttr;
  const parts: string[] = [];
  const fills = "fills" in node ? (node.fills ?? []) : [];
  for (const f of fills) {
    const a = fillAttr(f, ctx);
    if (a) parts.push(geoEl(a));
  }
  const strokes: Stroke[] = "strokes" in node ? ((node.strokes ?? []) as Stroke[]) : [];
  for (const s of strokes) {
    const a = strokeAttr(s);
    if (a) parts.push(geoEl(a, true));
  }
  return parts.join("");
}

/* ---------------- 节点 ---------------- */

function renderNode(node: DesignNode, ctx: Ctx): string {
  if (node.visible === false) return "";
  const tf = [`translate(${node.x} ${node.y})`];
  if (node.rotation) tf.push(`rotate(${node.rotation} ${node.w / 2} ${node.h / 2})`);
  const gAttr = `transform="${tf.join(" ")}"${(node.opacity ?? 1) < 1 ? ` opacity="${node.opacity}"` : ""}`;
  const fx = filterAttr(node.effects, ctx);

  if (node.type === "group") {
    return `<g ${gAttr}>${node.children.map((c) => renderNode(c, ctx)).join("")}</g>`;
  }
  if (node.type === "frame") {
    ctx.uid += 1;
    const clipId = `c${ctx.uid}`;
    const clip = node.clip !== false;
    if (clip) ctx.defs.push(`<clipPath id="${clipId}"><rect width="${node.w}" height="${node.h}"/></clipPath>`);
    const bg = boxEls(node, ctx, "rect");
    const kids = node.children.map((c) => renderNode(c, ctx)).join("");
    return `<g ${gAttr}>${bg}<g${clip ? ` clip-path="url(#${clipId})"` : ""}>${kids}</g></g>`;
  }
  if (node.type === "rect" || node.type === "ellipse") {
    return `<g ${gAttr}${fx}>${boxEls(node, ctx, node.type === "rect" ? "rect" : "ellipse")}</g>`;
  }
  if (["triangle", "diamond", "pentagon", "hexagon", "star"].includes(node.type)) {
    const d = shapePath(node.type, node.w, node.h) ?? "";
    return `<g ${gAttr}${fx}>${boxEls(node, ctx, "path", d)}</g>`;
  }
  if (node.type === "line" || node.type === "arrow") {
    const { x1, y1, x2, y2 } = lineEnds((node.dir ?? 0) as 0 | 1 | 2 | 3, node.w, node.h);
    const s = (node.strokes ?? [])[0];
    const sa = s ? strokeAttr(s) : 'stroke="#111111" stroke-width="1"';
    if (!sa) return "";
    const head =
      node.type === "arrow" && s && s.visible !== false
        ? `<path d="${arrowHeadPath(x2, y2, x1, y1, Math.max(6, s.width * 3))}" fill="${esc(s.color)}"/>`
        : "";
    return `<g ${gAttr}${fx}><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${sa}/>${head}</g>`;
  }
  if (node.type === "text") {
    const frags = layoutText(
      runsToSpec(node.runs),
      node.w,
      node.h,
      node.align ?? "left",
      node.vAlign ?? "top",
      node.lineHeight ?? 1.4,
      ctx.measure,
    );
    const ls = node.letterSpacing ? ` letter-spacing="${node.letterSpacing}"` : "";
    const body = frags
      .map(
        (f) =>
          `<text x="${f.x.toFixed(2)}" y="${f.baseline.toFixed(2)}" font-size="${f.run.fontSize}" font-family="${esc(f.run.font)}" fill="${esc(f.run.color)}"${f.run.bold ? ' font-weight="700"' : ""}${f.run.italic ? ' font-style="italic"' : ""}${ls}>${esc(f.text)}</text>`,
      )
      .join("");
    return `<g ${gAttr}${fx}>${body}</g>`;
  }
  if (node.type !== "image") return "";
  const url = ctx.images.get(node.src);
  const rad = radiusProp(node);
  let img = "";
  if (url) {
    const par = node.fit === "contain" ? "xMidYMid meet" : node.fit === "stretch" ? "none" : "xMidYMid slice";
    let clipAttr = "";
    if (rad !== undefined) {
      ctx.uid += 1;
      const cid = `ci${ctx.uid}`;
      ctx.defs.push(
        `<clipPath id="${cid}">${Array.isArray(rad) ? `<path d="${rectPath(node.w, node.h, rad)}"/>` : `<rect width="${node.w}" height="${node.h}" rx="${Math.min(rad, node.w / 2, node.h / 2)}"/>`}</clipPath>`,
      );
      clipAttr = ` clip-path="url(#${cid})"`;
    }
    img = `<image href="${url}" x="0" y="0" width="${node.w}" height="${node.h}" preserveAspectRatio="${par}"${clipAttr}/>`;
  } else {
    img = `<rect width="${node.w}" height="${node.h}" fill="#f1f3f5"/>`;
  }
  const strokes = (node.strokes ?? []).map((s) => strokeAttr(s)).filter(Boolean);
  const ring = strokes
    .map((a) => `<rect width="${node.w}" height="${node.h}" fill="none" ${a}/>`)
    .join("");
  return `<g ${gAttr}${fx}>${img}${ring}</g>`;
}

/* ---------------- 入口 ---------------- */

/** 解析选中档内节点的图片资产为 dataURL（blob url → base64，失败 null） */
async function resolveImages(doc: DesignDoc, pageIds: string[], nodes: DesignNode[]): Promise<Map<string, string | null>> {
  const srcs = new Set<string>();
  const collect = (list: DesignNode[]) => {
    for (const n of list) {
      if (n.type === "image") srcs.add(n.src);
      if (n.type === "frame" || n.type === "group") collect(n.children);
    }
  };
  void doc;
  void pageIds;
  collect(nodes);
  const out = new Map<string, string | null>();
  await Promise.all(
    [...srcs].map(async (src) => {
      const st = getAssetState(src);
      if (!st || st.status !== "ready" || !st.url) {
        out.set(src, null);
        return;
      }
      try {
        const blob = await fetch(st.url).then((r) => r.blob());
        out.set(src, await blobToBase64(blob).then((b64) => `data:${blob.type || "image/png"};base64,${b64}`));
      } catch {
        out.set(src, null);
      }
    }),
  );
  return out;
}

/**
 * 导出给定节点集合（世界盒为画幅）→ SVG 字符串。
 * 顶层节点用局部坐标；嵌套选中经世界盒平移对齐。
 */
export async function nodesToSvg(doc: DesignDoc, ids: string[], measure: MeasureFn): Promise<{ svg: string; box: Box } | null> {
  const items = ids
    .map((id) => {
      const loc = findNode(doc, id);
      const wb = worldBoxOf(doc, id);
      return loc && wb && loc.node.visible !== false ? { node: loc.node, wb, top: !loc.parent } : null;
    })
    .filter((x): x is { node: DesignNode; wb: Box; top: boolean } => !!x);
  if (items.length === 0) return null;
  const box = unionBox(items.map((i) => i.wb))!;
  const images = await resolveImages(doc, [], items.map((i) => i.node));
  const ctx: Ctx = { defs: [], uid: 0, measure, images };
  const body = items
    .map((i) => {
      const inner = renderNode(i.node, ctx);
      // 顶层节点：局部==世界；嵌套选中：世界盒已含父链偏移，平移到世界位置
      return i.top ? inner : `<g transform="translate(${i.wb.x - i.node.x} ${i.wb.y - i.node.y})">${inner}</g>`;
    })
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1, Math.round(box.w))}" height="${Math.max(1, Math.round(box.h))}" ` +
    `viewBox="${(box.x).toFixed(2)} ${box.y.toFixed(2)} ${box.w.toFixed(2)} ${box.h.toFixed(2)}">` +
    (ctx.defs.length ? `<defs>${ctx.defs.join("")}</defs>` : "") +
    body +
    `</svg>`;
  return { svg, box };
}

/** SVG → PNG（浏览器光栅化；字体走本机解析，与画布渲染同源） */
export function svgToPngBlob(svg: string, w: number, h: number, scale: number): Promise<Blob> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(w * scale));
      cv.height = Math.max(1, Math.round(h * scale));
      const ctx = cv.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        rej(new Error("no-2d"));
        return;
      }
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      cv.toBlob((b) => (b ? res(b) : rej(new Error("toBlob-fail"))), "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error("svg-load-fail"));
    };
    img.src = url;
  });
}

/** 落盘：宿主态走桥（工作区文件）；独立态浏览器下载 */
export async function saveBlob(name: string, blob: Blob): Promise<void> {
  if (bridge.standalone) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }
  bridge.exportFile(name, await blobToBase64(blob));
}
