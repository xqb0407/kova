"use client";

import { t } from "@/lib/i18n";

/**
 * Agent 生命周期事件总线：transport / 审批 / 提问 store 在关键节点 emit，
 * 提示音（sounds.ts）与 webhook（webhook-dispatcher.ts）作为订阅者消费。
 * 新增事件 = 扩展 AgentEventName + 注册表加一行，设置页与 webhook 订阅
 * 列表自动跟随。命名空间：agent.* / automation.* / system.*（未来 mcp.* / skill.*）。
 */

export type AgentEventName =
  | "agent.turn.started"
  | "agent.turn.completed"
  | "agent.turn.error"
  | "agent.turn.stopped"
  | "agent.approval.pending"
  | "agent.question.pending"
  | "automation.task.completed"
  | "automation.task.failed"
  | "system.test";

export interface AgentEvent {
  id: string;
  name: AgentEventName;
  threadId?: string;
  data?: Record<string, unknown>;
  occurredAt: number;
}

export type SoundTone = "complete" | "error" | "approval" | "question";

/**
 * 可订阅事件注册表：label/desc 供设置页与 webhook 文案，tone 对应提示音音色。
 *
 * **刻意不进注册表**：`agent.turn.started` / `agent.turn.stopped` 是过程性状态
 * 信号（桌宠的工作态），每个 turn 都发一次——进注册表会让弹窗/提示音/webhook
 * 对每轮对话都轰炸。消费方（桌宠等）按 AgentEventName 直接匹配。
 */
export const AGENT_EVENT_REGISTRY: {
  name: Exclude<AgentEventName, "system.test">;
  label: string;
  desc: string;
  tone: SoundTone;
}[] = [
  {
    name: "agent.turn.completed",
    label: "任务完成",
    desc: "一轮对话运行结束",
    tone: "complete",
  },
  {
    name: "agent.approval.pending",
    label: "等待审批",
    desc: "工具执行前等待你批准",
    tone: "approval",
  },
  {
    name: "agent.question.pending",
    label: "等待回答",
    desc: "Agent 提问等待你作答",
    tone: "question",
  },
  {
    name: "agent.turn.error",
    label: "运行出错",
    desc: "本轮运行异常终止",
    tone: "error",
  },
  {
    name: "automation.task.completed",
    label: "定时任务完成",
    desc: "自动化定时任务一次运行成功结束",
    tone: "complete",
  },
  {
    name: "automation.task.failed",
    label: "定时任务失败",
    desc: "自动化定时任务运行出错或被中止",
    tone: "error",
  },
];

/** 事件名 → 中文标签（webhook 文案与推送记录展示用） */
export function eventLabel(name: AgentEventName): string {
  if (name === "system.test") return t("settings.webhooks.events.test");
  const entry = AGENT_EVENT_REGISTRY.find((e) => e.name === name);
  return entry ? t(`settings.webhooks.events.${EVENT_LABEL_KEYS[name]}`) : name;
}

const EVENT_LABEL_KEYS: Record<string, string> = {
  "agent.turn.completed": "taskComplete",
  "agent.approval.pending": "approvalPending",
  "agent.question.pending": "questionPending",
  "agent.turn.error": "turnError",
  "automation.task.completed": "automationCompleted",
  "automation.task.failed": "automationFailed",
};

const listeners = new Set<(event: AgentEvent) => void>();

export function subscribeAgentEvents(
  cb: (event: AgentEvent) => void,
): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emitAgentEvent(
  name: AgentEventName,
  opts?: { threadId?: string; data?: Record<string, unknown> },
): void {
  if (typeof crypto === "undefined") return;
  const event: AgentEvent = {
    id: crypto.randomUUID(),
    name,
    threadId: opts?.threadId,
    data: opts?.data,
    occurredAt: Date.now(),
  };
  // 单个消费者异常不拖垮其余订阅者，更不阻断 chunk 流主流程
  for (const cb of listeners) {
    try {
      cb(event);
    } catch {
      // ignore
    }
  }
}
