"use client";

import { useSyncExternalStore } from "react";

/**
 * 自动归档旧任务（设置 → 归档）：偏好 store + 候选判定纯函数。
 * - 偏好持久化于 localStorage（键 pi.auto-archive），与置顶/未读同款模式：
 *   扫描器是渲染层常驻组件（ThreadAutoArchiver），而判定要读的置顶/未读
 *   本就是本地状态，sidecar 看不见它们——所以配置也留在本地，不占 kv。
 * - 归档动作复用既有链路 aui.threads.item({id}).archive()（→ sidecar
 *   archive_session），归档态跨端一致，可在设置 → 归档恢复。
 * - collectAutoArchiveCandidates 不碰任何全局，时间注入便于单测。
 */

const KEY = "pi.auto-archive";

/** 可选保留期限（天） */
export const AUTO_ARCHIVE_RETENTION_OPTIONS = [
  { value: 3, label: "3 天后归档" },
  { value: 7, label: "7 天后归档" },
  { value: 14, label: "14 天后归档" },
  { value: 30, label: "30 天后归档" },
] as const;

export const AUTO_ARCHIVE_DEFAULT_RETENTION_DAYS = 7;

export type AutoArchivePrefs = {
  enabled: boolean;
  retentionDays: number;
};

const DEFAULTS: AutoArchivePrefs = {
  enabled: false,
  retentionDays: AUTO_ARCHIVE_DEFAULT_RETENTION_DAYS,
};

function normalizeDays(raw: unknown): number {
  return AUTO_ARCHIVE_RETENTION_OPTIONS.some((o) => o.value === raw)
    ? (raw as number)
    : AUTO_ARCHIVE_DEFAULT_RETENTION_DAYS;
}

function load(): AutoArchivePrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULTS;
    const { enabled, retentionDays } = parsed as Partial<AutoArchivePrefs>;
    return {
      enabled: enabled === true,
      retentionDays: normalizeDays(retentionDays),
    };
  } catch {
    return DEFAULTS;
  }
}

// 快照在模块初始化时同步读取（与 pi-pinned-sessions 同款）
let snapshot: AutoArchivePrefs = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    // 配额/隐私模式写失败：偏好仍在本会话内生效，只是不跨启动
  }
}

function setSnapshot(next: AutoArchivePrefs) {
  if (
    next.enabled === snapshot.enabled &&
    next.retentionDays === snapshot.retentionDays
  ) {
    return;
  }
  snapshot = next;
  persist();
  for (const l of listeners) l();
}

export function getAutoArchivePrefs(): AutoArchivePrefs {
  return snapshot;
}

export function subscribeAutoArchivePrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setAutoArchiveEnabled(enabled: boolean): void {
  setSnapshot({ ...snapshot, enabled });
}

/** 保留天数只接受档位内的值，脏输入回退默认 7 天 */
export function setAutoArchiveRetentionDays(days: number): void {
  setSnapshot({ ...snapshot, retentionDays: normalizeDays(days) });
}

export function useAutoArchivePrefs(): AutoArchivePrefs {
  return useSyncExternalStore(
    subscribeAutoArchivePrefs,
    getAutoArchivePrefs,
    () => DEFAULTS,
  );
}

/** 候选判定的最小输入形状（侧栏 threadItems 的投影，避免耦合 aui 类型） */
export type AutoArchiveItemInput = {
  /** aui 线程 id（草稿线程为 __LOCALID_ 前缀，仅作 keep 比对与返回） */
  id: string;
  /** pi sessionId；未落盘会话没有 → 不可归档 */
  remoteId?: string | undefined;
  /** "new" | "regular" | "archived"（aui ThreadListItemView.status） */
  status: string;
  lastMessageAt?: Date | undefined;
};

export type AutoArchiveCandidateInput = {
  items: readonly AutoArchiveItemInput[];
  /** 置顶集合（remoteId 键） */
  pinnedIds: ReadonlySet<string>;
  /** 未读集合（remoteId 键） */
  unreadIds: ReadonlySet<string>;
  /** 运行中判定（sidecar activeTurns 投影） */
  isRunning: (remoteId: string) => boolean;
  /** 当前打开线程（mainThreadId + 其绑定的 sessionId），永不归档 */
  keepIds: ReadonlySet<string>;
  retentionDays: number;
  /** 当前时刻（ms），注入便于单测 */
  nowMs: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 筛出可自动归档的线程 id：已落盘（regular）、未置顶、无未读、不在运行、
 * 最后消息时间早于「now − 保留期」、且不是当前打开线程。
 * 返回的是 aui 线程 id（archive primitive 按 id 定位）。
 */
export function collectAutoArchiveCandidates(
  input: AutoArchiveCandidateInput,
): string[] {
  const cutoff = input.nowMs - input.retentionDays * DAY_MS;
  const out: string[] = [];
  for (const item of input.items) {
    if (item.status !== "regular") continue;
    const remoteId = item.remoteId;
    if (!remoteId) continue;
    if (input.keepIds.has(item.id) || input.keepIds.has(remoteId)) continue;
    if (input.pinnedIds.has(remoteId)) continue;
    if (input.unreadIds.has(remoteId)) continue;
    if (input.isRunning(remoteId)) continue;
    const ts = item.lastMessageAt?.getTime();
    if (!ts || ts > cutoff) continue;
    out.push(item.id);
  }
  return out;
}
