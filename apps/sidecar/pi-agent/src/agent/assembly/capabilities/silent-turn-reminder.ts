/**
 * silent-turn 能力：连续 N 个回合模型没有任何用户可见输出（只发工具调用、
 * 文本为空或占位符），通过 turn 收尾注入一条「汇报进展」提醒。
 *
 * - 阈值默认 5，可经能力参数 silent-turn-reminder.threshold 覆盖；
 * - 每段连续静默只提醒一次（用户可见输出即重置计数与提醒位）；
 * - 排队提醒只在循环确认继续时注入，最后一轮自动丢弃，绝不留到下一次用户 prompt；
 * - 任何检测/回调失败都 fail open。
 */
import { logAt, logErr } from "../../../log";
import type { Capability, TurnEndInfo, TurnSnapshot } from "../contracts";
import { readCapabilityParams } from "../settings";

const DEFAULT_THRESHOLD = 5;

/** 只有空白或这些占位文字的 assistant 文本不算与用户沟通（口径对齐成熟实现）。 */
const PLACEHOLDER_TEXTS: ReadonlySet<string> = new Set(["(no content)", "No response requested."]);

const REMINDER_TEXT =
  "The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell — a finding, a change of plan.";

function isVisibleText(text: string | undefined): boolean {
  const trimmed = (text ?? "").trim();
  return trimmed.length > 0 && !PLACEHOLDER_TEXTS.has(trimmed);
}

function readThreshold(): number {
  const value = readCapabilityParams("silent-turn-reminder").threshold;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_THRESHOLD;
}

type StretchState = {
  silentTurns: number;
  reminded: boolean;
};

/** 状态表上限：按会话/回合 key 增长；超出时丢最旧的（与 loop-guard 同策略）。 */
const MAX_TRACKED_RUNS = 64;

export function silentTurnReminderCapability(): Capability {
  const states = new Map<string, StretchState>();

  function stateFor(snapshot: TurnSnapshot): StretchState {
    const key = `${snapshot.sessionId}\u0000${snapshot.turnId}`;
    let state = states.get(key);
    if (!state) {
      // 同一会话进入新的一轮用户 prompt：丢掉上一轮的状态，避免无界增长。
      const prefix = `${snapshot.sessionId}\u0000`;
      for (const existing of states.keys()) {
        if (existing.startsWith(prefix) && existing !== key) states.delete(existing);
      }
      while (states.size >= MAX_TRACKED_RUNS) {
        const oldest = states.keys().next().value;
        if (oldest === undefined) break;
        states.delete(oldest);
      }
      state = { silentTurns: 0, reminded: false };
      states.set(key, state);
    }
    return state;
  }

  return {
    id: "silent-turn-reminder",
    title: "Nudge the model to report progress after silent turns",
    defaultEnabled: true,
    disposeSession(sessionId) {
      const prefix = `${sessionId}\u0000`;
      for (const key of states.keys()) {
        if (key.startsWith(prefix)) states.delete(key);
      }
    },
    install(host) {
      host.onTurnEnd((info: TurnEndInfo, snapshot: TurnSnapshot) => {
        try {
          if (info.stopRequested) return;
          const state = stateFor(snapshot);
          if (isVisibleText(info.assistantText)) {
            state.silentTurns = 0;
            state.reminded = false;
            return;
          }
          state.silentTurns += 1;
          if (state.silentTurns < readThreshold() || state.reminded) return;
          state.reminded = true;
          logAt(
            "event",
            `silent-turn-reminder: ${state.silentTurns} silent turns in ${snapshot.sessionId}`,
          );
          info.queueReminder(REMINDER_TEXT);
        } catch (error) {
          logErr("capability:silent-turn-reminder: turn:end failed:", error);
        }
      }, 200);
    },
  };
}
