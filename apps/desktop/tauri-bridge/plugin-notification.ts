/**
 * `@tauri-apps/plugin-notification` 兼容实现：Electron renderer 有原生
 * Notification API（权限与 Tauri 插件同语义：macOS 首次弹授权框）。
 */
export async function requestPermission(): Promise<"granted" | "denied" | "default"> {
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export interface NotificationOptions {
  title?: string;
  body?: string;
}

export function sendNotification(options: string | NotificationOptions): void {
  const o = typeof options === "string" ? { title: options } : options ?? {};
  try {
    new Notification(String(o.title ?? ""), { body: o.body ? String(o.body) : undefined });
  } catch {
    /* 权限未授予时静默（与插件行为一致） */
  }
}
