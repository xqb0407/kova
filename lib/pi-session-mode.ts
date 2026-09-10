"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi-bridge";
import { piSessionRegistry } from "@/lib/pi-thread-adapter";

/**
 * 会话模式与计划审批状态（pi-agent sidecar 的 modes.ts 状态机镜像）。
 * - 事实源在 sidecar：prompt 流里的 data-planningState chunk 推送变更（见 pi-transport 的 tap）
 * - 管理操作（set_mode/approve_plan/reject_plan）走 piRequest 请求-响应，响应即新状态
 * - 前端只是 per-thread 快照 store，切换线程时各自独立
 */

export type SessionMode = "agent" | "plan" | "goal";

/** 逐工具审批级别（agent 模式）：ask = 每次确认；auto-edit = 编辑免确认；auto = 全免 */
export type ApprovalLevel = "ask" | "auto-edit" | "auto";

export type PlanningStateValue = "inactive" | "planning" | "awaiting_approval";

export type PendingProposal = {
  kind: "plan" | "goal";
  title: string;
  markdown: string;
  question: string;
};

export type PlanningSnapshot = {
  mode: SessionMode;
  approvalLevel: ApprovalLevel;
  planning: PlanningStateValue;
  proposal: PendingProposal | null;
};

export const DEFAULT_PLANNING_SNAPSHOT: PlanningSnapshot = {
  mode: "agent",
  approvalLevel: "ask",
  planning: "inactive",
  proposal: null,
};

/** threadId -> 最近一次已知的模式/审批快照 */
const snapshots = new Map<string, PlanningSnapshot>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function setSnapshot(threadId: string, snap: PlanningSnapshot) {
  snapshots.set(threadId, snap);
  notify();
}

/** 消费 prompt 流里的 data-planningState chunk（pi-transport 调用） */
export function applyPlanningChunk(threadId: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as Partial<PlanningSnapshot>;
  if (
    (d.mode !== "agent" && d.mode !== "plan" && d.mode !== "goal") ||
    (d.planning !== "inactive" && d.planning !== "planning" && d.planning !== "awaiting_approval")
  ) {
    return;
  }
  const proposal =
    d.proposal && typeof d.proposal === "object"
      ? {
          kind: d.proposal.kind === "goal" ? ("goal" as const) : ("plan" as const),
          title: String(d.proposal.title ?? ""),
          markdown: String(d.proposal.markdown ?? ""),
          question: String(d.proposal.question ?? ""),
        }
      : null;
  setSnapshot(threadId, {
    mode: d.mode,
    approvalLevel:
      d.approvalLevel === "auto-edit" || d.approvalLevel === "auto" ? d.approvalLevel : "ask",
    planning: d.planning,
    proposal: d.planning === "awaiting_approval" ? proposal : null,
  });
}

/** 订阅当前线程的审批快照 */
export function useSessionMode(threadId: string | undefined): PlanningSnapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (threadId ? (snapshots.get(threadId) ?? DEFAULT_PLANNING_SNAPSHOT) : DEFAULT_PLANNING_SNAPSHOT),
    () => DEFAULT_PLANNING_SNAPSHOT,
  );
}

type ModeResponse = {
  type: "mode_changed" | "planning_state";
  mode: SessionMode;
  approvalLevel?: ApprovalLevel;
  planning: PlanningStateValue;
  proposal: PendingProposal | null;
};

async function requestMode(threadId: string, payload: Record<string, unknown>): Promise<void> {
  const sessionId = piSessionRegistry.get(threadId);
  const res = await piRequest<ModeResponse>({ ...payload, threadId, ...(sessionId ? { sessionId } : {}) });
  setSnapshot(threadId, {
    mode: res.mode,
    approvalLevel: res.approvalLevel ?? "ask",
    planning: res.planning,
    proposal: res.proposal ?? null,
  });
}

/** 手动切换模式；agent 模式可携带审批级别（变更前确认/自动编辑/完全访问） */
export function setSessionMode(
  threadId: string,
  mode: SessionMode,
  approvalLevel?: ApprovalLevel,
): Promise<void> {
  return requestMode(threadId, {
    type: "set_mode",
    mode,
    ...(approvalLevel ? { approvalLevel } : {}),
  });
}

/** 批准未决提案：sidecar 回 agent 模式；随后由调用方 append 批准消息开始实施 */
export function approveSessionPlan(threadId: string): Promise<void> {
  return requestMode(threadId, { type: "approve_plan" });
}

/** 拒绝未决提案：留在契约模式，用户输入反馈后模型重新提交 */
export function rejectSessionPlan(threadId: string): Promise<void> {
  return requestMode(threadId, { type: "reject_plan" });
}
