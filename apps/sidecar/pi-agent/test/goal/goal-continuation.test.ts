/**
 * 停机判定的矩阵。
 *
 * 这里测的是「顺序」而不只是「每一个能不能触发」——终局判定与两条停机阀短路在
 * 同一段代码里，顺序错了症状是隐蔽的：模型调完 goal_complete 之后如果还能被
 * 后续判定改写状态，用户看到的目标就既没完成也没暂停。
 *
 * 另外钉一条回归：token 用量再大也不产生任何停机判定（无 token 预算，见
 * goal-state.ts「为什么没有 token 预算」）。
 */
import { describe, expect, test } from "bun:test";
import { decideContinuation, makeGoalContinueMessage } from "../../src/goal/goal-continuation";
import { createGoal, type Goal } from "../../src/goal/goal-state";
import { GOAL_CONTINUE_PREFIX } from "pi-protocol";

const LIMITS = { maxAutoTurns: 5, maxStallTurns: 3 };

const goal = (over: Partial<Goal> = {}): Goal => ({ ...createGoal("把 README 补全"), ...over });

/** assistant 消息：文本 + 可选工具调用 */
const msg = (text: string, tools: string[] = [], over: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [
    ...(text ? [{ type: "text", text }] : []),
    ...tools.map((name, i) => ({ type: "toolCall", id: `c${i}`, name, arguments: {} })),
  ],
  ...over,
});

const textOf = (m: unknown): string => {
  const content = (m as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
};

describe("decideContinuation 判定顺序", () => {
  test("正常推进：结算一轮并注入续跑", () => {
    const d = decideContinuation(goal(), msg("我先看看现有实现", ["read"]), 0, LIMITS);
    expect(d.action).toBe("continue");
    if (d.action !== "continue") return;
    expect(d.goal.turnCount).toBe(1);
    expect(d.goal.tokensUsed).toBe(0);
    expect(textOf(d.message).startsWith(GOAL_CONTINUE_PREFIX)).toBe(true);
    // 目标原文必须重述——只说「继续」是最常见的丢目标方式
    expect(textOf(d.message)).toContain("把 README 补全");
  });

  test("工具已结算成 complete/blocked：函数开头就停，不重复结算", () => {
    // goal_complete 是在工具自己的 execute 里改的状态，走到 turn_end 时盘面已是终态，
    // 所以「模型收了尾」不需要专门的分支去判
    for (const status of ["complete", "blocked"] as const) {
      const d = decideContinuation(goal({ status }), msg("收尾", ["goal_complete"]), 0, LIMITS);
      expect(d.action).toBe("stop");
      expect(d.goal.status).toBe(status);
      expect(d.goal.turnCount).toBe(0);
    }
  });

  test("目标工具被拒（过期护栏 / 说没做完）不终止循环，继续跑", () => {
    // 工具被拒时目标还是 active：模型拿到的是一句「重新调用试试」，
    // 正确反应是接着干，而不是让整个目标在这里断掉
    const d = decideContinuation(goal(), msg("我宣布完成", ["goal_complete"]), 0, LIMITS);
    expect(d.action).toBe("continue");
    if (d.action !== "continue") return;
    expect(d.goal.status).toBe("active");
  });

  test("被拒轮不计进展：反复被拒会累积停滞并最终暂停", () => {
    // 删掉「有目标工具调用就停」的分支之后必须补上这条，否则模型可以靠
    // 反复用错 goal_id 空转到撞轮次上限
    let g = goal();
    let last = decideContinuation(g, msg("我完成了", ["goal_complete"]), 0, LIMITS);
    for (let i = 0; i < LIMITS.maxStallTurns; i++) {
      if (last.action === "stop") break;
      g = last.goal;
      last = decideContinuation(g, msg("我完成了", ["goal_complete"]), 0, LIMITS);
    }
    expect(last.action).toBe("stop");
    expect(last.goal.status).toBe("paused");
    expect(last.goal.pauseReason).toContain("no progress");
  });

  test("被拒轮里如果同时调了别的工具，仍算进展（不是空转）", () => {
    const d = decideContinuation(goal(), msg("我再看看", ["goal_complete", "bash"]), 0, LIMITS);
    if (d.action !== "continue") throw new Error("expected continue");
    expect(d.goal.stallTurns).toBe(0);
  });

  test("provider 报错 / 被中止：暂停而不是无限重试", () => {
    for (const stopReason of ["error", "aborted"]) {
      const d = decideContinuation(
        goal(),
        msg("做到一半", [], { stopReason }),
        0,
        LIMITS,
      );
      expect(d.action).toBe("stop");
      expect(d.goal.status).toBe("paused");
      expect(d.goal.pauseReason).toContain(stopReason);
    }
  });

  test("非 active 目标一律不唤醒（工具结算的终态与人停的态都算）", () => {
    for (const status of ["paused", "blocked", "complete"] as const) {
      const d = decideContinuation(goal({ status }), msg("又做了点事"), 0, LIMITS);
      expect(d.action).toBe("stop");
      expect(d.goal.turnCount).toBe(0); // 没结算任何东西
    }
  });
});

describe("安全阀 1：轮次上限", () => {
  test("到达上限即暂停，且注入消息绝不再来", () => {
    const d = decideContinuation(
      goal({ turnCount: LIMITS.maxAutoTurns - 1 }),
      msg("又一轮", ["read"]),
      0,
      LIMITS,
    );
    expect(d.action).toBe("stop");
    expect(d.goal.status).toBe("paused");
    expect(d.goal.pauseReason).toContain("turn limit");
  });

  test("maxAutoTurns = null 表示不限轮次", () => {
    const d = decideContinuation(
      goal({ turnCount: 999 }),
      msg("还在跑", ["read"]),
      0,
      { maxAutoTurns: null, maxStallTurns: 3 },
    );
    expect(d.action).toBe("continue");
  });
});

describe("安全阀 2：无进展检测", () => {
  /** 三轮零工具 + 完全相同输出 → 第三轮判停滞 */
  const threeIdenticalIdleTurns = (): Goal => {
    let g = goal();
    for (let i = 0; i < LIMITS.maxStallTurns; i++) {
      const d = decideContinuation(g, msg("我在想……"), 0, LIMITS);
      if (d.action === "stop") return d.goal;
      g = d.goal;
    }
    return g;
  };

  test("连续相同空转三轮 → 暂停", () => {
    const g = threeIdenticalIdleTurns();
    expect(g.status).toBe("paused");
    expect(g.pauseReason).toContain("no progress");
  });

  test("调过工具就一定在推进，停滞计数立即清零", () => {
    const g = goal({ stallTurns: 2, lastOutputFingerprint: "fp" });
    const d = decideContinuation(g, msg("完全一样的话", ["bash"]), 0, LIMITS);
    if (d.action !== "continue") throw new Error("expected continue");
    expect(d.goal.stallTurns).toBe(0);
  });

  test("输出变了就不算停滞（大小写/空白/全角差异归一后相同才算）", () => {
    let g = goal();
    const first = decideContinuation(g, msg("我在分析结构"), 0, LIMITS);
    if (first.action !== "continue") throw new Error("expected continue");
    g = first.goal;
    // 实质内容不同 → 重新计数到 1，不累加
    const second = decideContinuation(g, msg("我换个思路试试"), 0, LIMITS);
    if (second.action !== "continue") throw new Error("expected continue");
    expect(second.goal.stallTurns).toBe(1);
  });
});

describe("makeGoalContinueMessage", () => {
  test("带轮次读数，目标原文重述，含两个出口工具名", () => {
    const g = goal({ turnCount: 2 });
    const text = textOf(makeGoalContinueMessage(g, LIMITS));
    expect(text.startsWith(GOAL_CONTINUE_PREFIX)).toBe(true);
    expect(text).toContain("turn 2 of 5");
    expect(text).toContain("把 README 补全");
    expect(text).toContain("goal_complete");
    expect(text).toContain("goal_blocked");
  });

  test("token 用量不进入判定：用掉 10m token 仍在继续跑", () => {
    const d = decideContinuation(goal(), msg("还在推进", ["read"]), 10_000_000, LIMITS);
    expect(d.action).toBe("continue");
    if (d.action !== "continue") return;
    expect(d.goal.status).toBe("active");
    expect(d.goal.tokensUsed).toBe(10_000_000);
  });

  test("未设轮次上限时不写分母", () => {
    const text = textOf(makeGoalContinueMessage(goal({ turnCount: 7 }), { maxAutoTurns: null }));
    expect(text).toContain("turn 7");
    expect(text).not.toContain("of null");
  });
});
