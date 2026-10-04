/**
 * goal 模式的轮边界续跑决策（纯函数层，零副作用）。
 *
 * 时序契约（改 pi-agent-core 升级时必须复查）：
 *   turn_end 监听器 settle 之后、vendor 循环退出之前，循环恰好轮询一次 followUp
 *   队列——长度截断续跑（stream.ts makeAutoContinueMessage）就是靠这条契约生效的，
 *   本模块复用同一入口（run.agent.followUp）而不是另造一套唤醒机制。
 *
 * 判定顺序敏感，逐条短路：
 *   1. provider 报错 / 被中止 → 暂停（不是「做完了」，只是不能再盲目重试）
 *   2. 轮次上限
 *   3. 无进展停滞
 * 顺序即优先级：先问「这轮还能不能继续」，再问「还该不该继续」。两条停机阀谁先
 * 谁后无所谓——触到任意一条都只是停，不存在「另一条会给出更好理由」的情况。
 *
 * 「模型自己收了尾」不在这里判：goal_complete / goal_blocked 在工具的 execute 里
 * 就把状态改好了，所以函数开头那次 status 检查已经覆盖它。曾经在这里加过一个
 * 「本轮出现过目标工具调用就停」的分支，本意是兜底「工具被 modeBeforeToolCall 拦掉」
 * 的情形，结果只有 bug：那个场景下 run.mode 已不是 goal，stream.ts 根本不会调到这里
 *（见 stream.ts 的 turn_end 分支），于是这个分支只在**工具被拒**时执行——stale guard
 * 拒掉旧 goal_id、或摘要命中「说没做完」的正则——一次误判就终止整个目标。
 */
import {
  hasSubstantiveToolCall,
  nextStallState,
  resetSafetyEpoch,
  settleGoalTurn,
  transitionGoal,
  type Goal,
} from "./goal-state";
import { GOAL_CONTINUE_PREFIX } from "pi-protocol";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** 决策结果：续跑（注入哪条消息）+ 结算后的目标盘面 */
export type ContinuationDecision =
  | { action: "continue"; goal: Goal; message: AgentMessage }
  | { action: "stop"; goal: Goal; reason?: string };

/** 终局的 stopReason：这三种都意味着 provider 已经不在正常工作，续跑只会重复失败 */
const TERMINAL_STOP_REASONS = new Set(["error", "aborted"]);

/**
 * 一个 turn 结束后的续跑决策。
 *
 * @param goal      结算前的目标盘面
 * @param message   本轮的 assistant 消息（判终局 / 停滞用）
 * @param tokensUsed 会话累计 token（与目标建立时的基线作差后的目标内用量）
 * @param limits    安全阀参数
 */
export function decideContinuation(
  goal: Goal,
  message: unknown,
  tokensUsed: number,
  limits: { maxAutoTurns: number | null; maxStallTurns: number | null },
): ContinuationDecision {
  // 目标已经不在自治态：没有任何东西可以注入。
  // complete / blocked 由工具自己结算；paused 是人为停的，都不该被自动叫醒。
  if (goal.status !== "active") {
    return { action: "stop", goal, reason: `goal is ${goal.status}` };
  }

  const stopReason = (message as { stopReason?: string } | undefined)?.stopReason;
  if (typeof stopReason === "string" && TERMINAL_STOP_REASONS.has(stopReason)) {
    const paused = transitionGoal(goal, "paused", {
      expectedGoalId: goal.id,
      reason: `model turn ended with ${stopReason}`,
    });
    const settled = paused ?? resetSafetyEpoch(goal);
    return { action: "stop", goal: settled, reason: stopReason };
  }

  // 轮次 + 用量结算一次：停滞判定要落在本轮的输出上
  const settled = settleGoalTurn(goal, tokensUsed);

  // 2) 轮次上限
  if (limits.maxAutoTurns !== null && settled.turnCount >= limits.maxAutoTurns) {
    const paused = transitionGoal(settled, "paused", {
      expectedGoalId: settled.id,
      reason: `automatic turn limit reached (${settled.turnCount} turns)`,
    });
    return { action: "stop", goal: paused ?? settled, reason: "turn limit" };
  }

  // 3) 无进展停滞。判据用的是「有没有实质工具调用」：只有目标工具调用的轮次不算
  //    进展——那种轮次意味着 goal_complete/goal_blocked 被拒了（成功的会在函数开头
  //    就停掉），模型拿到的是一句「重新调用试试」，原地重复并不比什么都不做更前进
  const stall = nextStallState(settled, message, { substantiveToolCallsOnly: true });
  const withStall: Goal = { ...settled, ...stall };
  if (limits.maxStallTurns !== null && stall.stallTurns >= limits.maxStallTurns) {
    const paused = transitionGoal(withStall, "paused", {
      expectedGoalId: withStall.id,
      reason: `no progress across ${stall.stallTurns} consecutive turns`,
    });
    return { action: "stop", goal: paused ?? withStall, reason: "no progress" };
  }

  return {
    action: "continue",
    goal: withStall,
    message: makeGoalContinueMessage(withStall, limits),
  };
}

/**
 * 自动续跑注入的消息（user 角色 + 哨兵前缀，与 makeAutoContinueMessage 同构）。
 *
 * 必须把目标原文重述一遍，而不是只说「继续」：续跑轮的模型上下文里可能只剩
 * 一份摘要加自己上一轮的话，指望它自己记得目标原文是最常见的丢目标方式。
 *
 * 哨兵前缀让 UI 各路径能把它从用户气泡里滤掉（契约层 GOAL_CONTINUE_PREFIX）。
 */
export function makeGoalContinueMessage(
  goal: Goal,
  limits: { maxAutoTurns: number | null },
): AgentMessage {
  return goalUserMessage(goalContinueText(goal, limits), GOAL_CONTINUE_PREFIX);
}

/**
 * 续跑文本本体（**带哨兵前缀**，单源）。
 *
 * 两个消费方：轮边界的 followUp 注入（makeGoalContinueMessage 包成 AgentMessage），
 * 以及空闲时「点继续 → 补起一轮」的 dispatchPrompt。后者要求文本先带前缀，
 * 因为它在 runPromptTurn 里会经过 syncGoalOnUserPrompt——那条路靠前缀认出
 * 「这是系统的续跑注入，不是用户接管」，不加前缀刚 resume 就被自己暂停。
 */
export function goalContinueText(
  goal: Goal,
  limits: { maxAutoTurns: number | null },
): string {
  const turnLabel =
    limits.maxAutoTurns === null
      ? `turn ${goal.turnCount}`
      : `turn ${goal.turnCount} of ${limits.maxAutoTurns}`;
  return GOAL_CONTINUE_PREFIX + [
    `Continuing the active goal (${turnLabel}).`,
    "",
    "The goal is not done yet. Keep working on it from the current state of the workspace.",
    "",
    "<goal_objective>",
    goal.objective,
    "</goal_objective>",
    "",
    "If the goal is fully done and verified, call goal_complete. If you are truly stuck,",
    "call goal_blocked with the evidence. Otherwise keep going — do not summarize and stop.",
  ].join("\n");
}

/** user 角色 + 哨兵前缀的注入消息（走 followUp 队列的续跑消息都是这个形状） */
function goalUserMessage(body: string, prefix: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: prefix + body }],
    timestamp: Date.now(),
  } as AgentMessage;
}

/**
 * 用户输入接管：目标进行中来了非目标自有的消息 → 暂停并清零安全 epoch。
 *
 * 为什么必须重置：用户中途发一条消息通常是在纠偏。这条消息本身占了一轮上下文，
 * 之后模型拿到的是全新起点；继续沿用暂停前的轮次计数，等于让用户的纠偏白白
 * 吃掉半个轮次预算。
 *
 * @returns 暂停后的目标；原本就不 active 时原样返回（幂等）
 */
export function pauseForUserInput(goal: Goal): Goal {
  if (goal.status !== "active") return goal;
  const paused = transitionGoal(goal, "paused", {
    expectedGoalId: goal.id,
    reason: "user sent a message while the goal was running",
  });
  return resetSafetyEpoch(paused ?? goal);
}

/** 手动/UI 触发的恢复：paused | blocked → active，安全 epoch 清零 */
export function resumeGoal(goal: Goal): Goal {
  if (goal.status !== "paused" && goal.status !== "blocked") return goal;
  const active = transitionGoal(goal, "active", { expectedGoalId: goal.id });
  return resetSafetyEpoch(active ?? goal);
}