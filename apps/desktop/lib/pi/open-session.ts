"use client";

/**
 * "打开某个会话"的跨组件小总线（与 automation:focus-task 同款 window 事件）：
 * 生产方是系统通知点击的回焦消费（Rust notify_show 记待发会话 → 窗口回焦时
 * lib/notify 取走转这里）；消费方是 Base（切回聊天视图并 switchToThread，
 * 见 components/agent-thread/base.tsx）。
 */

export const OPEN_SESSION_EVENT = "app:open-session";

/** 打开会话时可携带的定位意图（内容命中跳到该消息并高亮） */
export type OpenSessionDetail = {
  sessionId: string;
  /** 内容命中的转录 seq：历史到达后定位到 pi-msg:<seq> */
  seq?: number;
  /** 命中查询词：定位后短暂高亮该词 */
  query?: string;
  /** false = 打开已归档会话时不自动取消归档（默认 true，保持既有入口语义） */
  unarchive?: boolean;
};

export function requestOpenSession(
  sessionId: string,
  intent?: { seq?: number; query?: string; unarchive?: boolean },
): void {
  if (typeof window === "undefined" || !sessionId) return;
  window.dispatchEvent(
    new CustomEvent<OpenSessionDetail>(OPEN_SESSION_EVENT, {
      detail: {
        sessionId,
        ...(intent?.seq !== undefined ? { seq: intent.seq } : {}),
        ...(intent?.query ? { query: intent.query } : {}),
        ...(intent?.unarchive === false ? { unarchive: false } : {}),
      },
    }),
  );
}

export function subscribeOpenSession(cb: (detail: OpenSessionDetail) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<Partial<OpenSessionDetail>>).detail;
    if (typeof detail?.sessionId === "string")
      cb({
        sessionId: detail.sessionId,
        seq: typeof detail.seq === "number" ? detail.seq : undefined,
        query: typeof detail.query === "string" ? detail.query : undefined,
        unarchive: detail.unarchive === false ? false : undefined,
      });
  };
  window.addEventListener(OPEN_SESSION_EVENT, handler);
  return () => window.removeEventListener(OPEN_SESSION_EVENT, handler);
}
