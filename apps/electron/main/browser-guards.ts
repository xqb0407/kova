/**
 * webview 硬化（对齐 ZCode desktopWindowChrome 的 will-attach-webview 分支的最小版）：
 * - 只允许浏览器面板的固定 partition，别的 webview 一律拒绝（插件面板走 iframe，
 *   不依赖 webview）；
 * - 初始 src 走 URL 白名单（http/https/file 受信根/about:blank）；
 * - 强制 contextIsolation / sandbox / 无 node；删除渲染端可注入的 preload、
 *   nodeintegration、disablewebsecurity 等危险参数。
 *
 * 权限 handler 在 browser-permissions.ts 的 installBrowserSessionGuards 里装。
 */
import type { BrowserWindow } from "electron";
import { join } from "node:path";
import { logWarn } from "./logging";
import { emitToWindow } from "./ipc";
import { BROWSER_PARTITION } from "./browser-permissions";
import { isAllowedBrowserUrl } from "./browser-urls";

const LOG_TAG = "[browser-guard]";

export function installWebviewGuards(win: BrowserWindow): void {
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const raw = params as unknown as Record<string, unknown>;
    const partition = typeof raw.partition === "string" ? raw.partition : "";
    if (partition !== BROWSER_PARTITION) {
      event.preventDefault();
      logWarn(`${LOG_TAG} blocked webview with partition=${JSON.stringify(partition)}`);
      return;
    }

    const src = typeof raw.src === "string" && raw.src.length > 0 ? raw.src : "about:blank";
    if (!isAllowedBrowserUrl(src)) {
      event.preventDefault();
      logWarn(`${LOG_TAG} blocked unsupported webview url: ${src}`);
      // 静默拦截在 UI 上就是一块白屏：给用户一条可见解释（agent 侧已有
      // parseBrowserUrl 的明确报错，这里兜住地址栏手输 file:// 的路径）。
      emitToWindow("main", "browser:attach-blocked", {
        url: src,
        reason: "unsupported-url",
      });
      return;
    }

    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.sandbox = true;
    // 固定的隔离 preload：只提供 alert/confirm 的同步来源标识桥，不暴露 Node/IPC。
    webPreferences.preload = join(__dirname, "browser-guest.cjs");

    // 渲染端可经 <webview> 属性注入这些参数；宿主统一覆盖/删除，防被页面或
    // 未来插件代码改写。allowpopups 由宿主打开，popup 在 setWindowOpenHandler
    // 里统一收口（单 webview 阶段原地导航）。
    delete raw.preload;
    delete raw.nodeintegration;
    delete raw.disablewebsecurity;
    raw.nodeintegrationinsubframes = "true";
    raw.allowpopups = "true";
  });
}

/** 供 browser.ts 的 guest 绑定/导航复用：同一个白名单。 */
export function assertAllowedBrowserUrl(url: string): void {
  if (!isAllowedBrowserUrl(url)) {
    throw new Error(`blocked unsupported url: ${url}`);
  }
}
