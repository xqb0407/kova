/**
 * 桌宠悬浮窗位置钳制（纯计算，不 import electron，可在 bun test 下直跑）。
 *
 * 目标不是"把窗口锁在一块屏里"（那会让多屏用户没法把宠物拖到副屏），而是
 * "任何时候都至少留一块能抓到的可见区域"：
 * - 窗口被各显示器工作区截出来的可见部分，包围盒至少 minVisible 见方 → 放行
 *   （跨屏接缝的窄窗每边只露 60px 也算可见，不会被吸回单屏）；
 * - 完全出屏（或落在显示器之间的空隙里）→ 按窗口中心挑最近的显示器拉回。
 *
 * 之前按左上角 `getDisplayNearestPoint` 钳制的写法在跨屏拖动时会把窗口
 * 卡在主屏右缘——拖向副屏的第一步就被判成"出屏"。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** 窗口在某块工作区内至少露出这么多像素（可见部分包围盒横纵同时满足）才算"找得回来"。 */
export const MIN_VISIBLE = 80;

/** 窗口矩形与各工作区相交部分的包围盒，在纵横两个方向都够大才算"找得回来"。 */
export function hasEnoughVisibleArea(
  rect: Rect,
  workAreas: readonly Rect[],
  minVisible = MIN_VISIBLE,
): boolean {
  // 用"可见部分并集的包围盒"而不是"某一块屏上的重叠"：窗口跨在两屏接缝上时
  // 每边可能只露 60px，但那 120px 合起来完全抓得到；按单屏卡会把窗口吸回一侧。
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const work of workAreas) {
    const loX = Math.max(rect.x, work.x);
    const hiX = Math.min(rect.x + rect.width, work.x + work.width);
    const loY = Math.max(rect.y, work.y);
    const hiY = Math.min(rect.y + rect.height, work.y + work.height);
    // 这块屏上不可见（或只贴着边）就不参与包围盒
    if (hiX <= loX || hiY <= loY) continue;
    if (loX < minX) minX = loX;
    if (hiX > maxX) maxX = hiX;
    if (loY < minY) minY = loY;
    if (hiY > maxY) maxY = hiY;
  }
  if (maxX < minX || maxY < minY) return false;
  return maxX - minX >= minVisible && maxY - minY >= minVisible;
}

/** 距窗口中心最近的显示器工作区（窗口/显示器可以不相交）。 */
function nearestWorkArea(rect: Rect, workAreas: readonly Rect[]): Rect | null {
  if (workAreas.length === 0) return null;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  let best: Rect | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const work of workAreas) {
    const dx = Math.max(work.x - cx, 0, cx - (work.x + work.width));
    const dy = Math.max(work.y - cy, 0, cy - (work.y + work.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = work;
    }
  }
  return best;
}

/**
 * 位置钳制：
 * - 有足够可见区域 → 原样返回；
 * - 否则拉回最近工作区边缘，保留 minVisible 可见。
 * 没有显示器信息（异常环境）时原样返回，绝不把窗口算到 NaN。
 */
export function clampWindowPosition(
  point: Point,
  size: Size,
  workAreas: readonly Rect[],
  minVisible = MIN_VISIBLE,
): Point {
  if (workAreas.length === 0) return point;
  const rect: Rect = { x: point.x, y: point.y, width: size.width, height: size.height };
  if (hasEnoughVisibleArea(rect, workAreas, minVisible)) return point;

  const work = nearestWorkArea(rect, workAreas);
  if (work === null) return point;
  return {
    x: Math.min(Math.max(point.x, work.x - size.width + minVisible), work.x + work.width - minVisible),
    y: Math.min(
      Math.max(point.y, work.y - size.height + minVisible),
      work.y + work.height - minVisible,
    ),
  };
}
