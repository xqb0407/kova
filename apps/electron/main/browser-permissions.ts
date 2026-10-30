/**
 * 内置浏览器会话治理的装配层：
 * - 对 persist:browser-panel 应用权限策略（策略本体在 browser-permission-policy.ts）；
 * - 权限询问 broker：主进程按队列一次只发一个请求给渲染端，20s 未答复按拒绝；
 * - 站点同意记录初始化与清除（browser_clear_data 复用）。
 *
 * 不 import browser.ts，避免与工具执行层形成环；自动化标记由 browser-automation 提供。
 */
import { session } from "electron";
import { join } from "node:path";
import { appDataDir } from "./paths";
import { emitToWindow } from "./ipc";
import { logInfo, logWarn } from "./logging";
import { applyBrowserPermissionPolicy, type BrowserPermissionAction, type BrowserPermissionSessionLike } from "./browser-permission-policy";
import {
  clearBrowserSitePermissions,
  createBrowserSitePermissionStore,
  getBrowserSitePermission,
  getBrowserSitePermissionSnapshot,
  initBrowserSitePermissions,
  writeBrowserSitePermission,
} from "./browser-site-permissions";
import { isBrowserAutomationActive } from "./browser-automation";

/** 面板 <webview> 的持久化分区（渲染端 partition 属性同值）。 */
export const BROWSER_PARTITION = "persist:browser-panel";

const PROMPT_TIMEOUT_MS = 20_000;

interface PendingPrompt {
  id: string;
  origin: string;
  permission: string;
  mediaTypes?: readonly string[];
  resolve: (action: BrowserPermissionAction) => void;
  timer: NodeJS.Timeout | null;
}

const queue: PendingPrompt[] = [];
let active: PendingPrompt | null = null;
let promptSeq = 0;
let installed = false;

function normalizeAction(value: unknown): BrowserPermissionAction {
  return value === "allow-always" ||
    value === "allow-session" ||
    value === "block-always" ||
    value === "dismiss"
    ? value
    : "dismiss";
}

function settle(id: string, action: BrowserPermissionAction): void {
  if (!active || active.id !== id) return;
  const done = active;
  active = null;
  if (done.timer) clearTimeout(done.timer);
  done.resolve(action);
  pump();
}

function pump(): void {
  if (active || queue.length === 0) return;
  const next = queue.shift();
  if (!next) return;
  active = next;
  next.timer = setTimeout(() => settle(next.id, "dismiss"), PROMPT_TIMEOUT_MS);
  emitToWindow("main", "browser:permission-request", {
    id: next.id,
    origin: next.origin,
    permission: next.permission,
    ...(next.mediaTypes && next.mediaTypes.length > 0
      ? { mediaTypes: next.mediaTypes }
      : {}),
  });
}

/** 权限策略的 prompt 注入：请求入队，等待渲染端气泡答复或 20s 超时。 */
export function requestBrowserPermissionPrompt(input: {
  origin: string;
  permission: string;
  mediaTypes?: readonly string[];
}): Promise<BrowserPermissionAction> {
  return new Promise((resolve) => {
    queue.push({
      id: `perm-${++promptSeq}`,
      origin: input.origin,
      permission: input.permission,
      mediaTypes: input.mediaTypes,
      resolve,
      timer: null,
    });
    pump();
  });
}

/** 渲染端气泡答复（browser_permission_resolve 命令）。 */
export function resolveBrowserPermissionPrompt(args: {
  id?: unknown;
  action?: unknown;
}): null {
  const id = typeof args?.id === "string" ? args.id : "";
  if (!id) return null;
  settle(id, normalizeAction(args?.action));
  return null;
}

/** 启动装配：必须早于任何 webview 导航（index.ts 的 app.whenReady 内调用）。 */
export function installBrowserSessionGuards(): void {
  if (installed) return;
  installed = true;
  const target = session.fromPartition(BROWSER_PARTITION);

  // 先挂 handler（同步），再异步加载站点记录：加载窗口内退化为「每次询问」，
  // 不会误放行已记录的 allow。
  // Electron 的 Session 方法签名比策略层声明的窄（DisplayMedia 的 Streams 等），
  // 策略层只用到共同面，这里按结构断言接入。
  applyBrowserPermissionPolicy(target as unknown as BrowserPermissionSessionLike, {
    logger: { info: logInfo, warn: logWarn },
    prompt: requestBrowserPermissionPrompt,
    getSitePermission: getBrowserSitePermission,
    writeSitePermission: (origin, permission, state) => {
      void writeBrowserSitePermission(origin, permission, state);
    },
    isAutomationActive: isBrowserAutomationActive,
  });

  void initBrowserSitePermissions({
    store: createBrowserSitePermissionStore(join(appDataDir(), "browser-site-permissions.json")),
    logger: { warn: logWarn },
  })
    .then(() => logInfo("[browser] permission policy installed"))
    .catch((err) => logWarn(`[browser] permission store init failed: ${String(err)}`));
}

/** 站点权限快照（设置页/诊断用）。 */
export function browserSitePermissions(): unknown {
  return { record: getBrowserSitePermissionSnapshot() };
}

/** 清空站点权限（browser_clear_data 联动）。 */
export async function clearBrowserPermissions(): Promise<null> {
  await clearBrowserSitePermissions();
  return null;
}
