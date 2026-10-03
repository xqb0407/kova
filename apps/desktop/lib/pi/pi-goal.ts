"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import {
  piSessionIdForThread,
  piStoreKeyForThread,
  refreshSessionPrefs,
} from "@/lib/pi/pi-thread-adapter";
import type { GoalState } from "pi-protocol";

/**
 * 目标模式常驻条的目标快照（sidecar goal.ts 状态机镜像）。
 * 形态与 pi-session-mode.ts 同款：per-thread store + chunk 推更 + 请求水合，
 * 但没有乐观本地写入——目标不是用户直接拨的档位，它由「用户在 goal 档说的第一句
 * 话」产生，任何本地猜测都可能和 sidecar 的实际盘面不一致（轮次/token 账只有
 * sidecar 算得准）。所以这里只有 apply（chunk）与 fetch（水合）两条写入口，
 * 按钮动作一律走请求-响应，等 sidecar 回包再刷新。
 */

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export type GoalSnapshot = {
  id: string;
  objective: string;
  status: GoalStatus;
  /** sidecar 算好的一行摘要（两端不各算一遍：轮次上限的展示口径必须与
   *  「什么时候真的停下来」同源，否则常驻条会显示「3/25」而实际已经停了） */
  statusLine: string;
  turnCount: number;
  /** null = 未设轮次上限 */
  maxAutoTurns: number | null;
  tokensUsed: number;
  startedAt: number;
  updatedAt: number;
  pauseReason?: string;
  completionSummary?: string;
};

export type GoalStoreState = { goal: GoalSnapshot | null };

export const EMPTY_GOAL_STATE: GoalStoreState = { goal: null };

/** chunk / 响应里的 goal 是否形状完整（loose 协议：未知字段透传，脏数据一律当无目标） */
function normalizeGoal(raw: unknown): GoalSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Partial<GoalSnapshot>;
  if (typeof g.id !== "string" || typeof g.objective !== "string") return null;
  const status = g.status;
  if (
    status !== "active" &&
    status !== "paused" &&
    status !== "blocked" &&
    status !== "complete"
  ) {
    return null;
  }
  if (typeof g.statusLine !== "string" || typeof g.turnCount !== "number") return null;
  return {
    id: g.id,
    objective: g.objective,
    status,
    statusLine: g.statusLine,
    turnCount: g.turnCount,
    maxAutoTurns: typeof g.maxAutoTurns === "number" ? g.maxAutoTurns : null,
    tokensUsed: typeof g.tokensUsed === "number" ? g.tokensUsed : 0,
    startedAt: typeof g.startedAt === "number" ? g.startedAt : 0,
    updatedAt: typeof g.updatedAt === "number" ? g.updatedAt : 0,
    ...(typeof g.pauseReason === "string" ? { pauseReason: g.pauseReason } : {}),
    ...(typeof g.completionSummary === "string"
      ? { completionSummary: g.completionSummary }
      : {}),
  };
}

/** 键归一与 storeKey 迁移规则同 pi-session-mode（草稿键上的态惰性搬到会话键） */
const states = new Map<string, GoalStoreState>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function storeKey(threadId: string, migrate = false): string {
  const key = piStoreKeyForThread(threadId);
  if (migrate && key !== threadId) {
    const draft = states.get(threadId);
    if (draft && !states.has(key)) states.set(key, draft);
  }
  return key;
}

function setState(threadId: string, next: GoalStoreState) {
  states.set(storeKey(threadId, true), next);
  notify();
}

/** 消费 prompt 流里的 data-goal-state chunk（pi-client-base 调用） */
export function applyGoalChunk(threadId: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as { goal?: unknown };
  setState(threadId, { goal: normalizeGoal(d.goal) });
}

/** 订阅当前线程的目标快照 */
export function useGoalState(threadId: string | undefined): GoalStoreState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () =>
      threadId
        ? (states.get(storeKey(threadId, true)) ?? EMPTY_GOAL_STATE)
        : EMPTY_GOAL_STATE,
    () => EMPTY_GOAL_STATE,
  );
}

/** 目标进行中（自治循环正在跑）：常驻条的运行态判据 */
export function useActiveGoal(threadId: string | undefined): GoalSnapshot | null {
  const goal = useGoalState(threadId).goal;
  return goal && goal.status === "active" ? goal : null;
}

/**
 * 拉取 sidecar 侧目标快照并水合（刷新 / 切线程 / 切档后常驻条要立刻恢复）。
 * 没有已知 sessionId 的线程（未发送草稿）直接跳过：sidecar 不可能持有它的目标，
 * 而请求会懒建空白会话（污染）。
 */
export function fetchGoalState(threadId: string): Promise<void> {
  if (!piSessionIdForThread(threadId)) return Promise.resolve();
  return requestGoal(threadId, { type: "get_goal_state" });
}

async function requestGoal(
  threadId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const sessionId = piSessionIdForThread(threadId);
  // 回包的 goal 形状由 normalizeGoal 逐字段复核后才进 store，不直接信它
  const res = await piRequest<{ type: "goal_state"; goal: GoalState["goal"] }>({
    ...payload,
    threadId,
    ...(sessionId ? { sessionId } : {}),
  });
  setState(threadId, { goal: normalizeGoal(res?.goal) });
}

/**
 * 常驻条的动作（继续 / 清除）。
 *
 * 不做乐观更新：这些动作的落点是目标状态机（resume 会清零轮次与停滞计数、
 * clear 要落一行 goal_state），前端算不出正确的新盘面，等 sidecar 回包刷新。
 */
export function resumeGoalNow(threadId: string): Promise<void> {
  return requestGoal(threadId, { type: "goal_resume" });
}

export function clearGoalNow(threadId: string): Promise<void> {
  return requestGoal(threadId, { type: "goal_clear" });
}

/* ---------------- 测试缝 ---------------- */

/** 测试钩子：直读某线程目标快照（与 hook 同源数据，绕开渲染器） */
export const goalSnapshotForTest = (threadId: string): GoalStoreState =>
  states.get(storeKey(threadId)) ?? EMPTY_GOAL_STATE;

/**
 * 改这条目标的轮数上限（常驻条上点分母改的就是它）。
 * value = null 表示不限。调低到已跑轮数以下时 sidecar 会顺手暂停目标，
 * 前端不做乐观更新——新盘面以回包为准。
 *
 * sidecar 同时把这次的值写进会话偏好列（这个会话的下一条目标就从它开始），
 * 所以回包后顺手刷一次偏好镜像，条上显示的预设才不会落后一格。
 */
export function setGoalLimitNow(
  threadId: string,
  maxAutoTurns: number | null,
): Promise<void> {
  return requestGoal(threadId, { type: "goal_set_limit", maxAutoTurns }).then(() =>
    refreshSessionPrefs(),
  );
}
