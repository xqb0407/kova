/**
 * 连线绑定（Excalidraw bound arrows 语义）：线类形状可携带
 * startBind / endBind —— **同一容器内**被连接元素的 id。
 * 两点线几何是普通 bbox+dir；带折点（pts≥3）的折线取首/末点世界像做锚定，
 * 端点重锚后内部折点原样保留、bbox 重算为全点并集。syncBoundArrows 在文档
 * 每次落定（提交 / 撤销 / 外部载入，统一走 applyDoc）时把绑定端重算到
 * 被绑元素**朝向对端**的边缘锚点上（锚点求交在元素旋转后的真实边上进行）——
 * 移动、缩放或旋转元素，连线箭头自动跟随；被重算的连线自身 rotation 归一化清除。
 * 纯函数；无变化时返回原文档引用（不产生新对象、不弄脏文档）。
 *
 * 绑定 id 只按所在容器解析：objects 与各 frame.elements 的 id 空间互不相通，
 * 跨容器引用一律视为悬空并在同步时清除。
 */
import type { CanvasDoc, El, ShapeEl } from "./doc";
import { boxOf, rotVec, toLocalPoint } from "./geometry";
import { isPolyline, rebasePoly } from "./viewspec";

/** 可作为连线的形状（与 dir/curve 语义同域；须与 doc.ts 保持一致） */
export const LINE_SHAPES: ReadonlySet<string> = new Set(["line", "arrow", "double-arrow"]);

/** 是线类形状（可能带绑定的那几种） */
export function isBindableLine(el: El): el is ShapeEl {
  return el.kind === "shape" && LINE_SHAPES.has(el.shape);
}

type Pt = { x: number; y: number };

/** bbox + dir（起点→终点对角）→ 两端点：dir0=(x,y)→(x+w,y+h) 1=↗ 2=↖ 3=↙ */
export function lineEnds(el: Pick<ShapeEl, "x" | "y" | "w" | "h" | "dir">): [Pt, Pt] {
  const dir = el.dir ?? 0;
  const downRight = dir === 0 || dir === 1; // 起点在左侧
  const upLeft = dir === 0 || dir === 3; // 起点在上方（对角终点取反）
  const start: Pt = { x: downRight ? el.x : el.x + el.w, y: upLeft ? el.y : el.y + el.h };
  const end: Pt = { x: downRight ? el.x + el.w : el.x, y: upLeft ? el.y + el.h : el.y };
  return [start, end];
}

/** 拖拽向量 → dir（与 CanvasStage 提交式一致） */
export function dirFromVec(x0: number, y0: number, x1: number, y1: number): 0 | 1 | 2 | 3 {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return (dx >= 0 ? (dy >= 0 ? 0 : 1) : dy >= 0 ? 3 : 2) as 0 | 1 | 2 | 3;
}

const centerOf = (el: El): Pt => {
  const b = boxOf(el);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
};

/* ---------------- 正交路由（route:"orth"） ---------------- */

type Side = "l" | "r" | "t" | "b";
const ORTH_STUB = 24;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 选边：t 相对元素中心的方位被哪条轴"吃掉"更多就从哪侧出/入（与 anchorOn 同判据）。
 *  锚点 = 该边中点沿边朝 t 偏移（≤1/4 边长），既不全员叠正中，也保留朝向感。 */
function sideToward(el: El, t: Pt): { side: Side; pt: Pt } {
  const b = boxOf(el);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = t.x - cx;
  const dy = t.y - cy;
  const horizontal = Math.abs(dx) * b.h >= Math.abs(dy) * b.w;
  if (horizontal) {
    const side: Side = dx >= 0 ? "r" : "l";
    const off = clamp(dy * 0.25, -b.h * 0.25, b.h * 0.25);
    return { side, pt: { x: side === "r" ? b.x + b.w : b.x, y: cy + off } };
  }
  const side: Side = dy >= 0 ? "b" : "t";
  const off = clamp(dx * 0.25, -b.w * 0.25, b.w * 0.25);
  return { side, pt: { x: cx + off, y: side === "b" ? b.y + b.h : b.y } };
}

/** 水平出入（aOut/bIn：+1 = 右侧，-1 = 左侧）的肘形路径；能直行则中轴单折（simplify 后成直线） */
function orthPathH(a: Pt, aOut: 1 | -1, b: Pt, bIn: 1 | -1): Pt[] {
  const ax = a.x + aOut * ORTH_STUB;
  const bx = b.x + bIn * ORTH_STUB;
  const straight = (aOut === 1 && bIn === -1 && bx >= ax) || (aOut === -1 && bIn === 1 && bx <= ax);
  if (straight) {
    const mid = (ax + bx) / 2;
    return [a, { x: mid, y: a.y }, { x: mid, y: b.y }, b];
  }
  const midY = (a.y + b.y) / 2;
  return [a, { x: ax, y: a.y }, { x: ax, y: midY }, { x: bx, y: midY }, { x: bx, y: b.y }, b];
}

/** 垂直出入（+1 = 下侧，-1 = 上侧） */
function orthPathV(a: Pt, aOut: 1 | -1, b: Pt, bIn: 1 | -1): Pt[] {
  const ay = a.y + aOut * ORTH_STUB;
  const by = b.y + bIn * ORTH_STUB;
  const straight = (aOut === 1 && bIn === -1 && by >= ay) || (aOut === -1 && bIn === 1 && by <= ay);
  if (straight) {
    const mid = (ay + by) / 2;
    return [a, { x: a.x, y: mid }, { x: b.x, y: mid }, b];
  }
  const midX = (a.x + b.x) / 2;
  return [a, { x: a.x, y: ay }, { x: midX, y: ay }, { x: midX, y: by }, { x: b.x, y: by }, b];
}

/** 混合（一端水平出入、一端垂直出入）走 L 形 */
function orthPath(a: Pt, aSide: Side, b: Pt, bSide: Side): Pt[] {
  const aH = aSide === "l" || aSide === "r";
  const bH = bSide === "l" || bSide === "r";
  if (aH !== bH) {
    return aH ? [a, { x: b.x, y: a.y }, b] : [a, { x: a.x, y: b.y }, b];
  }
  const aOut: 1 | -1 = aSide === "r" || aSide === "b" ? 1 : -1;
  const bIn: 1 | -1 = bSide === "l" || bSide === "t" ? -1 : 1;
  return aH ? orthPathH(a, aOut, b, bIn) : orthPathV(a, aOut, b, bIn);
}

/** 去共线中间点：同轴的中间点折叠（直行路径收缩为两端点） */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0 || i === pts.length - 1) {
      out.push(p);
      continue;
    }
    const prev = out[out.length - 1];
    const next = pts[i + 1];
    if ((prev.x === p.x && p.x === next.x) || (prev.y === p.y && p.y === next.y)) continue;
    out.push(p);
  }
  return out;
}

/** 从 box 中心朝 target 的射线与（可能旋转的）矩形边求交。
 *  旋转以存储盒中心为轴（与渲染轨 transform: rotate 一致）：target 化到局部系
 *  做轴对齐求交，交点再转回世界系。中心点不受旋转影响，centerOf/瞄准点无需变换。 */
function anchorOn(el: El, t: Pt): Pt {
  const b = boxOf(el);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const deg = el.rotation ?? 0;
  const p = deg ? toLocalPoint(t.x, t.y, b, deg) : t;
  const dx = p.x - cx;
  const dy = p.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  const lx = cx + dx * s;
  const ly = cy + dy * s;
  if (!deg) return { x: lx, y: ly };
  const v = rotVec(lx - cx, ly - cy, deg);
  return { x: cx + v.x, y: cy + v.y };
}

/** 同步一个容器内的全部绑定线；无变化返回 null */
function syncContainer(els: El[]): El[] | null {
  if (!els.some((e) => isBindableLine(e) && (e.startBind || e.endBind || (e.route === "orth" && !isPolyline(e))))) return null;
  const byId = new Map(els.map((e) => [e.id, e] as const));
  let changed = false;
  const out = els.map((el) => {
    if (!isBindableLine(el)) return el;
    const bound = !!(el.startBind || el.endBind);
    // 自由端正交线：首次同步生成一次 L 形折线，之后折点归用户手动编辑（不再重算）
    if (!bound) {
      if (el.route !== "orth" || isPolyline(el)) return el;
      const [s0, s1] = lineEnds(el);
      const horizontal = el.w >= el.h;
      const mx = (s0.x + s1.x) / 2;
      const my = (s0.y + s1.y) / 2;
      const raw: Pt[] = horizontal
        ? [s0, { x: mx, y: s0.y }, { x: mx, y: s1.y }, s1]
        : [s0, { x: s0.x, y: my }, { x: s1.x, y: my }, s1];
      const rel = simplify(raw).map((p) => ({ x: p.x - el.x, y: p.y - el.y }));
      changed = true;
      return { ...el, ...rebasePoly(el, rel), curve: undefined };
    }
    // 自绑 / 两端同绑 / 目标已删除 → 该端视为未绑定
    const a = el.startBind && el.startBind !== el.id ? byId.get(el.startBind) : undefined;
    const b =
      el.endBind && el.endBind !== el.id && el.endBind !== el.startBind ? byId.get(el.endBind) : undefined;
    if (!a && !b) {
      changed = true;
      return { ...el, startBind: undefined, endBind: undefined };
    }
    // 折线线类（pts≥3）：首/末点即起终点，内部折点原样保留、仅两端参与锚定；两点线走对角语义
    const poly = el.pts && el.pts.length >= 3 ? el.pts : null;
    const [p0, p1] = poly
      ? ([
          { x: el.x + poly[0][0], y: el.y + poly[0][1] },
          { x: el.x + poly[poly.length - 1][0], y: el.y + poly[poly.length - 1][1] },
        ] as [Pt, Pt])
      : lineEnds(el);
    // 连线自身可能带 rotation（属性面板设的；旋转手势本身会解绑）：自由端按世界位置参与。
    const wp = (p: Pt): Pt => {
      if (!el.rotation) return p;
      const c = centerOf(el);
      const v = rotVec(p.x - c.x, p.y - c.y, el.rotation);
      return { x: c.x + v.x, y: c.y + v.y };
    };
    const w0 = wp(p0);
    const w1 = wp(p1);
    // 正交路由：锚点=按方位选边的边中点（锚向对端），路径每次全量重算（pts 由同步接管）
    if (el.route === "orth") {
      const t0 = b ? centerOf(b) : w1;
      const t1 = a ? centerOf(a) : w0;
      const sa = a ? sideToward(a, t0) : null;
      const sb = b ? sideToward(b, t1) : null;
      let wpts: Pt[];
      if (sa && sb) {
        wpts = simplify(orthPath(sa.pt, sa.side, sb.pt, sb.side));
      } else if (sa) {
        // 仅起点绑定：从锚点 L 形到自由端（水平/垂直按锚边）
        wpts = sa.side === "l" || sa.side === "r"
          ? simplify([sa.pt, { x: w1.x, y: sa.pt.y }, w1])
          : simplify([sa.pt, { x: sa.pt.x, y: w1.y }, w1]);
      } else {
        wpts = sb && (sb.side === "l" || sb.side === "r")
          ? simplify([w0, { x: sb.pt.x, y: w0.y }, sb.pt])
          : simplify([w0, { x: w0.x, y: sb ? sb.pt.y : w1.y }, sb ? sb.pt : w1]);
      }
      const orth =
        wpts.length < 3
          ? (() => {
              // 直行收缩：bbox+dir 两点线形式（与普通绑定线同形，不物化 pts）
              const [q0, q1] = wpts;
              const d = dirFromVec(q0.x, q0.y, q1.x, q1.y);
              return {
                ...el,
                x: Math.round(Math.min(q0.x, q1.x)),
                y: Math.round(Math.min(q0.y, q1.y)),
                w: Math.max(1, Math.round(Math.abs(q1.x - q0.x))),
                h: Math.max(1, Math.round(Math.abs(q1.y - q0.y))),
                dir: d === 0 ? undefined : d,
                curve: undefined,
                rotation: undefined,
                startBind: a ? el.startBind : undefined,
                endBind: b ? el.endBind : undefined,
              };
            })()
          : {
              ...el,
              ...rebasePoly(
                el,
                wpts.map((p) => ({ x: p.x - el.x, y: p.y - el.y })),
              ),
              curve: undefined,
              rotation: undefined,
              startBind: a ? el.startBind : undefined,
              endBind: b ? el.endBind : undefined,
            };
      if (
        orth.x !== el.x || orth.y !== el.y || orth.w !== el.w || orth.h !== el.h ||
        (orth.dir ?? 0) !== (el.dir ?? 0) || orth.rotation !== el.rotation ||
        (orth.curve ?? 0) !== (el.curve ?? 0) ||
        orth.startBind !== el.startBind || orth.endBind !== el.endBind ||
        JSON.stringify(orth.pts ?? null) !== JSON.stringify(el.pts ?? null)
      ) {
        changed = true;
        return orth;
      }
      return el;
    }

    // 绑定端 → 被绑元素（含旋转）边缘锚点（朝对端元素中心；对端自由则朝自由端现状）；自由端原样保留
    const q0 = a ? anchorOn(a, b ? centerOf(b) : w1) : w0;
    const q1 = b ? anchorOn(b, a ? centerOf(a) : w0) : w1;
    let next: ShapeEl;
    if (poly) {
      // 折线：整条按世界折点重写（rotation 烘焙进点列），bbox=点并集（rebasePoly），dir/curve/rotation 清除
      const rel = poly.map((pt) => {
        const wpt = wp({ x: el.x + pt[0], y: el.y + pt[1] });
        return { x: wpt.x - el.x, y: wpt.y - el.y };
      });
      rel[0] = { x: q0.x - el.x, y: q0.y - el.y };
      rel[rel.length - 1] = { x: q1.x - el.x, y: q1.y - el.y };
      next = { ...el, ...rebasePoly(el, rel), rotation: undefined, startBind: a ? el.startBind : undefined, endBind: b ? el.endBind : undefined };
    } else {
      const x = Math.round(Math.min(q0.x, q1.x));
      const y = Math.round(Math.min(q0.y, q1.y));
      const w = Math.max(1, Math.round(Math.abs(q1.x - q0.x)));
      const h = Math.max(1, Math.round(Math.abs(q1.y - q0.y)));
      const dir = dirFromVec(q0.x, q0.y, q1.x, q1.y);
      // 几何已由锚点整体重写为"轴对齐 bbox+dir 对角线"，连线自身的 rotation 至此无意义：清掉
      next = {
        ...el,
        x,
        y,
        w,
        h,
        dir: dir === 0 ? undefined : dir,
        rotation: undefined,
        startBind: a ? el.startBind : undefined,
        endBind: b ? el.endBind : undefined,
      };
    }
    if (
      next.x !== el.x || next.y !== el.y || next.w !== el.w || next.h !== el.h ||
      (next.dir ?? 0) !== (el.dir ?? 0) || next.rotation !== el.rotation ||
      next.startBind !== el.startBind || next.endBind !== el.endBind ||
      JSON.stringify(next.pts ?? null) !== JSON.stringify(el.pts ?? null)
    ) {
      changed = true;
      return next;
    }
    return el;
  });
  return changed ? out : null;
}

/** 重算全档绑定线端点（objects）；无变化返回原 doc 引用 */
export function syncBoundArrows(doc: CanvasDoc): CanvasDoc {
  const objects = syncContainer(doc.objects);
  if (!objects) return doc;
  return { ...doc, objects };
}
