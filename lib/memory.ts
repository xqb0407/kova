"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi-bridge";
import type {
  PiMemoryConfig,
  PiMemoryFilesResponse,
  PiMemoryScopeState,
} from "@/lib/pi-bridge";

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

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void initMemoryConfig();
