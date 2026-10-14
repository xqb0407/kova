/**
 * 圆角手柄的纯计算 + 写回规则（无 DOM、无 React）。
 *
 * 从 chrome/RadiusHandles.tsx 里抽出来，是因为"拖多快算多少半径""拖哪一角改哪几角"
 * 是这个交互的全部语义，值得单独测；组件里只剩指针事件与定位。
 */
import type { Box } from "./geometry";
import type { DesignNode } from "./doc";

/** 四角半径（tl, tr, br, bl） */
export type Corners = [number, number, number, number];

/** 支持圆角的节点类型（与 Inspector 的 isBoxRadius 同口径） */
export const RADIUS_TYPES: readonly string[] = ["rect", "frame", "image"];

export const hasRadiusField = (n: DesignNode): boolean => RADIUS_TYPES.includes(n.type);

/** radius 字段 → 四角数组（数字 = 四角统一；数组 = 逐角） */
export function radiiOf(n: DesignNode): Corners {
  const r = (n as { radius?: number | number[] }).radius;
  if (Array.isArray(r)) return [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 0];
  const v = typeof r === "number" ? r : 0;
  return [v, v, v, v];
}

/** 圆角是不是「四角统一」（还没被拆开） */
export const isUniformRadius = (n: DesignNode): boolean => !Array.isArray((n as { radius?: unknown }).radius);

/** 圆角上限：短边的一半（再大 CSS/SVG 也会夹住） */
export const maxRadius = (box: Pick<Box, "w" | "h">): number => Math.max(0, Math.min(box.w, box.h) / 2);

/** 第 i 角（0=tl 1=tr 2=br 3=bl）的角点坐标与朝内方向 */
export function cornerAt(box: Box, i: number): { x: number; y: number; dx: 1 | -1; dy: 1 | -1 } {
  const dx: 1 | -1 = i === 0 || i === 3 ? 1 : -1;
  const dy: 1 | -1 = i === 0 || i === 1 ? 1 : -1;
  return { x: box.x + (dx > 0 ? 0 : box.w), y: box.y + (dy > 0 ? 0 : box.h), dx, dy };
}

/**
 * 指针位置 → 半径：把指针相对角点的位移投影到**对角线方向**上，即两轴内向位移的平均值。
 *
 * 为什么不是"取两轴较小的那个"：手柄本来就在角点的对角线上（偏移 (r, r)），
 * 用 min 的话沿着任一条边拖（另一轴不动）min 恒等于当前 r，半径**根本不跟着变**。
 * 平均值等价于沿对角线投影——手柄贴着光标沿对角线走，两轴一起拖手感最自然，
 * 只拖一轴也有半速响应，不会卡死。往外拖到角点之外 → 归 0。
 */
export function radiusFromPointer(
  corner: { x: number; y: number; dx: 1 | -1; dy: 1 | -1 },
  p: { x: number; y: number },
  max: number,
): number {
  const inX = (p.x - corner.x) * corner.dx; // 朝盒内为正
  const inY = (p.y - corner.y) * corner.dy;
  const r = (inX + inY) / 2;
  return Math.round(Math.min(Math.max(r, 0), max) * 10) / 10;
}

/**
 * 手柄落点（圆角弧的圆心）：角点沿对角线内移 r，并在两个方向上夹住内移量：
 *   · 下界 `minInset`（世界单位）：半径很小时手柄不会被缩放手柄压住；
 *   · 上界 `shortHalf - minInset`：胶囊形（radius = 短边一半）时同一条边上的上下两个
 *     手柄会落到**同一点**，抓不住也分不清——夹一刀让它们至少隔开 2×minInset。
 */
export function handleAt(box: Box, i: number, radius: number, minInset: number): { x: number; y: number } {
  const c = cornerAt(box, i);
  const r = Math.max(radius, minInset);
  const capX = Math.max(minInset, box.w / 2 - minInset);
  const capY = Math.max(minInset, box.h / 2 - minInset);
  return { x: c.x + c.dx * Math.min(r, capX), y: c.y + c.dy * Math.min(r, capY) };
}

/**
 * 写回圆角。`split`（或节点原本就是四角数组）= 只改这一角；否则四角一起改成同一个值
 * （保持"统一"这种清白状态，用户拖一个角就是想要四个角一样）。
 * 全 0 → 摘掉 radius 字段（不留 0 值，diff 干净）。
 */
export function withCornerRadius(
  n: DesignNode,
  i: number,
  r: number,
  opts: { split?: boolean } = {},
): DesignNode {
  const cur = radiiOf(n);
  const split = opts.split === true || !isUniformRadius(n);
  const out: Corners = split ? ([...cur] as Corners) : [r, r, r, r];
  if (split) out[i] = r;
  const next = { ...n } as DesignNode & { radius?: unknown };
  if (out.every((v) => v === 0)) delete next.radius;
  else if (out[0] === out[1] && out[1] === out[2] && out[2] === out[3]) next.radius = out[0];
  else next.radius = out;
  return next;
}
