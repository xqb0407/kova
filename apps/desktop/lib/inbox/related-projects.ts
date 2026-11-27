"use client";

/**
 * 外部收件箱条目 ↔ 项目/会话的匹配。
 *
 * 主进程/平台侧只给 repo/项目名，没有 workspace 信息；这里按项目注册表里
 * 的名称与目录 basename 做启发式匹配。只用于「相关会话」展示和默认工作区，
 * 匹配不到就退化为当前工作区，不影响任何写操作。
 */
import type { InboxItem } from "pi-protocol";
import {
  projectDisplayName,
  type ProjectRecord,
} from "@/lib/pi/pi-projects";

/** 会话列表切片里本模块需要的字段（避免依赖 assistant-ui 的内部类型）。 */
export type ThreadLike = {
  id: string;
  remoteId?: string | null;
  title?: string;
  status?: string;
  lastMessageAt?: Date;
};

export type RelatedSession = {
  id: string;
  title: string;
  lastMessageAt: number;
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function parentBase(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? "";
}

/** 按 item 的 repo/来源名找项目：项目名或任一目录 basename 命中即可。 */
export function matchProject(
  item: InboxItem,
  projects: readonly ProjectRecord[],
): ProjectRecord | null {
  const key = item.external?.key ?? "";
  const raw = key.split(/[#!]/)[0] ?? "";
  const repo = parentBase(raw);
  const source = parentBase(item.external?.sourceName ?? "");
  const needles = new Set([repo, source].filter(Boolean));
  if (needles.size === 0) return null;
  return (
    projects.find((project) => {
      if (needles.has(projectDisplayName(project).toLowerCase())) return true;
      return project.folders.some(
        (folder) => needles.has(parentBase(folder.path)),
      );
    }) ?? null
  );
}

/**
 * 项目下最近的会话（按 cwd 落在项目目录内匹配）。
 * 只取 regular 会话；archived 不混进来，避免详情页突然出现一堆旧线程。
 */
export function relatedSessionsForProject(
  project: ProjectRecord | null,
  threadItems: readonly ThreadLike[],
  cwdMap: ReadonlyMap<string, string>,
  limit = 5,
): RelatedSession[] {
  if (!project || project.folders.length === 0) return [];
  const roots = project.folders
    .map((folder) => normalizePath(folder.path))
    .filter(Boolean);
  if (roots.length === 0) return [];
  const out: RelatedSession[] = [];
  const seen = new Set<string>();
  for (const item of threadItems) {
    if (item.status && item.status !== "regular") continue;
    const remoteId = item.remoteId?.trim();
    if (!remoteId || seen.has(remoteId)) continue;
    const cwd = normalizePath(cwdMap.get(remoteId) ?? "");
    if (!cwd) continue;
    const inProject = roots.some(
      (root) => cwd === root || cwd.startsWith(`${root}/`),
    );
    if (!inProject) continue;
    seen.add(remoteId);
    out.push({
      id: remoteId,
      title: item.title?.trim() || remoteId,
      lastMessageAt: item.lastMessageAt?.getTime() ?? 0,
    });
  }
  return out
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, limit);
}
