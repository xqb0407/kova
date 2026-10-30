/**
 * 内置浏览器的 URL 白名单：http(s) 全放行；file: 只放行受信根内的真实文件
 * （复用 fs-cmds 的 isTrustedFilePath，与 kova://file 预览同一套根：当前
 * workspace / task-workspace / 资料库根 / 项目虚拟目录根）。
 *
 * 为什么要卡 file:：agent 的 browser_navigate / browser_shot 能读页面文本，
 * 若不限制就等于给了一个绕过 read 工具沙箱的本地文件读取通道。
 */
import { isTrustedFilePath } from "./fs-cmds";

/** file:// URL → 绝对路径（Windows 盘符路径去掉前导斜杠）；非 file: 返回 null。 */
export function filePathFromUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "file:") return null;
    let p = decodeURIComponent(u.pathname);
    if (process.platform === "win32") p = p.replace(/^\/+/, "");
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

export function isTrustedFileUrl(raw: string): boolean {
  const p = filePathFromUrl(raw);
  return p !== null && isTrustedFilePath(p);
}

/** webview 初始 src / 导航 / 截图 URL 共用白名单。about:blank 仅用于空标签。 */
export function isAllowedBrowserUrl(raw: string): boolean {
  const t = (raw ?? "").trim();
  if (!t) return false;
  if (t === "about:blank") return true;
  try {
    const u = new URL(t);
    if (u.protocol === "http:" || u.protocol === "https:") return true;
    if (u.protocol === "file:") return isTrustedFileUrl(t);
    return false;
  } catch {
    return false;
  }
}

/** 校验并规整导航 URL；错误串保持既有工具口径（模型按字面理解）。 */
export function parseBrowserUrl(raw: string): string {
  const t = (raw ?? "").trim();
  if (!t) throw new Error("url is required");
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new Error(`invalid url: ${t}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "file:") {
    throw new Error(`only http/https/file urls are supported: ${t}`);
  }
  if (u.protocol === "file:" && !isTrustedFileUrl(u.toString())) {
    throw new Error(
      `file urls are limited to trusted workspace roots: ${t}. ` +
        "Copy the file into the workspace (or ask the user to) and retry.",
    );
  }
  return u.toString();
}
