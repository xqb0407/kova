/**
 * pen.ts — 钢笔工具纯几何核（零 DOM/leafer 依赖，bun 可测）。
 *
 * 路径模型主流口径（Figma Pen 同款）：
 *  - Anchor.p = 锚点（盒局部坐标）；hin/hout = 入柄/出柄，**相对锚点的偏移向量**
 *    （缺省 undefined = 直角锚）。平滑 = hin ≡ −hout；折角 = 两柄独立。
 *  - PathShape = { pts: Anchor[]; closed: boolean }；SVG path 串：
 *    无柄段 → L，任一侧有柄 → C（p0+p0.hout, p1+p1.hin, p1），闭合 → Z。
 *  - 全部纯函数：splitSeg 用 de Casteljau 切分（新锚点柄由切分公式给出、邻柄裁剪），
 *    penBBox 为保守盒（锚点+柄极值，非紧密——文档标注），hitSeg 每段 24 采样找最近。
 */

export type Anchor = { p: [number, number]; hin?: [number, number]; hout?: [number, number] };
export type PenPath = { pts: Anchor[]; closed: boolean };
/** 线段命中结果：seg=段起点锚下标，t=段参数，d2=距平方 */
export type SegHit = { seg: number; t: number; d2: number };

const TAU = Math.PI * 2;

const add = (a: [number, number], b: [number, number]): [number, number] => [a[0] + b[0], a[1] + b[1]];
const sub = (a: [number, number], b: [number, number]): [number, number] => [a[0] - b[0], a[1] - b[1]];
const mul = (a: [number, number], k: number): [number, number] => [a[0] * k, a[1] * k];
const len = (a: [number, number]): number => Math.hypot(a[0], a[1]);
const n2 = (a: [number, number]): number => a[0] * a[0] + a[1] * a[1];

const r2 = (v: number): number => {
  const x = Math.round(v * 100) / 100;
  return x === 0 ? 0 : x; // 归一 -0（序列化/断言都别带负零）
};
const fmt = (v: number): string => String(r2(v));

/** 三次贝塞尔 t 处的点（de Casteljau；线性段等价退化） */
export function segPoint(p0: [number, number], c0: [number, number], c1: [number, number], p1: [number, number], t: number): [number, number] {
  const u = 1 - t;
  const a = mul(p0, u * u * u);
  const b = mul(c0, 3 * u * u * t);
  const c = mul(c1, 3 * u * t * t);
  const d = mul(p1, t * t * t);
  return [a[0] + b[0] + c[0] + d[0], a[1] + b[1] + c[1] + d[1]];
}

/** 段 i（锚 i → 锚 i+1；closed 时末段回卷）两端的世界柄：无柄段柄=锚点本身（线性） */
export function segHandles(pts: Anchor[], i: number, closed: boolean): { p0: [number, number]; c0: [number, number]; c1: [number, number]; p1: [number, number] } | null {
  const n = pts.length;
  if (n < 2) return null;
  const j = i + 1;
  if (j >= n && !(closed && n > 2)) return null;
  const a = pts[i]!;
  const b = pts[j % n]!;
  const c0 = a.hout ? add(a.p, a.hout) : a.p;
  const c1 = b.hin ? add(b.p, b.hin) : b.p;
  return { p0: a.p, c0, c1: b.hin ? c1 : c1, p1: b.p };
}

/** PathShape → SVG path d 串（M…L/C…[Z]），坐标 2 位小数。
 *  闭合末段：直线回卷段由 Z 隐含（不再重复 L），带柄回卷段才输出 C。 */
export function penPathD(path: PenPath): string {
  const { pts, closed } = path;
  if (pts.length === 0) return "";
  let d = `M ${fmt(pts[0]!.p[0])} ${fmt(pts[0]!.p[1])}`;
  const n = pts.length;
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const h = segHandles(pts, i, closed);
    if (!h) break;
    const curved = !!pts[i]!.hout || !!pts[(i + 1) % n]!.hin;
    if (curved) d += ` C ${fmt(h.c0[0])} ${fmt(h.c0[1])} ${fmt(h.c1[0])} ${fmt(h.c1[1])} ${fmt(h.p1[0])} ${fmt(h.p1[1])}`;
    else if (closed && i === n - 1) continue; // 直线回卷 → Z 隐含
    else d += ` L ${fmt(h.p1[0])} ${fmt(h.p1[1])}`;
  }
  if (closed) d += " Z";
  return d;
}

/** 保守包围盒：锚点 + 全部控制柄极值（非紧密——够命中/选框用，文档标注） */
export function penBBox(path: PenPath): { x: number; y: number; w: number; h: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const a of path.pts) {
    xs.push(a.p[0], a.p[0] + (a.hin?.[0] ?? 0), a.p[0] + (a.hout?.[0] ?? 0));
    ys.push(a.p[1], a.p[1] + (a.hin?.[1] ?? 0), a.p[1] + (a.hout?.[1] ?? 0));
  }
  if (!xs.length) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(0.5, Math.max(...xs) - x), h: Math.max(0.5, Math.max(...ys) - y) };
}

/**
 * 段 i 上参数 t 处插入锚点（de Casteljau 切分）：
 * 新锚 = 切点，柄按切分公式分裂；两侧原柄裁剪为子曲线柄。返回新 pts（原数组不动）。
 */
export function splitSeg(pts: Anchor[], i: number, t: number, closed: boolean): Anchor[] {
  const n = pts.length;
  if (n < 2) return pts.slice();
  const j = i + 1;
  if (j >= n && !(closed && n > 2)) return pts.slice();
  const tt = Math.min(0.999, Math.max(0.001, t));
  const a = pts[i]!;
  const b = pts[j % n]!;
  const c0 = a.hout ? add(a.p, a.hout) : a.p;
  const c1 = b.hin ? add(b.p, b.hin) : b.p;
  // de Casteljau 三层切点
  const ab = add(mul(a.p, 1 - tt), mul(c0, tt));
  const bc = add(mul(c0, 1 - tt), mul(c1, tt));
  const cd = add(mul(c1, 1 - tt), mul(b.p, tt));
  const abc = add(mul(ab, 1 - tt), mul(bc, tt));
  const bcd = add(mul(bc, 1 - tt), mul(cd, tt));
  const pt = add(mul(abc, 1 - tt), mul(bcd, tt));
  const out = pts.slice();
  const na: Anchor = { p: [r2(pt[0]), r2(pt[1])] };
  if (a.hout || b.hin) {
    // 曲线段：新锚两柄 = 子曲线切点向量；原锚出柄/原锚入柄裁剪
    na.hout = [r2(bcd[0] - pt[0]), r2(bcd[1] - pt[1])];
    na.hin = [r2(abc[0] - pt[0]), r2(abc[1] - pt[1])];
    const na2 = { ...a };
    if (a.hout) na2.hout = [r2(ab[0] - a.p[0]), r2(ab[1] - a.p[1])];
    const nb = { ...b };
    if (b.hin) nb.hin = [r2(cd[0] - b.p[0]), r2(cd[1] - b.p[1])];
    out[i] = na2;
    out[j % n] = nb;
  }
  out.splice(Math.min(j, n), 0, na);
  return out;
}

/** 删除锚点 i：闭合且余 ≥3 时邻段以两侧柄直接相连（C 段），开路径直接 splice */
export function delAnchor(pts: Anchor[], i: number, closed: boolean): Anchor[] {
  const n = pts.length;
  if (n <= (closed ? 3 : 2)) return pts.slice();
  const a = pts[(i - 1 + n) % n]!;
  const b = pts[(i + 1) % n]!;
  const out = pts.slice();
  out.splice(i, 1);
  if (closed && n > 3) {
    // 邻段直接用两侧原柄相连（p0.hout → p1.hin），几何连续性由调用方接受
    const na = { ...out[(i - 1) % out.length]! };
    const nb = { ...out[(i + 1) % out.length]! };
    void a;
    void b;
    out[(i - 1) % out.length] = na;
    out[(i + 1) % out.length] = nb;
  }
  return out;
}

/** 平移锚点 i（柄随锚整体平移，相对偏移不变） */
export function moveAnchor(pts: Anchor[], i: number, d: [number, number]): Anchor[] {
  const out = pts.slice();
  const a = out[i]!;
  out[i] = { ...a, p: [r2(a.p[0] + d[0]), r2(a.p[1] + d[1])] };
  return out;
}

/**
 * 拖柄：which "hin"/"hout"，to = 柄的新绝对位置（盒局部同系）。
 * smooth=true 时对侧柄完整镜像（等长反向，Figma smooth 口径）；false 折角独立。
 */
export function moveHandle(pts: Anchor[], i: number, which: "hin" | "hout", to: [number, number], smooth: boolean): Anchor[] {
  const out = pts.slice();
  const a = out[i]!;
  const h: [number, number] = [r2(to[0] - a.p[0]), r2(to[1] - a.p[1])];
  const other = which === "hin" ? "hout" : "hin";
  if (smooth) {
    out[i] = { ...a, [which]: h, [other]: [r2(-h[0]), r2(-h[1])] } as Anchor;
  } else {
    out[i] = { ...a, [which]: h } as Anchor;
  }
  return out;
}

/** 平滑切换：on = hin 取 hout 的等长反向（无 hout 则造水平柄）；off = 两柄独立保留 */
export function toggleSmooth(pts: Anchor[], i: number, on: boolean): Anchor[] {
  const out = pts.slice();
  const a = out[i]!;
  if (!on) return out;
  const ho = a.hout ?? [12, 0];
  const l = len(ho) || 12;
  const dir = len(ho) > 1e-6 ? mul(ho, -1 / len(ho)) : [-1, 0];
  out[i] = { ...a, hin: [r2(dir[0] * l), r2(dir[1] * l)] };
  return out;
}

/** 闭合路径（≥3 锚）；已闭合原样返回 */
export function closePath(pts: Anchor[]): Anchor[] {
  if (pts.length < 3) return pts.slice();
  return pts.slice();
}

/** 线段命中：每段 24 采样取最近（返回 null = 未命中半径内） */
export function hitSeg(path: PenPath, wp: [number, number], r: number): SegHit | null {
  const { pts, closed } = path;
  const n = pts.length;
  if (n < 2) return null;
  const segCount = closed ? n : n - 1;
  let best: SegHit | null = null;
  for (let i = 0; i < segCount; i++) {
    const h = segHandles(pts, i, closed);
    if (!h) continue;
    const curved = !!pts[i]!.hout || !!pts[(i + 1) % n]!.hin;
    for (let k = 0; k <= 24; k++) {
      const t = k / 24;
      const q = curved ? segPoint(h.p0, h.c0, h.c1, h.p1, t) : add(mul(h.p0, 1 - t), mul(h.p1, t));
      const d2 = n2(sub(wp, q));
      if (d2 <= r * r && (!best || d2 < best.d2)) best = { seg: i, t, d2 };
    }
  }
  return best;
}

/** 锚点命中：返回下标 | null（r 为命中半径） */
export function hitAnchor(pts: Anchor[], wp: [number, number], r: number): number | null {
  for (let i = 0; i < pts.length; i++) {
    if (n2(sub(wp, pts[i]!.p)) <= r * r) return i;
  }
  return null;
}

/** 把整条路径平移 d（拖整根矢量用） */
export function translatePath(path: PenPath, d: [number, number]): PenPath {
  return { closed: path.closed, pts: path.pts.map((a) => ({ ...a, p: [r2(a.p[0] + d[0]), r2(a.p[1] + d[1])] as [number, number] })) };
}

export const PEN_TAU = TAU;

/** 收笔落节点口径：世界坐标锚点 → 盒（保守包围盒）+ 盒局部 path d 串 */
export function penToNode(pts: Anchor[], closed: boolean): { x: number; y: number; w: number; h: number; path: string } {
  const bb = penBBox({ pts, closed })!;
  const local = pts.map((a) => ({
    p: [r2(a.p[0] - bb.x), r2(a.p[1] - bb.y)] as [number, number],
    ...(a.hin ? { hin: [r2(a.hin[0]), r2(a.hin[1])] as [number, number] } : {}),
    ...(a.hout ? { hout: [r2(a.hout[0]), r2(a.hout[1])] as [number, number] } : {}),
  }));
  return { x: r2(bb.x), y: r2(bb.y), w: r2(bb.w), h: r2(bb.h), path: penPathD({ pts: local, closed }) };
}
