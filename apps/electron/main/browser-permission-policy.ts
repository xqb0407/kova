/**
 * 内置浏览器 partition 的权限闸门（对齐 ZCode embeddedBrowserPermissionPolicy
 * 的最小版）。Electron 未注册 permission handler 的 session 会自动批准所有权限
 * 请求——恶意页面可静默拿到摄像头/麦克风/剪贴板/地理位置。
 *
 * 本模块对目标 session 注册默认拒绝的 request/check/device/displayMedia handler：
 * - 无害白名单静默放行（写剪贴板、全屏、指针锁、DRM）；
 * - 敏感权限经产品级弹窗由用户决策；弹窗缺席或自动化期间一律拒绝；
 * - 设备类权限放行到 select-* chooser，但 chooser 未接入时显式取消，
 *   阻断 Electron「未监听 select-* 即静默授权第一个设备」的默认行为；
 * - 未识别权限 fail-closed，防 Electron 后续版本新增枚举绕过白名单。
 *
 * 依赖全部注入，bun test 用 fake session 直接驱动（不 import electron）。
 */

export const BROWSER_SILENT_ALLOW_PERMISSIONS: ReadonlySet<string> = new Set([
  // 写剪贴板对应网页「复制」按钮、fullscreen/pointerLock 对应视频全屏与交互、
  // mediaKeySystem 对应 DRM 视频播放：拒绝会造成大面积功能性故障，且不泄露用户数据。
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "mediaKeySystem",
]);

export const BROWSER_PROMPT_PERMISSIONS: ReadonlySet<string> = new Set([
  "media",
  "clipboard-read",
  "geolocation",
  "notifications",
  "midi",
  "midiSysex",
  "idle-detection",
  "speaker-selection",
  "window-management",
  "storage-access",
  "top-level-storage-access",
  "keyboardLock",
  "fileSystem",
]);

/** check handler 枚举里的设备类权限：放行到 select-* chooser（chooser 才是授权闸门）。 */
const DEVICE_CHECK_PERMISSIONS: ReadonlySet<string> = new Set(["usb", "hid", "serial"]);

export type BrowserPermissionAction =
  | "allow-always"
  | "allow-session"
  | "block-always"
  | "dismiss";

export interface BrowserPermissionPromptRequest {
  origin: string;
  permission: string;
  mediaTypes?: readonly string[];
}

export interface BrowserPermissionLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface BrowserPermissionRequestDetails {
  requestingUrl?: string;
  mediaTypes?: string[];
}

export type BrowserPermissionGrantCallback = (granted: boolean) => void;

/** 只声明用到的 Electron Session 面，避免 import electron（测试可直接构造 fake）。 */
export interface BrowserPermissionSessionLike {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: BrowserPermissionGrantCallback,
      details: BrowserPermissionRequestDetails,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
      details?: unknown,
    ) => boolean,
  ): void;
  setDevicePermissionHandler(handler: (details: unknown) => boolean): void;
  setDisplayMediaRequestHandler(
    handler: (request: unknown, callback: (streams: unknown) => void) => void,
  ): void;
  on(
    event: "select-hid-device" | "select-usb-device" | "select-serial-port",
    listener: (...args: unknown[]) => void,
  ): void;
}

export interface ApplyBrowserPermissionPolicyOptions {
  logger: BrowserPermissionLogger;
  /** 缺省时敏感权限一律拒绝（安全闭环先行）。 */
  prompt?: (request: BrowserPermissionPromptRequest) => Promise<BrowserPermissionAction>;
  getSitePermission: (origin: string, permission: string) => "allow" | "deny" | undefined;
  writeSitePermission: (origin: string, permission: string, state: "allow" | "deny") => void;
  /** agent 动作期间为真：权限请求立即拒绝，不让页面卡 20 秒。 */
  isAutomationActive?: () => boolean;
}

const LOG_TAG = "[browser-permission]";
const UNKNOWN_ORIGIN = "unknown";

export function originFromUrl(url: string | undefined): string {
  try {
    return new URL(url ?? "").origin;
  } catch {
    return UNKNOWN_ORIGIN;
  }
}

export function applyBrowserPermissionPolicy(
  target: BrowserPermissionSessionLike,
  options: ApplyBrowserPermissionPolicyOptions,
): void {
  const { logger } = options;
  const sessionAllow = new Map<string, Set<string>>();
  const inflight = new Map<string, Promise<BrowserPermissionAction>>();

  const logDecision = (
    decision: "granted" | "denied",
    meta: Record<string, unknown>,
    warn = false,
  ): void => {
    const message = `${LOG_TAG} decision=${decision}`;
    if (warn) logger.warn(message, meta);
    else logger.info(message, meta);
  };

  target.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const origin = originFromUrl(details?.requestingUrl);
    const mediaTypes = details?.mediaTypes;

    if (BROWSER_SILENT_ALLOW_PERMISSIONS.has(permission)) {
      logDecision("granted", { permission, origin, source: "allowlist" });
      callback(true);
      return;
    }

    if (BROWSER_PROMPT_PERMISSIONS.has(permission)) {
      const persisted = options.getSitePermission(origin, permission);
      if (persisted === "allow" || persisted === "deny") {
        logDecision(persisted === "allow" ? "granted" : "denied", {
          permission,
          origin,
          source: "site-setting",
        });
        callback(persisted === "allow");
        return;
      }
      if (sessionAllow.get(origin)?.has(permission)) {
        logDecision("granted", { permission, origin, source: "session-allow" });
        callback(true);
        return;
      }
      if (options.isAutomationActive?.()) {
        logDecision("denied", { permission, origin, source: "automation" });
        callback(false);
        return;
      }
      if (!options.prompt) {
        logDecision("denied", { permission, origin, source: "default-deny" });
        callback(false);
        return;
      }

      // 同 origin+权限并发请求共享一个弹窗。
      const key = `${origin}|${permission}`;
      let flight = inflight.get(key);
      if (!flight) {
        flight = options
          .prompt({
            origin,
            permission,
            ...(mediaTypes && mediaTypes.length > 0 ? { mediaTypes } : {}),
          })
          .finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, flight);
      }
      void flight.then(
        (action) => {
          const granted = action === "allow-always" || action === "allow-session";
          logDecision(granted ? "granted" : "denied", {
            permission,
            origin,
            source: "user-prompt",
            action,
          });
          if (action === "allow-always") {
            options.writeSitePermission(origin, permission, "allow");
          } else if (action === "allow-session") {
            const grantedSet = sessionAllow.get(origin) ?? new Set<string>();
            grantedSet.add(permission);
            sessionAllow.set(origin, grantedSet);
          } else if (action === "block-always") {
            options.writeSitePermission(origin, permission, "deny");
          }
          callback(granted);
        },
        (error: unknown) => {
          logger.warn(`${LOG_TAG} permission prompt failed: ${String(error)}`);
          callback(false);
        },
      );
      return;
    }

    logDecision("denied", { permission, origin, source: "default-deny" }, true);
    callback(false);
  });

  target.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (BROWSER_SILENT_ALLOW_PERMISSIONS.has(permission)) return true;
    // 设备类 check 返回 false 会让 requestDevice 在 check 层被拦死、chooser 根本不触发；
    // 真正的授权闸门是下方 select-* 监听（未选择即取消）。
    if (DEVICE_CHECK_PERMISSIONS.has(permission)) return true;
    if (!BROWSER_PROMPT_PERMISSIONS.has(permission)) return false;
    const origin = originFromUrl(requestingOrigin);
    if (options.getSitePermission(origin, permission) === "allow") return true;
    return sessionAllow.get(origin)?.has(permission) === true;
  });

  // 恒 true 只表示「放行到 chooser」，不构成授权（见上）。
  target.setDevicePermissionHandler(() => true);

  target.setDisplayMediaRequestHandler((_request, callback) => {
    logDecision("denied", { permission: "display-capture", source: "default-deny" });
    callback({});
  });

  // Electron 未监听 select-* 时会静默授权第一个匹配设备；注册监听即阻断该路径。
  const cancelArgFor = (permission: string): string | undefined =>
    permission === "select-hid-device" || permission === "select-usb-device" ? undefined : "";

  const cancelDeviceSelection =
    (permission: string) =>
    (...args: unknown[]): void => {
      // 必须阻止默认行为，否则 Chromium 在事件 fire 后立即自行取消，异步选择无法生效。
      const event = args[0] as { preventDefault?: () => void } | undefined;
      event?.preventDefault?.();
      const callback = args[args.length - 1] as ((value?: string) => void) | undefined;
      logDecision("denied", { permission, source: "device-picker" });
      callback?.(cancelArgFor(permission));
    };

  target.on("select-hid-device", cancelDeviceSelection("select-hid-device"));
  target.on("select-usb-device", cancelDeviceSelection("select-usb-device"));
  target.on("select-serial-port", cancelDeviceSelection("select-serial-port"));
}
