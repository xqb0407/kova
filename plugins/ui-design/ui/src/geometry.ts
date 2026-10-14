/**
 * 几何引擎（纯函数，可单测）：容器局部坐标 ↔ 世界坐标、选择集包围盒、
 * group 包围盒派生、对齐/分布、吸附候选与求值、框选/点选命中。
 *
 * 坐标系约定（与 doc.ts 一致）：节点 x/y/w/h 是**父容器局部坐标**（页面级 = 画布绝对
 * 坐标），rotation 绕自身盒中心；"世界" = 页面绝对坐标。
 * 世界变换 = 逐层父链仿射：先节点自身旋转，再对每个祖先做「绕祖先中心旋转 → 落进祖先父空间」
 * ——与 leafer 场景嵌套 group 的矩阵合成严格一致（见 scene.ts 恒等变换契约）。
 */
import type { DesignDoc, DesignNode, Page } from "./doc";
import { findNode } from "./doc";

export type Box = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };

const deg2rad = (d: number) => (d * Math.PI) / 180;
export const round1 = (v: number): number => Math.round(v * 10) / 10;

/** 盒绕自身中心旋转后的轴对齐外接盒 */
export function aabbRotated(box: Box, th: number): Box {
  if (!th) return box;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const cos = Math.abs(Math.cos(deg2rad(th)));
  const sin = Math.abs(Math.sin(deg2rad(th)));
  const w = box.w * cos + box.h * sin;
  const h = box.w * sin + box.h * cos;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

const boxCorners = (b: Box): Pt[] => [
  { x: b.x, y: b.y },
  { x: b.x + b.w, y: b.y },
  { x: b.x + b.w, y: b.y + b.h },
  { x: b.x, y: b.y + b.h },
];

/** 点绕绝对中心旋转 */
function rotateAbout(p: Pt, cx: number, cy: number, th: number): Pt {
  if (!th) return p;
  const rad = deg2rad(th);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - cx;
  const dy = p.y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/**
 * 节点的世界角点（含自身与全部祖先的旋转）。带环防御。
 * 页面级无父链：角点 = 自身盒绕自身中心旋转后原样（局部即世界）。
 */
export function worldCornersOf(doc: DesignDoc, id: string): Pt[] | null {
  const loc = findNode(doc, id);
  if (!loc) return null;
  const n = loc.node;
  let pts = boxCorners(n).map((p) => rotateAbout(p, n.x + n.w / 2, n.y + n.h / 2, n.rotation || 0));
  let parent = loc.parent;
  const guard = new Set<string>();
  while (parent) {
    const hw = parent.w / 2;
    const hh = parent.h / 2;
    const cx = parent.x + hw;
    const cy = parent.y + hh;
    const th = parent.rotation || 0;
    if (th) {
      // 子局部点 p（相对祖先左上角）→ 祖先父空间：中心 + R(θ)·(p − 半宽高)
      pts = pts.map((p) => {
        const dx = p.x - hw;
        const dy = p.y - hh;
        const rad = deg2rad(th);
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
      });
    } else {
      pts = pts.map((p) => ({ x: cx + (p.x - hw), y: cy + (p.y - hh) }));
    }
    if (guard.has(parent.id)) break;
    guard.add(parent.id);
    parent = findNode(doc, parent.id)?.parent ?? null;
  }
  return pts;
}

/** 节点的世界外接盒（子树链上所有旋转都算进来）；找不到返回 null */
export function worldBoxOf(doc: DesignDoc, id: string): Box | null {
  const pts = worldCornersOf(doc, id);
  if (!pts) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 选择集的世界并盒；空/全失效 null */
export function selectionWorldBox(doc: DesignDoc, ids: string[]): Box | null {
  return unionBox(ids.map((id) => worldBoxOf(doc, id)).filter((b): b is Box => !!b));
}

export function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ---------------- group 包围盒派生 ---------------- */

/**
 * 用子节点（组局部坐标）并集重算 group 盒：组盒收缩贴合内容，原点 = 旧原点 + 局部并集最小角；
 * 子坐标相对组盒左上角，原点位移时整体反向补偿（世界位置不变）。就地修改。
 */
export function deriveGroupBox(g: { x: number; y: number; w: number; h: number; children: DesignNode[] }): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const c of g.children) {
    any = true;
    const b = aabbRotated({ x: c.x, y: c.y, w: c.w, h: c.h }, c.rotation || 0);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!any) return; // 空 group 保留原盒（否则塌成 0 面积）
  g.x = round1(g.x + minX);
  g.y = round1(g.y + minY);
  g.w = Math.max(1, round1(maxX - minX));
  g.h = Math.max(1, round1(maxY - minY));
  if (minX !== 0 || minY !== 0) {
    for (const c of g.children) {
      c.x = round1(c.x - minX);
      c.y = round1(c.y - minY);
    }
  }
}

/** 全档 group 盒重导（载入/agent 写档后跑一遍；自底向上） */
export function normalizeGroups(doc: DesignDoc): void {
  const visit = (list: DesignNode[]) => {
    for (const n of list) {
      if (n.type === "group" || n.type === "frame") {
        visit(n.children);
        if (n.type === "group") deriveGroupBox(n);
      }
    }
  };
  for (const page of doc.pages) visit(page.nodes);
}

/* ---------------- 对齐 / 分布 ---------------- */

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "hdist" | "vdist";

/**
 * 对选择集施加对齐/分布，就地改节点（调用方先克隆进 commit 管线）。
 * ref：null = 按选择集并盒对齐（≥2 个）；给盒 = 按该盒对齐（单/多均可，Figma 画板对齐行为）。
 * 返回实际移动的节点 id。group 的子节点不可独立移动——跳过（正常选择命中组根，不受影响）；
 * 锁定/隐藏节点整体跳过（不参与参照盒，也不被挪动）。
 * 位移在世界系计算；祖先链带旋转时按祖先旋转和逆变换回父局部坐标再落笔。
 */
export function applyAlign(doc: DesignDoc, ids: string[], mode: AlignMode, ref: Box | null): string[] {
  const entries: { node: DesignNode; box: Box; move: { x: number; y: number }; ancRot: number }[] = [];
  for (const id of ids) {
    const loc = findNode(doc, id);
    if (!loc) continue;
    if (loc.parent?.type === "group") continue;
    if (loc.node.locked === true || loc.node.visible === false) continue;
    const box = worldBoxOf(doc, id);
    if (!box) continue;
    let ancRot = 0;
    const seen = new Set<string>();
    for (let p: DesignNode | null = loc.parent; p && !seen.has(p.id); p = findNode(doc, p.id)?.parent ?? null) {
      seen.add(p.id);
      ancRot += p.rotation || 0;
    }
    entries.push({ node: loc.node, box, move: { x: 0, y: 0 }, ancRot });
  }
  if (entries.length === 0) return [];
  if (mode === "hdist" || mode === "vdist") {
    if (entries.length < 3) return [];
    const axis = mode === "hdist" ? ("x" as const) : ("y" as const);
    const size = mode === "hdist" ? ("w" as const) : ("h" as const);
    entries.sort((a, b) => a.box[axis] - b.box[axis]);
    const first = entries[0]!;
    const last = entries[entries.length - 1]!;
    const span = last.box[axis] + last.box[size] - first.box[axis];
    const totalSize = entries.reduce((s, e) => s + e.box[size], 0);
    const gap = (span - totalSize) / (entries.length - 1);
    let cursor = first.box[axis];
    for (const e of entries) {
      e.move[axis] = cursor - e.box[axis];
      cursor += e.box[size] + gap;
    }
    return commitMoves(entries);
  }
  const box = ref ?? unionBox(entries.map((e) => e.box));
  if (!box) return [];
  for (const e of entries) {
    if (mode === "left") e.move.x = box.x - e.box.x;
    else if (mode === "hcenter") e.move.x = box.x + box.w / 2 - (e.box.x + e.box.w / 2);
    else if (mode === "right") e.move.x = box.x + box.w - (e.box.x + e.box.w);
    else if (mode === "top") e.move.y = box.y - e.box.y;
    else if (mode === "vcenter") e.move.y = box.y + box.h / 2 - (e.box.y + e.box.h / 2);
    else if (mode === "bottom") e.move.y = box.y + box.h - (e.box.y + e.box.h);
  }
  return commitMoves(entries);
}

function commitMoves(entries: { node: DesignNode; move: { x: number; y: number }; ancRot: number }[]): string[] {
  const ids: string[] = [];
  for (const e of entries) {
    let { x: dx, y: dy } = e.move;
    if (e.ancRot && (dx !== 0 || dy !== 0)) {
      // 世界平移向量 → 父局部平移：旋转合成只影响线性部，逆着祖先旋转和转回去
      const r = rotateAbout({ x: dx, y: dy }, 0, 0, -e.ancRot);
      dx = r.x;
      dy = r.y;
    }
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) continue;
    e.node.x = round1(e.node.x + dx);
    e.node.y = round1(e.node.y + dy);
    ids.push(e.node.id);
  }
  return ids;
}

/* ---------------- 吸附 ---------------- */

export const SNAP_PX = 6; // 屏幕像素阈值（除以缩放得世界阈值）

export type SnapLine = { at: number; a: number; b: number };
export type SnapCandidates = { v: SnapLine[]; h: SnapLine[] };
export type SnapResult = { dx: number; dy: number; vLines: SnapLine[]; hLines: SnapLine[] };

/** 一组世界盒贡献的对齐线（左右/中 × 上下/中） */
export function linesFromBoxes(boxes: Box[]): SnapCandidates {
  const v: SnapLine[] = [];
  const h: SnapLine[] = [];
  for (const b of boxes) {
    v.push({ at: b.x, a: b.y, b: b.y + b.h });
    v.push({ at: b.x + b.w / 2, a: b.y, b: b.y + b.h });
    v.push({ at: b.x + b.w, a: b.y, b: b.y + b.h });
    h.push({ at: b.y, a: b.x, b: b.x + b.w });
    h.push({ at: b.y + b.h / 2, a: b.x, b: b.x + b.w });
    h.push({ at: b.y + b.h, a: b.x, b: b.x + b.w });
  }
  return { v, h };
}

/** 页面顶层可见节点（画板边/元素边/中线）贡献的吸附候选线，排除被拖动集合 */
export function snapCandidates(doc: DesignDoc, page: Page, excludeIds: Set<string>): SnapCandidates {
  const boxes: Box[] = [];
  for (const n of page.nodes) {
    if (excludeIds.has(n.id) || n.visible === false || n.locked === true) continue;
    const b = worldBoxOf(doc, n.id);
    if (b) boxes.push(b);
  }
  return linesFromBoxes(boxes);
}

/**
 * 全树吸附盒：排除移动集本身及其子孙；祖先保留
 * （在画板内拖动时，画板边/中线是最重要的参照）。
 */
export function collectSnapBoxes(doc: DesignDoc, page: Page, movingIds: Set<string>): Box[] {
  const out: Box[] = [];
  const walk = (list: DesignNode[], inMoving: boolean) => {
    for (const n of list) {
      const moving = movingIds.has(n.id);
      if (!moving && !inMoving && n.visible !== false && n.locked !== true) {
        const b = worldBoxOf(doc, n.id);
        if (b) out.push(b);
      }
      if ((n.type === "frame" || n.type === "group") && !moving) walk(n.children, inMoving || moving);
    }
  };
  walk(page.nodes, false);
  return out;
}

/** 拖动中到相邻元素的间距标注（世界系线段 + 文本）；投影须相交，间距 ∈ (0.5, maxGap] */
export type SpacingLabel = { x1: number; y1: number; x2: number; y2: number; text: string };

export function spacingLabels(moving: Box, boxes: Box[], maxGap: number): SpacingLabel[] {
  const out: SpacingLabel[] = [];
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);
  let left: { edge: number; span: number } | null = null;
  let right: { edge: number; span: number } | null = null;
  let top: { edge: number; span: number } | null = null;
  let bottom: { edge: number; span: number } | null = null;
  for (const b of boxes) {
    const xo = overlap(moving.y, moving.y + moving.h, b.y, b.y + b.h);
    if (xo > 0) {
      if (b.x + b.w <= moving.x + 0.5) {
        if (!left || b.x + b.w > left.edge) left = { edge: b.x + b.w, span: xo };
      } else if (b.x >= moving.x + moving.w - 0.5) {
        if (!right || b.x < right.edge) right = { edge: b.x, span: xo };
      }
    }
    const yo = overlap(moving.x, moving.x + moving.w, b.x, b.x + b.w);
    if (yo > 0) {
      if (b.y + b.h <= moving.y + 0.5) {
        if (!top || b.y + b.h > top.edge) top = { edge: b.y + b.h, span: yo };
      } else if (b.y >= moving.y + moving.h - 0.5) {
        if (!bottom || b.y < bottom.edge) bottom = { edge: b.y, span: yo };
      }
    }
  }
  const push = (
    seg: { x1: number; y1: number; x2: number; y2: number } | null,
    gap: number,
  ) => {
    if (!seg || gap <= 0.5 || gap > maxGap) return;
    out.push({ ...seg, text: String(Math.round(gap)) });
  };
  const my = moving.y + moving.h / 2;
  if (left) push({ x1: left.edge, y1: my, x2: moving.x, y2: my }, moving.x - left.edge);
  if (right) push({ x1: moving.x + moving.w, y1: my, x2: right.edge, y2: my }, right.edge - (moving.x + moving.w));
  if (top) push({ x1: moving.x + moving.w / 2, y1: top.edge, x2: moving.x + moving.w / 2, y2: moving.y }, moving.y - top.edge);
  if (bottom) push({ x1: moving.x + moving.w / 2, y1: moving.y + moving.h, x2: moving.x + moving.w / 2, y2: bottom.edge }, bottom.edge - (moving.y + moving.h));
  return out;
}

/** 拖动盒对候选线求吸附修正：返回增量与世界系下应画的对齐线段 */
export function resolveSnap(moving: Box, cand: SnapCandidates, threshold: number): SnapResult {
  const edgesV = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
  const edgesH = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
  let bestV: { d: number; line: SnapLine } | null = null;
  for (const line of cand.v) {
    for (const pos of edgesV) {
      const d = line.at - pos;
      if (Math.abs(d) <= threshold && (!bestV || Math.abs(d) < Math.abs(bestV.d))) bestV = { d, line };
    }
  }
  let bestH: { d: number; line: SnapLine } | null = null;
  for (const line of cand.h) {
    for (const pos of edgesH) {
      const d = line.at - pos;
      if (Math.abs(d) <= threshold && (!bestH || Math.abs(d) < Math.abs(bestH.d))) bestH = { d, line };
    }
  }
  const out: SnapResult = { dx: bestV?.d ?? 0, dy: bestH?.d ?? 0, vLines: [], hLines: [] };
  if (bestV) out.vLines.push({ at: bestV.line.at, a: Math.min(bestV.line.a, moving.y), b: Math.max(bestV.line.b, moving.y + moving.h) });
  if (bestH) out.hLines.push({ at: bestH.line.at, a: Math.min(bestH.line.a, moving.x), b: Math.max(bestH.line.b, moving.x + moving.w) });
  return out;
}

/* ---------------- 命中 ---------------- */

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 框选（页面顶层节点，相交即选）：返回可独立选中的顶层 id（组/画板整体；锁定/隐藏跳过） */
export function hitRect(doc: DesignDoc, page: Page, rect: Box): string[] {
  const out: string[] = [];
  for (const n of page.nodes) {
    if (n.visible === false || n.locked === true) continue;
    const b = worldBoxOf(doc, n.id);
    if (b && overlaps(b, rect)) out.push(n.id);
  }
  return out;
}

/** 点选：最深可见未锁节点（同容器里后画者在上；锁定/隐藏整枝穿透到下层；AABB 判定含全链旋转） */
export function hitPoint(doc: DesignDoc, page: Page, pt: { x: number; y: number }): string | null {
  const hitList = (list: DesignNode[]): string | null => {
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i]!;
      if (n.visible === false || n.locked === true) continue;
      const b = worldBoxOf(doc, n.id);
      if (!b || pt.x < b.x || pt.x > b.x + b.w || pt.y < b.y || pt.y > b.y + b.h) continue;
      if (n.type === "frame" || n.type === "group") {
        const inner = hitList(n.children);
        if (inner) return inner;
      }
      return n.id;
    }
    return null;
  };
  return hitList(page.nodes);
}

/** 全档节点数 */
export function countNodes(doc: DesignDoc): number {
  const countList = (list: DesignNode[]): number => {
    let n = 0;
    for (const node of list) {
      n++;
      if (node.type === "frame" || node.type === "group") n += countList(node.children);
    }
    return n;
  };
  let n = 0;
  for (const page of doc.pages) n += countList(page.nodes);
  return n;
}
