/**
 * 浏览器 alert/confirm 的纯逻辑（来源标签、按钮文案、请求校验）：
 * 从 browser-dialog.ts 拆出来，避免 bun test import electron。
 */

export type BrowserDialogRequestType = "alert" | "confirm";

export interface BrowserDialogRequest {
  type: BrowserDialogRequestType;
  message: string;
}

export function parseBrowserDialogRequest(value: unknown): BrowserDialogRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<BrowserDialogRequest>;
  if (candidate.type !== "alert" && candidate.type !== "confirm") return null;
  if (typeof candidate.message !== "string") return null;
  return { type: candidate.type, message: candidate.message.slice(0, 10_000) };
}

/** 来源标签：只认 Chromium 提供的 frame URL / guest URL 里的 host。 */
export function resolveBrowserDialogSource(frameUrl?: string, guestUrl?: string): string {
  for (const candidate of [frameUrl, guestUrl]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.host.length > 0
      ) {
        return `${parsed.host} says`;
      }
      if (parsed.protocol === "blob:") {
        const origin = new URL(parsed.origin);
        if (
          (origin.protocol === "http:" || origin.protocol === "https:") &&
          origin.host.length > 0
        ) {
          return `${origin.host} says`;
        }
      }
    } catch {
      /* 继续尝试下一层可信 URL */
    }
  }
  return "This page says";
}

export function resolveBrowserDialogButtons(
  locale: string,
  type: BrowserDialogRequestType,
): { buttons: string[]; defaultId: number; cancelId: number } {
  const zh = locale.toLowerCase().startsWith("zh");
  if (type === "alert") {
    return { buttons: [zh ? "确定" : "OK"], defaultId: 0, cancelId: 0 };
  }
  return { buttons: zh ? ["取消", "确定"] : ["Cancel", "OK"], defaultId: 1, cancelId: 0 };
}
