"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi-bridge";
import { piSessionRegistry } from "@/lib/pi-thread-adapter";

/**
 * 会话模式与计划状态（pi-agent sidecar 的 modes.ts 状态机镜像）。
 * - 事实源在 sidecar：prompt 流里的 data-planningState chunk 推送变更（见 pi-transport 的 tap）
 * - 管理操作（set_mode/get_planning_state）走 piRequest 请求-响应，响应即新状态
 * - 前端只是 per-thread 快照 store，切换线程时各自独立
 * - plan_exit 的执行确认不在这里：它走逐工具审批通道（pi-tool-approval）
 */

export type SessionMode = "agent" | "plan";

/** 逐工具审批级别（agent 模式）：ask = 每次确认；auto-edit = 编辑免确认；auto = 全免 */
export type ApprovalLevel = "ask" | "auto-edit" | "auto";

export type PlanningStateValue = "inactive" | "planning";

export type PlanningSnapshot = {
  mode: SessionMode;
  approvalLevel: ApprovalLevel;
  planning: PlanningStateValue;
};

export const DEFAULT_PLANNING_SNAPSHOT: PlanningSnapshot = {
  mode: "agent",
  approvalLevel: "ask",
  planning: "inactive",
};

/** threadId -> 最近一次已知的模式快照 */
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
    (d.mode !== "agent" && d.mode !== "plan") ||
    (d.planning !== "inactive" && d.planning !== "planning")
  ) {
    return;
  }
  setSnapshot(threadId, {
    mode: d.mode,
    approvalLevel:
      d.approvalLevel === "auto-edit" || d.approvalLevel === "auto" ? d.approvalLevel : "ask",
    planning: d.planning,
  });
}

/** 订阅当前线程的模式快照 */
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
};

function snapshotFrom(res: ModeResponse): PlanningSnapshot {
  return {
    mode: res.mode,
    approvalLevel: res.approvalLevel ?? "ask",
    planning: res.planning,
  };
}

async function requestMode(threadId: string, payload: Record<string, unknown>): Promise<void> {
  const sessionId = piSessionRegistry.get(threadId);
  const res = await piRequest<ModeResponse>({ ...payload, threadId, ...(sessionId ? { sessionId } : {}) });
  setSnapshot(threadId, snapshotFrom(res));
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

/**
 * 拉取 sidecar 侧模式快照并水合本地 store：页面刷新/切线程后 mode-picker
 * 内存快照丢失，用请求-响应恢复（无运行中 turn 也有效）。
 * 没有已知 sessionId 的线程直接跳过：sidecar 不可能持有它的特殊模式，
 * 而请求会懒建会话（污染）。
 */
export function fetchPlanningState(threadId: string): Promise<void> {
  if (!piSessionRegistry.get(threadId)) return Promise.resolve();
  return requestMode(threadId, { type: "get_planning_state" });
}
