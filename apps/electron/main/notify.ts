/**
 * 系统通知（对齐 notify.rs）：show 后即遗忘；点击"直达会话"用 pending 槽 +
 * 前端 focus 时 consume 取走（30s TTL）实现。
 */
import { Notification } from "electron";
import { focusMainWindow } from "./ipc";

let pendingSession: { id: string; at: number } | null = null;
const PENDING_TTL_MS = 30_000;

export function notifyShow(args: { title: string; body: string; session?: string | null }): null {
  try {
    if (!Notification.isSupported()) throw new Error("notification unsupported");
    const n = new Notification({ title: String(args.title ?? ""), body: String(args.body ?? "") });
    n.show();
  } catch (e) {
    // macOS 首次弹授权框（与 JS 路径同语义）；失败仍登记 pending，语义不回退
    const err = e as Error;
    throw new Error(err.message);
  }
  if (typeof args.session === "string" && args.session) {
    pendingSession = { id: args.session, at: Date.now() };
  }
  return null;
}

export function notifyConsumePendingSession(): string | null {
  const entry = pendingSession;
  pendingSession = null;
  if (!entry) return null;
  if (Date.now() - entry.at >= PENDING_TTL_MS) return null;
  focusMainWindow();
  return entry.id;
}

export function setupNotifyCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("notify_show", (a) => notifyShow(a));
  register("notify_consume_pending_session", () => notifyConsumePendingSession());
}
