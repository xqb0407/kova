/**
 * 内置浏览器 JavaScript Dialog（alert/confirm）的来源标识（对齐 X
 * embeddedBrowserJavaScriptDialog）：
 * - guest preload 在调用原生 API 之前同步问主进程；
 * - 用户手动浏览时用系统 MessageBox 展示「<host> says」，避免网页内容冒充
 *   应用提示；confirm 返回布尔值，alert 返回 undefined；
 * - agent 自动化期间（beginBrowserAutomation 的深度/grace）返回 handled:false，
 *   回落到 Chromium 原生 Dialog，交给 CDP 的 getDialog/handleDialog 处理；
 * - prompt/beforeunload/HTTP 认证不在此接管（保持原生语义）。
 *
 * 只接受已绑定 guest 的请求；senderFrame URL 由 Electron 提供，不信任网页
 * 传入的 origin/标题。
 */
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type WebContents,
} from "electron";
import { isBrowserAutomationActive } from "./browser-automation";
import {
  parseBrowserDialogRequest,
  resolveBrowserDialogButtons,
  resolveBrowserDialogSource,
  type BrowserDialogRequest,
} from "./browser-dialog-source";
import { logDebug, logWarn } from "./logging";

const CHANNEL = "kova:browser-dialog";
const LOG_TAG = "[browser-dialog]";

interface DialogResponse {
  handled: boolean;
  value?: boolean;
}

const guests = new Set<number>();
const openDialogs = new Set<number>();
let installed = false;

export function bindBrowserDialogGuest(wc: WebContents): void {
  guests.add(wc.id);
  wc.once("destroyed", () => {
    guests.delete(wc.id);
    openDialogs.delete(wc.id);
  });
}

export function unbindBrowserDialogGuest(wc: WebContents): void {
  guests.delete(wc.id);
  openDialogs.delete(wc.id);
}

function handleDialogRequest(event: IpcMainEvent, payload: unknown): DialogResponse {
  const sender = event.sender;
  if (!guests.has(sender.id)) return { handled: false };
  const request: BrowserDialogRequest | null = parseBrowserDialogRequest(payload);
  if (!request) return { handled: false };
  logDebug(
    `${LOG_TAG} request type=${request.type} automation=${isBrowserAutomationActive()} guestBound=${guests.has(sender.id)}`,
  );
  // 同一个 guest 已有系统框在展示：交给原生（避免重入叠加）。
  if (openDialogs.has(sender.id)) return { handled: false };
  // agent 动作期间放回原生 Dialog，让 CDP 观察/处理。
  if (isBrowserAutomationActive()) return { handled: false };

  const host = sender.hostWebContents ?? null;
  const parent = (host ? BrowserWindow.fromWebContents(host) : null) ?? undefined;
  if (parent?.isDestroyed()) return { handled: false };

  const frameUrl = event.senderFrame?.url;
  const guestUrl = (() => {
    try {
      return sender.getURL();
    } catch {
      return "";
    }
  })();
  const source = resolveBrowserDialogSource(frameUrl, guestUrl);
  const buttons = resolveBrowserDialogButtons(app.getLocale(), request.type);
  const options = {
    type: request.type === "alert" ? ("info" as const) : ("question" as const),
    buttons: buttons.buttons,
    defaultId: buttons.defaultId,
    cancelId: buttons.cancelId,
    message: source,
    detail: request.message,
    noLink: true,
    normalizeAccessKeys: true,
  };

  openDialogs.add(sender.id);
  try {
    const selected = parent
      ? dialog.showMessageBoxSync(parent, options)
      : dialog.showMessageBoxSync(options);
    return {
      handled: true,
      ...(request.type === "confirm" ? { value: selected === 1 } : {}),
    };
  } catch (err) {
    // 系统框创建失败时不能伪造用户选择：通知 preload 调回网页原生 API。
    logWarn(`${LOG_TAG} failed to show dialog: ${String(err)}`);
    return { handled: false };
  } finally {
    openDialogs.delete(sender.id);
  }
}

export function installBrowserDialogHandler(): void {
  if (installed) return;
  installed = true;
  ipcMain.on(CHANNEL, (event, payload) => {
    let response: DialogResponse;
    try {
      response = handleDialogRequest(event, payload);
    } catch (err) {
      logWarn(`${LOG_TAG} handler failed: ${String(err)}`);
      response = { handled: false };
    }
    // sendSync 必须回填 returnValue，否则 guest 渲染线程会一直等。
    event.returnValue = response;
  });
}
