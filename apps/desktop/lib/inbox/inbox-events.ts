"use client";

/**
 * 「打开收件箱里的某条事项」跨组件小总线（与 open-session / open-chat 同款
 * window 事件）：生产方是外部来源系统通知的点击回放（主进程 inbox:open 只带
 * 来源与条目 id，Base 切视图后由这里把选中态交给 InboxView）。
 */

export const OPEN_INBOX_ITEM_EVENT = "app:open-inbox-item";

export function requestOpenInboxItem(itemId: string): void {
  if (typeof window === "undefined" || !itemId) return;
  window.dispatchEvent(
    new CustomEvent(OPEN_INBOX_ITEM_EVENT, { detail: { itemId } }),
  );
}

export function subscribeOpenInboxItem(
  callback: (itemId: string) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ itemId?: string }>).detail;
    if (typeof detail?.itemId === "string" && detail.itemId) {
      callback(detail.itemId);
    }
  };
  window.addEventListener(OPEN_INBOX_ITEM_EVENT, handler);
  return () => window.removeEventListener(OPEN_INBOX_ITEM_EVENT, handler);
}
