/**
 * 本地文件（非 vendored）：把 vendored scheduler_* LLM 工具（tools.ts）挂进
 * 对话 run 的扩展工具组（"对话里让 agent 帮你建任务"的入口）。
 * 不进 baseTools：与 Task/技能管理组同层，plan 模式结构性拿不到（toolsForMode
 * 只给 agent 模式拼扩展组）。自动化自己的无人值守 run 不挂：定时任务不该
 * 在批处理里自行繁殖排期。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Running } from "../types";
import { getAutomationPolicy } from "./policy";
import { getAutomationScheduler } from "./runtime";
import { createSchedulerTools } from "./tools";

export function buildSchedulerTools(run: Running): AgentTool[] {
  if (getAutomationPolicy(run.threadId)) return [];
  const scheduler = getAutomationScheduler();
  if (!scheduler) return [];
  return createSchedulerTools(scheduler, () => {
    const model = run.agent.state.model as { provider?: string; id?: string } | undefined;
    return {
      sessionId: run.sessionId,
      ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
    };
  });
}
