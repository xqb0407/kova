/**
 * 设计档 → SVG 字符串的**纯构建器**（零浏览器依赖：不碰 DOM / bridge / react / leafer）。
 * 面板导出（export.ts）与 MCP 截图（mcp/render.ts）共用这一份，保证"所见即所导/所见即所截"：
 * 几何与文字排版用 leafer/scene.ts 同一套函数（shapePath/lineEnds/layoutText），
 * 渲染端只需提供 measure（文本测量）与 images（src → dataURL 资产表）。
 */
import { findNode, instanceView, layerText, resolveVarColor, type DesignDoc, type DesignNode, type Effect, type Fill, type Stroke, type TextRun } from "./doc";
import { unionBox, worldBoxOf, type Box } from "./geometry";
import { arrowHeadPath, layoutText, lineEnds, radiusProp, runsToSpec, shapePath, type MeasureFn } from "./leafer/scene";
import { iconDrawSpec } from "./icons";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 文字排版参数：text 节点与形状内嵌文字都落成这个形状再交给 textBody */
type TextBlock = {
  runs: TextRun[];
  align?: "left" | "center" | "right";
  vAlign?: "top" | "middle" | "bottom";
  lineHeight?: number;
  letterSpacing?: number;
};

/**
 * 一块文字的 SVG 片段。text 节点与**形状内嵌文字**共用，且与画布 scene.ts 同源
 * （都调 layoutText），所以导出/原型/截图与画布的文字落位一致。
 */
function textBody(block: TextBlock, w: number, h: number, ctx: Ctx): string {
  const frags = layoutText(
    runsToSpec(block.runs),
    w,
    h,
    block.align ?? "left",
    block.vAlign ?? "top",
    block.lineHeight ?? 1.4,
    ctx.measure,
  );
  const ls = block.letterSpacing ? ` letter-spacing="${block.letterSpacing}"` : "";
  return frags
    .map(
      (f) =>
        `<text x="${f.x.toFixed(2)}" y="${f.baseline.toFixed(2)}" font-size="${f.run.fontSize}" font-family="${esc(f.run.font)}" fill="${esc(resolveVarColor(ctx.doc, f.run.color))}"${f.run.bold ? ' font-weight="700"' : ""}${f.run.italic ? ' font-style="italic"' : ""}${ls}>${esc(f.text)}</text>`,
    )
    .join("");
}

/** 形状内嵌文字：缺省水平垂直双居中（与画布 scene.ts 的 layerTextBlock 同一份缺省） */
function layerTextBody(node: DesignNode, w: number, h: number, ctx: Ctx): string {
  const lt = layerText(node);
  if (!lt) return "";
  return textBody({ runs: lt.runs, align: lt.align ?? "center", vAlign: lt.vAlign ?? "middle", lineHeight: lt.lineHeight, letterSpacing: lt.letterSpacing }, w, h, ctx);
}

type Ctx = {
  defs: string[];
  uid: number;
  measure: MeasureFn;
  images: Map<string, string | null>; // src → dataURL（null=取不到，画占位）
  doc: DesignDoc; // 实例渲染解析主档用
};

/* ---------------- 涂料 ---------------- */

function fillAttr(f: Fill, ctx: Ctx): string | null {
  if (f.visible === false) return null;
  const op = f.opacity ?? 1;
  const opA = op < 1 ? ` fill-opacity="${op}"` : "";
  if (f.type === "solid") return `fill="${esc(resolveVarColor(ctx.doc, f.color))}"${opA}`;
  const stops = (f.stops ?? [])
    .map((s) => `<stop offset="${Math.max(0, Math.min(1, s.at))}" stop-color="${esc(resolveVarColor(ctx.doc, s.color))}"/>`)
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

function strokeAttr(s: Stroke, ctx: Ctx): string | null {
  if (s.visible === false || s.width <= 0) return null;
  const dash =
    s.style === "dashed"
      ? ` stroke-dasharray="${(s.width * 4).toFixed(1)} ${(s.width * 3).toFixed(1)}"`
      : s.style === "dotted"
        ? ` stroke-dasharray="${Math.max(1, s.width)} ${s.width * 2}" stroke-linecap="round"`
        : "";
  return `stroke="${esc(resolveVarColor(ctx.doc, s.color))}" stroke-width="${s.width}"${dash}`;
}

function filterAttr(effects: Effect[] | undefined, ctx: Ctx): string {
  if (!effects || effects.length === 0) return "";
  const body: string[] = [];
  for (const e of effects) {
    if (e.visible === false) continue;
    // layer-blur 在档内当 iOS 毛玻璃（背景模糊）旋钮用：SVG 无 backdrop-filter，
    // 若对节点自身 feGaussianBlur 会把半透卡片糊成一团（画布侧同样不渲染此效果）。
    // 与画布口径一致：导出跳过，保留半透卡面本体。
    if (e.type === "layer-blur") continue;
    // 内投影在 SVG 里近似为外投影（导出场景占比极低，避免 mask 复杂度）
    else body.push(`<feDropShadow dx="${e.x}" dy="${e.y}" stdDeviation="${(e.blur ?? 0) / 2}" flood-color="${esc(resolveVarColor(ctx.doc, e.color))}"/>`);
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
  let geoEl = (attr: string, fillNone = false): string => "";
  if (kind === "rect") {
    if (Array.isArray(rad)) {
      // 四角不等圆角走 path：描边层必须同样带 fill="none"，否则 SVG 缺省填充=黑，
      // 黑填充叠在白填充层之上 → 半透圆角卡在 WebKit 里整块发黑（resvg 宽容看不出来）
      geoEl = (attr, fillNone) => `<path d="${rectPath(w, h, rad)}" ${attr}${fillNone ? ' fill="none"' : ""}${extraAttr}/>`;
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
  const parts: string[] = [];
  const fills = "fills" in node ? (node.fills ?? []) : [];
  for (const f of fills) {
    if (f.type === "image") {
      const img = imageFillEl(node, ctx, f, kind, rad, d);
      if (img) parts.push(img);
      continue;
    }
    const a = fillAttr(f, ctx);
    if (a) parts.push(geoEl(a));
  }
  const strokes: Stroke[] = "strokes" in node ? ((node.strokes ?? []) as Stroke[]) : [];
  for (const s of strokes) {
    const a = strokeAttr(s, ctx);
    if (a) parts.push(geoEl(a, true));
  }
  return parts.join("");
}

/** 裁剪用几何元素（clipPath 内容不需 paint 属性） */
function geoMarkup(kind: "rect" | "ellipse" | "path", w: number, h: number, rad: ReturnType<typeof radiusProp>, d?: string): string {
  if (kind === "ellipse") return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}"/>`;
  if (kind === "path") return `<path d="${d ?? ""}"/>`;
  if (Array.isArray(rad)) return `<path d="${rectPath(w, h, rad)}"/>`;
  return `<rect width="${w}" height="${h}"${rad !== undefined && rad > 0 ? ` rx="${Math.min(rad, w / 2, h / 2)}"` : ""}/>`;
}

/** 图片填充层：几何裁剪 + <image>；资产缺失（dataURL 表没有）→ 跳过该层 */
function imageFillEl(
  node: DesignNode,
  ctx: Ctx,
  f: Fill,
  kind: "rect" | "ellipse" | "path",
  rad: ReturnType<typeof radiusProp>,
  d?: string,
): string | null {
  if (f.visible === false || !f.src) return null;
  const url = ctx.images.get(f.src);
  if (!url) return null;
  ctx.uid += 1;
  const id = `if${ctx.uid}`;
  ctx.defs.push(`<clipPath id="${id}">${geoMarkup(kind, node.w, node.h, rad, d)}</clipPath>`);
  const par = f.scaleMode === "fit" ? "xMidYMid meet" : f.scaleMode === "stretch" ? "none" : "xMidYMid slice";
  const op = f.opacity !== undefined && f.opacity < 1 ? ` opacity="${f.opacity}"` : "";
  return `<image href="${esc(url)}" width="${node.w}" height="${node.h}" preserveAspectRatio="${par}" clip-path="url(#${id})"${op}/>`;
}

/* ---------------- 节点 ---------------- */

/** 蒙版节点的裁剪几何（父局部坐标）：形状/圆角/旋转参与；line/text/image 等退化为盒。
 *  注意 clipPath 子元素不允许 <g>（SVG 1.1，resvg 会忽略 → 空裁剪），变换直接挂在元素上 */
function maskGeo(n: DesignNode): string {
  const tf = ` transform="translate(${n.x} ${n.y})${n.rotation ? ` rotate(${n.rotation} ${n.w / 2} ${n.h / 2})` : ""}"`;
  if (n.type === "ellipse") return `<ellipse${tf} cx="${n.w / 2}" cy="${n.h / 2}" rx="${n.w / 2}" ry="${n.h / 2}"/>`;
  if (n.type === "rect") return geoMarkup("rect", n.w, n.h, radiusProp(n)).replace("/>", `${tf}/>`);
  if (["triangle", "diamond", "pentagon", "hexagon", "star"].includes(n.type)) {
    return `<path${tf} d="${shapePath(n.type, n.w, n.h) ?? ""}"/>`;
  }
  if (n.type === "vector") return `<path${tf} d="${n.path}"/>`;
  return `<rect${tf} width="${n.w}" height="${n.h}"/>`;
}

/**
 * 子节点绘制 + 蒙版分段（Figma 语义）：mask 节点自身不绘制，其几何裁剪同容器中
 * 位于它之后（更靠上层）的全部兄弟；多蒙版依次嵌套 = 交集。隐藏的蒙版跳过。
 */
function renderChildrenMasks(children: DesignNode[], ctx: Ctx): string {
  let out = "";
  let depth = 0;
  for (const c of children) {
    if (c.mask && c.visible !== false) {
      ctx.uid += 1;
      const id = `m${ctx.uid}`;
      ctx.defs.push(`<clipPath id="${id}">${maskGeo(c)}</clipPath>`);
      out += `<g clip-path="url(#${id})">`;
      depth++;
      continue;
    }
    out += renderNode(c, ctx);
  }
  while (depth-- > 0) out += "</g>";
  return out;
}

function renderNode(node: DesignNode, ctx: Ctx): string {
  if (node.visible === false) return "";
  const tf = [`translate(${node.x} ${node.y})`];
  if (node.rotation) tf.push(`rotate(${node.rotation} ${node.w / 2} ${node.h / 2})`);
  // 镜像：绕盒中心翻转（translate(w,0) scale(-1,1) 的组合，x/y/rotate 之后叠加）
  if (node.flipX || node.flipY) {
    tf.push(`translate(${node.flipX ? node.w : 0} ${node.flipY ? node.h : 0})`);
    tf.push(`scale(${node.flipX ? -1 : 1} ${node.flipY ? -1 : 1})`);
  }
  const blendAttr = node.blendMode ? ` mix-blend-mode="${node.blendMode}" style="mix-blend-mode:${node.blendMode}"` : "";
  // data-id：原型运行时按 id 定位节点（toggleVisible 显隐 / scrollTo 定位）；
  // 静态导出（PNG/SVG 文件）多一个属性无副作用，换来预览与导出跑同一份语义。
  const gAttr = `transform="${tf.join(" ")}"${(node.opacity ?? 1) < 1 ? ` opacity="${node.opacity}"` : ""}${blendAttr} data-id="${esc(node.id)}"`;
  const fx = filterAttr(node.effects, ctx);

  if (node.type === "group") {
    return `<g ${gAttr}>${renderChildrenMasks(node.children, ctx)}</g>`;
  }
  if (node.type === "frame") {
    ctx.uid += 1;
    const clipId = `c${ctx.uid}`;
    // 滚动区域隐式裁切（内容超框才有得滚，裁掉框外部分）
    const clip = node.clip !== false || !!node.scroll;
    if (clip) ctx.defs.push(`<clipPath id="${clipId}"><rect width="${node.w}" height="${node.h}"/></clipPath>`);
    const bg = boxEls(node, ctx, "rect");
    const rendered = renderChildrenMasks(node.children, ctx);
    // 滚动体：运行时给它加 translate(0 -scrollTop)，静态端无 transform = offset 0
    const kids = node.scroll ? `<g data-scroll-body="${esc(node.scroll)}">${rendered}</g>` : rendered;
    const scrollAttr = node.scroll ? ` data-scroll="${esc(node.scroll)}"` : "";
    return `<g ${gAttr}${scrollAttr}>${bg}<g${clip ? ` clip-path="url(#${clipId})"` : ""}>${kids}</g></g>`;
  }
  if (node.type === "instance") {
    // 与画布同口径：instanceView（主档+覆盖烘焙到实例局部、字号随缩放）；坏引用虚线占位
    const view = instanceView(ctx.doc, node);
    if (!view)
      return (
        `<g ${gAttr}>` +
        `<rect width="${node.w}" height="${node.h}" fill="#f1f3f5" stroke="#9aa0a6" stroke-width="1" stroke-dasharray="5 4"/>` +
        `</g>`
      );
    return `<g ${gAttr}>${renderChildrenMasks(view, ctx)}</g>`;
  }
  if (node.type === "rect" || node.type === "ellipse") {
    return `<g ${gAttr}${fx}>${boxEls(node, ctx, node.type === "rect" ? "rect" : "ellipse")}${layerTextBody(node, node.w, node.h, ctx)}</g>`;
  }
  if (["triangle", "diamond", "pentagon", "hexagon", "star"].includes(node.type)) {
    const d = shapePath(node.type, node.w, node.h) ?? "";
    return `<g ${gAttr}${fx}>${boxEls(node, ctx, "path", d)}${layerTextBody(node, node.w, node.h, ctx)}</g>`;
  }
  if (node.type === "line" || node.type === "arrow") {
    const { x1, y1, x2, y2 } = lineEnds((node.dir ?? 0) as 0 | 1 | 2 | 3, node.w, node.h);
    const s = (node.strokes ?? [])[0];
    const sa = s ? strokeAttr(s, ctx) : 'stroke="#111111" stroke-width="1"';
    if (!sa) return "";
    const head =
      node.type === "arrow" && s && s.visible !== false
        ? `<path d="${arrowHeadPath(x2, y2, x1, y1, Math.max(6, s.width * 3))}" fill="${esc(resolveVarColor(ctx.doc, s.color))}"/>`
        : "";
    return `<g ${gAttr}${fx}><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${sa}/>${head}</g>`;
  }
  if (node.type === "text") {
    return `<g ${gAttr}${fx}>${textBody(node, node.w, node.h, ctx)}</g>`;
  }
  if (node.type === "vector") {
    return `<g ${gAttr}${fx}>${boxEls(node, ctx, "path", node.path)}</g>`;
  }
  if (node.type === "icon") {
    const spec = iconDrawSpec(node.icon, node.w, node.h, node.strokeWidth ?? 2);
    if (!spec) {
      // 未知图标名占位：虚线盒 + ?（warnings/截图文本会提示改名字）
      const fs = Math.max(8, Math.min(node.w, node.h) * 0.6);
      return (
        `<g ${gAttr}${fx}><rect width="${node.w}" height="${node.h}" fill="none" stroke="#9aa0a6" stroke-width="1" stroke-dasharray="4 3"/>` +
        `<text x="${node.w / 2}" y="${node.h / 2 + fs * 0.35}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="${fs.toFixed(1)}" fill="#9aa0a6">?</text></g>`
      );
    }
    return `<g ${gAttr}${fx}><path d="${spec.d}" fill="none" stroke="${esc(resolveVarColor(ctx.doc, node.color, "#111111"))}" stroke-width="${spec.sw.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
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
  const strokes = (node.strokes ?? []).map((s) => strokeAttr(s, ctx)).filter(Boolean);
  const ring = strokes
    .map((a) => `<rect width="${node.w}" height="${node.h}" fill="none" ${a}/>`)
    .join("");
  return `<g ${gAttr}${fx}>${img}${ring}</g>`;
}

/* ---------------- 入口 ---------------- */

/** 收集节点子树里全部位图引用（image 节点 src + 图片填充 src；渲染端据此预取 dataURL 表） */
export function collectImageSrcs(nodes: DesignNode[]): Set<string> {
  const srcs = new Set<string>();
  const collect = (list: DesignNode[]) => {
    for (const n of list) {
      if (n.type === "image") srcs.add(n.src);
      if ("fills" in n) {
        for (const f of n.fills) {
          if (f.type === "image" && f.src) srcs.add(f.src);
        }
      }
      if (n.type === "frame" || n.type === "group") collect(n.children);
    }
  };
  collect(nodes);
  return srcs;
}

export type SvgOptions = {
  measure: MeasureFn;
  images: Map<string, string | null>;
  /** 给画幅铺底色（截图给模型看时避免透明底；导出默认不加） */
  background?: string;
};

/**
 * 导出给定节点集合（世界盒为画幅）→ SVG 字符串。纯函数。
 * 顶层节点用局部坐标；嵌套选中经世界盒平移对齐。ids 全不可见/不存在 → null。
 */
export function buildSvg(doc: DesignDoc, ids: string[], opts: SvgOptions): { svg: string; box: Box } | null {
  const items = ids
    .map((id) => {
      const loc = findNode(doc, id);
      const wb = worldBoxOf(doc, id);
      return loc && wb && loc.node.visible !== false ? { node: loc.node, wb, top: !loc.parent } : null;
    })
    .filter((x): x is { node: DesignNode; wb: Box; top: boolean } => !!x);
  if (items.length === 0) return null;
  const box = unionBox(items.map((i) => i.wb))!;
  const ctx: Ctx = { defs: [], uid: 0, measure: opts.measure, images: opts.images, doc };
  // 顶层：按页面子序渲染并应用蒙版分段（mask 语义作用在同容器 = 页面级也成立）；
  // 嵌套选中：世界盒已含父链偏移，各自独立渲染（蒙版语义只在其容器内成立）
  const topIds = new Set(items.filter((i) => i.top).map((i) => i.node.id));
  let body = "";
  for (const p of doc.pages) {
    const seq = p.nodes.filter((n) => topIds.has(n.id) && n.visible !== false);
    if (seq.length) body += renderChildrenMasks(seq, ctx);
  }
  for (const i of items) {
    if (i.top) continue;
    const inner = renderNode(i.node, ctx);
    body += `<g transform="translate(${i.wb.x - i.node.x} ${i.wb.y - i.node.y})">${inner}</g>`;
  }
  const bg = opts.background
    ? `<rect x="${box.x.toFixed(2)}" y="${box.y.toFixed(2)}" width="${box.w.toFixed(2)}" height="${box.h.toFixed(2)}" fill="${esc(opts.background)}"/>`
    : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1, Math.round(box.w))}" height="${Math.max(1, Math.round(box.h))}" ` +
    `viewBox="${(box.x).toFixed(2)} ${box.y.toFixed(2)} ${box.w.toFixed(2)} ${box.h.toFixed(2)}">` +
    (ctx.defs.length ? `<defs>${ctx.defs.join("")}</defs>` : "") +
    bg +
    body +
    `</svg>`;
  return { svg, box };
}
