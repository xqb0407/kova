/**
 * 连接器共用的纯函数：URL/文本归一、事件开关、原因文案。
 * 不导入 Electron，provider fixture 测试可以直接用。
 */
import type {
  InboxConnectorEvents,
  InboxConnectorProvider,
} from "pi-protocol";
import { ConnectorError } from "./errors";
import type { StoredConnector } from "./types";

export const PROVIDER_LABELS: Record<InboxConnectorProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  linear: "Linear",
};

const DEFAULT_EVENTS: Record<
  InboxConnectorProvider,
  Required<InboxConnectorEvents>
> = {
  github: {
    assigned: true,
    reviewRequested: true,
    mention: true,
    unmergeable: false,
    buildFailed: false,
  },
  gitlab: {
    assigned: true,
    reviewRequested: true,
    mention: true,
    unmergeable: true,
    buildFailed: false,
  },
  jira: {
    assigned: true,
    reviewRequested: false,
    mention: false,
    unmergeable: false,
    buildFailed: false,
  },
  linear: {
    assigned: true,
    reviewRequested: false,
    mention: false,
    unmergeable: false,
    buildFailed: false,
  },
};

export function eventEnabled(
  config: StoredConnector,
  key: keyof InboxConnectorEvents,
): boolean {
  return config.events?.[key] ?? DEFAULT_EVENTS[config.provider][key];
}

const REASON_LABELS: Record<string, string> = {
  assigned: "指派给你",
  assign: "指派给你",
  review_requested: "请求你评审",
  mention: "提到了你",
  team_mention: "提到了你",
  directly_addressed: "提到了你",
  unmergeable: "合并冲突",
  build_failed: "流水线失败",
  approval_required: "需要你批准",
  marked: "有新标记",
  state_change: "状态变更",
  ci_activity: "CI 结果",
  subscribed: "有新动态",
  manual: "有新动态",
};

export function reasonLabel(reason: string | undefined): string {
  if (!reason) return "有新动态";
  return REASON_LABELS[reason] ?? "有新动态";
}

/** 合并成单行摘要；空段自动省略。 */
export function summaryLine(
  ...parts: Array<string | undefined | false>
): string | undefined {
  const value = parts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join(" · ");
  return value || undefined;
}

export function clampText(
  value: string | undefined,
  max: number,
): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 多行正文用：保留换行/缩进，只做长度上限（Markdown 不能压空白）。 */
export function clampMultiline(
  value: string | undefined,
  max: number,
): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\r\n/g, "\n").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

export function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** 把用户填的服务器地址归一成无尾斜杠的 http(s) URL；空值用官方默认。 */
export function normalizeBaseUrl(
  raw: string | undefined,
  fallback: string,
  label: string,
): string {
  const trimmed = (raw ?? "").trim();
  const candidate = trimmed || fallback;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
    ? candidate
    : `https://${candidate}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ConnectorError("config", `${label}：服务器地址不合法`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorError("config", `${label}：服务器地址只支持 http(s)`);
  }
  if (url.search || url.hash) {
    throw new ConnectorError("config", `${label}：服务器地址不要带查询参数或锚点`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function hostOf(value: string | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}
