"use client";

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/tauri";

/**
 * 当前 workspace（工作目录）状态：持久化到 Rust 侧 SQLite（state.db 的 kv 表）。
 * - getWorkspace()：非 React 场景读取（adapter/transport）
 * - useWorkspace()：React 组件订阅
 * 非 Tauri 环境（web 预览）仅内存态，不持久化。
 */
const KV_KEY = "workspace";
const RECENTS_KEY = "workspace.recents";
const RECENTS_LIMIT = 5;

let current: string | null = null;
let recents: string[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getWorkspace(): string | null {
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React 组件订阅当前 workspace */
export function useWorkspace(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** React 组件订阅最近选择的 workspace（最多 5 个，新的在前） */
export function useWorkspaceRecents(): string[] {
  return useSyncExternalStore(
    subscribe,
    () => recents,
    () => EMPTY,
  );
}

const EMPTY: string[] = [];

/** 取消选中当前 workspace（历史记录保留） */
export function clearWorkspace() {
  setWorkspace(null);
}

export function setWorkspace(dir: string | null) {
  current = dir;
  // 记入最近选择（去重，置顶）
  if (dir != null) {
    recents = [dir, ...recents.filter((d) => d !== dir)].slice(0, RECENTS_LIMIT);
  }
  emit();

  if (!isTauri()) return;
  const write =
    dir == null
      ? invoke("kv_delete", { key: KV_KEY })
      : invoke("kv_set", { key: KV_KEY, value: dir });
  void write.catch(() => {});
  void invoke("kv_set", { key: RECENTS_KEY, value: JSON.stringify(recents) }).catch(() => {});
}

/** 从 SQLite 恢复 workspace 与最近选择，应用启动时调用 */
export async function initWorkspaceStore(): Promise<void> {
  if (!isTauri()) return;
  try {
    const value = await invoke<string | null>("kv_get", { key: KV_KEY });
    if (typeof value === "string" && value) {
      current = value;
    }
    const recentValues = await invoke<string | null>("kv_get", { key: RECENTS_KEY });
    if (typeof recentValues === "string" && recentValues) {
      const parsed = JSON.parse(recentValues);
      if (Array.isArray(parsed)) {
        recents = parsed.filter((d): d is string => typeof d === "string").slice(0, RECENTS_LIMIT);
      }
    }
    emit();
  } catch {
    // 数据库不可用时保持无 workspace
  }
}

// client bundle 加载即恢复（SSR 端 isTauri() 为 false，直接跳过）
void initWorkspaceStore();

/**
 * 弹出系统目录选择框，选中后设为当前 workspace。
 * 非 Tauri 环境（web 预览）没有原生 dialog，返回 null。
 */
export async function openWorkspacePicker(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({
      directory: true,
      multiple: false,
      title: "选择工作目录",
    });
    if (typeof dir === "string") {
      setWorkspace(dir);
      return dir;
    }
  } catch {
    // 非 Tauri 环境
  }
  return null;
}

/** 路径最后一段作为显示名（兼容 / 与 \） */
export function pathBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}
