/**
 * 顶部锚点垫片的重算入口（模块级）。
 *
 * 框架的 `mountTopAnchorReserve` 只在 target / anchor / 视口尺寸变化或
 * assistant-ui store 变更时重算垫片；聊天区里折叠面板（思考、工具组、轮过程）
 * 的高度变化不在它的观察范围内。面板收起时 `scrollHeight` 变小、垫片保持旧值，
 * 浏览器会把 `scrollTop` 夹到新的 `maxScrollTop`——表现就是「用户消息从视口
 * 顶部被往下推」。
 *
 * ThreadViewport 挂载时把自己的重算函数注册进来；折叠动画结束后由
 * useScrollLock 触发一次，让框架按最终 `scrollHeight` 重新写垫片，之后它
 * 内部的 reserve 状态与 DOM 一致。
 */
type Recompute = () => void;

const recomputers = new Set<Recompute>();

export function registerTopAnchorReserveRecomputer(
  fn: Recompute,
): () => void {
  recomputers.add(fn);
  return () => {
    recomputers.delete(fn);
  };
}

export function recomputeTopAnchorReserve(): void {
  for (const fn of [...recomputers]) fn();
}
