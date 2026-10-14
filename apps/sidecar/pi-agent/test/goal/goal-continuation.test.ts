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
import {
  decideContinuation,
  makeGoalContinueMessage,
  makeGoalNegotiationMessage,
} from "../../src/goal/goal-continuation";
import { createGoal, skipCriteria, type Goal } from "../../src/goal/goal-state";
import { GOAL_CONTINUE_PREFIX } from "pi-protocol";

const LIMITS = { maxAutoTurns: 5, maxStallTurns: 3 };

/**
 * 执行阶段的目标：本文件测的是协商结束之后的判定（停机阀、进展检测）。
 *
 * 必须显式跳过验收标准——新目标从 pending（协商轮）起步，不跳过的话
 * decideContinuation 会走协商分支，这里所有断言测的就都不是它想测的东西了。
 * 协商阶段自己的判定在文件末尾单独一组。
 */
const goal = (over: Partial<Goal> = {}): Goal => ({
  ...skipCriteria(createGoal("把 README 补全"))!,
  ...over,
});

/** 协商阶段的目标（pending，还没提议标准） */
const negotiatingGoal = (over: Partial<Goal> = {}): Goal => ({
  ...createGoal("把 README 补全"),
  ...over,
});

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

describe("契约阶段：协商中 / 等确认", () => {
  test("协商轮没提议就继续，注入的是协商指令而不是执行续跑", () => {
    const d = decideContinuation(negotiatingGoal(), msg("我看了一圈"), 0, LIMITS);
    expect(d.action).toBe("continue");
    if (d.action !== "continue") return;
    expect(d.goal.negotiationTurns).toBe(1);
    const text = textOf(d.message);
    expect(text.startsWith(GOAL_CONTINUE_PREFIX)).toBe(true); // 前缀：不被判成用户接管
    expect(text).toContain("goal_propose_criteria");
    // 协商轮必须明说别动手——执行续跑那条说的是「接着干目标」
    expect(text).toContain("Do not modify any file");
    expect(text).not.toContain("call goal_complete");
  });

  test("协商轮照常结算用量：drainUsagePending 清零后传进来的 token 不能丢", () => {
    // continueGoalTurn 里 drainUsagePending 会先把 run.usagePending 清零再传进来，
    // 协商分支若提前 return 而不结算，这批 token 就凭空消失且没有任何症状
    const d = decideContinuation(negotiatingGoal(), msg("勘察"), 1234, LIMITS);
    if (d.action !== "continue") throw new Error("expected continue");
    expect(d.goal.tokensUsed).toBe(1234);
    expect(d.goal.turnCount).toBe(1);
  });

  test("连续协商无果达上限 → 暂停（不能永远只勘察不提议）", () => {
    let g = negotiatingGoal();
    let last = decideContinuation(g, msg("我看了一圈"), 0, LIMITS);
    for (let i = 0; i < 3; i++) {
      if (last.action === "stop") break;
      g = last.goal;
      last = decideContinuation(g, msg("我看了一圈"), 0, LIMITS);
    }
    expect(last.action).toBe("stop");
    expect(last.goal.status).toBe("paused");
    expect(last.goal.pauseReason).toContain("no acceptance criteria proposed");
  });

  test("勘察轮不计入协商预算：读文件多少轮都不算空转", () => {
    // 大仓库里跑十几轮勘察才提得出可验证标准是常态。这条阀要抓的是「只说不做」
    // 的原地打转，不是刨得深——把勘察也数进去等于惩罚认真读代码的模型
    let g = negotiatingGoal();
    for (let i = 0; i < 12; i++) {
      const d = decideContinuation(g, msg("读了一批文件", ["read", "grep"]), 0, LIMITS);
      if (d.action !== "continue") throw new Error(`第 ${i + 1} 轮就被停了`);
      expect(d.goal.negotiationTurns).toBe(0);
      g = d.goal;
    }
    expect(g.status).toBe("active");
  });

  test("勘察与空转交替：空转计数被勘察清零，凑不满上限", () => {
    // 否则模型可以靠「读一个文件再发一轮呆」的空转拖到天荒地老
    let g = negotiatingGoal();
    for (let i = 0; i < 5; i++) {
      const idle = decideContinuation(g, msg("我再想想"), 0, LIMITS);
      if (idle.action !== "continue") throw new Error("空转轮不该直接停");
      const work = decideContinuation(idle.goal, msg("读了点东西", ["read"]), 0, LIMITS);
      if (work.action !== "continue") throw new Error("勘察轮不该被停");
      expect(work.goal.negotiationTurns).toBe(0);
      g = work.goal;
    }
    expect(g.status).toBe("active");
  });

  test("已提议等确认 → 停轮，且不消耗协商计数", () => {
    const proposed = negotiatingGoal();
    const withProposal: Goal = {
      ...proposed,
      acceptance: {
        status: "proposed",
        items: [{ id: "c1", text: "pnpm test 全绿" }],
      },
    };
    const d = decideContinuation(withProposal, msg("提交标准"), 500, LIMITS);
    expect(d.action).toBe("stop");
    // 用量照样入账，但既不续跑也不涨协商计数（等的是用户，不是模型）
    expect(d.goal.tokensUsed).toBe(500);
    expect(d.goal.negotiationTurns).toBe(0);
    expect(d.goal.status).toBe("active");
  });

  test("协商阶段的停机阀不参与判定：轮次已满也先等用户", () => {
    // 语义是「这一轮该不该继续」而不是「还能不能继续」——协商都还没完成，
    // 拿轮次上限先把目标停掉是错的
    const proposed: Goal = {
      ...negotiatingGoal({ turnCount: LIMITS.maxAutoTurns }),
      acceptance: { status: "proposed", items: [{ id: "c1", text: "x" }] },
    };
    const d = decideContinuation(proposed, msg("提交"), 0, LIMITS);
    expect(d.action).toBe("stop");
    expect(d.goal.status).toBe("active");
    expect(d.goal.pauseReason).toBeUndefined();
  });

  test("协商注入也重述目标原文", () => {
    const text = textOf(makeGoalNegotiationMessage(negotiatingGoal()));
    expect(text).toContain("把 README 补全");
  });
});
