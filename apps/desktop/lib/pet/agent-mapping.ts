/**
 * Agent 事件 → 宠物反应 的映射（纯函数，无 React / DOM）。
 *
 * 事件源是 `lib/pi/agent-events` 的六类生命周期事件（agent.* / automation.*），
 * 悬浮窗与内嵌宿主共用这一份映射；未知事件名（前向兼容的新事件）返回 null，
 * 宿主据此忽略，不乱切动作。
 */

import type { PetMotion } from "./types";

/** 事件到达时宠物的一次反应：插播动作 + 可选头顶气泡。 */
export interface PetAgentReaction {
  motion: PetMotion;
  /**
   * 气泡文案；**缺省 = 只做动作不弹泡**——过程性事件（如 turn.started 每轮都发）
   * 不该打扰，只有值得用户知道的事（完成/出错/等待）才配气泡。
   */
  bubble?: string;
  /** 气泡是否值得点击跳会话（没有 threadId 时宿主自行降级为纯提示） */
  actionable: boolean;
}

const REACTIONS: Record<string, PetAgentReaction> = {
  // 过程态：只切动作，不弹泡
  "agent.turn.started": { motion: "working", actionable: false },
  "agent.turn.stopped": { motion: "idle", actionable: false },
  // 终态/待交互：动作 + 气泡
  "agent.turn.completed": { motion: "waving", bubble: "任务完成", actionable: true },
  "agent.turn.error": { motion: "failed", bubble: "运行出错", actionable: true },
  "agent.approval.pending": { motion: "waiting", bubble: "等你审批", actionable: true },
  "agent.question.pending": { motion: "waiting", bubble: "等你回答", actionable: true },
  "automation.task.completed": { motion: "jumping", bubble: "定时任务完成", actionable: true },
  "automation.task.failed": { motion: "failed", bubble: "定时任务失败", actionable: true },
};

/** 截断成短摘要（气泡一行放得下） */
function brief(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const t = value.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 事件 → 反应；`data` 用于把任务上下文拼进气泡（prompt 摘要、出错原因、工具名）。
 * 未登记的事件返回 null（调用方忽略）。
 */
export function reactionForAgentEvent(
  name: string,
  data?: Record<string, unknown>,
): PetAgentReaction | null {
  const base = REACTIONS[name];
  if (!base) return null;
  let bubble = base.bubble;
  switch (name) {
    case "agent.turn.completed": {
      const prompt = brief(data?.prompt, 20);
      bubble = prompt ? `完成：${prompt}` : bubble;
      break;
    }
    case "agent.turn.error": {
      const message = brief(data?.message, 24);
      bubble = message ? `出错：${message}` : bubble;
      break;
    }
    case "agent.approval.pending": {
      const tool = brief(data?.toolName, 16);
      bubble = tool ? `等你审批：${tool}` : bubble;
      break;
    }
    case "agent.question.pending": {
      const count = typeof data?.count === "number" ? data.count : 0;
      const first = brief(data?.firstTitle, 16);
      bubble = first ? `等你回答：${first}` : count > 0 ? `等你回答（${count} 个）` : bubble;
      break;
    }
    default:
      break;
  }
  return { ...base, bubble };
}
