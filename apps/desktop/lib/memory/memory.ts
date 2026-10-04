"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type {
  PiMemoryConfig,
  PiMemoryFilesResponse,
  PiMemoryScopeState,
  PiMemoryTrashEntry,
  PiMemoryVersionEntry,
  PiMemoryVersionSource,
} from "@/lib/pi/pi-bridge";

/**
 * 记忆（设置 → 记忆）：全局 + 工作区双作用域 markdown 记忆库的配置镜像。
 * 事实源在 sidecar——SQLite kv 整包持久化 + 活动会话系统提示词热替换；
 * 这里只做镜像缓存：启动 get_memory 水合，保存走 set_memory（与个性化同款链路）。
 * 文件清单（list_memory_files）无状态，按需拉取。
 */

export type MemoryConfig = PiMemoryConfig;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  global: true,
  workspace: true,
  fileSearch: true,
  enabledFiles: { global: null, workspace: null },
};

let current: MemoryConfig = DEFAULT_MEMORY_CONFIG;
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMemoryConfig(): MemoryConfig {
  return current;
}

export function useMemoryConfig(): MemoryConfig {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_MEMORY_CONFIG,
  );
}

/** 从 sidecar 水合镜像（启动时调用一次；sidecar 不可用则保持默认） */
export async function initMemoryConfig(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const res = await piRequest<{ type: "memory"; settings: MemoryConfig }>({
      type: "get_memory",
    });
    current = { ...DEFAULT_MEMORY_CONFIG, ...res.settings };
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持默认，保存时仍会尝试
  }
}

/** 保存记忆设置：乐观更新本地镜像；sidecar 落 SQLite 并热更新活动会话，
 *  失败时回滚并抛出（设置页据此提示） */
export async function saveMemoryConfig(next: MemoryConfig): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    await piRequest({ type: "set_memory", settings: next });
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

/** 拉取两作用域记忆目录清单（cwd 传当前工作区；不传则 workspace 为 null） */
export async function listMemoryFiles(
  cwd?: string | null,
): Promise<PiMemoryFilesResponse["scopes"]> {
  const res = await piRequest<PiMemoryFilesResponse>({
    type: "list_memory_files",
    ...(cwd ? { cwd } : {}),
  });
  return res.scopes;
}

/** 读单个记忆文件（设置页点开预览/编辑用；不做开关门控，关闭也能看） */
export async function readMemoryEntry(
  scope: "global" | "workspace",
  cwd: string | null,
  file: string,
): Promise<string> {
  const res = await piRequest<{ type: "memory_file"; file: string; content: string }>({
    type: "read_memory_file",
    scope,
    file,
    ...(cwd ? { cwd } : {}),
  });
  return res.content;
}

/** 保存设置页编辑的记忆文件（整体覆盖；sidecar 保存后热替换活动会话提示词） */
export async function writeMemoryEntry(
  scope: "global" | "workspace",
  cwd: string | null,
  file: string,
  content: string,
): Promise<void> {
  await piRequest({
    type: "write_memory_file",
    scope,
    file,
    content,
    ...(cwd ? { cwd } : {}),
  });
}

export type { PiMemoryScopeState, PiMemoryFilesResponse };

/* ------------------------------- 版本史与回收站 -------------------------------
 * 版本史（.history/<文件名>/）：每次改动自动记一版，来源 page/agent/external/restore/delete；
 * 回收站（.trash/）：删除 = 移入回收站，可恢复/彻底删除/清空（彻底删除会连版本史一起清）。
 * 两者都是记忆目录下的隐藏子目录，不进文件清单、注入与检索（见 sidecar agent/memory.ts）。
 */

/** 某文件的版本清单（最新在前） */
export async function listMemoryVersions(
  scope: "global" | "workspace",
  cwd: string | null,
  file: string,
): Promise<PiMemoryVersionEntry[]> {
  const res = await piRequest<{ type: "memory_versions"; file: string; versions: PiMemoryVersionEntry[] }>({
    type: "list_memory_versions",
    scope,
    file,
    ...(cwd ? { cwd } : {}),
  });
  return res.versions;
}

/** 读某一版内容（历史弹窗预览用） */
export async function readMemoryVersion(
  scope: "global" | "workspace",
  cwd: string | null,
  file: string,
  versionId: string,
): Promise<string> {
  const res = await piRequest<{ type: "memory_version"; file: string; versionId: string; content: string }>({
    type: "read_memory_version",
    scope,
    file,
    versionId,
    ...(cwd ? { cwd } : {}),
  });
  return res.content;
}

/** 把某一版写回文件（写回本身也进历史，任何一步都能回退） */
export async function restoreMemoryVersion(
  scope: "global" | "workspace",
  cwd: string | null,
  file: string,
  versionId: string,
): Promise<void> {
  await piRequest({
    type: "restore_memory_version",
    scope,
    file,
    versionId,
    ...(cwd ? { cwd } : {}),
  });
}

/** 删单条版本（当前内容不受影响） */
export async function deleteMemoryVersion(
  scope: "global" | "workspace",
  cwd: string | null,
  file: string,
  versionId: string,
): Promise<void> {
  await piRequest({
    type: "delete_memory_version",
    scope,
    file,
    versionId,
    ...(cwd ? { cwd } : {}),
  });
}

/** 删除记忆文件 = 移入回收站（可恢复） */
export async function trashMemoryEntry(
  scope: "global" | "workspace",
  cwd: string | null,
  file: string,
): Promise<void> {
  await piRequest({
    type: "trash_memory_file",
    scope,
    file,
    ...(cwd ? { cwd } : {}),
  });
}

/** 回收站清单（最新在前） */
export async function listMemoryTrash(
  scope: "global" | "workspace",
  cwd: string | null,
): Promise<PiMemoryTrashEntry[]> {
  const res = await piRequest<{ type: "memory_trash"; scope: "global" | "workspace"; entries: PiMemoryTrashEntry[] }>({
    type: "list_memory_trash",
    scope,
    ...(cwd ? { cwd } : {}),
  });
  return res.entries;
}

/** 从回收站恢复（同名文件已存在时 sidecar 会拒绝，不覆盖当前内容） */
export async function restoreMemoryTrash(
  scope: "global" | "workspace",
  cwd: string | null,
  trashId: string,
): Promise<void> {
  await piRequest({
    type: "restore_memory_trash",
    scope,
    trashId,
    ...(cwd ? { cwd } : {}),
  });
}

/** 彻底删除回收站的一条（连同该文件的版本史） */
export async function deleteMemoryTrash(
  scope: "global" | "workspace",
  cwd: string | null,
  trashId: string,
): Promise<void> {
  await piRequest({
    type: "delete_memory_trash",
    scope,
    trashId,
    ...(cwd ? { cwd } : {}),
  });
}

/** 清空回收站（返回清掉的条数；活着的记忆文件的版本史不动） */
export async function emptyMemoryTrash(
  scope: "global" | "workspace",
  cwd: string | null,
): Promise<number> {
  const res = await piRequest<{ type: "memory_trash_emptied"; scope: "global" | "workspace"; removed: number }>({
    type: "empty_memory_trash",
    scope,
    ...(cwd ? { cwd } : {}),
  });
  return res.removed;
}

export type {
  PiMemoryTrashEntry,
  PiMemoryVersionEntry,
  PiMemoryVersionSource,
};

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void initMemoryConfig();
