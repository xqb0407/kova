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

/** 一条验收标准（id 由 sidecar 分配，UI 只展示与回传） */
export type Criterion = { id: string; text: string };

/**
 * 验收标准契约的四态。UI 据它决定待确认卡片出不出来、条上写什么状态——
 * 注意「待确认」时 goal.status 仍是 active（循环并没有跑，只是停着等人），
 * 所以**不能**只看 status 渲染运行态，那是「条上说在跑、实际没跑」的老毛病。
 */
export type AcceptanceStatus = "pending" | "proposed" | "confirmed" | "skipped";

export type GoalAcceptance = {
  status: AcceptanceStatus;
  items: Criterion[];
  /** 用户驳回意见（status = pending 时有意义） */
  feedback?: string;
};

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
  acceptance?: GoalAcceptance;
};

export type GoalStoreState = { goal: GoalSnapshot | null };

export const EMPTY_GOAL_STATE: GoalStoreState = { goal: null };

/** 契约阶段（proposed/pending）时循环停着，条上不能报「进行中」 */
export function isGoalAwaitingConfirmation(goal: GoalSnapshot): boolean {
  return goal.status === "active" && goal.acceptance?.status === "proposed";
}

export function isGoalNegotiating(goal: GoalSnapshot): boolean {
  return goal.status === "active" && goal.acceptance?.status === "pending";
}

/** 已生效的验收标准（其余阶段返回空数组，调用方无需再判 status） */
export function confirmedCriteria(goal: GoalSnapshot): Criterion[] {
  return goal.acceptance?.status === "confirmed" ? goal.acceptance.items : [];
}

function normalizeAcceptance(raw: unknown): GoalAcceptance | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as { status?: unknown; items?: unknown; feedback?: unknown };
  const status = a.status;
  if (
    status !== "pending" &&
    status !== "proposed" &&
    status !== "confirmed" &&
    status !== "skipped"
  ) {
    return undefined;
  }
  const items: Criterion[] = [];
  if (Array.isArray(a.items)) {
    for (const entry of a.items) {
      if (!entry || typeof entry !== "object") continue;
      const c = entry as { id?: unknown; text?: unknown };
      if (typeof c.id !== "string" || typeof c.text !== "string") continue;
      items.push({ id: c.id, text: c.text });
    }
  }
  return {
    status,
    items,
    ...(typeof a.feedback === "string" ? { feedback: a.feedback } : {}),
  };
}

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
  const acceptance = normalizeAcceptance(g.acceptance);
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
    ...(acceptance ? { acceptance } : {}),
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

/* ------------------------ 验收标准契约的三个决定 ------------------------ */

/**
 * 改目标原文（点常驻条上的目标文字改的就是它）。
 *
 * 与「协商阶段直接在对话里补一句」不同：那是在现有目标上加要求，这是换掉目标。
 * sidecar 会按契约阶段决定标准要不要作废重谈（proposed/confirmed 一律作废——
 * 那套标准是按旧目标提的，留着只会让模型拿对不上的判据收工）。
 */
export function setGoalObjectiveNow(threadId: string, objective: string): Promise<void> {
  return requestGoal(threadId, { type: "goal_set_objective", objective });
}

/**
 * 确认待确认的标准（并可选一并改这条目标的权限档）。
 *
 * 权限档跟确认绑在一起是有实际理由的：默认 ask 档下每条 write/bash 都要弹审批卡，
 * 而这个目标要跑几十上百轮。让用户在「确认契约」这一步就决定它跑在哪个档，
 * 比跑到第 30 轮才发现要一条条点确认强。sidecar 会把它写进审批级别的偏好列
 * （下次切换会话沿用），所以回包后顺手刷一次偏好镜像。
 */
export function confirmGoalCriteriaNow(
  threadId: string,
  approvalLevel?: string,
): Promise<void> {
  return requestGoal(threadId, {
    type: "goal_confirm_criteria",
    ...(approvalLevel ? { approvalLevel } : {}),
  }).then(() => (approvalLevel ? refreshSessionPrefs() : undefined));
}

/** 驳回并带上意见——模型下一轮协商据此重提，不带意见等于让它猜 */
export function rejectGoalCriteriaNow(
  threadId: string,
  feedback: string,
): Promise<void> {
  return requestGoal(threadId, { type: "goal_reject_criteria", feedback });
}

/** 用户不想要这道门：直接进执行阶段，完成时不做对账 */
export function skipGoalCriteriaNow(threadId: string): Promise<void> {
  return requestGoal(threadId, { type: "goal_skip_criteria" });
}
