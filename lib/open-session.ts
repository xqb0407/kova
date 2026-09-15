"use client";

/**
 * "打开某个会话"的跨组件小总线（与 automation:focus-task 同款 window 事件）：
 * 生产方是系统通知点击的回焦消费（Rust notify_show 记待发会话 → 窗口回焦时
 * lib/notify 取走转这里）；消费方是 Base（切回聊天视图并 switchToThread，
 * 见 components/agent-thread/base.tsx）。
 */

export const OPEN_SESSION_EVENT = "app:open-session";

export function requestOpenSession(sessionId: string): void {
  if (typeof window === "undefined" || !sessionId) return;
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId } }));
}

export function subscribeOpenSession(cb: (sessionId: string) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
    if (typeof detail?.sessionId === "string") cb(detail.sessionId);
  };
  window.addEventListener(OPEN_SESSION_EVENT, handler);
  return () => window.removeEventListener(OPEN_SESSION_EVENT, handler);
}
