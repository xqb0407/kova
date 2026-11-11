/**
 * 项目虚拟目录的会话侧装配：目录变更后把新清单灌进驻留 run 并热替换
 * 提示词/技能缓存。
 *
 * 目录本身的事实源在 agent/project-dirs（用户本机 kv）；本模块只负责
 * 「项目配置变了，活会话如何立刻跟上」，不持有任何持久状态。
 */
import { syncRunPrompt } from "../agent/modes";
import {
  effectiveDirsForProject,
  primaryFolder,
  projectById,
} from "../agent/projects";
import { resolveExternalPath } from "../agent/external-dirs";
import { projectCwdFor } from "../agent/project-dirs";
import { ensureSkillsLoaded } from "../skills/skills";
import { running } from "./registry";
import type { Running } from "../types";

/** 预热技能缓存并同步提示词：外部目录/技能清单变化走尾部隐藏更新，不改写首条 system。
 *  必须带当前模型：环境段的 Model 行在每次请求里都有，漏传会被 diff 当成变化。
 *  工具表也要重建：search_external_files 按「是否存在附加目录」条件注册，
 *  目录从无到有/从有到无时仅改 run.externalDirs 不会让工具出现或消失。
 *  动态 import 打断本模块与 resolve（重建实现所在）的模块环。 */
export async function applyDirsToRun(run: Running): Promise<void> {
  await ensureSkillsLoaded(
    run.cwd,
    (run.externalDirs ?? []).map((dir) => dir.path),
  );
  const { reloadToolsForRun } = await import("./resolve");
  await reloadToolsForRun(run);
  syncRunPrompt(run, run.agent.state.model);
}

function realOr(path: string): string {
  try {
    return resolveExternalPath(path, path);
  } catch {
    return path;
  }
}

/**
 * 目录被移出项目后，把 cwd 已不在项目 folders 内的驻留 run 解除项目归属。
 * 只改内存字段；持久化（sessions.project_id）由协议层负责。返回受影响的
 * sessionId —— 调用方随后要重算这些 run 的 effectiveDirs，否则它们还会
 * 继续加载原项目的附加目录。
 */
export function unbindRunsOutsideProject(
  projectId: string,
  folders: readonly string[],
): string[] {
  const keys = new Set(folders.map(realOr));
  const affected: string[] = [];
  for (const run of running.values()) {
    if (run.projectId !== projectId) continue;
    if (run.cwd && keys.has(realOr(run.cwd))) continue;
    run.projectId = null;
    affected.push(run.sessionId);
  }
  return affected;
}

/**
 * 显式改会话归属（set_session_project / 移动到共享目录）后同步驻留 run：
 * 只改 DB 会让摘要显示在新项目、运行态却还挂着旧项目目录（或 null）。
 * 返回是否命中了驻留 run。
 */
export async function applyProjectBindingToRun(
  sessionId: string,
  projectId: string | null,
): Promise<boolean> {
  const run = [...running.values()].find(
    (candidate) => candidate.sessionId === sessionId,
  );
  if (!run) return false;
  run.projectId = projectId;
  run.externalDirs = effectiveDirsForProject(projectId, run.cwd);
  await applyDirsToRun(run);
  return true;
}

/**
 * 项目目录变更后的热生效：所有属于该项目的驻留 run 重算附加目录、
 * 预热技能并重排提示词。返回受影响的 sessionId（协议层据此广播
 * sessions_changed，让侧栏分组与其它端同步）。
 *
 * previousRoots = 变更前的根集合：移除最后一个根后，原根里的 run 已不再
 * 属于该项目，但仍要重算一次才能把项目目录从它们的生效清单里摘掉。
 */
export async function recomputeRunsForProject(
  projectCwd: string,
  previousRoots: readonly string[] = [],
): Promise<string[]> {
  const previous = new Set(previousRoots.map(realOr));
  const affected: string[] = [];
  for (const run of running.values()) {
    const runReal = realOr(run.cwd);
    const isMember =
      // 新模型：显式 project_id 归属（项目主目录变化时也命中）
      (run.projectId &&
        projectById(run.projectId) &&
        primaryFolder(projectById(run.projectId)) === projectCwd) ||
      // 旧会话回退：按 cwd 唯一归属推断
      projectCwdFor(run.cwd) === projectCwd ||
      runReal === projectCwd ||
      previous.has(runReal);
    if (!isMember) continue;
    run.externalDirs = effectiveDirsForProject(run.projectId, run.cwd);
    await applyDirsToRun(run);
    affected.push(run.sessionId);
  }
  return affected;
}
