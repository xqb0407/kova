"use client";

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * 备份与恢复（设置 → 系统 → 备份）的前端配置镜像与命令封装。
 * 事实源在 Rust：配置存 state.db kv（backup.config.v1），秘密字段
 * （S3 SecretKey / WebDAV 密码 / 备份口令）在 Rust 侧 AES-GCM 加密落库，
 * 视图（*_set 布尔）不回传秘密值。保存语义：秘密字段传空串 = 保留旧值。
 */

export type BackupProvider = "off" | "s3" | "webdav";

export interface BackupConfigView {
  provider: BackupProvider;
  includeWorkspace: boolean;
  deviceName: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  s3AccessKeyId: string;
  s3SecretAccessKeySet: boolean;
  s3PathStyle: boolean;
  davUrl: string;
  davUsername: string;
  davPasswordSet: boolean;
  davSubdir: string;
  rememberPassphrase: boolean;
  passphraseSet: boolean;
}

/** backup_config_set 入参：秘密字段传新值明文（Rust 加密），空串 = 保留旧值 */
export type BackupConfigSetInput = Omit<
  BackupConfigView,
  "s3SecretAccessKeySet" | "davPasswordSet" | "passphraseSet"
> & {
  s3SecretAccessKey?: string;
  davPassword?: string;
  passphrase?: string;
};

export interface RemoteBackup {
  name: string;
  size: number;
  modified: string;
  encrypted: boolean;
}

export interface BackupRunResult {
  fileName: string;
  size: number;
  fileCount: number;
  encrypted: boolean;
  remote: boolean;
  device: string;
  createdAt: string;
}

export interface BackupHeaderSummary {
  createdAt: string;
  device: string;
  appVersion: string;
  encrypted: boolean;
  fileCount: number;
}

export interface RestoreStagedResult {
  header: BackupHeaderSummary;
  needsRestart: boolean;
}

/** backup:progress 事件负载（Rust emit_progress） */
export interface BackupProgress {
  phase: string;
  done: number;
  total: number;
  message: string;
}

export const BACKUP_PROGRESS_EVENT = "backup:progress";

export const DEFAULT_BACKUP_CONFIG: BackupConfigView = {
  provider: "off",
  includeWorkspace: true,
  deviceName: "desktop",
  s3Endpoint: "",
  s3Region: "us-east-1",
  s3Bucket: "",
  s3Prefix: "",
  s3AccessKeyId: "",
  s3SecretAccessKeySet: false,
  s3PathStyle: true,
  davUrl: "",
  davUsername: "",
  davPasswordSet: false,
  davSubdir: "",
  rememberPassphrase: false,
  passphraseSet: false,
};

let current: BackupConfigView = DEFAULT_BACKUP_CONFIG;
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBackupConfig(): BackupConfigView {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_BACKUP_CONFIG,
  );
}

/** 非 Tauri 环境（SSR/网页端）不打水合 */
function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 模块加载水合一次；失败保持默认（设置页保存时仍会尝试） */
export async function initBackupConfig(): Promise<void> {
  if (initialized || !isTauriRuntime()) return;
  initialized = true;
  try {
    current = { ...DEFAULT_BACKUP_CONFIG, ...(await invoke<BackupConfigView>("backup_config_get")) };
    emit();
  } catch {
    // Rust 侧不可用：保持默认
  }
}

/** 保存配置：乐观更新本地镜像，失败回滚并抛出（设置页据此 toast） */
export async function saveBackupConfig(next: BackupConfigSetInput): Promise<BackupConfigView> {
  const previous = current;
  const optimistic: BackupConfigView = {
    ...previous,
    ...next,
    s3SecretAccessKeySet: next.s3SecretAccessKey ? true : previous.s3SecretAccessKeySet,
    davPasswordSet: next.davPassword ? true : previous.davPasswordSet,
    passphraseSet: next.passphrase ? true : previous.passphraseSet,
  };
  current = optimistic;
  emit();
  try {
    const view = await invoke<BackupConfigView>("backup_config_set", { config: next });
    current = { ...DEFAULT_BACKUP_CONFIG, ...view };
    emit();
    return current;
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void initBackupConfig();

// ---------------------------------------------------------------------------
// 命令封装
// ---------------------------------------------------------------------------

export function backupTest(): Promise<string> {
  return invoke<string>("backup_test");
}

export function backupRun(
  target: "remote" | "local",
  localPath?: string,
  passphrase?: string,
): Promise<BackupRunResult> {
  return invoke<BackupRunResult>("backup_run", { target, localPath, passphrase });
}

export function backupListRemote(): Promise<RemoteBackup[]> {
  return invoke<RemoteBackup[]>("backup_list_remote");
}

export function backupDownload(name: string, savePath: string): Promise<number> {
  return invoke<number>("backup_download", { name, savePath });
}

export function backupDeleteRemote(name: string): Promise<string> {
  return invoke<string>("backup_delete_remote", { name });
}

export function backupRestore(source: {
  remoteName?: string;
  localPath?: string;
  passphrase?: string;
}): Promise<RestoreStagedResult> {
  return invoke<RestoreStagedResult>("backup_restore", { source });
}

export function backupPeekHeader(path: string): Promise<BackupHeaderSummary> {
  return invoke<BackupHeaderSummary>("backup_peek_header", { path });
}

export function backupRestartApp(): Promise<void> {
  return invoke<void>("backup_restart_app");
}

/** 字节数人类可读（列表/结果展示用） */
export function formatBackupBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** modified 字段尽力转本地时间（S3 ISO / DAV HTTP-date），失败原样返回 */
export function formatBackupTime(raw: string): string {
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return raw;
  return new Date(t).toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
