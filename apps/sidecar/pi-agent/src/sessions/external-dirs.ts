/**
 * 项目虚拟目录的会话侧装配：目录变更后把新清单灌进驻留 run 并热替换
 * 提示词/技能缓存。
 *
 * 目录本身的事实源在 agent/project-dirs（用户本机 kv）；本模块只负责
 * 「项目配置变了，活会话如何立刻跟上」，不持有任何持久状态。
 */
import { setLeadingSystemMessage } from "../agent/context";
import { composeRunPrompt } from "../agent/modes";
import { effectiveProjectDirs, projectCwdFor } from "../agent/project-dirs";
import { resolveExternalPath } from "../agent/external-dirs";
import { ensureSkillsLoaded } from "../skills/skills";
import { running } from "./registry";
import type { Running } from "../types";

/** 预热技能缓存并热替换系统提示词（轮中经 loopContext 立即生效） */
export async function applyDirsToRun(run: Running): Promise<void> {
  await ensureSkillsLoaded(
    run.cwd,
    (run.externalDirs ?? []).map((dir) => dir.path),
  );
  const prompt = composeRunPrompt(run);
  setLeadingSystemMessage(run.agent.state.messages, prompt);
  if (run.loopContext) setLeadingSystemMessage(run.loopContext.messages, prompt);
}

function realOr(path: string): string {
  try {
    return resolveExternalPath(path, path);
  } catch {
    return path;
  }
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
      projectCwdFor(run.cwd) === projectCwd ||
      runReal === projectCwd ||
      previous.has(runReal);
    if (!isMember) continue;
    run.externalDirs = effectiveProjectDirs(run.cwd);
    await applyDirsToRun(run);
    affected.push(run.sessionId);  }
  return affected;
}
