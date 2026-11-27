"use client";

/**
 * 设置页「收件箱来源」的前端镜像 store。
 * 事实源在主进程（配置 + 加密 Token + 轮询状态）；这里只做 invoke 封装、
 * 事件订阅与 useSyncExternalStore 快照。
 */
import { useSyncExternalStore } from "react";
import type {
  InboxConnectorConfig,
  InboxConnectorPrefsInput,
  InboxConnectorSaveInput,
  InboxConnectorSnapshot,
  InboxConnectorStatus,
  InboxConnectorSyncResult,
  InboxConnectorTestInput,
  InboxConnectorTestResult,
  InboxExternalChecksResult,
  InboxExternalCommentInput,
  InboxExternalCommentResult,
  InboxExternalDetailInput,
  InboxExternalDetailResult,
  InboxExternalDiffResult,
  InboxExternalPullRequestInput,
  InboxPullRequestActionInput,
  InboxPullRequestActionResult,
} from "pi-protocol";
import { invoke } from "@/desktop-bridge/core";
import { listen } from "@/desktop-bridge/event";
import { isDesktop } from "@/lib/desktop-env";

export type InboxConnectorsView = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  connectors: InboxConnectorConfig[];
  statuses: InboxConnectorStatus[];
};

const EMPTY: InboxConnectorsView = {
  loaded: false,
  loading: false,
  error: null,
  connectors: [],
  statuses: [],
};

let current: InboxConnectorsView = EMPTY;
let initPromise: Promise<void> | null = null;
let unlisten: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applySnapshot(snapshot: InboxConnectorSnapshot): void {
  current = {
    ...current,
    loaded: true,
    loading: false,
    error: null,
    connectors: snapshot.connectors ?? [],
    statuses: snapshot.statuses ?? [],
  };
  emit();
}

export function useInboxConnectors(): InboxConnectorsView {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

export function getInboxConnectors(): InboxConnectorsView {
  return current;
}

async function refresh(): Promise<void> {
  current = { ...current, loading: true, error: null };
  emit();
  try {
    const snapshot = await invoke<InboxConnectorSnapshot>(
      "inbox_connectors_list",
    );
    applySnapshot(snapshot);
  } catch (error) {
    current = {
      ...current,
      loading: false,
      error: errorText(error),
    };
    emit();
    throw error;
  }
}

/** 设置页挂载时调用：拉首屏 + 订阅主进程状态推送。 */
export function initInboxConnectors(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!isDesktop()) {
      current = { ...EMPTY, loaded: true };
      emit();
      return;
    }
    await refresh().catch(() => {});
    try {
      const off = await listen<InboxConnectorSnapshot>(
        "inbox:connectors",
        (event) => {
          if (event.payload) applySnapshot(event.payload);
        },
      );
      unlisten = off;
    } catch {
      // 事件桥不可用：保留手动刷新/操作后的快照
    }
  })();
  return initPromise;
}

export async function refreshInboxConnectors(): Promise<void> {
  await refresh();
}

export async function saveInboxConnector(
  input: InboxConnectorSaveInput,
): Promise<InboxConnectorSnapshot> {
  const snapshot = await invoke<InboxConnectorSnapshot>(
    "inbox_connectors_save",
    { input },
  );
  applySnapshot(snapshot);
  return snapshot;
}

export async function deleteInboxConnector(
  id: string,
): Promise<InboxConnectorSnapshot> {
  const snapshot = await invoke<InboxConnectorSnapshot>(
    "inbox_connectors_delete",
    { id },
  );
  applySnapshot(snapshot);
  return snapshot;
}

export async function testInboxConnector(
  input: InboxConnectorTestInput,
): Promise<InboxConnectorTestResult> {
  return invoke<InboxConnectorTestResult>("inbox_connectors_test", { input });
}

export async function syncInboxConnector(
  id: string,
): Promise<InboxConnectorSyncResult> {
  const result = await invoke<InboxConnectorSyncResult>(
    "inbox_connectors_sync",
    { id },
  );
  await refresh().catch(() => {});
  return result;
}

/** 选中外部条目时按需拉取 issue 正文/评论（主进程缓存 60s）。 */
export async function fetchInboxExternalDetail(
  input: InboxExternalDetailInput,
): Promise<InboxExternalDetailResult> {
  return invoke<InboxExternalDetailResult>("inbox_connector_detail", { input });
}

/** PR/MR 只读 diff（主进程缓存 60s；大 patch 已截断）。 */
export async function fetchInboxPullRequestDiff(
  input: InboxExternalPullRequestInput,
): Promise<InboxExternalDiffResult> {
  return invoke<InboxExternalDiffResult>("inbox_connector_pr_diff", { input });
}

/** PR/MR 只读 checks（主进程缓存 60s）。 */
export async function fetchInboxPullRequestChecks(
  input: InboxExternalPullRequestInput,
): Promise<InboxExternalChecksResult> {
  return invoke<InboxExternalChecksResult>("inbox_connector_pr_checks", {
    input,
  });
}

/** 发表评论/回复（外部系统写操作）。 */
export async function postInboxExternalComment(
  input: InboxExternalCommentInput,
): Promise<InboxExternalCommentResult> {
  return invoke<InboxExternalCommentResult>("inbox_connector_comment", {
    input,
  });
}

/** PR/MR 合并/关闭/重新打开/ready（外部系统写操作）。 */
export async function runInboxPullRequestAction(
  input: InboxPullRequestActionInput,
): Promise<InboxPullRequestActionResult> {
  return invoke<InboxPullRequestActionResult>("inbox_connector_pr_action", {
    input,
  });
}

/** 通知偏好：静音/分类开关；成功后会收到最新连接器快照。 */
export async function updateInboxConnectorPrefs(
  input: InboxConnectorPrefsInput,
): Promise<InboxConnectorSnapshot> {
  const snapshot = await invoke<InboxConnectorSnapshot>(
    "inbox_connectors_update_prefs",
    { input },
  );
  applySnapshot(snapshot);
  return snapshot;
}

/** 测试缝 */
export function resetInboxConnectorsForTest(): void {
  unlisten?.();
  unlisten = null;
  initPromise = null;
  current = EMPTY;
  listeners.clear();
}
