/**
 * loop-guard 能力：观察同一回合内"同一个调用反复失败"，最多注入一次策略提醒。
 *
 * - 默认 shadow 模式：只记录，不干预（与现有 goal 续跑共存，不改变行为）。
 * - steer 模式：达到阈值后通过宿主提供的 steer 注入一条提醒；不 block、不中止。
 * - 任何检测 / 回调失败都 fail open；拿到一次成功调用即清空计数，避免误报。
 */
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import { logAt, logErr } from "../../../log";
import type { Capability, TurnEndInfo, TurnSnapshot } from "../contracts";
import { readCapabilityParams } from "../settings";

const DEFAULT_THRESHOLD = 3;
const FINGERPRINT_LIMIT = 512;
/** 状态表上限：按会话/回合 key 增长；超出时丢最旧的，避免长进程无界增长。 */
const MAX_TRACKED_TURNS = 64;

const REMINDER_TEXT =
  "You appear to have repeated the same failing tool call several times. " +
  "Stop and re-check the error: is it caused by the arguments, the path, or a missing " +
  "precondition? Change the approach (inspect the error, narrow the scope) instead of " +
  "retrying the same call verbatim.";

type TurnLoopState = {
  readonly failures: Map<string, number>;
  lastFingerprint: string;
  streak: number;
  pending: boolean;
  observed: boolean;
  reminded: boolean;
};

type LoopGuardOptions = {
  readonly threshold?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown, depth = 0): string {
  if (depth > 4) return "…";
  // 字符串先截断：write 等工具的参数可能带整篇文件内容，不能先物化再截。
  // 有意取舍：截断后"同一调用"退化为"同一前缀的调用"——两次不同的大文件
  // write（相同开头）会被判为重复。只按连续失败计数、成功即清零，误报面可控。
  if (typeof value === "string") {
    return JSON.stringify(value.length > 160 ? `${value.slice(0, 160)}…` : value);
  }
  if (value === null || typeof value !== "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  if (Array.isArray(value)) {
    return `[${value.slice(0, 20).map((entry) => stableValue(entry, depth + 1)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().slice(0, 30);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key], depth + 1)}`)
    .join(",")}}`;
}

function fingerprint(context: AfterToolCallContext): string {
  let args: string;
  try {
    args = stableValue(context.args);
  } catch {
    args = String(context.args);
  }
  return `${context.toolCall.name}:${args}`.slice(0, FINGERPRINT_LIMIT);
}

/** @internal 仅供测试：验证 fingerprint 在超大参数下仍保持长度上界。 */
export function __fingerprintForTest(context: AfterToolCallContext): string {
  return fingerprint(context);
}

function stateKey(snapshot: TurnSnapshot): string {
  return `${snapshot.sessionId}\u0000${snapshot.turnId}`;
}

function readThreshold(fallback: number): number {
  const value = readCapabilityParams("loop-guard").threshold;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function readMode(): "shadow" | "steer" {
  return readCapabilityParams("loop-guard").mode === "steer" ? "steer" : "shadow";
}

export function loopGuardCapability(options: LoopGuardOptions = {}): Capability {
  const defaultThreshold = options.threshold ?? DEFAULT_THRESHOLD;
  const states = new Map<string, TurnLoopState>();

  function stateFor(snapshot: TurnSnapshot): TurnLoopState {
    const key = stateKey(snapshot);
    let state = states.get(key);
    if (!state) {
      // 同一会话进入新的一轮用户 prompt：丢掉上一轮的状态，避免无界增长。
      const prefix = `${snapshot.sessionId}\u0000`;
      for (const existing of states.keys()) {
        if (existing.startsWith(prefix) && existing !== key) states.delete(existing);
      }
      while (states.size >= MAX_TRACKED_TURNS) {
        const oldest = states.keys().next().value;
        if (oldest === undefined) break;
        states.delete(oldest);
      }
      state = {
        failures: new Map(),
        lastFingerprint: "",
        streak: 0,
        pending: false,
        observed: false,
        reminded: false,
      };
      states.set(key, state);
    }
    return state;
  }

  return {
    id: "loop-guard",
    title: "Detect repeated failing tool calls",
    defaultEnabled: false,
    disposeSession(sessionId) {
      const prefix = `${sessionId}\u0000`;
      for (const key of states.keys()) {
        if (key.startsWith(prefix)) states.delete(key);
      }
    },
    install(host) {
      host.onToolAfter((context, snapshot) => {
        try {
          const state = stateFor(snapshot);
          state.observed = true;
          if (!context.isError) {
            state.failures.clear();
            state.streak = 0;
            state.lastFingerprint = "";
            // 已经恢复：之前达到阈值的待提醒状态作废，避免"纠错后被骂"。
            state.pending = false;
            return undefined;
          }

          const key = fingerprint(context);
          state.failures.set(key, (state.failures.get(key) ?? 0) + 1);
          state.streak = key === state.lastFingerprint ? state.streak + 1 : 1;
          state.lastFingerprint = key;

          const threshold = readThreshold(defaultThreshold);
          if (state.streak >= threshold) state.pending = true;
        } catch (error) {
          logErr("capability:loop-guard: observe failed:", error);
        }
        return undefined;
      }, 200);

      host.onTurnEnd((info: TurnEndInfo, snapshot: TurnSnapshot) => {
        if (info.stopRequested) return;
        // 没有 tool:after（例如只有文本轮）时也建一次状态，让 fallbackAllFailed
        // 能基于 turn_end 的 toolResults 兜底判断。
        const state = states.get(stateKey(snapshot)) ?? stateFor(snapshot);
        try {
          const threshold = readThreshold(defaultThreshold);
          const fallbackAllFailed =
            !state.observed &&
            info.toolResults.length >= threshold &&
            info.toolResults.every((result) => result.isError);
          if (!state.pending && !fallbackAllFailed) return;
          if (state.reminded) return;

          const mode = readMode();
          logAt(
            "event",
            `loop-guard: repeated failing tool call in ${snapshot.sessionId} ` +
              `(streak=${state.streak || info.toolResults.length}, mode=${mode})`,
          );
          state.reminded = true;
          state.pending = false;
          if (mode === "steer") info.queueReminder(REMINDER_TEXT);
        } catch (error) {
          logErr("capability:loop-guard: turn:end failed:", error);
        }
      }, 200);
    },
  };
}
