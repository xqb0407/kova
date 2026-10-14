/** 桌面桥 · 平台：platform()（UA 判定）。 */
export type Platform = "macos" | "windows" | "linux" | "android" | "ios";

export async function platform(): Promise<Platform> {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Macintosh|Mac OS X/.test(ua)) return "macos";
  if (/Windows NT/.test(ua)) return "windows";
  if (/Android/.test(ua)) return "android";
  if (/iPhone|iPad/.test(ua)) return "ios";
  return "linux";
}
