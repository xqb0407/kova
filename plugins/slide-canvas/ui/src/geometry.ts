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
      if (!left) nx = x2 - nw;
      if (!top) ny = y2 - nh;
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
