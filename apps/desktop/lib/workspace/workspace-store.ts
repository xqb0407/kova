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
let currentSource: WorkspaceSource | null = null;
let recents: string[] = [];
let kvWorkspaceWrite: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getWorkspace(): string | null {
  return current;
}

/** 当前目录的来源：用户手动选择 / 切换会话时自动同步（null=无目录） */
export type WorkspaceSource = "user" | "session";

export function getWorkspaceSource(): WorkspaceSource | null {
  return currentSource;
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

/** React 组件订阅当前 workspace 的来源（user=手动选，session=跟随会话，null=无目录） */
export function useWorkspaceSource(): WorkspaceSource | null {
  return useSyncExternalStore(
    subscribe,
    () => currentSource,
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

/**
 * 设置当前 workspace。source 标注目录来源：
 * - "user"（默认）：用户在胶囊/菜单里手动选择
 * - "session"：WorkspaceThreadSync 切会话时同步成该会话的目录
 * 仅用户手动选择才记入最近列表；会话同步不污染用户的"最近使用"。
 */
export function setWorkspace(dir: string | null, source: WorkspaceSource = "user") {
  current = dir;
  currentSource = dir == null ? null : source;
  // 只有用户主动选择的目录才置顶"最近使用"（session 同步是系统行为，不计）
  if (dir != null && source === "user") {
    recents = [dir, ...recents.filter((d) => d !== dir)].slice(0, RECENTS_LIMIT);
  }

  if (isTauri()) {
    const write =
      dir == null
        ? invoke("kv_delete", { key: KV_KEY })
        : invoke("kv_set", { key: KV_KEY, value: dir });
    // 记下本次 kv 写入的完成（吞错）：git 状态拉取要等它落库才发（Rust 侧
    // resolve_workspace 用 kv "workspace" 校验 cwd），见 whenWorkspacePersisted。
    // 写入先行、emit 后置：订阅者（git 胶囊等）在 emit 后重挂载取
    // whenWorkspacePersisted 时，拿到的必然是"包含这一次"的写入 Promise。
    kvWorkspaceWrite = write.catch(() => {});
    void invoke("kv_set", { key: RECENTS_KEY, value: JSON.stringify(recents) }).catch(() => {});
  }

  emit();
}

/**
 * 最近一次 workspace kv 写入的完成 Promise（未安装 Tauri / 从未写入即立即完成）。
 * lib/git/git-status.ts 的 refreshGitStatus 借此排在 kv_set 之后落库再发
 * git_status：若抢在写入前执行，Rust 的 resolve_workspace 会读到旧值判
 * cwd-not-allowed，被缓存成 null 且要到下次失效（聚焦/git-changed）才重试——
 * 表现为"git 胶囊出现得很慢"。
 */
export function whenWorkspacePersisted(): Promise<unknown> {
  return kvWorkspaceWrite;
}

/**
 * 启动时从 SQLite 恢复"最近选择"。
 * 注意：**不恢复** current——曾经恢复导致新对话/开机草稿静默带上一次的目录，
 * 用户以为"没选目录"却在旧目录里执行。现在新对话一律从"未选择"开始，
 * 上次目录通过 recents 一键可达；kv 写入保留（无害死数据，也兼容旧版本回退）。
 */
export async function initWorkspaceStore(): Promise<void> {
  if (!isTauri()) return;
  try {
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
