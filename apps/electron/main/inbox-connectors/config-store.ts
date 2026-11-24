/**
 * 连接器配置存储：state.db 的 kv 表。
 *
 * - 配置（含 tokenCipher）写 `inbox.connectors.v1`；
 * - 展示状态（上次同步/错误/账号名）写 `inbox.connectors.status.v1`，
 *   重启后设置页首屏不会空白；
 * - Token 用 secret.ts 的 AES-256-GCM 加密，公开快照只给 hasToken/末四位。
 */
import {
  INBOX_CONNECTOR_PROVIDERS,
  type InboxConnectorConfig,
  type InboxConnectorProvider,
  type InboxConnectorSaveInput,
  type InboxConnectorSnapshot,
  type InboxConnectorStatus,
} from "pi-protocol";
import { decrypt, encrypt } from "../secret";
import { kvGet, kvSet } from "../store";
import { ConnectorError } from "./errors";
import { normalizeBaseUrl, PROVIDER_LABELS } from "./normalize";
import type { StoredConnector } from "./types";

export const CONNECTORS_KV_KEY = "inbox.connectors.v1";
export const STATUS_KV_KEY = "inbox.connectors.status.v1";
const MIN_POLL_SEC = 30;
const MAX_POLL_SEC = 900;
const DEFAULT_POLL_SEC = 120;

function isProvider(value: unknown): value is InboxConnectorProvider {
  return (
    typeof value === "string" &&
    (INBOX_CONNECTOR_PROVIDERS as readonly string[]).includes(value)
  );
}

function clampPoll(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_POLL_SEC;
  return Math.min(MAX_POLL_SEC, Math.max(MIN_POLL_SEC, Math.trunc(n)));
}

function tokenHintOf(token: string): string {
  return token.length <= 4 ? "****" : `****${token.slice(-4)}`;
}

function sanitizeEvents(
  input: InboxConnectorSaveInput["events"],
): StoredConnector["events"] {
  if (!input || typeof input !== "object") return undefined;
  const out: NonNullable<StoredConnector["events"]> = {};
  for (const key of [
    "assigned",
    "reviewRequested",
    "mention",
    "unmergeable",
    "buildFailed",
  ] as const) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeStored(value: unknown): StoredConnector | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (!isProvider(raw.provider)) return null;
  return {
    id: raw.id,
    provider: raw.provider,
    enabled: raw.enabled !== false,
    ...(typeof raw.baseUrl === "string" && raw.baseUrl
      ? { baseUrl: raw.baseUrl }
      : {}),
    ...(typeof raw.account === "string" && raw.account
      ? { account: raw.account }
      : {}),
    ...(raw.authMode === "cloud" || raw.authMode === "server"
      ? { authMode: raw.authMode }
      : {}),
    ...(raw.events && typeof raw.events === "object"
      ? { events: raw.events as StoredConnector["events"] }
      : {}),
    ...(typeof raw.jql === "string" && raw.jql ? { jql: raw.jql } : {}),
    pollIntervalSec: clampPoll(raw.pollIntervalSec),
    desktopNotifications: raw.desktopNotifications !== false,
    ...(typeof raw.tokenCipher === "string" && raw.tokenCipher
      ? { tokenCipher: raw.tokenCipher }
      : {}),
    ...(typeof raw.tokenHint === "string" && raw.tokenHint
      ? { tokenHint: raw.tokenHint }
      : {}),
    ...(typeof raw.createdAt === "string" ? { createdAt: raw.createdAt } : {}),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function loadStoredConnectors(): StoredConnector[] {
  try {
    const raw = kvGet(CONNECTORS_KV_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: StoredConnector[] = [];
    for (const entry of parsed) {
      const normalized = normalizeStored(entry);
      if (normalized) out.push(normalized);
    }
    return out;
  } catch {
    return [];
  }
}

function persist(list: StoredConnector[]): void {
  kvSet(CONNECTORS_KV_KEY, JSON.stringify(list));
}

export function publicConfig(config: StoredConnector): InboxConnectorConfig {
  return {
    id: config.id,
    provider: config.provider,
    enabled: config.enabled,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.account ? { account: config.account } : {}),
    ...(config.authMode ? { authMode: config.authMode } : {}),
    ...(config.events ? { events: config.events } : {}),
    ...(config.jql ? { jql: config.jql } : {}),
    pollIntervalSec: config.pollIntervalSec ?? DEFAULT_POLL_SEC,
    desktopNotifications: config.desktopNotifications !== false,
    hasToken: Boolean(config.tokenCipher),
    ...(config.tokenHint ? { tokenHint: config.tokenHint } : {}),
    ...(config.createdAt ? { createdAt: config.createdAt } : {}),
    ...(config.updatedAt ? { updatedAt: config.updatedAt } : {}),
  };
}

export function tokenOf(config: StoredConnector): string | null {
  if (!config.tokenCipher) return null;
  const result = decrypt(config.tokenCipher);
  return result.ok && result.value ? result.value : null;
}

export function upsertConnector(input: InboxConnectorSaveInput): StoredConnector {
  if (!isProvider(input.provider)) {
    throw new ConnectorError("config", "不支持的收件箱来源");
  }
  const list = loadStoredConnectors();
  const id = (input.id ?? input.provider).trim();
  if (!id) throw new ConnectorError("config", "连接器 id 不能为空");
  const index = list.findIndex((entry) => entry.id === id);
  const prev = index >= 0 ? list[index] : undefined;
  if (!prev) {
    const duplicate = list.find((entry) => entry.provider === input.provider);
    if (duplicate) {
      throw new ConnectorError(
        "config",
        "该平台已经有连接器了；当前版本每个平台只支持一个账号",
      );
    }
  }
  if (prev && prev.provider !== input.provider) {
    throw new ConnectorError("config", "不能修改连接器的平台类型");
  }

  const token = (input.token ?? "").trim();
  if (!prev?.tokenCipher && !token) {
    throw new ConnectorError("config", "请填写 Token");
  }

  // 保存前做最小校验：让「填错站点/漏邮箱」在保存时就报出来，而不是等首轮
  // 轮询失败后卡片才红。地址仍会由 adapter 在每次请求前做最终归一。
  const baseUrl = input.baseUrl?.trim() ?? "";
  if (input.provider === "jira" && !baseUrl) {
    throw new ConnectorError("config", "Jira：请填写站点地址");
  }
  if (baseUrl && input.provider !== "linear") {
    normalizeBaseUrl(baseUrl, "", PROVIDER_LABELS[input.provider]);
  }
  if (input.provider === "jira") {
    const mode =
      input.authMode ??
      (/\.atlassian\.net$/i.test(baseUrl) ? "cloud" : "server");
    if (mode === "cloud" && !input.account?.trim()) {
      throw new ConnectorError("config", "Jira Cloud：请填写登录邮箱");
    }
  }
  let tokenCipher = prev?.tokenCipher;
  let tokenHint = prev?.tokenHint;
  if (token) {
    try {
      tokenCipher = encrypt(token);
      tokenHint = tokenHintOf(token);
    } catch {
      throw new ConnectorError(
        "config",
        "凭证加密不可用，请重启应用后再保存",
      );
    }
  }

  const now = new Date().toISOString();
  const next: StoredConnector = {
    id,
    provider: input.provider,
    enabled: input.enabled !== false,
    ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
    ...(input.account?.trim() ? { account: input.account.trim() } : {}),
    ...(input.authMode === "cloud" || input.authMode === "server"
      ? { authMode: input.authMode }
      : {}),
    ...(sanitizeEvents(input.events)
      ? { events: sanitizeEvents(input.events) }
      : {}),
    ...(input.jql?.trim() ? { jql: input.jql.trim() } : {}),
    pollIntervalSec: clampPoll(input.pollIntervalSec),
    desktopNotifications: input.desktopNotifications !== false,
    ...(tokenCipher ? { tokenCipher } : {}),
    ...(tokenHint ? { tokenHint } : {}),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  if (index >= 0) list[index] = next;
  else list.push(next);
  persist(list);
  return next;
}

export function deleteConnector(id: string): boolean {
  const list = loadStoredConnectors();
  const next = list.filter((entry) => entry.id !== id);
  if (next.length === list.length) return false;
  persist(next);
  return true;
}

export function setConnectorAccount(id: string, accountName: string): void {
  const list = loadStoredConnectors();
  const entry = list.find((item) => item.id === id);
  if (!entry || !accountName || entry.account === accountName) return;
  entry.account = accountName;
  entry.updatedAt = new Date().toISOString();
  persist(list);
}

export function loadStoredStatuses(): Record<string, InboxConnectorStatus> {
  try {
    const raw = kvGet(STATUS_KV_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, InboxConnectorStatus> = {};
    for (const [id, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      const state = row.state;
      if (
        state !== "disabled" &&
        state !== "idle" &&
        state !== "syncing" &&
        state !== "ok" &&
        state !== "error" &&
        state !== "needs_auth"
      ) {
        continue;
      }
      out[id] = {
        id,
        state,
        ...(typeof row.lastSyncAt === "string"
          ? { lastSyncAt: row.lastSyncAt }
          : {}),
        ...(typeof row.lastError === "string"
          ? { lastError: row.lastError }
          : {}),
        ...(typeof row.itemCount === "number"
          ? { itemCount: row.itemCount }
          : {}),
        ...(typeof row.accountName === "string"
          ? { accountName: row.accountName }
          : {}),
        ...(typeof row.nextSyncAt === "string"
          ? { nextSyncAt: row.nextSyncAt }
          : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function persistStoredStatuses(
  statuses: Record<string, InboxConnectorStatus>,
): void {
  try {
    kvSet(STATUS_KV_KEY, JSON.stringify(statuses));
  } catch {
    // 状态是旁路：写失败只影响设置页展示，不能打断同步
  }
}

export function buildSnapshot(
  connectors: StoredConnector[],
  statuses: Record<string, InboxConnectorStatus>,
): InboxConnectorSnapshot {
  return {
    connectors: connectors.map(publicConfig),
    statuses: connectors.map(
      (config) => statuses[config.id] ?? { id: config.id, state: "idle" },
    ),
  } as InboxConnectorSnapshot;
}
