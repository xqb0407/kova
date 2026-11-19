/**
 * todo-stale 能力：存在 in_progress 任务但连续 N 个回合没有写过 todo，
 * 通过 turn 收尾注入一条「更新任务状态」提醒——长会话里任务清单漂移
 * （做完不勾、跳步不记）会让 todo 从导航仪退化成噪声。
 *
 * - 阈值默认 10，可经能力参数 todo-stale-reminder.threshold 覆盖；
 * - 有 todo 写入即重置计数与提醒位；无 in_progress 任务时不计数；
 * - 每段连续停更只提醒一次；
 * - 任何检测/回调失败都 fail open。
 */
import { logAt, logErr } from "../../../log";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import { getTodoState } from "../../../todo/todo";
import { TODO_TOOL_NAME } from "../../../todo/todo-state";
import type { Capability, TurnEndInfo, TurnSnapshot } from "../contracts";
import { readCapabilityParams } from "../settings";

const DEFAULT_THRESHOLD = 10;

const REMINDER_TEXT =
  "Your task list has tasks in progress but hasn't been updated for a while. " +
  "Update it now: mark completed work done immediately, and add tasks for anything new you've taken on. " +
  "Exactly one task stays in_progress at a time.";

function readThreshold(): number {
  const value = readCapabilityParams("todo-stale-reminder").threshold;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_THRESHOLD;
}

function hasInProgressTask(threadId: string): boolean {
  try {
    return getTodoState(threadId).tasks.some((task) => task.status === "in_progress");
  } catch {
    return false;
  }
}

type StaleState = {
  turnsSinceWrite: number;
  reminded: boolean;
};

/** 状态表上限：按会话/回合 key 增长；超出时丢最旧的（与 loop-guard 同策略）。 */
const MAX_TRACKED_RUNS = 64;

export function todoStaleReminderCapability(): Capability {
  const states = new Map<string, StaleState>();

  function stateFor(snapshot: TurnSnapshot): StaleState {
    const key = `${snapshot.sessionId}\u0000${snapshot.turnId}`;
    let state = states.get(key);
    if (!state) {
      const prefix = `${snapshot.sessionId}\u0000`;
      for (const existing of states.keys()) {
        if (existing.startsWith(prefix) && existing !== key) states.delete(existing);
      }
      while (states.size >= MAX_TRACKED_RUNS) {
        const oldest = states.keys().next().value;
        if (oldest === undefined) break;
        states.delete(oldest);
      }
      state = { turnsSinceWrite: 0, reminded: false };
      states.set(key, state);
    }
    return state;
  }

  return {
    id: "todo-stale-reminder",
    title: "Nudge the model to update a stale task list",
    defaultEnabled: true,
    disposeSession(sessionId) {
      const prefix = `${sessionId}\u0000`;
      for (const key of states.keys()) {
        if (key.startsWith(prefix)) states.delete(key);
      }
    },
    install(host) {
      host.onToolAfter((context: AfterToolCallContext, snapshot: TurnSnapshot) => {
        try {
          if (context.toolCall.name !== TODO_TOOL_NAME || context.isError) return undefined;
          // 一次成功写入即重置：状态机回到「新鲜」
          stateFor(snapshot).turnsSinceWrite = 0;
        } catch (error) {
          logErr("capability:todo-stale-reminder: observe failed:", error);
        }
        return undefined;
      }, 200);

      host.onTurnEnd((info: TurnEndInfo, snapshot: TurnSnapshot) => {
        try {
          if (info.stopRequested) return;
          const state = stateFor(snapshot);
          if (!hasInProgressTask(snapshot.threadId)) return;
          state.turnsSinceWrite += 1;
          if (state.turnsSinceWrite < readThreshold() || state.reminded) return;
          state.reminded = true;
          logAt(
            "event",
            `todo-stale-reminder: ${state.turnsSinceWrite} turns without todo write in ${snapshot.sessionId}`,
          );
          info.queueReminder(REMINDER_TEXT);
        } catch (error) {
          logErr("capability:todo-stale-reminder: turn:end failed:", error);
        }
      }, 200);
    },
  };
}
