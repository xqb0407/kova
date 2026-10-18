/**
 * 拖拽调宽会话（侧边栏把手 / Agent 面板把手共用）。
 *
 * 拖拽期间宽度每帧都在变：所有「尺寸变化 → 读布局 + setState」的重测量组件
 * 如果逐帧回调，读布局会排队抢主线程，是拖动卡顿的主因。会话期间在 <html>
 * 上挂 `is-resizing`，这些组件据此跳过中间帧；松手后派发 `rail-resize-end`，
 * 各组件统一补一次终态测量。
 *
 * 事件名沿用侧边栏时代的历史命名，避免两套通知并存。
 */
export const RESIZE_SETTLED_EVENT = "rail-resize-end";
const RESIZE_CLASS = "is-resizing";

export function isResizing(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains(RESIZE_CLASS)
  );
}

export function beginResizeSession(): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.add(RESIZE_CLASS);
}

export function endResizeSession(): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.remove(RESIZE_CLASS);
  // 两拍：第一拍让 React 提交终态并完成布局，第二拍再让测量方读取，
  // 否则部分组件量到的还是拖拽中的旧尺寸
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event(RESIZE_SETTLED_EVENT));
    });
  });
}

/** 订阅「一次调宽结束、布局已落定」；返回取消订阅函数 */
export function onResizeSettled(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(RESIZE_SETTLED_EVENT, listener);
  return () => window.removeEventListener(RESIZE_SETTLED_EVENT, listener);
}
