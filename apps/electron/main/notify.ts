/**
 * 系统通知（对齐 notify.rs）：show 后即遗忘；带 session 的通知在用户点击
 * 卡片时通知主窗口 notify:open-session，前端据此打开对应会话。
 */
import { Notification } from "electron";
import { emitToWindow, focusMainWindow } from "./ipc";

/**
 * 系统通知：点击才打开对应会话。
 *
 * 之前用「show 时登记 pending + 窗口任意回焦消费」实现直达，导致用户只是
 * 切回应用（没有点通知）也会被带到另一个正在等审批/回答的会话——正是
 * “我在 A 会话，B 会话要审批就自己跳过去”的来源。Electron Notification
 * 本身有 click 事件，改为主进程收到 click 后只通知主窗口，前端只响应这次点击。
 */
export function notifyShow(args: { title: string; body: string; session?: string | null }): null {
  try {
    if (!Notification.isSupported()) throw new Error("notification unsupported");
    const session =
      typeof args.session === "string" && args.session ? args.session : null;
    const n = new Notification({ title: String(args.title ?? ""), body: String(args.body ?? "") });
    if (session) {
      n.on("click", () => {
        focusMainWindow();
        // 只发主窗口：辅助窗口（悬浮宠物、独立浏览器窗）不应被带着切会话
        emitToWindow("main", "notify:open-session", session);
      });
    }
    n.show();
  } catch (e) {
    // macOS 首次弹授权框（与 JS 路径同语义）；失败不登记任何待跳转状态
    const err = e as Error;
    throw new Error(err.message);
  }
  return null;
}

/** 兼容旧渲染层的命令：新的直达路径改为 click 事件广播，这里恒返回空。 */
export function notifyConsumePendingSession(): string | null {
  return null;
}

export function setupNotifyCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("notify_show", (a) => notifyShow(a));
  register("notify_consume_pending_session", () => notifyConsumePendingSession());
}
