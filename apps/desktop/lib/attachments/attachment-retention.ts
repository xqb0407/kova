"use client";

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/tauri";

/**
 * 附件中转缓存保留期限（通用设置）：粘贴的文档唯一副本落
 * app_data/attachments/<threadId>/，超期由 Rust 定时清理（启动 + 每小时 +
 * 每次 stage 三处触发）。值存 SQLite kv，Rust 侧 prune 直接读同一张表。
 * 0 = 不清理（用户自管）；无法解析回退 7 天。
 */

const KV_KEY = "attachments.retentionDays";

/** 可选保留期限（天）；0 = 不清理 */
export const ATTACHMENT_RETENTION_OPTIONS = [
  { value: 0, label: "不清理" },
  { value: 1, label: "1 天" },
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
] as const;

export const ATTACHMENT_RETENTION_DEFAULT_DAYS = 7;

let current: number = ATTACHMENT_RETENTION_DEFAULT_DAYS;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function normalize(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return ATTACHMENT_RETENTION_OPTIONS.some((o) => o.value === n)
    ? n
    : ATTACHMENT_RETENTION_DEFAULT_DAYS;
}

async function hydrate(): Promise<void> {
  if (hydrated || !isTauri()) {
    hydrated = true;
    emit();
    return;
  }
  try {
    const raw = await invoke<string | null>("kv_get", { key: KV_KEY });
    current = normalize(raw ?? ATTACHMENT_RETENTION_DEFAULT_DAYS);
  } catch {
    current = ATTACHMENT_RETENTION_DEFAULT_DAYS;
  }
  hydrated = true;
  emit();
}

export function getAttachmentRetentionDays(): number {
  return current;
}

/** 设置保留天数（0 = 不清理）并持久化；失败时本地仍生效（下次启动回退默认） */
export async function setAttachmentRetentionDays(days: number): Promise<void> {
  const next = normalize(days);
  current = next;
  emit();
  if (!isTauri()) return;
  try {
    await invoke("kv_set", { key: KV_KEY, value: String(next) });
  } catch {}
}

/** React 订阅；首次调用触发异步水合（kv 读取） */
export function useAttachmentRetentionDays(): number {
  if (!hydrated) void hydrate();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => ATTACHMENT_RETENTION_DEFAULT_DAYS,
  );
}
