/**
 * 定制编辑工具的纯几何数学（leafer/editTools.ts 的计算内核，刻意零 leafer 依赖）：
 * leafer-ui 在模块加载期就摸 CanvasRenderingContext2D，bun test 环境跑不动，
 * 把手工具的事件胶水留在 editTools.ts，这里的函数全部可直接单测。
 *
 * 语义口径 = DOM 轨同名交互的移植：onUp draw（端点→盒/dir 编码）、node 模式
 * （折点 + Shift 15° 吸附 + rebasePoly）、alt 删点（3→2 塌缩）。改这里必须同步对照 DOM 轨。
 */
import type { ShapeEl } from "../doc";
import { dirFromVec } from "../bind";
import { lineEnds, rebasePoly } from "../viewspec";

export interface Vec {
  x: number;
  y: number;
}

/** 手势 END 时 LeaferStage 要消费的最终补丁（editTools.ts 的宿主协议也引用此类型） */
export interface FinishedGesture {
  elId: string;
  patch: Partial<ShapeEl>;
  /** 线端点手势：新几何（取整后）的两端点，容器坐标 —— 绑定重锚 hit 用 */
  endpoints?: { start: Vec; end: Vec } | null;
}

/**
 * 两点线/箭头端点拖拽：dragStart 时的 doc 元素 + 局部系累计位移 → 新 bbox 几何 + 容器坐标端点。
 * dx/dy 已是 el 局部（未旋转）系增量（innerTotal 产物）。
 * - axisLock（Shift）：保主轴、另一轴清零（LineEditTool.getInnerMove 同口径，但作用于 TOTAL 防漂移）
 * - around（Alt）：另一端对称内移，盒中心不变（穿过中心拖）
 * - w/h 最小 1、坐标取整：与画线落笔（onUp draw）完全同款
 */
export function endpointDrag(
  el: ShapeEl,
  which: "start" | "end",
  dx: number,
  dy: number,
  opts?: { around?: boolean; axisLock?: boolean },
): { patch: Partial<ShapeEl>; start: Vec; end: Vec } {
  const e = lineEnds(el.w, el.h, el.dir);
  let ax = el.x + e.x1;
  let ay = el.y + e.y1;
  let bx = el.x + e.x2;
  let by = el.y + e.y2;
  let mx = dx;
  let my = dy;
  if (opts?.axisLock) {
    if (Math.abs(mx) > Math.abs(my)) my = 0;
    else mx = 0;
  }
  if (which === "start") {
    ax += mx;
    ay += my;
    if (opts?.around) {
      bx -= mx;
      by -= my;
    }
  } else {
    bx += mx;
    by += my;
    if (opts?.around) {
      ax -= mx;
      ay -= my;
    }
  }
  const x = Math.round(Math.min(ax, bx));
  const y = Math.round(Math.min(ay, by));
  const w = Math.max(1, Math.round(Math.abs(bx - ax)));
  const h = Math.max(1, Math.round(Math.abs(by - ay)));
  const dir = dirFromVec(ax, ay, bx, by);
  const patch: Partial<ShapeEl> = { x, y, w, h, ...(dir !== (el.dir ?? 0) ? { dir } : {}) };
  // 端点回报按「取整后的新盒」重算：hit 结果与渲染/提交几何严格一致
  const le = lineEnds(w, h, dir);
  return { patch, start: { x: x + le.x1, y: y + le.y1 }, end: { x: x + le.x2, y: y + le.y2 } };
}

/**
 * 折点拖拽：base 元素 + base 局部点列 + 拖点序号 + 局部系累计位移（+ Shift 15° 吸附）
 * → rebasePoly 全量重写补丁。数学逐行对照 DOM 轨 node 模式（死区由调用方判）。
 */
export function vertexDrag(el: ShapeEl, basePts: Vec[], idx: number, dx: number, dy: number, shift?: boolean): Partial<ShapeEl> {
  const next = basePts.map((p) => ({ x: p.x, y: p.y }));
  let nx = next[idx].x + dx;
  let ny = next[idx].y + dy;
  if (shift) {
    // 以相邻前一点为锚，方向吸附到 15° 整倍、保持长度
    const anchor = next[idx - 1] ?? next[idx + 1];
    if (anchor) {
      const ddx = nx - anchor.x;
      const ddy = ny - anchor.y;
      const len = Math.hypot(ddx, ddy);
      if (len > 0.5) {
        const ang = Math.round(Math.atan2(ddy, ddx) / (Math.PI / 12)) * (Math.PI / 12);
        nx = anchor.x + Math.cos(ang) * len;
        ny = anchor.y + Math.sin(ang) * len;
      }
    }
  }
  next[idx] = { x: nx, y: ny };
  return rebasePoly({ x: el.x, y: el.y }, next) as Partial<ShapeEl>;
}

/** 恰 3 点删中点 → 两点对角线塌缩（pts/curve 清除，dir 按剩两点重编码）；keep = 保留点（局部系） */
export function collapsePatch(el: ShapeEl, keep: Vec[]): { patch: Partial<ShapeEl>; start: Vec; end: Vec } {
  const [a, b] = keep;
  const ax = el.x + a.x;
  const ay = el.y + a.y;
  const bx = el.x + b.x;
  const by = el.y + b.y;
  const patch = {
    x: Math.round(Math.min(ax, bx)),
    y: Math.round(Math.min(ay, by)),
    w: Math.max(1, Math.round(Math.abs(bx - ax))),
    h: Math.max(1, Math.round(Math.abs(by - ay))),
    dir: dirFromVec(ax, ay, bx, by) || undefined,
    pts: undefined,
    curve: undefined,
  } as Partial<ShapeEl>;
  return { patch, start: { x: ax, y: ay }, end: { x: bx, y: by } };
}
