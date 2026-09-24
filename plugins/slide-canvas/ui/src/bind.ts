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
import { rebasePoly } from "./viewspec";

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
  if (!els.some((e) => isBindableLine(e) && (e.startBind || e.endBind))) return null;
  const byId = new Map(els.map((e) => [e.id, e] as const));
  let changed = false;
  const out = els.map((el) => {
    if (!isBindableLine(el) || (!el.startBind && !el.endBind)) return el;
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

/** 重算全档绑定线端点（objects + 每页 elements）；无变化返回原 doc 引用 */
export function syncBoundArrows(doc: CanvasDoc): CanvasDoc {
  const objects = syncContainer(doc.objects);
  let framesTouched = false;
  const frames = doc.frames.map((f) => {
    const els = syncContainer(f.elements);
    if (!els) return f;
    framesTouched = true;
    return { ...f, elements: els };
  });
  if (!objects && !framesTouched) return doc;
  return { ...doc, ...(objects ? { objects } : {}), ...(framesTouched ? { frames } : {}) };
}
