"use client";

import {
  findProjectByPath,
  getRegistryProjects,
  initProjectRegistry,
  isRegistryLoaded,
  projectHasPath,
  projectPrimaryPath,
  type ProjectRecord,
} from "@/lib/pi/pi-projects";
import {
  ensureRemoteProjectsLoaded,
  findRemoteProjectByPath,
} from "./remote-projects";
import {
  clearWorkspace,
  ensureWorkspaceStoreReady,
  getLastUsedWorkspace,
  getWorkspaceSource,
  setWorkspace,
  type LastUsedWorkspace,
} from "./workspace-store";

/**
 * 新对话的项目空间恢复：
 * - 用户最后一次手动选择的项目/目录（workspace.lastUsed）→ 新对话直接沿用；
 * - 项目已删除/目录不再属于项目 → 留空，不猜一个替代项目；
 * - 切换会话产生的 source="session" 回填不写入该偏好。
 *
 * 纯解析拆出来便于单测；实际恢复还要等项目注册表/远程项目清单就绪。
 */

/** 远程项目匹配（只取路径；连接目标由 createThread 按路径反查） */
export type RemoteLastUsedMatch = { remotePath: string } | null;

/**
 * 最近项目解析：
 * 1. 项目 id 仍在 → 用存储目录（仍属于项目）或项目当前主目录；
 * 2. id 不在但路径匹配到现有项目（项目重建/迁移）→ 用匹配到的项目；
 * 3. 远程路径匹配现有远程项目 → 保持远程路径；
 * 4. 其余 → null（视为失效，留空）。
 */
export function resolveLastUsedWorkspace(
  lastUsed: LastUsedWorkspace,
  projects: readonly ProjectRecord[],
  remoteMatch: (path: string) => RemoteLastUsedMatch,
): LastUsedWorkspace | null {
  const byId = lastUsed.projectId
    ? projects.find((project) => project.id === lastUsed.projectId)
    : undefined;
  if (byId) {
    const dir = projectHasPath(byId, lastUsed.dir)
      ? lastUsed.dir
      : projectPrimaryPath(byId);
    return dir ? { dir, projectId: byId.id } : null;
  }
  const local = findProjectByPath(projects, lastUsed.dir);
  if (local) return { dir: lastUsed.dir, projectId: local.id };
  const remote = remoteMatch(lastUsed.dir);
  if (remote) return { dir: remote.remotePath, projectId: null };
  return null;
}

/**
 * 把当前 workspace 恢复成"最近选择的项目空间"；没有或已失效则留空。
 *
 * options.skipIfSession：启动草稿恢复时用。若 WorkspaceThreadSync 已经把
 * workspace 跟到某个旧会话（source="session"），不要用最近项目覆盖它。
 * 用户主动点"新对话"时不要传该选项——那正是要用最近项目覆盖当前会话目录。
 */
export async function restoreLastUsedWorkspace(options?: {
  skipIfSession?: boolean;
}): Promise<void> {
  const skipForSession = () =>
    options?.skipIfSession === true && getWorkspaceSource() === "session";
  await ensureWorkspaceStoreReady();
  if (skipForSession()) return;
  const lastUsed = getLastUsedWorkspace();
  if (!lastUsed) {
    if (!skipForSession()) clearWorkspace();
    return;
  }
  // 校验依赖项目注册表/远程清单；都读不到时按存储值原样恢复（不误判失效）
  await Promise.all([initProjectRegistry(), ensureRemoteProjectsLoaded()]);
  // 等待期间会话同步可能已经跟上某个旧会话：启动草稿场景下让位给会话目录
  if (skipForSession()) return;
  // 等待期间用户也可能刚选了别的项目：以最新值为准
  const latest = getLastUsedWorkspace() ?? lastUsed;
  if (!isRegistryLoaded()) {
    setWorkspace(latest.dir, "user", latest.projectId);
    return;
  }
  const resolved = resolveLastUsedWorkspace(
    latest,
    getRegistryProjects(),
    (path) => findRemoteProjectByPath(path),
  );
  if (!resolved) {
    if (!skipForSession()) clearWorkspace();
    return;
  }
  setWorkspace(resolved.dir, "user", resolved.projectId);
}

let startupRestoreStarted = false;

/**
 * 启动草稿恢复只跑一次：主壳因错误边界重挂载时，不能再用"最近项目"覆盖
 * 用户当前手动选择（或刚清空）的工作空间。
 */
export function restoreLastUsedWorkspaceAtStartup(): Promise<void> {
  if (startupRestoreStarted) return Promise.resolve();
  startupRestoreStarted = true;
  return restoreLastUsedWorkspace({ skipIfSession: true });
}
