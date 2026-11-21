"use client";

import { invoke } from "@/desktop-bridge/core";
import { useSyncExternalStore } from "react";
import { isDesktop } from "@/lib/desktop-env";

/**
 * 当前 workspace（工作目录）状态：持久化到 Rust 侧 SQLite（state.db 的 kv 表）。
 * - getWorkspace()：非 React 场景读取（adapter/transport）
 * - useWorkspace()：React 组件订阅
 * 非 桌面壳环境（web 预览）仅内存态，不持久化。
 */
const KV_KEY = "workspace";
const RECENTS_KEY = "workspace.recents";
/** 最近一次用户手动选择的项目空间（新对话默认恢复它；失效则留空） */
const LAST_USED_KEY = "workspace.lastUsed";
const RECENTS_LIMIT = 5;

/** 最近选择的项目空间：dir + 项目归属（远程项目/普通目录为 null） */
export type LastUsedWorkspace = {
  dir: string;
  projectId: string | null;
};

let current: string | null = null;
let currentSource: WorkspaceSource | null = null;
let currentProjectId: string | null = null;
let recents: string[] = [];
let lastUsed: LastUsedWorkspace | null = null;
/** 用户手动选择的序号：启动 kv 读取回填时用来防止覆盖更新的选择 */
let selectionSeq = 0;
let loadPromise: Promise<void> | null = null;
let kvWorkspaceWrite: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getWorkspace(): string | null {
  return current;
}

/** 当前选中的项目 id（与 workspace 配对；null = 普通任务/旧流程） */
export function getProjectId(): string | null {
  return currentProjectId;
}

/** 当前目录的来源：用户手动选择 / 切换会话时自动同步（null=无目录） */
export type WorkspaceSource = "user" | "session";

export function getWorkspaceSource(): WorkspaceSource | null {
  return currentSource;
}

/** 最近一次用户手动选择的项目空间（新对话默认恢复；未选择过为 null） */
export function getLastUsedWorkspace(): LastUsedWorkspace | null {
  return lastUsed;
}

export function useLastUsedWorkspace(): LastUsedWorkspace | null {
  return useSyncExternalStore(
    subscribe,
    () => lastUsed,
    () => null,
  );
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

/** 取消选中当前 workspace（recents 与"最近项目"偏好保留，只作用于当前会话） */
export function clearWorkspace() {
  setWorkspace(null);
}

/**
 * 设置当前 workspace。source 标注目录来源：
 * - "user"（默认）：用户在胶囊/菜单里手动选择
 * - "session"：WorkspaceThreadSync 切会话时同步成该会话的目录
 * 仅用户手动选择才记入最近列表与"最近项目"（lastUsed）；会话同步不污染偏好。
 * projectId 与目录配对：项目会话新建时带上，让 sidecar 显式绑定归属。
 */
export function setWorkspace(
  dir: string | null,
  source: WorkspaceSource = "user",
  projectId?: string | null,
) {
  const changed = current !== dir;
  current = dir;
  currentSource = dir == null ? null : source;
  currentProjectId = dir == null ? null : (projectId ?? null);
  // 只有用户主动选择的目录才置顶"最近使用"（session 同步是系统行为，不计），
  // 同时记为"最近选择的项目空间"，供下一次新对话恢复
  if (dir != null && source === "user") {
    selectionSeq += 1;
    recents = [dir, ...recents.filter((d) => d !== dir)].slice(0, RECENTS_LIMIT);
    lastUsed = { dir, projectId: projectId ?? null };
    if (isDesktop()) {
      void invoke("kv_set", {
        key: LAST_USED_KEY,
        value: JSON.stringify(lastUsed),
      }).catch(() => {});
    }
  }

  if (isDesktop()) {
    // workspace 切换后连接池要按新 cwd 重调：旧工作区的 MCP 服务器（尤其
    // eager/keep-alive）不该继续挂在全局池里。动态引入避免把 MCP 拖进首屏。
    // 只对用户手动选择/清空生效：session 同步（切会话）只刷新清单，避免
    // 打断后台线程正在跑的 MCP 调用。
    if (changed && (source === "user" || dir === null)) {
      void import("@/lib/mcp/mcp")
        .then(({ reconcileMcpConnections }) => reconcileMcpConnections(dir))
        .catch(() => {});
    }
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

/** React 组件订阅当前项目 id */
export function useWorkspaceProjectId(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => currentProjectId,
    () => null,
  );
}

/**
 * 最近一次 workspace kv 写入的完成 Promise（未安装 桌面壳 / 从未写入即立即完成）。
 * lib/git/git-status.ts 的 refreshGitStatus 借此排在 kv_set 之后落库再发
 * git_status：若抢在写入前执行，Rust 的 resolve_workspace 会读到旧值判
 * cwd-not-allowed，被缓存成 null 且要到下次失效（聚焦/git-changed）才重试——
 * 表现为"git 胶囊出现得很慢"。
 */
export function whenWorkspacePersisted(): Promise<unknown> {
  return kvWorkspaceWrite;
}

async function loadWorkspaceStore(): Promise<void> {
  if (!isDesktop()) return;
  const seq = selectionSeq;
  try {
    const [recentValues, lastUsedValue] = await Promise.all([
      invoke<string | null>("kv_get", { key: RECENTS_KEY }),
      invoke<string | null>("kv_get", { key: LAST_USED_KEY }),
    ]);
    // 读取期间用户可能已经手动选择：以内存里的新选择为准，别用旧快照覆盖
    if (seq === selectionSeq) {
      if (typeof recentValues === "string" && recentValues) {
        const parsed = JSON.parse(recentValues);
        if (Array.isArray(parsed)) {
          recents = parsed.filter((d): d is string => typeof d === "string").slice(0, RECENTS_LIMIT);
        }
      }
      if (typeof lastUsedValue === "string" && lastUsedValue) {
        const parsed = JSON.parse(lastUsedValue) as Partial<LastUsedWorkspace> | null;
        lastUsed =
          parsed && typeof parsed.dir === "string" && parsed.dir.trim()
            ? {
                dir: parsed.dir.trim(),
                projectId:
                  typeof parsed.projectId === "string" && parsed.projectId
                    ? parsed.projectId
                    : null,
              }
            : null;
      } else {
        lastUsed = null;
      }
    }
    emit();
  } catch {
    // 数据库不可用时保持无 workspace / 无最近项目
  }
}

/**
 * 启动时从 SQLite 恢复 recents 与"最近选择的项目空间"。
 * store 本身仍不恢复 current：新对话/启动草稿由 restoreLastUsedWorkspace
 * 显式设置（并校验项目仍存在）。这样"最近项目"只在新对话入口生效，
 * 恢复值会显示在工作空间胶囊里，不是静默带目录。
 */
export function initWorkspaceStore(): Promise<void> {
  if (!isDesktop()) return Promise.resolve();
  loadPromise = loadWorkspaceStore();
  return loadPromise;
}

/** 等启动加载完成（首次新对话恢复最近项目用；尚未加载则补一次） */
export function ensureWorkspaceStoreReady(): Promise<void> {
  return loadPromise ?? initWorkspaceStore();
}

// client bundle 加载即恢复（SSR 端 isDesktop() 为 false，直接跳过）
void initWorkspaceStore();

/** 路径最后一段作为显示名：实现已移到纯模块，这里 re-export 保持既有调用方不变 */
export { pathBasename } from "./path";
