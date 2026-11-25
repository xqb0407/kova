"use client";

/**
 * 「切回聊天」跨组件小总线：收件箱「交给 Agent」创建新会话后，需要让
 * 主区从收件箱页切回聊天视图。与 open-session 同款 window 事件。
 */
export const OPEN_CHAT_EVENT = "app:open-chat";

export function requestOpenChat(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_CHAT_EVENT));
}
