/**
 * SVG 导入：把一段 SVG 文本烘焙成设计节点（不依赖 DOMParser，纯字符串处理，
 * 浏览器面板 / bun 单测 / MCP 三处同一实现）。
 *
 * 策略是"**几何全部烘焙到根坐标系**"：transform 链（translate/scale/rotate/matrix/skew）
 * 逐点应用后就丢掉，产物不再携带 transform —— 与设计档"每节点轴对齐盒 + rotation"的
 * 模型天然一致。代价是失去可编辑的原生分组结构（换 group 层的语义本来也不成立）。
 *
 * 支持：svg/g/rect/circle/ellipse/line/polyline/polygon/path/text；
 * fill/stroke 色（hex/rgb()/色名，经 doc.ts colorOr）、opacity 三件套合成进 alpha、
 * stroke-dasharray→dashed；text-anchor 近似；viewBox→width/height 缩放。
 * 不支持（降级 + warnings）：渐变/图案（url(#id) → 该填充置无）、mask/clipPath/filter、
 * use/defs/image、任意旋转下的文本精确摆位、非均匀缩放下圆弧精确度。
 */
import { colorOr, uid, type DesignNode, type Fill, type Stroke, type TextRun } from "./doc";

/* ---------------- 最小 XML 解析（够用即可，不做完备规范） ---------------- */

export type SvgEl = { tag: string; attrs: Record<string, string>; children: (SvgEl | string)[] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);?/g, (all, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(parseInt(body.slice(2), 16) || 0);
    if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)) || 0);
    const named = ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    return ""; // 未知实体（&nbsp; 之类）：按空处理，够用
  });
}

const NAME_RE = /[^\s/>=]+/;

/** 解析 SVG 文本为元素树；致命结构问题直接 throw（导入入口统一报错） */
export function parseSvgXml(src: string): SvgEl {
  let i = 0;
  const n = src.length;
  const root: SvgEl = { tag: "#root", attrs: {}, children: [] };
  const stack: SvgEl[] = [root];
  const top = () => stack[stack.length - 1]!;
  const skipWs = () => { while (i < n && /\s/.test(src[i]!)) i++; };

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      const text = decodeEntities(src.slice(i, n));
      if (text.trim()) top().children.push(text);
      break;
    }
    if (lt > i) {
      const text = decodeEntities(src.slice(i, lt));
      if (text.trim()) top().children.push(text);
    }
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (src.startsWith("<!", i)) {
      const end = src.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i);
      const name = src.slice(i + 2, end < 0 ? n : end).trim();
      i = end < 0 ? n : end + 1;
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k]!.tag === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    // 开始标签
    i++; // '<'
    const nm = NAME_RE.exec(src.slice(i, i + 64));
    if (!nm) { i++; continue; }
    let tag = nm[0];
    i += tag.length;
    const colon = tag.indexOf(":");
    if (colon >= 0) tag = tag.slice(colon + 1); // 命名空间前缀（xlink:href→href）
    const el: SvgEl = { tag, attrs: {}, children: [] };
    let selfClose = false;
    for (;;) {
      skipWs();
      if (i >= n) break;
      const c = src[i]!;
      if (c === ">") { i++; break; }
      if (c === "/") { selfClose = true; i++; continue; }
      const an = NAME_RE.exec(src.slice(i, i + 96));
      if (!an) { i++; continue; }
      let key = an[0];
      i += key.length;
      const ac = key.indexOf(":");
      if (ac >= 0) key = key.slice(ac + 1);
      skipWs();
      let val = "";
      if (src[i] === "=") {
        i++;
        skipWs();
        const q = src[i];
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, i + 1);
          val = decodeEntities(src.slice(i + 1, end < 0 ? n : end));
          i = end < 0 ? n : end + 1;
        } else {
          const m = /[^\s>]+/.exec(src.slice(i, i + 200));
          val = decodeEntities(m ? m[0] : "");
          i += val.length;
        }
      }
      el.attrs[key] = val;
    }
    top().children.push(el);
    if (!selfClose) stack.push(el);
  }
  const svg = root.children.find((c): c is SvgEl => typeof c !== "string" && c.tag === "svg");
  if (!svg) throw new Error("不是有效的 SVG（缺少 <svg> 根元素）");
  return svg;
}

/* ---------------- 仿射矩阵 ---------------- */

/** [a,b,c,d,e,f] ⇔ 点变换 x'=ax+cy+e, y'=bx+dy+f */
export type Mat = [number, number, number, number, number, number];
export const MAT_ID: Mat = [1, 0, 0, 1, 0, 0];
const EPS = 1e-9;

/** A×B：先应用 B 再应用 A（SVG 属性链 transform="A B" 在父系下的合成方向即此） */
export function matMul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function matPoint(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 是否轴对齐（允许翻转：b、c 为 0）——矩形/椭圆能保住原生类型的判据 */
export const matAxisAligned = (m: Mat): boolean => Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6;

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** transform 属性 → 矩阵（未知函数按恒等跳过并记 warning）；translate(10) scale(2) rotate(45 5 5)… */
export function parseTransform(t: string, warn: (m: string) => void): Mat {
  let m: Mat = MAT_ID;
  const re = /([a-zA-Z]+)\s*\(([^()]*)\)/g;
  let mm: RegExpExecArray | null;
  const nums = (s: string): number[] =>
    (s.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number).filter((x) => Number.isFinite(x));
  while ((mm = re.exec(t))) {
    const fn = mm[1]!.toLowerCase();
    const p = nums(mm[2]!);
    let op: Mat | null = null;
    if (fn === "translate") op = [1, 0, 0, 1, p[0] ?? 0, p[1] ?? 0];
    else if (fn === "scale") op = [p[0] ?? 1, 0, 0, p[1] ?? p[0] ?? 1, 0, 0];
    else if (fn === "rotate") {
      const a = ((p[0] ?? 0) * Math.PI) / 180;
      const rot: Mat = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
      if (p.length >= 3) {
        const cx = p[1]!, cy = p[2]!;
        op = matMul(matMul([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]);
      } else op = rot;
    } else if (fn === "matrix" && p.length >= 6) op = [p[0]!, p[1]!, p[2]!, p[3]!, p[4]!, p[5]!];
    else if (fn === "skewx") { const k = Math.tan(((p[0] ?? 0) * Math.PI) / 180); op = [1, 0, k, 1, 0, 0]; }
    else if (fn === "skewy") { const k = Math.tan(((p[0] ?? 0) * Math.PI) / 180); op = [1, k, 0, 1, 0, 0]; }
    else warn(`transform 函数未支持，已忽略：${fn}`);
    if (op) m = matMul(m, op);
  }
  return m;
}

/* ---------------- 数值与颜色小工具 ---------------- */

const numA = (v: string | undefined, d = 0): number => {
  if (v === undefined) return d;
  const s = v.trim();
  if (!s) return d;
  const x = Number(s.replace(/px$/i, ""));
  return Number.isFinite(x) ? x : d;
};

/** #rgb/#rrggbb/#rrggbbaa → {hex6, alpha} */
function splitHex(hex: string): { hex6: string; alpha: number } {
  const body = hex.slice(1);
  if (body.length === 3) return { hex6: `#${body[0]!}${body[0]!}${body[1]!}${body[1]!}${body[2]!}${body[2]!}`, alpha: 1 };
  if (body.length === 8) return { hex6: `#${body.slice(0, 6)}`, alpha: parseInt(body.slice(6, 8), 16) / 255 };
  return { hex6: `#${body.slice(0, 6)}`, alpha: 1 };
}

/** 基色 × 额外 alpha → 8 位 hex（<1 才带后缀，与设计档色板口径一致） */
function paint(base: string, alpha: number): string {
  const { hex6, alpha: a0 } = splitHex(base);
  const a = Math.max(0, Math.min(1, a0 * alpha));
  if (a >= 0.999) return hex6;
  return `${hex6}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
}

const NONE_PROBE = "__none__";
/**  paints 值解析：none/transparent/url(渐变)→null；其余走 colorOr（色名/rgb()/hex） */
function resolvePaint(raw: string | undefined, warn: (m: string) => void): string | null | undefined {
  if (raw === undefined) return undefined; // "未声明"（继承）≠ "none"（显式无填充）
  const s = raw.trim().toLowerCase();
  if (s === "none" || s === "transparent") return null;
  if (s.startsWith("url(")) { warn("渐变/图案填充未支持，已按无填充处理"); return null; }
  const c = colorOr(raw, NONE_PROBE);
  if (c === NONE_PROBE) { warn(`颜色无法解析：${raw}`); return null; }
  return c;
}

/* ---------------- 路径 d 烘焙 ---------------- */

type PCmd = { c: string; a: number[] };

const pathNums = (s: string): number[] =>
  (s.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number).filter((x) => Number.isFinite(x));

/** d 属性 → 命令序列（原样，含相对命令） */
export function tokenizePath(d: string): PCmd[] {
  const out: PCmd[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/g;
  let cur: PCmd | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) {
      const c = m[1];
      if (c.toUpperCase() === "Z") { out.push({ c: "Z", a: [] }); cur = null; continue; }
      cur = { c, a: [] };
      out.push(cur);
    } else if (cur) cur.a.push(Number(m[2]));
  }
  return out.filter((p) => p.c.toUpperCase() === "Z" || p.a.length > 0);
}

/**
 * 烘焙：相对→绝对 + 逐点应用矩阵 m；输出命令全部大写（绝对）。
 * 同时收集所有落点（含控制点与 H/V 的 pen 位）供 bbox。
 */
function bakePath(d: string, m: Mat): { cmds: PCmd[]; pts: [number, number][] } {
  const cmds: PCmd[] = [];
  const pts: [number, number][] = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastCtrl: [number, number] | null = null;
  let lastCmd = "";
  const tp = (px0: number, py0: number): [number, number] => {
    const p = matPoint(m, px0, py0);
    pts.push(p);
    return p;
  };
  const emit = (c: string, a: number[]): void => {
    cmds.push({ c, a });
    lastCmd = c;
  };
  for (const cmd of tokenizePath(d)) {
    const rel = cmd.c !== cmd.c.toUpperCase();
    const up = cmd.c.toUpperCase();
    const A = cmd.a;
    if (up === "Z") { emit("Z", []); x = sx; y = sy; lastCtrl = null; continue; }
    const step = up === "M" || up === "L" || up === "T" ? 2 : up === "C" ? 6 : up === "S" || up === "Q" ? 4 : up === "A" ? 7 : 1;
    for (let k = 0; k + step <= A.length; k += step) {
      const seg = A.slice(k, k + step);
      if (up === "H") {
        const nx = rel ? x + seg[0]! : seg[0]!;
        const [ex, ey] = tp(nx, y);
        emit("L", [r2(ex), r2(ey)]);
        x = nx; lastCtrl = null;
      } else if (up === "V") {
        const ny = rel ? y + seg[0]! : seg[0]!;
        const [ex, ey] = tp(x, ny);
        emit("L", [r2(ex), r2(ey)]);
        y = ny; lastCtrl = null;
      } else if (up === "M" || up === "L") {
        const px0 = rel ? x + seg[0]! : seg[0]!;
        const py0 = rel ? y + seg[1]! : seg[1]!;
        const [ex, ey] = tp(px0, py0);
        emit(up, [r2(ex), r2(ey)]);
        if (up === "M") { sx = px0; sy = py0; }
        x = px0; y = py0; lastCtrl = null;
      } else if (up === "T") {
        const ref: [number, number] = lastCmd === "Q" || lastCmd === "T" ? [2 * x - lastCtrl![0], 2 * y - lastCtrl![1]] : [x, y];
        const px0 = rel ? x + seg[0]! : seg[0]!;
        const py0 = rel ? y + seg[1]! : seg[1]!;
        const c1 = tp(ref[0], ref[1]);
        const end = tp(px0, py0);
        emit("Q", [r2(c1[0]), r2(c1[1]), r2(end[0]), r2(end[1])]);
        lastCtrl = [ref[0], ref[1]];
        x = px0; y = py0;
      } else if (up === "Q") {
        const c1x = rel ? x + seg[0]! : seg[0]!, c1y = rel ? y + seg[1]! : seg[1]!;
        const ex = rel ? x + seg[2]! : seg[2]!, ey = rel ? y + seg[3]! : seg[3]!;
        const c1 = tp(c1x, c1y); const end = tp(ex, ey);
        emit("Q", [r2(c1[0]), r2(c1[1]), r2(end[0]), r2(end[1])]);
        lastCtrl = [c1x, c1y];
        x = ex; y = ey;
      } else if (up === "C" || up === "S") {
        let c1x: number, c1y: number;
        if (up === "C") { c1x = rel ? x + seg[0]! : seg[0]!; c1y = rel ? y + seg[1]! : seg[1]!; }
        else if (lastCmd === "C" || lastCmd === "S") { c1x = 2 * x - lastCtrl![0]; c1y = 2 * y - lastCtrl![1]; } // lastCtrl 存的就是上一段的 c2
        else { c1x = x; c1y = y; }
        const c2x = rel ? x + (up === "C" ? seg[2] : seg[0])! : (up === "C" ? seg[2] : seg[0])!;
        const c2y = rel ? y + (up === "C" ? seg[3] : seg[1])! : (up === "C" ? seg[3] : seg[1])!;
        const ex = rel ? x + (up === "C" ? seg[4] : seg[2])! : (up === "C" ? seg[4] : seg[2])!;
        const ey = rel ? y + (up === "C" ? seg[5] : seg[3])! : (up === "C" ? seg[5] : seg[3])!;
        const p1 = tp(c1x, c1y), p2 = tp(c2x, c2y), p3 = tp(ex, ey);
        emit("C", [r2(p1[0]), r2(p1[1]), r2(p2[0]), r2(p2[1]), r2(p3[0]), r2(p3[1])]);
        lastCtrl = [c2x, c2y];
        x = ex; y = ey;
      } else if (up === "A") {
        const ex = rel ? x + seg[5]! : seg[5]!;
        const ey = rel ? y + seg[6]! : seg[6]!;
        const end = tp(ex, ey);
        // 圆弧近似：rx/ry 按平均缩放（非均匀+旋转下无法精确保形，接受近似）
        const sAvg = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
        emit("A", [r2(seg[0]! * sAvg), r2(seg[1]! * sAvg), seg[2] ?? 0, seg[3] ?? 0, seg[4] ?? 0, r2(end[0]), r2(end[1])]);
        x = ex; y = ey; lastCtrl = null;
      }
    }
  }
  return { cmds, pts };
}

function pathBBox(pts: [number, number][]): { x: number; y: number; w: number; h: number } | null {
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 命令串 → SVG d（坐标平移 dx/dy 后拼接） */
function joinPath(cmds: PCmd[], dx: number, dy: number): string {
  const out: string[] = [];
  for (const c of cmds) {
    if (c.c === "Z") { out.push("Z"); continue; }
    const args: number[] = [];
    for (let k = 0; k < c.a.length; k++) {
      const isNum = c.c === "A" && k < 5; // A 的前 5 个参数（rx ry rot laf sf）不平移
      args.push(isNum ? c.a[k]! : r2(c.a[k]! + (k % 2 === 0 ? dx : dy)));
    }
    out.push(`${c.c}${args.join(" ")}`);
  }
  return out.join(" ");
}

/* ---------------- 样式链与元素映射 ---------------- */

type Style = {
  fill: string | null; // null = none
  stroke: string | null;
  strokeWidth: number;
  dash: boolean;
  fillOpacity: number;
  strokeOpacity: number;
  opacity: number;
  fontSize: number;
  fontWeight: string;
  fontFamily: string;
  anchor: "start" | "middle" | "end";
  hidden: boolean;
};

const BASE_STYLE: Style = {
  fill: "#000000", stroke: null, strokeWidth: 1, dash: false,
  fillOpacity: 1, strokeOpacity: 1, opacity: 1,
  fontSize: 16, fontWeight: "", fontFamily: "", anchor: "start", hidden: false,
};

function styleMap(attr: string | undefined): Record<string, string> {
  const m: Record<string, string> = {};
  if (!attr) return m;
  for (const part of attr.split(";")) {
    const i = part.indexOf(":");
    if (i > 0) m[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return m;
}

function inheritStyle(parent: Style, el: SvgEl, warn: (m: string) => void): Style {
  const sm = styleMap(el.attrs["style"]);
  const g = (k: string): string | undefined => (sm[k] !== undefined ? sm[k] : el.attrs[k]);
  const next: Style = { ...parent };
  const f = resolvePaint(g("fill"), warn);
  if (f !== undefined) next.fill = f;
  const s = resolvePaint(g("stroke"), warn);
  if (s !== undefined) next.stroke = s;
  const sw = g("stroke-width");
  if (sw !== undefined) next.strokeWidth = Math.max(0, numA(sw, parent.strokeWidth));
  const da = g("stroke-dasharray");
  if (da !== undefined) next.dash = da.trim() !== "" && da.trim().toLowerCase() !== "none";
  const fo = g("fill-opacity"); if (fo !== undefined) next.fillOpacity = Math.min(1, Math.max(0, numA(fo, parent.fillOpacity)));
  const so = g("stroke-opacity"); if (so !== undefined) next.strokeOpacity = Math.min(1, Math.max(0, numA(so, parent.strokeOpacity)));
  const op = g("opacity"); if (op !== undefined) next.opacity = Math.min(1, Math.max(0, numA(op, parent.opacity)));
  const fs = g("font-size"); if (fs !== undefined) next.fontSize = Math.max(1, numA(fs, parent.fontSize));
  const fw = g("font-weight"); if (fw !== undefined) next.fontWeight = fw;
  const ff = g("font-family"); if (ff !== undefined) next.fontFamily = ff;
  const ta = g("text-anchor");
  if (ta === "middle" || ta === "end" || ta === "start") next.anchor = ta;
  if ((g("display") ?? "").trim() === "none" || (g("visibility") ?? "").trim() === "hidden") next.hidden = true;
  return next;
}

function mkFills(st: Style): Fill[] {
  if (!st.fill) return [];
  return [{ type: "solid", color: paint(st.fill, st.fillOpacity * st.opacity) }];
}

function mkStrokes(st: Style, scale: number): Stroke[] {
  if (!st.stroke || st.strokeWidth <= 0) return [];
  return [{ color: paint(st.stroke, st.strokeOpacity * st.opacity), width: Math.max(0.1, r2(st.strokeWidth * scale)), align: "center", style: st.dash ? "dashed" : "solid" }];
}

export type SvgImportResult = { nodes: DesignNode[]; w: number; h: number; warnings: string[] };

/** 文本宽度粗估（仅用于盒宽；渲染按盒宽自动换行）：CJK 1em、半角 0.55em */
function estimateTextWidth(t: string, size: number): number {
  let w = 0;
  for (const ch of t) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF＀-￯]/.test(ch) ? 1 : 0.55;
  return Math.max(8, r2(w * size));
}

const SKIP_TAGS = new Set(["defs", "symbol", "clipPath", "mask", "filter", "linearGradient", "radialGradient", "pattern", "style", "title", "desc", "metadata", "switch"]);
const KNOWN = new Set(["svg", "g", "a", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan"]);

function elText(el: SvgEl): string {
  let s = "";
  for (const c of el.children) {
    if (typeof c === "string") s += c;
    else if (c.tag === "tspan") s += elText(c);
  }
  return s.replace(/\s+/g, " ").trim();
}

function convert(el: SvgEl, m: Mat, st: Style, out: DesignNode[], warn: (msg: string) => void): void {
  // 元素自身展示属性/style 先并入继承链（形状自己的 fill/stroke 也要生效）
  const est = inheritStyle(st, el, warn);
  if (est.hidden) return;
  const own = parseTransform(el.attrs["transform"] ?? "", warn);
  const mm = matMul(m, own);
  const sAvg = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2])) || 1;
  const axis = matAxisAligned(mm);
  const name = el.attrs["id"] || undefined;

  const boxVector = (cmds: PCmd[], pts: [number, number][]): DesignNode | null => {
    const bb = pathBBox(pts);
    if (!bb || bb.w <= 0 || bb.h <= 0) return null;
    return {
      id: uid("v"), type: "vector", name: name ?? "矢量",
      x: r2(bb.x), y: r2(bb.y), w: Math.max(0.5, r2(bb.w)), h: Math.max(0.5, r2(bb.h)),
      path: joinPath(cmds, -bb.x, -bb.y),
      fills: mkFills(est), strokes: mkStrokes(est, sAvg),
    } as unknown as DesignNode;
  };

  switch (el.tag) {
    case "svg":
    case "g":
    case "a":
    case "switch": {
      for (const c of el.children) if (typeof c !== "string") convert(c, mm, est, out, warn);
      return;
    }
    case "rect": {
      const x = numA(el.attrs["x"]), y = numA(el.attrs["y"]);
      const w = numA(el.attrs["width"]), h = numA(el.attrs["height"]);
      if (w <= 0 || h <= 0) return;
      const rxRaw = el.attrs["rx"] !== undefined ? numA(el.attrs["rx"]) : el.attrs["ry"] !== undefined ? numA(el.attrs["ry"]) : 0;
      const rx = Math.min(Math.max(0, rxRaw), w / 2, h / 2);
      if (axis) {
        const p1 = matPoint(mm, x, y), p2 = matPoint(mm, x + w, y + h);
        const bx = Math.min(p1[0], p2[0]), by = Math.min(p1[1], p2[1]);
        const node: Record<string, unknown> = {
          id: uid("r"), type: "rect", name: name ?? "矩形",
          x: r2(bx), y: r2(by), w: r2(Math.abs(p2[0] - p1[0])), h: r2(Math.abs(p2[1] - p1[1])),
          fills: mkFills(est), strokes: mkStrokes(est, sAvg),
        };
        const rr = rx * Math.min(Math.abs(mm[0]), Math.abs(mm[3]));
        if (rr > 0) node.radius = r2(rr);
        out.push(node as unknown as DesignNode);
      } else {
        const corners = [
          matPoint(mm, x, y), matPoint(mm, x + w, y), matPoint(mm, x + w, y + h), matPoint(mm, x, y + h),
        ];
        const cmds: PCmd[] = [{ c: "M", a: [corners[0]![0], corners[0]![1]] }, { c: "L", a: [corners[1]![0], corners[1]![1]] }, { c: "L", a: [corners[2]![0], corners[2]![1]] }, { c: "L", a: [corners[3]![0], corners[3]![1]] }, { c: "Z", a: [] }];
        const v = boxVector(cmds, corners);
        if (v) out.push(v);
        warn("带旋转的矩形已烘焙为矢量路径（圆角丢失）");
      }
      return;
    }
    case "circle": {
      const cx = numA(el.attrs["cx"]), cy = numA(el.attrs["cy"]), r = numA(el.attrs["r"]);
      if (r <= 0) return;
      if (axis) {
        const p1 = matPoint(mm, cx - r, cy - r), p2 = matPoint(mm, cx + r, cy + r);
        out.push({
          id: uid("e"), type: "ellipse", name: name ?? "椭圆",
          x: r2(p1[0]), y: r2(p1[1]), w: r2(Math.abs(p2[0] - p1[0])), h: r2(Math.abs(p2[1] - p1[1])),
          fills: mkFills(est), strokes: mkStrokes(est, sAvg),
        } as unknown as DesignNode);
      } else {
        const pts: [number, number][] = [];
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          pts.push(matPoint(mm, cx + r * Math.cos(a), cy + r * Math.sin(a)));
        }
        const cmds: PCmd[] = pts.map((p, i) => ({ c: i === 0 ? "M" : "L", a: [p[0], p[1]] })).concat([{ c: "Z", a: [] }]);
        const v = boxVector(cmds, pts);
        if (v) out.push(v);
      }
      return;
    }
    case "ellipse": {
      const cx = numA(el.attrs["cx"]), cy = numA(el.attrs["cy"]);
      const rx = numA(el.attrs["rx"]), ry = numA(el.attrs["ry"]);
      if (rx <= 0 || ry <= 0) return;
      if (axis) {
        const p1 = matPoint(mm, cx - rx, cy - ry), p2 = matPoint(mm, cx + rx, cy + ry);
        out.push({
          id: uid("e"), type: "ellipse", name: name ?? "椭圆",
          x: r2(p1[0]), y: r2(p1[1]), w: r2(Math.abs(p2[0] - p1[0])), h: r2(Math.abs(p2[1] - p1[1])),
          fills: mkFills(est), strokes: mkStrokes(est, sAvg),
        } as unknown as DesignNode);
      } else {
        const pts: [number, number][] = [];
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          pts.push(matPoint(mm, cx + rx * Math.cos(a), cy + ry * Math.sin(a)));
        }
        const cmds: PCmd[] = pts.map((p, i) => ({ c: i === 0 ? "M" : "L", a: [p[0], p[1]] })).concat([{ c: "Z", a: [] }]);
        const v = boxVector(cmds, pts);
        if (v) out.push(v);
      }
      return;
    }
    case "line": {
      const p1 = matPoint(mm, numA(el.attrs["x1"]), numA(el.attrs["y1"]));
      const p2 = matPoint(mm, numA(el.attrs["x2"]), numA(el.attrs["y2"]));
      const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
      if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
      // 设计档 line：盒 = 两端点包围盒，dir = 第二端相对第一端的象限（0=↘ 1=↗ 2=↖ 3=↙）
      const dir: 0 | 1 | 2 | 3 = dx >= 0 ? (dy >= 0 ? 0 : 1) : dy >= 0 ? 3 : 2;
      out.push({
        id: uid("l"), type: "line", name: name ?? "直线",
        x: r2(Math.min(p1[0], p2[0])), y: r2(Math.min(p1[1], p2[1])), w: r2(Math.abs(dx)), h: r2(Math.abs(dy)),
        dir, strokes: mkStrokes(est, sAvg), fills: [],
      } as unknown as DesignNode);
      return;
    }
    case "polyline":
    case "polygon": {
      const ns = pathNums(el.attrs["points"] ?? "");
      if (ns.length < 4) return;
      const pts: [number, number][] = [];
      for (let k = 0; k + 1 < ns.length; k += 2) pts.push(matPoint(mm, ns[k]!, ns[k + 1]!));
      const cmds: PCmd[] = pts.map((p, i) => ({ c: i === 0 ? "M" : "L", a: [p[0], p[1]] }));
      if (el.tag === "polygon") cmds.push({ c: "Z", a: [] });
      const v = boxVector(cmds, pts);
      if (v) out.push(v);
      return;
    }
    case "path": {
      const { cmds, pts } = bakePath(el.attrs["d"] ?? "", mm);
      if (!cmds.length) return;
      const v = boxVector(cmds, pts);
      if (v) out.push(v);
      return;
    }
    case "text": {
      const content = elText(el);
      if (!content) return;
      const size = Math.max(1, r2(est.fontSize * sAvg));
      const x0 = numA(el.attrs["x"]);
      const y0 = numA(el.attrs["y"]);
      const w = estimateTextWidth(content, size);
      let top = x0;
      if (est.anchor === "middle") top = x0 - w / 2;
      else if (est.anchor === "end") top = x0 - w;
      const [bxp, byp] = matPoint(mm, top, y0 - est.fontSize * 0.8);
      const weight = /^bold$/i.test(est.fontWeight) ? 700 : /^\d+$/.test(est.fontWeight) ? Number(est.fontWeight) : undefined;
      const runs: TextRun[] = [
        {
          text: content.slice(0, 500),
          size,
          ...(est.fill ? { color: paint(est.fill, est.fillOpacity * est.opacity) } : {}),
          ...(weight ? { weight } : {}),
          ...(est.fontFamily ? { font: est.fontFamily.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "").slice(0, 60) } : {}),
        },
      ];
      out.push({
        id: uid("t"), type: "text", name: name ?? "文本",
        x: r2(bxp), y: r2(byp), w: Math.max(8, r2(w)), h: Math.max(size, r2(size * 1.4)),
        runs, fills: [],
      } as unknown as DesignNode);
      if (!axis) warn("旋转文本按轴对齐近似摆放");
      else warn("文字按 SVG 基线近似换算为顶行（可能有 1–3px 偏差）");
      return;
    }
    default: {
      if (el.tag === "image" || el.tag === "use") warn(`〈${el.tag}〉未支持，已跳过`);
      else if (!SKIP_TAGS.has(el.tag) && !KNOWN.has(el.tag)) warn(`未知元素〈${el.tag}〉已跳过`);
      return;
    }
  }
}

/** SVG 文本 → 设计节点（根局部坐标系）+ 根盒尺寸 + warnings */
export function importSvg(svgText: string): SvgImportResult {
  const root = parseSvgXml(svgText);
  const warnSet = new Set<string>();
  const warnings: string[] = [];
  const warn = (m: string): void => { if (!warnSet.has(m) && warnings.length < 12) { warnSet.add(m); warnings.push(m); } };

  const vb = (root.attrs["viewBox"] ?? "").trim().split(/[\s,]+/).map(Number);
  const vbOk = vb.length === 4 && vb.every((x) => Number.isFinite(x)) && vb[2]! > 0 && vb[3]! > 0;
  let width = numA(root.attrs["width"], 0);
  let height = numA(root.attrs["height"], 0);
  if (width <= 0 || height <= 0) {
    if (vbOk) { width = vb[2]!; height = vb[3]!; }
    else { width = width > 0 ? width : 320; height = height > 0 ? height : 320; warn("缺少 width/height 与 viewBox，按 320×320 导入"); }
  }
  let base: Mat = MAT_ID;
  if (vbOk) {
    const sx = width / vb[2]!, sy = height / vb[3]!;
    base = matMul([1, 0, 0, 1, -sx * vb[0]!, -sy * vb[1]!], [sx, 0, 0, sy, 0, 0]);
  }

  const nodes: DesignNode[] = [];
  const rstyle = inheritStyle(BASE_STYLE, root, warn);
  for (const c of root.children) if (typeof c !== "string") convert(c, base, rstyle, nodes, warn);
  if (nodes.length === 0) warn("没有解析到可导入的图形（元素可能都受支持范围外）");
  return { nodes, w: r2(width), h: r2(height), warnings };
}
