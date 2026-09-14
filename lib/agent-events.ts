"use client";

/**
 * Agent 生命周期事件总线：transport / 审批 / 提问 store 在关键节点 emit，
 * 提示音（sounds.ts）与 webhook（webhook-dispatcher.ts）作为订阅者消费。
 * 新增事件 = 扩展 AgentEventName + 注册表加一行，设置页与 webhook 订阅
 * 列表自动跟随。命名空间预留：agent.* / system.*（未来 mcp.* / skill.*）。
 */

export type AgentEventName =
  | "agent.turn.completed"
  | "agent.turn.error"
  | "agent.approval.pending"
  | "agent.question.pending"
  | "system.test";

export interface AgentEvent {
  id: string;
  name: AgentEventName;
  threadId?: string;
  data?: Record<string, unknown>;
  occurredAt: number;
}

export type SoundTone = "complete" | "error" | "approval" | "question";

/** 可订阅事件注册表：label/desc 供设置页与 webhook 文案，tone 对应提示音音色 */
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
];

/** 事件名 → 中文标签（webhook 文案与推送记录展示用） */
export function eventLabel(name: AgentEventName): string {
  if (name === "system.test") return "测试推送";
  return AGENT_EVENT_REGISTRY.find((e) => e.name === name)?.label ?? name;
}

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
