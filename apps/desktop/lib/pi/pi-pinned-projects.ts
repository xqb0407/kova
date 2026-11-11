"use client";

import { useSyncExternalStore } from "react";

/**
 * 侧边栏项目置顶集合（localStorage 持久化，键 pi.pinned-projects）。
 *
 * 与 pi-pinned-sessions 同款模块级 store：置顶项目会整体从「项目」分区
 * 移到「置顶」分区，以项目卡（可展开）的形式展示；项目内会话不再重复
 * 平铺。项目实体在 sidecar，置顶只是本机侧栏偏好，所以不落 DB。
 *
 * 列表里已不存在的 id 惰性忽略：分组计算时与项目注册表取交集。
 */

const KEY = "pi.pinned-projects";
const EMPTY: readonly string[] = [];

const listeners = new Set<() => void>();

function load(): readonly string[] {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : EMPTY;
  } catch {
    return EMPTY;
  }
}

// 快照在模块初始化时同步读取：desktop 是纯客户端静态导出，首帧前已完成
let snapshot: readonly string[] = load();

function persist() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    // 配额/隐私模式写失败：置顶仍在本会话内生效，只是不跨启动
  }
}

function setSnapshot(next: readonly string[]) {
  snapshot = next;
  persist();
  for (const l of listeners) l();
}

/** 置顶 / 取消置顶（幂等切换）；新置顶的项目排在最前 */
export function togglePinProject(projectId: string): void {
  setSnapshot(
    snapshot.includes(projectId)
      ? snapshot.filter((id) => id !== projectId)
      : [projectId, ...snapshot],
  );
}

export function subscribePinnedProjects(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getPinnedProjects(): readonly string[] {
  return snapshot;
}

export function isProjectPinned(projectId: string | undefined): boolean {
  return projectId ? snapshot.includes(projectId) : false;
}

/** 分组计算用：整个置顶项目 id 快照，随集合变更重渲染 */
export function usePinnedProjectIds(): readonly string[] {
  return useSyncExternalStore(
    subscribePinnedProjects,
    getPinnedProjects,
    () => EMPTY,
  );
}

/** 项目操作菜单用：单个项目的置顶状态 */
export function useIsProjectPinned(projectId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribePinnedProjects,
    () => isProjectPinned(projectId),
    () => false,
  );
}
