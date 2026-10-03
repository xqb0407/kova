"use client";

import { useSyncExternalStore } from "react";
import {
  piSessionIdForThread,
  piSessionPrefsMap,
} from "@/lib/pi/pi-thread-adapter";

/**
 * 目标轮数上限：会话偏好（记忆）+ 本次应用运行里的显式修改（覆盖层）。
 *
 * 上限本身是**每条目标自己的**字段（Goal.maxAutoTurns，随目标落盘），但「这个会话
 * 我习惯用多少」是会话级的，落在 `sessions.goal_max_turns` 偏好列——与 model /
 * 思考档位同型（见 sidecar 的 resolve.ts 与 goal.ts 的 rememberGoalMaxTurns）。
 * 于是有两个来源，取舍是：
 *
 * - **本次运行里没改过** → 请求不带这个字段，让 sidecar 按它自己的
 *   「请求 → 会话偏好 → 默认 300」裁决。前端在这里补一个默认值只会把会话记忆冲掉。
 * - **改过** → 这个显式值优先，随首条消息发给 sidecar 建目标，并由 sidecar 回写
 *   会话偏好列，下一条目标就从这个数开始。
 *
 * 显示走 `useGoalTurnDraft`（显式值 → 会话偏好 → 默认）：条上显示的就是建目标时
 * 真正会用的那个数，不会出现「条上写 300、实际建出来 100」。
 */

/** 与 sidecar DEFAULT_MAX_AUTO_TURNS 同值；0 = 不限 */
export const DEFAULT_GOAL_TURN_DRAFT = 300;

/** 用户在条上可填的范围（0 单独表示不限），与 sidecar 的钳位口径一致 */
export const GOAL_TURN_DRAFT_MIN = 1;
export const GOAL_TURN_DRAFT_MAX = 5_000;

/** 0 = 不限 */
export type GoalTurnDraft = number;

/** threadId -> 本次运行里用户显式改过的值（没有条目 = 没改过，交给会话偏好） */
const overrides = new Map<string, GoalTurnDraft>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 规整：0 = 不限原样保留；脏值回落默认；越界钳位 */
export function normalizeGoalTurnDraft(raw: unknown): GoalTurnDraft {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_GOAL_TURN_DRAFT;
  const n = Math.round(raw);
  if (n === 0) return 0;
  if (n < 0) return DEFAULT_GOAL_TURN_DRAFT;
  return Math.min(GOAL_TURN_DRAFT_MAX, Math.max(GOAL_TURN_DRAFT_MIN, n));
}

/**
 * 会话偏好列（数字字符串，"0" = 不限）→ 数值。
 * 三态：null = 本会话定过「不限」；undefined = 从未定过；number = 具体轮数。
 * `""` 与脏值都按「从未定过」——空串是列被显式清空的形态，等价于没记忆。
 */
export function parseSessionGoalTurnsPref(
  raw: string | null | undefined,
): number | null | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return undefined;
  return n === 0 ? null : normalizeGoalTurnDraft(n);
}

/** 某个线程当前生效的上限（显示用）：显式值 → 会话偏好 → 默认 */
export function getGoalTurnDraft(threadId: string): GoalTurnDraft {
  const explicit = overrides.get(threadId);
  if (explicit !== undefined) return explicit;
  const sessionId = piSessionIdForThread(threadId);
  if (sessionId) {
    const pref = parseSessionGoalTurnsPref(piSessionPrefsMap.get(sessionId)?.goalMaxTurns);
    // pref === null 是「本会话定过不限」：要显示成 0，不能回落默认
    if (pref === null) return 0;
    if (pref !== undefined) return pref;
  }
  return DEFAULT_GOAL_TURN_DRAFT;
}

/**
 * 随 prompt 请求发送的值。
 *
 * **没改过就返回 undefined**（请求里不带这个字段），让 sidecar 走它自己的裁决。
 */
export function goalTurnDraftForSend(threadId: string): number | undefined {
  return overrides.get(threadId);
}

export function setGoalTurnDraft(raw: unknown, threadId: string): void {
  const next = normalizeGoalTurnDraft(raw);
  if (overrides.get(threadId) === next) return;
  overrides.set(threadId, next);
  emit();
}

export function useGoalTurnDraft(threadId: string | undefined): GoalTurnDraft {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? getGoalTurnDraft(threadId) : DEFAULT_GOAL_TURN_DRAFT),
    () => DEFAULT_GOAL_TURN_DRAFT,
  );
}

/** 测试缝 */
export function resetGoalTurnDraftForTest(): void {
  overrides.clear();
}
