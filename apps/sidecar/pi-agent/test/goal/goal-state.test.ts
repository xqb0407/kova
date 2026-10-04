import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_AUTO_TURNS,
  DEFAULT_MAX_STALL_TURNS,
  GOAL_TOOL_NAMES,
  createGoal,
  fingerprintAssistantOutput,
  formatGoalStatus,
  hasGoalToolCall,
  hasToolCall,
  isResumableStatus,
  limitsFor,
  isTransitionValid,
  hasSubstantiveToolCall,
  nextStallState,
  normalizeLoadedGoal,
  normalizeTurnLimitValue,
  setTurnLimit,
  resetSafetyEpoch,
  settleGoalTurn,
  transitionGoal,
  validateObjective,
  visibleAssistantText,
} from "../../src/goal/goal-state";

/** 构造一条 assistant 消息：text 块 + 可选 toolCall 块 */
function assistant(content: unknown[], stopReason = "stop"): unknown {
  return { role: "assistant", content, stopReason };
}

function textBlock(text: string) {
  return { type: "text", text };
}

function toolCallBlock(name: string) {
  return { type: "toolCall", name, id: "tc-1", args: {} };
}

describe("goal 状态迁移表", () => {
  test("同态迁移恒接受", () => {
    for (const s of ["active", "paused", "blocked", "complete"] as const) {
      expect(isTransitionValid(s, s)).toBe(true);
    }
  });

  test("complete 是唯一不可离开的终态", () => {
    for (const s of ["active", "paused", "blocked"] as const) {
      expect(isTransitionValid("complete", s)).toBe(false);
    }
  });

  test("paused / blocked 可 resume 回 active", () => {
    expect(isTransitionValid("paused", "active")).toBe(true);
    expect(isTransitionValid("blocked", "active")).toBe(true);
    expect(isResumableStatus("paused")).toBe(true);
    expect(isResumableStatus("blocked")).toBe(true);
    expect(isResumableStatus("complete")).toBe(false);
  });
});

describe("transitionGoal 过期护栏", () => {
  test("expectedGoalId 不匹配时拒绝迁移", () => {
    const goal = createGoal("重构鉴权模块");
    const next = transitionGoal(goal, "complete", {
      expectedGoalId: "some-other-id",
      summary: "做完了",
    });
    expect(next).toBeUndefined();
  });

  test("expectedGoalId 匹配时正常迁移", () => {
    const goal = createGoal("重构鉴权模块");
    const next = transitionGoal(goal, "complete", {
      expectedGoalId: goal.id,
      summary: "做完了",
    });
    expect(next?.status).toBe("complete");
    expect(next?.completionSummary).toBe("做完了");
  });

  test("不带 expectedGoalId 时不做护栏（内部迁移用）", () => {
    const goal = createGoal("重构鉴权模块");
    expect(transitionGoal(goal, "paused", { reason: "手动暂停" })?.status).toBe("paused");
  });

  test("非法迁移返回 undefined 而非抛异常", () => {
    const goal = { ...createGoal("x"), status: "complete" as const };
    expect(transitionGoal(goal, "active")).toBeUndefined();
  });

  test("离开 active 时丢弃指纹，resume 后第一轮不与暂停前比较", () => {
    const goal = settleGoalTurn(
      { ...createGoal("x"), lastOutputFingerprint: "a".repeat(64) },
      100,
    );
    expect(transitionGoal(goal, "paused", { reason: "r" })?.lastOutputFingerprint)
      .toBeUndefined();
  });

  test("complete 清掉 pauseReason；paused 写入 reason", () => {
    const goal = createGoal("x");
    const paused = transitionGoal(goal, "paused", { reason: "触到轮次上限" })!;
    expect(paused.pauseReason).toBe("触到轮次上限");
    const done = transitionGoal(paused, "complete", { summary: "s" })!;
    expect(done.pauseReason).toBeUndefined();
  });
});

describe("轮次结算与安全 epoch", () => {
  test("settleGoalTurn 轮数 +1 且落定用量", () => {
    const goal = createGoal("x");
    const settled = settleGoalTurn(goal, 1234);
    expect(settled.turnCount).toBe(1);
    expect(settled.tokensUsed).toBe(1234);
  });

  test("resetSafetyEpoch 清零轮次与停滞计数并丢弃指纹", () => {
    const goal = {
      ...createGoal("x"),
      turnCount: 9,
      stallTurns: 2,
      lastOutputFingerprint: "b".repeat(64),
    };
    const reset = resetSafetyEpoch(goal);
    expect(reset.turnCount).toBe(0);
    expect(reset.stallTurns).toBe(0);
    expect(reset.lastOutputFingerprint).toBeUndefined();
    // 目标本身与累计 token 不受影响
    expect(reset.objective).toBe(goal.objective);
    expect(reset.tokensUsed).toBe(goal.tokensUsed);
  });
});

describe("输出指纹归一化", () => {
  test("大小写/空白/全角差异归一后指纹相同", () => {
    const a = fingerprintAssistantOutput("我  正在检查  登录流程");
    const b = fingerprintAssistantOutput("我　正在检查\n登录流程");
    expect(a).toBe(b);
  });

  test("实质内容不同则指纹不同", () => {
    expect(fingerprintAssistantOutput("第一段")).not.toBe(
      fingerprintAssistantOutput("第二段"),
    );
  });

  test("空输出与纯标点返回 undefined（视为没输出）", () => {
    expect(fingerprintAssistantOutput("")).toBeUndefined();
    expect(fingerprintAssistantOutput("   ")).toBeUndefined();
    expect(fingerprintAssistantOutput("。。。 ***")).toBeUndefined();
  });
});

describe("消息盘面提取", () => {
  test("visibleAssistantText 只取 text 块", () => {
    const msg = assistant([
      { type: "thinking", thinking: "不该被算进指纹" },
      textBlock("第一段"),
      toolCallBlock("read"),
      textBlock("第二段"),
    ]);
    expect(visibleAssistantText(msg)).toBe("第一段\n第二段");
  });

  test("hasToolCall 识别工具调用", () => {
    expect(hasToolCall(assistant([textBlock("a"), toolCallBlock("bash")]))).toBe(true);
    expect(hasToolCall(assistant([textBlock("a")]))).toBe(false);
  });

  test("hasGoalToolCall 只认目标工具", () => {
    expect(
      hasGoalToolCall(assistant([toolCallBlock(GOAL_TOOL_NAMES.complete)]), [
        GOAL_TOOL_NAMES.complete,
        GOAL_TOOL_NAMES.blocked,
      ]),
    ).toBe(true);
    expect(
      hasGoalToolCall(assistant([toolCallBlock("bash")]), [
        GOAL_TOOL_NAMES.complete,
        GOAL_TOOL_NAMES.blocked,
      ]),
    ).toBe(false);
  });
});

describe("无进展检测推进", () => {
  const NAMES = [GOAL_TOOL_NAMES.complete, GOAL_TOOL_NAMES.blocked];

  test("零工具 + 输出与上轮相同 → 计数累加", () => {
    // 停滞盘面随轮次滚动：上一轮的 nextStallState 结果就是下一轮的入参盘面
    const goal = createGoal("x");
    const first = nextStallState(goal, assistant([textBlock("我卡住了")]));
    expect(first.stallTurns).toBe(1);
    const second = nextStallState(
      { ...goal, ...first },
      assistant([textBlock("我卡住了")]),
    );
    expect(second.stallTurns).toBe(2);
    const third = nextStallState(
      { ...goal, ...second },
      assistant([textBlock("我卡住了")]),
    );
    expect(third.stallTurns).toBe(3);
  });

  test("零工具 + 输出变化 → 计数归 1", () => {
    const goal = {
      ...createGoal("x"),
      stallTurns: 2,
      lastOutputFingerprint: fingerprintAssistantOutput("旧内容"),
    };
    const next = nextStallState(goal, assistant([textBlock("全新内容")]));
    expect(next.stallTurns).toBe(1);
  });

  test("调过工具 → 立即清零（一定在推进）", () => {
    const goal = {
      ...createGoal("x"),
      stallTurns: 2,
      lastOutputFingerprint: fingerprintAssistantOutput("我卡住了"),
    };
    const next = nextStallState(goal, assistant([toolCallBlock("read")]));
    expect(next.stallTurns).toBe(0);
  });

  test("本轮零输出 → 计数清零，不参与停滞判定", () => {
    const goal = { ...createGoal("x"), stallTurns: 2 };
    expect(nextStallState(goal, assistant([])).stallTurns).toBe(0);
    expect(NAMES.length).toBe(2);
  });
});

describe("状态摘要展示", () => {
  test("formatGoalStatus 各态给出一行摘要", () => {
    const goal = { ...createGoal("重构鉴权模块"), tokensUsed: 128_000 };
    expect(formatGoalStatus({ ...goal, turnCount: 2 })).toBe("进行中 · 第 3/300 轮 · 128k");
    expect(formatGoalStatus({ ...goal, status: "paused" })).toContain("已暂停");
    expect(formatGoalStatus({ ...goal, status: "blocked" })).toContain("受阻");
    expect(formatGoalStatus({ ...goal, status: "complete" })).toBe("已完成");
  });

  test("tokensUsed 再大也不产生停机判定：10m token 的目标仍在进行中", () => {
    const goal = { ...createGoal("x"), tokensUsed: 10_000_000 };
    expect(formatGoalStatus(goal)).toBe("进行中 · 第 1/300 轮 · 10m");
    expect(settleGoalTurn(goal, 10_000_000).status).toBe("active");
  });

  test("无上限时轮次不写分母", () => {
    const goal = createGoal("x", null);
    const limits = { ...limitsFor(goal), maxAutoTurns: null };
    expect(formatGoalStatus(goal, limits)).toContain("第 1 轮");
    expect(formatGoalStatus(goal, limits)).not.toContain("/300");
  });
});

describe("持久化快照卫生", () => {
  test("合法行原样还原", () => {
    const goal = createGoal("重构鉴权模块");
    const restored = normalizeLoadedGoal(JSON.parse(JSON.stringify(goal)), 0);
    expect(restored?.id).toBe(goal.id);
    expect(restored?.objective).toBe(goal.objective);
  });

  test("老行（没有 maxAutoTurns 字段）补默认值，不能补成不限", () => {
    // 补 null 会让一条历史目标突然变成「不限轮次」，反向放宽了安全阀
    const legacy = { ...createGoal("x") } as Record<string, unknown>;
    delete legacy.maxAutoTurns;
    expect(normalizeLoadedGoal(legacy, 0)?.maxAutoTurns).toBe(DEFAULT_MAX_AUTO_TURNS);
  });

  test("落盘的轮次上限原样带回来（含 null = 不限）", () => {
    expect(normalizeLoadedGoal(JSON.parse(JSON.stringify(createGoal("x", 42))), 0)?.maxAutoTurns)
      .toBe(42);
    expect(normalizeLoadedGoal(JSON.parse(JSON.stringify(createGoal("x", null))), 0)?.maxAutoTurns)
      .toBeNull();
  });

  test("畸形行整条丢弃", () => {
    expect(normalizeLoadedGoal(null, 0)).toBeUndefined();
    expect(normalizeLoadedGoal([], 0)).toBeUndefined();
    expect(normalizeLoadedGoal({ ...createGoal("x"), id: "" }, 0)).toBeUndefined();
    expect(normalizeLoadedGoal({ ...createGoal("x"), objective: "  " }, 0)).toBeUndefined();
    expect(
      normalizeLoadedGoal({ ...createGoal("x"), status: "weird" }, 0),
    ).toBeUndefined();
  });

  test("非法计数与指纹退回安全默认", () => {
    const restored = normalizeLoadedGoal(
      { ...createGoal("x"), turnCount: -5, stallTurns: 1.5, tokensUsed: "nope" },
      0,
    );
    expect(restored?.turnCount).toBe(0);
    expect(restored?.stallTurns).toBe(0);
    expect(restored?.tokensUsed).toBe(0);
  });
});

describe("per-goal 轮次上限", () => {
  test("createGoal 默认 300，可显式给值或给不限", () => {
    expect(createGoal("x").maxAutoTurns).toBe(300);
    expect(createGoal("x", 12).maxAutoTurns).toBe(12);
    expect(createGoal("x", null).maxAutoTurns).toBeNull();
  });

  test("normalizeTurnLimitValue：0/null = 不限，undefined/脏值 = 默认，越界钳位", () => {
    expect(normalizeTurnLimitValue(0)).toBeNull();
    expect(normalizeTurnLimitValue(null)).toBeNull();
    expect(normalizeTurnLimitValue(undefined)).toBe(DEFAULT_MAX_AUTO_TURNS);
    expect(normalizeTurnLimitValue(Number.NaN)).toBe(DEFAULT_MAX_AUTO_TURNS);
    expect(normalizeTurnLimitValue("300")).toBe(DEFAULT_MAX_AUTO_TURNS);
    expect(normalizeTurnLimitValue(-5)).toBe(DEFAULT_MAX_AUTO_TURNS);
    expect(normalizeTurnLimitValue(99_999)).toBe(5_000);
    expect(normalizeTurnLimitValue(12.6)).toBe(13);
  });

  test("setTurnLimit 只动上限，不动状态与计数", () => {
    const goal = { ...createGoal("x", 10), turnCount: 4, status: "active" as const };
    const next = setTurnLimit(goal, 50);
    expect(next.maxAutoTurns).toBe(50);
    expect(next.turnCount).toBe(4);
    expect(next.status).toBe("active");
    expect(next.id).toBe(goal.id);
  });

  test("limitsFor 用目标自己的上限，停滞阈值走全局常量", () => {
    expect(limitsFor(createGoal("x", 7))).toEqual({ maxAutoTurns: 7, maxStallTurns: DEFAULT_MAX_STALL_TURNS });
    expect(limitsFor(createGoal("x", null))).toEqual({ maxAutoTurns: null, maxStallTurns: 3 });
  });
});

describe("只有目标工具调用的轮次不算进展", () => {
  const onlyGoalTool = {
    role: "assistant",
    content: [{ type: "toolCall", name: "goal_complete", id: "t", args: {} }],
  };

  test("hasSubstantiveToolCall 把纯目标工具轮判为没干活", () => {
    expect(hasSubstantiveToolCall(onlyGoalTool)).toBe(false);
    expect(
      hasSubstantiveToolCall({
        role: "assistant",
        content: [
          { type: "toolCall", name: "goal_complete", id: "t", args: {} },
          { type: "toolCall", name: "bash", id: "u", args: {} },
        ],
      }),
    ).toBe(true);
  });

  test("带开关时，反复被拒的目标工具调用会累积停滞计数（空转能被抓住）", () => {
    let goal = createGoal("x");
    for (let i = 0; i < DEFAULT_MAX_STALL_TURNS; i++) {
      const stall = nextStallState(goal, { ...onlyGoalTool, content: [...onlyGoalTool.content, { type: "text", text: "我完成了" }] }, { substantiveToolCallsOnly: true });
      goal = { ...goal, ...stall };
    }
    expect(goal.stallTurns).toBe(DEFAULT_MAX_STALL_TURNS);
  });

  test("不带开关时保持旧语义（任何工具调用都清零）", () => {
    const stall = nextStallState(createGoal("x"), onlyGoalTool);
    expect(stall.stallTurns).toBe(0);
  });
});

describe("目标文本校验", () => {
  test("空白与超长被拒", () => {
    expect(validateObjective("   ")).toBeTruthy();
    expect(validateObjective("x".repeat(4_001))).toBeTruthy();
    expect(validateObjective(123)).toBeTruthy();
  });

  test("正常目标通过并被 trim", () => {
    expect(validateObjective("  重构鉴权模块  ")).toBeUndefined();
    expect(createGoal("  重构鉴权模块  ").objective).toBe("重构鉴权模块");
  });
});