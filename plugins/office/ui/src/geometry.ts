/**
 * 画布几何纯函数：框选相交、并盒、对齐/分布、组缩放、旋转吸附、z 序重排、
 * 剪贴板偏移。全部无副作用，供 CanvasStage/state 调用并单测覆盖。
 */
import type { Box } from "./doc";
import type { El } from "./doc";

export const norm = (b: Box): Box => ({
  x: Math.min(b.x, b.x + b.w),
  y: Math.min(b.y, b.y + b.h),
  w: Math.abs(b.w),
  h: Math.abs(b.h),
});

export const boxOf = (el: { x: number; y: number; w: number; h: number }): Box => ({
  x: el.x,
  y: el.y,
  w: el.w,
  h: el.h,
});

/** 两盒是否相交（面积>0 接触才算，边贴边不算——框选语义） */
export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + a.h && b.y < a.y + a.h;
}

export function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/**
 * 对齐：单选相对容器（画板），多选相对并盒。返回 id → 新 {x,y}。
 */
export function alignBoxes(
  items: { id: string; box: Box }[],
  mode: AlignMode,
  container: Box,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (items.length === 0) return out;
  // 单选：相对容器（画板）；多选：相对选中并盒
  const frame = items.length === 1 ? container : unionBox(items.map((i) => i.box))!;
  for (const { id, box } of items) {
    let { x, y } = box;
    if (mode === "left") x = frame.x;
    else if (mode === "hcenter") x = frame.x + (frame.w - box.w) / 2;
    else if (mode === "right") x = frame.x + frame.w - box.w;
    else if (mode === "top") y = frame.y;
    else if (mode === "vcenter") y = frame.y + (frame.h - box.h) / 2;
    else if (mode === "bottom") y = frame.y + frame.h - box.h;
    out.set(id, { x: Math.round(x), y: Math.round(y) });
  }
  return out;
}

/**
 * 分布（≥3 才有效果）：首尾固定，中间按等间隙排布。axis=h 排 x，v 排 y。
 */
export function distributeBoxes(
  items: { id: string; box: Box }[],
  axis: "h" | "v",
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (items.length < 3) return out;
  const pos = (b: Box) => (axis === "h" ? b.x : b.y);
  const size = (b: Box) => (axis === "h" ? b.w : b.h);
  const sorted = [...items].sort((a, b) => pos(a.box) - pos(b.box));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = pos(last.box) + size(last.box) - pos(first.box);
  const sumSizes = sorted.reduce((acc, it) => acc + size(it.box), 0);
  const gap = (span - sumSizes) / (sorted.length - 1);
  let cursor = pos(first.box);
  sorted.forEach((it, i) => {
    const p = i === sorted.length - 1 ? pos(last.box) : cursor;
    if (axis === "h") out.set(it.id, { x: Math.round(p), y: it.box.y });
    else out.set(it.id, { x: it.box.x, y: Math.round(p) });
    cursor = p + size(it.box) + gap;
  });
  return out;
}

/** 组缩放：把 orig 盒映射到 next 盒，各元素相对映射。返回 id → 新几何 */
export function scaleGroup(
  orig: Box,
  next: Box,
  items: { id: string; box: Box }[],
): Map<string, Box> {
  const out = new Map<string, Box>();
  const kx = orig.w === 0 ? 1 : next.w / orig.w;
  const ky = orig.h === 0 ? 1 : next.h / orig.h;
  for (const { id, box } of items) {
    out.set(id, {
      x: Math.round(next.x + (box.x - orig.x) * kx),
      y: Math.round(next.y + (box.y - orig.y) * ky),
      w: Math.max(4, Math.round(box.w * kx)),
      h: Math.max(4, Math.round(box.h * ky)),
    });
  }
  return out;
}

/** 旋转归一到 (-180,180]；Shift 吸附 15° */
export function normalizeDeg(d: number): number {
  let v = d % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return v;
}
export function snapDeg(deg: number, shift: boolean): number {
  if (!shift) return Math.round(deg);
  return Math.round(deg / 15) * 15;
}

/** z 序重排（纯数组操作）：front 移到数组尾、back 移到数组头，forward/backward 逐级移动 */
export function reorderForZ<T extends { id: string }>(
  elements: T[],
  ids: Set<string>,
  mode: "front" | "back" | "forward" | "backward",
): T[] {
  const arr = elements.slice();
  if (mode === "front") {
    const sel = arr.filter((e) => ids.has(e.id));
    return [...arr.filter((e) => !ids.has(e.id)), ...sel];
  }
  if (mode === "back") {
    const sel = arr.filter((e) => ids.has(e.id));
    return [...sel, ...arr.filter((e) => !ids.has(e.id))];
  }
  if (mode === "forward") {
    for (let i = arr.length - 2; i >= 0; i--) {
      if (ids.has(arr[i]!.id) && !ids.has(arr[i + 1]!.id)) {
        [arr[i], arr[i + 1]] = [arr[i + 1]!, arr[i]!];
      }
    }
  } else {
    for (let i = 1; i < arr.length; i++) {
      if (ids.has(arr[i]!.id) && !ids.has(arr[i - 1]!.id)) {
        [arr[i], arr[i - 1]] = [arr[i - 1]!, arr[i]!];
      }
    }
  }
  return arr;
}

/** 粘贴偏移：整体平移 + 新 id（前缀保留） */
export function offsetPasted(
  els: El[],
  dx: number,
  dy: number,
  newId: (old: string) => string,
): El[] {
  return els.map((e) => ({ ...structuredClone(e), id: newId(e.id), x: e.x + dx, y: e.y + dy }) as El);
}

/**
 * 组选中联动：把选中集合扩成完整编辑组（同 groupId 的成员全部入选）。
 * groupId 是一层扁平标注，无嵌套——按出现的组 id 集合并集即可。
 */
export function expandGroup(els: El[], ids: string[]): string[] {
  const byId = new Set(ids);
  const gids = new Set<string>();
  for (const e of els) if (byId.has(e.id) && e.groupId) gids.add(e.groupId);
  if (gids.size === 0) return ids;
  const out = new Set(ids);
  for (const e of els) if (e.groupId && gids.has(e.groupId)) out.add(e.id);
  return [...out];
}

/** 复制粘贴时给组换新 id：同一次粘贴内的组关系保留，不同次粘贴不串组 */
export function regroupCopies(els: El[]): El[] {
  const gids = new Set(els.flatMap((e) => (e.groupId ? [e.groupId] : [])));
  if (gids.size === 0) return els;
  const map = new Map([...gids].map((g) => [g, `g${Math.random().toString(36).slice(2, 10)}`]));
  return els.map((e) => (e.groupId ? ({ ...e, groupId: map.get(e.groupId) } as El) : e));
}

/** 8 向手柄的 resize 盒计算（从 CanvasStage 抽出供测试） */
export function resizeBox(
  orig: Box,
  handle: number,
  dx: number,
  dy: number,
  shift: boolean,
  alt: boolean,
): Box {
  const left = handle === 0 || handle === 6 || handle === 7;
  const right = handle === 2 || handle === 3 || handle === 4;
  const top = handle === 0 || handle === 1 || handle === 2;
  const bottom = handle === 4 || handle === 5 || handle === 6;
  let x1 = orig.x,
    y1 = orig.y,
    x2 = orig.x + orig.w,
    y2 = orig.y + orig.h;
  if (left) x1 += dx;
  if (right) x2 += dx;
  if (top) y1 += dy;
  if (bottom) y2 += dy;
  let nx = Math.min(x1, x2),
    ny = Math.min(y1, y2);
  let nw = Math.abs(x2 - x1),
    nh = Math.abs(y2 - y1);
  if (shift && (left || right) && (top || bottom) && orig.w > 0 && orig.h > 0) {
    const k = Math.max(nw / orig.w, nh / orig.h);
    nw = orig.w * k;
    nh = orig.h * k;
    if (alt) {
      nx = orig.x + orig.w / 2 - nw / 2;
      ny = orig.y + orig.h / 2 - nh / 2;
    } else {
      // 锚定未拖动的对边：k 由另一轴主导时 nw/nh 会小于拖出的距离，
      // 用已移动边反推位置会让整框漂移——固定点必须是不动的那条边
      nx = left ? x2 - nw : x1;
      ny = top ? y2 - nh : y1;
    }
  }
  if (alt) {
    const cx = orig.x + orig.w / 2;
    const cy = orig.y + orig.h / 2;
    const ddx = (right && !left ? 1 : left && !right ? -1 : 0) * (dx / 2);
    const ddy = (bottom && !top ? 1 : top && !bottom ? -1 : 0) * (dy / 2);
    nw = Math.max(4, orig.w + 2 * ddx);
    nh = Math.max(4, orig.h + 2 * ddy);
    nx = cx - nw / 2;
    ny = cy - nh / 2;
  }
  return {
    x: Math.round(nx),
    y: Math.round(ny),
    w: Math.max(4, Math.round(nw)),
    h: Math.max(4, Math.round(nh)),
  };
}

/* ---------------- 旋转元素的几何变换（编辑器交互用；渲染轨各自 rotate 中心变换） ---------------- */

/** 向量旋转（度；屏幕 +y 向下，与 CSS/SVG rotate 同向：正值顺时针） */
export function rotVec(dx: number, dy: number, deg: number): { x: number; y: number } {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** 世界点 → 元素本地框（存储盒、绕其中心旋转 deg 后的视觉）坐标系：逆旋转 */
export function toLocalPoint(px: number, py: number, box: Box, deg: number): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const v = rotVec(px - cx, py - cy, -deg);
  return { x: v.x + cx, y: v.y + cy };
}

/** 元素存储盒视觉旋转后的轴对外接盒（框选/可视相交判定用） */
export function rotatedAABB(box: Box, deg: number): Box {
  if (!deg) return box;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const pts = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((p) => ({ x: cx + rotVec(p.x - cx, p.y - cy, deg).x, y: cy + rotVec(p.x - cx, p.y - cy, deg).y }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** resizeBox 在本地系里锁定的锚点：拖动边的对侧角/边中点；alt＝中心缩放锚定中心 */
export function resizeAnchor(box: Box, handle: number, alt: boolean): { x: number; y: number } {
  if (alt) return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const x2 = box.x + box.w;
  const y2 = box.y + box.h;
  return [
    { x: x2, y: y2 }, // 0 ⇖ 拖 nw，锚 se
    { x: box.x + box.w / 2, y: y2 }, // 1 ⇑ 锚下边中点
    { x: box.x, y: y2 }, // 2 锚 sw
    { x: box.x, y: box.y + box.h / 2 }, // 3 锚左边中点
    { x: box.x, y: box.y }, // 4 锚 nw
    { x: box.x + box.w / 2, y: box.y }, // 5 锚上边中点
    { x: x2, y: box.y }, // 6 锚 ne
    { x: x2, y: box.y + box.h / 2 }, // 7 锚右边中点
  ][handle] ?? { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/**
 * 旋转态等比缩放：把世界指针位移化进元素本地系跑 resizeBox，再把本地锚点的世界位置
 * 反推回存储盒（渲染 = 绕存储盒中心转 deg，故存储盒中心须落在 锚世界点 − R(锚−新中心)）。
 * 效果：屏幕上对侧锚点不动，拖哪长哪，与未旋转时的手感一致。deg=0 退化为 resizeBox。
 */
export function resizeRotated(
  orig: Box,
  handle: number,
  dx: number,
  dy: number,
  shift: boolean,
  alt: boolean,
  deg: number,
): Box {
  if (!deg) return resizeBox(orig, handle, dx, dy, shift, alt);
  const ld = rotVec(dx, dy, -deg);
  const g = resizeBox(orig, handle, ld.x, ld.y, shift, alt);
  const a = resizeAnchor(orig, handle, alt);
  const oc = { x: orig.x + orig.w / 2, y: orig.y + orig.h / 2 };
  const oav = rotVec(a.x - oc.x, a.y - oc.y, deg);
  const A = { x: oc.x + oav.x, y: oc.y + oav.y }; // 锚点的世界位置（旧）
  const gc = { x: g.x + g.w / 2, y: g.y + g.h / 2 };
  const gav = rotVec(a.x - gc.x, a.y - gc.y, deg);
  const cS = { x: A.x - gav.x, y: A.y - gav.y }; // 新存储盒中心
  return { x: cS.x - g.w / 2, y: cS.y - g.h / 2, w: g.w, h: g.h };
}

/** 画板网格布局（纯函数，列数只依赖 s=1 容器宽——缩放不重排） */
export function gridLayout(
  slides: { id: string; w: number; h: number }[],
  containerW: number,
  containerH: number,
  gap = 56,
  pad = 80,
): { positions: { id: string; x: number; y: number }[]; totalW: number; totalH: number } {
  if (slides.length === 0) return { positions: [], totalW: 1, totalH: 1 };
  const maxW = Math.max(...slides.map((s) => s.w));
  const maxH = Math.max(...slides.map((s) => s.h));
  const cols = Math.max(1, Math.floor((containerW - pad) / (maxW + gap)) || 1);
  const positions: { id: string; x: number; y: number }[] = [];
  let rowH = 0;
  let y = pad;
  slides.forEach((slide, i) => {
    const col = i % cols;
    if (col === 0 && i > 0) y += rowH + gap;
    rowH = Math.max(rowH, slide.h);
    positions.push({ id: slide.id, x: pad + col * (maxW + gap), y });
  });
  const rows = Math.ceil(slides.length / cols);
  return {
    positions,
    totalW: pad * 2 + cols * maxW + (cols - 1) * gap,
    totalH: Math.max(containerH, pad * 2 + rows * maxH + (rows - 1) * gap),
  };
}

/* ---------------- 折线笔画命中 ---------------- */

/** 点 (px,py) 到线段 ab 的距离 */
export function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 折线（点列与 p 同坐标系）按「加粗笔画」命中：任一段距离 ≤ tol（<2 点恒 false） */
export function polyHit(pts: { x: number; y: number }[], px: number, py: number, tol: number): boolean {
  for (let i = 0; i + 1 < pts.length; i++) {
    if (pointSegDist(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= tol) return true;
  }
  return false;
}
