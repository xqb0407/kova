/**
 * 外部来源的系统通知：只对「新出现且需要动作」的事项弹一次。
 *
 * - 主窗口已聚焦时不弹（用户已经在看，收件箱徽标足够）；
 * - 点击聚焦窗口并让渲染层切到收件箱；
 * - 失败静默：通知是旁路，不能影响同步本身。
 */
import { BrowserWindow, Notification } from "electron";
import { emitToWindows, focusMainWindow } from "../ipc";
import { CONNECTOR_ADAPTERS } from "./providers";
import type { ExternalNotification, StoredConnector } from "./types";

const PULL_REQUEST_TYPES = new Set(["pull_request", "merge_request"]);
const ISSUE_TYPES = new Set(["issue", "ticket"]);

function mutedNow(config: StoredConnector): boolean {
  if (!config.mutedUntil) return false;
  const until = Date.parse(config.mutedUntil);
  return Number.isFinite(until) && until > Date.now();
}

function sourceMuted(config: StoredConnector, item: ExternalNotification): boolean {
  if (!config.mutedSources?.length || !item.sourceName) return false;
  const source = item.sourceName.trim().toLowerCase();
  return config.mutedSources.some(
    (entry) => entry.trim().toLowerCase() === source,
  );
}

function categoryEnabled(
  config: StoredConnector,
  item: ExternalNotification,
): boolean {
  const type = (item.type ?? "").toLowerCase();
  if (PULL_REQUEST_TYPES.has(type)) return config.notifyPullRequests !== false;
  if (ISSUE_TYPES.has(type)) return config.notifyIssues !== false;
  // discussion/release/commit 等暂不单独分类，跟随总开关
  return true;
}

/** 偏好过滤：总静音 → 按来源静音 → issue/PR 分类开关。 */
function allowed(config: StoredConnector, item: ExternalNotification): boolean {
  if (mutedNow(config)) return false;
  if (sourceMuted(config, item)) return false;
  return categoryEnabled(config, item);
}

/** sidecar externalKeys 只把 http(s) URL 当稳定键；非 http URL 回退标题 */
function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 与 sidecar `externalInboxItemId` 同口径：external:<provider>:<stableKey> */
function externalItemId(provider: string, item: ExternalNotification): string {
  const stableKey = (item.idKey || item.key || safeHttpUrl(item.url) || item.title).slice(0, 300);
  return `external:${provider}:${stableKey}`;
}

function bodyFor(items: ExternalNotification[]): string {
  const shown = items.slice(0, 3).map((item) => {
    const key = item.key ? `${item.key} ` : "";
    return `${key}${item.title}`.trim();
  });
  const more = items.length > shown.length ? ` 等 ${items.length} 项` : "";
  const body = `${shown.join("；")}${more}`;
  return body.length > 180 ? `${body.slice(0, 179)}…` : body;
}

export function notifyNewExternalItems(
  provider: keyof typeof CONNECTOR_ADAPTERS,
  items: ExternalNotification[],
  config: StoredConnector,
): void {
  const actionable = items.filter(
    (item) => item.requiresAction === true && allowed(config, item),
  );
  if (actionable.length === 0) return;
  try {
    if (BrowserWindow.getFocusedWindow()) return;
    if (!Notification.isSupported()) return;
    const label = CONNECTOR_ADAPTERS[provider]?.label ?? provider;
    const notification = new Notification({
      title: `${label} · ${actionable.length} 项需要处理`,
      body: bodyFor(actionable),
    });
    notification.on("click", () => {
      try {
        focusMainWindow();
        // 带上条目 id：渲染层切到收件箱后直接选中第一条，不用用户自己找
        emitToWindows("inbox:open", {
          provider,
          itemIds: actionable.map((item) => externalItemId(provider, item)),
        });
      } catch {
        /* 窗口已销毁：忽略 */
      }
    });
    notification.show();
  } catch {
    // 系统通知权限/平台不支持：静默降级
  }
}
