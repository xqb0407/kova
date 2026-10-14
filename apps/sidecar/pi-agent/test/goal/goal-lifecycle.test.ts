/**
 * 目标与 run 生命周期的接缝：这一层出过的都是「状态对了但没人跑」类的问题，
 * 症状全是「常驻条说一套、实际干另一套」，而且没有异常、没有报错。
 *
 * 三条被钉住的因果：
 * 1. 循环唯一的驱动源是「有 run 在飞 + turn_end」，所以**只改状态不会让它跑起来**；
 * 2. 离开 goal 档时目标必须收尾，否则它会永远挂在 active 上（切档后没有任何
 *    代码会再去停机它——续跑判定被 run.mode === "goal" 门着）；
 * 3. 我们自己的续跑注入不能被当成「用户接管」，否则 resume 当场自杀。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  continueGoalTurn,
  confirmGoalCriteria,
  getGoal,
  goalTokensUsed,
  pauseGoalOnModeExit,
  rejectGoalCriteria,
  restoreGoal,
  resume,
  setGoalMaxTurns,
  setGoalObjective,
  skipGoalCriteria,
  startGoal,
  syncGoalOnUserPrompt,
  commitGoal,
} from "../../src/goal/goal";
import { goalContinueText } from "../../src/goal/goal-continuation";
import {
  createGoal,
  limitsFor,
  MAX_GOAL_OBJECTIVE_LENGTH,
  proposeCriteria,
  type Goal,
} from "../../src/goal/goal-state";
import { parseGoalMaxTurnsPref } from "../../src/goal/goal";
import { appendGoalStateRow } from "../../src/sessions/transcript";
import { GOAL_CONTINUE_PREFIX } from "pi-protocol";
import type { Running } from "../../src/types";

let seq = 0;

function makeRun(over: Partial<Running> = {}): Running {
  seq += 1;
  return {
    // followUp 是续跑注入点（fake 上只需存在：本文件测的是结算，不是注入）
    agent: { state: { messages: [] }, followUp: () => {} } as unknown as Running["agent"],
    threadId: `t-goal-${seq}`,
    sessionId: `s-goal-${seq}`,
    cwd: ".",
    mode: "goal",
    // 真实 run 由 resolveSession 构造，这个累加器必定存在（message_end 直接 += ）
    usagePending: 0,
    ...over,
  } as unknown as Running;
}

afterEach(() => {
  // 槽位是模块级 Map：每个用例用自己的 threadId，不需要显式清理
});

describe("resume 只搬状态，起轮是 handler 的活", () => {
  test("resume 把 paused 搬回 active 并清零轮次（起轮由 kickGoalLoop 负责）", () => {
    const run = makeRun();
    startGoal(run, "把 README 补全");
    const first = getGoal(run.threadId)!;
    commitGoal(run, { ...first, status: "paused", turnCount: 9, pauseReason: "x" });

    const resumed = resume(run)!;
    expect(resumed.status).toBe("active");
    expect(resumed.turnCount).toBe(0);
  });

  test("没有目标时 resume 返回 undefined（handler 据此抛错，不留半截状态）", () => {
    expect(resume(makeRun())).toBeUndefined();
  });
});

describe("续跑注入不会被当成用户接管", () => {
  test("带哨兵前缀的文本：active 目标不被暂停（这是 resume 能跑通的前提）", () => {
    const run = makeRun();
    const goal = startGoal(run, "把 README 补全");
    syncGoalOnUserPrompt(run, goalContinueText(goal, limitsFor(goal)));
    expect(getGoal(run.threadId)!.status).toBe("active");
  });

  test("普通用户消息仍然接管：暂停 + 清零安全 epoch", () => {
    // 执行阶段才有「接管」可言：契约定下来之后用户插话就是在叫停当前方向。
    // 协商阶段的插话是补充需求，不是接管（那两条在下面「验收标准契约的生命周期」里）
    const run = makeRun();
    const goal = startGoal(run, "把 README 补全");
    commitGoal(run, skipGoalCriteria(run)!);
    expect(goal.acceptance?.status).toBe("pending");
    syncGoalOnUserPrompt(run, "等一下，先别改那个文件");
    const after = getGoal(run.threadId)!;
    expect(after.status).toBe("paused");
    expect(after.pauseReason).toContain("user sent a message");
  });

  test("哨兵文本也不会被误当成「首条消息即目标」", () => {
    // 目标被清掉之后迟到的续跑注入：不能凭空建一条目标，把注入文本当目标原文
    const run = makeRun();
    syncGoalOnUserPrompt(run, `${GOAL_CONTINUE_PREFIX} Continuing the active goal (turn 3).`);
    expect(getGoal(run.threadId)).toBeUndefined();
  });
});

describe("验收标准契约的生命周期", () => {
  /** 建目标 → 模型提议 → 落到 proposed（用户确认之前的常态） */
  const withProposal = (run: Running, items = ["pnpm test 全绿", "README 有 API 章节"]): Goal => {
    const goal = startGoal(run, "把 README 补全");
    const proposed = proposeCriteria(goal, items)!;
    commitGoal(run, proposed);
    return proposed;
  };

  test("新目标从协商阶段起步（pending），不是直接开跑", () => {
    const run = makeRun();
    const goal = startGoal(run, "把 README 补全");
    expect(goal.acceptance?.status).toBe("pending");
    expect(goal.negotiationTurns).toBe(0);
  });

  test("提议分配服务端 id，确认后转 confirmed 并保留清单", () => {
    const run = makeRun();
    withProposal(run);
    const confirmed = confirmGoalCriteria(run)!;
    expect(confirmed.acceptance?.status).toBe("confirmed");
    expect(confirmed.acceptance?.status === "confirmed" && confirmed.acceptance.items.map((c) => c.id)).toEqual([
      "c1",
      "c2",
    ]);
  });

  test("确认只在 proposed 态成立（没有待确认的契约时返回 undefined）", () => {
    const run = makeRun();
    startGoal(run, "x");
    expect(confirmGoalCriteria(run)).toBeUndefined();
  });

  test("驳回把清单退回 pending 并带回意见，协商计数归零重来", () => {
    const run = makeRun();
    const proposed = withProposal(run);
    commitGoal(run, { ...proposed, negotiationTurns: 2 });
    const rejected = rejectGoalCriteria(run, "第二条太宽泛")!;
    expect(rejected.acceptance?.status).toBe("pending");
    expect(rejected.acceptance?.status === "pending" && rejected.acceptance.feedback).toBe("第二条太宽泛");
    // 用户明确表了态，不该把上一轮的协商计数继续算在模型头上
    expect(rejected.negotiationTurns).toBe(0);
  });

  test("跳过直接进执行阶段，且不会退化成「没协商过」", () => {
    // 这是 skipped 单独成态的理由：若用 undefined 兼表「跳过」，
    // 下一轮又会要求模型提议标准，用户点了跳过却出不去
    const run = makeRun();
    startGoal(run, "x");
    const skipped = skipGoalCriteria(run)!;
    expect(skipped.acceptance?.status).toBe("skipped");
    // 再跳一次是幂等的，不会把已确认的契约抹掉
    expect(skipGoalCriteria(run)!.acceptance?.status).toBe("skipped");
  });

  test("已确认的契约不能被跳过覆盖（那道门是用户亲手开的）", () => {
    const run = makeRun();
    withProposal(run);
    confirmGoalCriteria(run);
    expect(skipGoalCriteria(run)).toBeUndefined();
    expect(getGoal(run.threadId)!.acceptance?.status).toBe("confirmed");
  });

  test("proposed 阶段的用户消息是对标准的意见，不是接管目标", () => {
    // 分叉点很实际：用户看着待确认的清单回一句「第 2 条不对」，那是在改契约。
    // 按接管处理会把刚提交的标准连目标一起挂起，用户还得再点一次「继续」
    const run = makeRun();
    withProposal(run);
    syncGoalOnUserPrompt(run, "第二条不对，改成覆盖所有导出函数");
    const after = getGoal(run.threadId)!;
    expect(after.status).toBe("active"); // 没被暂停
    expect(after.acceptance?.status).toBe("pending");
    expect(after.acceptance?.status === "pending" && after.acceptance.feedback).toContain("第二条不对");
  });

  test("协商阶段（标准都还没提出来）的用户消息是补充需求，同样不暂停", () => {
    // 模型此刻本来就在读工作区、还没动手，「顺便把 X 也算上」是这一步的常态。
    // 按接管处理会把目标暂停，用户得先点「继续」才能让协商接着走——而那条消息
    // 本身已经进了对话，模型下一轮照样读得到，暂停只是白白多一次点击
    const run = makeRun();
    startGoal(run, "把 README 补全");
    commitGoal(run, { ...getGoal(run.threadId)!, turnCount: 4, stallTurns: 2 });
    syncGoalOnUserPrompt(run, "顺便把 API 章节也写上");
    const after = getGoal(run.threadId)!;
    expect(after.status).toBe("active");
    expect(after.pauseReason).toBeUndefined();
    // 用户给了新输入，安全 epoch 该重新起算（否则「继续」的起点不干净）
    expect(after.turnCount).toBe(0);
    expect(after.stallTurns).toBe(0);
  });

  test("契约已生效后用户消息照常接管（恢复原有语义）", () => {
    const run = makeRun();
    withProposal(run);
    confirmGoalCriteria(run);
    syncGoalOnUserPrompt(run, "换个方向");
    expect(getGoal(run.threadId)!.status).toBe("paused");
  });

  test("跳过之后用户消息也照常接管（skipped 不特殊）", () => {
    const run = makeRun();
    startGoal(run, "x");
    skipGoalCriteria(run);
    syncGoalOnUserPrompt(run, "换个方向");
    expect(getGoal(run.threadId)!.status).toBe("paused");
  });

  test("驳回意见跨过一次重提：模型改完再提交时用户还看得到自己提过什么", () => {
    // 提议时就丢掉意见的话，「上一版为什么被退回」在卡片上永远显示不出来——
    // 而用户复审新版时最需要的就是「我提的那点它真改了吗」
    const run = makeRun();
    const goal = startGoal(run, "把 README 补全");
    commitGoal(run, proposeCriteria(goal, ["测试全绿"])!);
    rejectGoalCriteria(run, "太宽泛，要指名具体命令");
    commitGoal(run, proposeCriteria(getGoal(run.threadId)!, ["pnpm test 全绿"])!);
    const after = getGoal(run.threadId)!;
    expect(after.acceptance?.status).toBe("proposed");
    expect(after.acceptance?.status === "proposed" && after.acceptance.feedback).toBe(
      "太宽泛，要指名具体命令",
    );
    // 确认之后意见就解决了，不再携带
    const confirmed = confirmGoalCriteria(run)!;
    expect(confirmed.acceptance?.status).toBe("confirmed");
    expect("feedback" in confirmed.acceptance! ? confirmed.acceptance.feedback : undefined).toBeUndefined();
  });

  test("重启回放：老转录行（没有 acceptance 字段）回落 skipped，不要求补标准", () => {
    // 升级后每一条在跑的历史目标都不该突然停下、要求用户重来一遍契约
    const run = makeRun();
    const legacy = { ...createGoal("老目标"), acceptance: undefined } as unknown as Goal;
    restoreGoal(run.threadId, run.sessionId);
    commitGoal(run, legacy);
    // 直接走一次续跑判定：skipped 应走执行块而不是协商块
    continueGoalTurn(run, { role: "assistant", content: [{ type: "text", text: "干活" }] });
    expect(getGoal(run.threadId)!.negotiationTurns).toBe(0);
  });
});

describe("改目标原文", () => {
  const currentGoal = (run: Running) => getGoal(run.threadId)!;

  test("协商阶段改：原文换掉，契约还停在 pending", () => {
    const run = makeRun();
    startGoal(run, "把 README 补全");
    const after = setGoalObjective(run, "把鉴权模块重构完")!;
    expect(after.objective).toBe("把鉴权模块重构完");
    expect(after.acceptance?.status).toBe("pending");
  });

  test("已提议的标准作废重谈——那套判据是按旧目标提的", () => {
    // 留着旧标准比没有更糟：模型会拿对不上目标的判据去收工，而且完成对账
    // 还会一本正经地逐条核对它
    const run = makeRun();
    const goal = startGoal(run, "把 README 补全");
    commitGoal(run, proposeCriteria(goal, ["README 有 API 章节"])!);
    const after = setGoalObjective(run, "把鉴权模块重构完")!;
    expect(after.acceptance?.status).toBe("pending");
    // 作废必须说明原因：不说的话模型看见的只是「再提一次标准」，而旧列表还
    // 躺在转录里，它多半会原样再交一遍
    expect(after.acceptance?.status === "pending" && after.acceptance.feedback).toContain(
      "edited the goal objective",
    );
  });

  test("已确认的契约同样作废：旧契约不能管新目标", () => {
    const run = makeRun();
    const goal = startGoal(run, "把 README 补全");
    commitGoal(run, proposeCriteria(goal, ["README 有 API 章节"])!);
    commitGoal(run, confirmGoalCriteria(run)!);
    const after = setGoalObjective(run, "换个目标：修 CI")!;
    expect(after.acceptance?.status).toBe("pending");
  });

  test("跳过过标准的目标保持跳过：不借这次改动把门装回去", () => {
    const run = makeRun();
    startGoal(run, "把 README 补全");
    commitGoal(run, skipGoalCriteria(run)!);
    const after = setGoalObjective(run, "换个目标：修 CI")!;
    expect(after.acceptance?.status).toBe("skipped");
  });

  test("轮次与停滞计数重新起算（新目标不背旧预算）", () => {
    const run = makeRun();
    const goal = startGoal(run, "把 README 补全");
    commitGoal(run, { ...goal, turnCount: 40, stallTurns: 2, negotiationTurns: 3 });
    const after = setGoalObjective(run, "换个目标：修 CI")!;
    expect(after.turnCount).toBe(0);
    expect(after.stallTurns).toBe(0);
    expect(after.negotiationTurns).toBe(0);
    // token 账不清：那是这条目标真实烧掉的，用户要靠它看消耗
    expect(after.tokensUsed).toBe(goal.tokensUsed);
  });

  test("一字未改是空操作：不该顺手把契约作废", () => {
    const run = makeRun();
    const goal = startGoal(run, "把 README 补全");
    commitGoal(run, proposeCriteria(goal, ["a"])!);
    const after = setGoalObjective(run, "  把 README 补全  ")!;
    expect(after.acceptance?.status).toBe("proposed");
    expect(after).toBe(currentGoal(run));
  });

  test("已完成的目标不接受改（是收工记录，不是待办）", () => {
    const run = makeRun();
    const goal = startGoal(run, "把 README 补全");
    commitGoal(run, { ...goal, status: "complete" });
    expect(setGoalObjective(run, "再来一次")).toBeUndefined();
    expect(currentGoal(run).objective).toBe("把 README 补全");
  });

  test("空白与超长文本被拒", () => {
    const run = makeRun();
    startGoal(run, "把 README 补全");
    expect(setGoalObjective(run, "   ")).toBeUndefined();
    expect(setGoalObjective(run, "x".repeat(MAX_GOAL_OBJECTIVE_LENGTH + 1))).toBeUndefined();
    expect(currentGoal(run).objective).toBe("把 README 补全");
  });

  test("无目标时返回 undefined", () => {
    expect(setGoalObjective(makeRun(), "随便")).toBeUndefined();
  });
});

describe("离开 goal 档收尾", () => {  test("active 目标转 paused，理由写明是切档（不删目标，切回来还能接着做）", () => {
    const run = makeRun();
    startGoal(run, "把 README 补全");
    pauseGoalOnModeExit(run);
    const after = getGoal(run.threadId)!;
    expect(after.status).toBe("paused");
    expect(after.pauseReason).toContain("user left goal mode");
  });

  test("已经停下的目标不重复迁移（幂等）", () => {
    const run = makeRun();
    startGoal(run, "x");
    const paused = { ...getGoal(run.threadId)!, status: "paused" as const, pauseReason: "先停的" };
    commitGoal(run, paused);
    pauseGoalOnModeExit(run);
    expect(getGoal(run.threadId)!.pauseReason).toBe("先停的");
  });

  test("无目标时什么都不做", () => {
    expect(() => pauseGoalOnModeExit(makeRun())).not.toThrow();
  });
});

describe("per-goal 轮次上限", () => {
  test("建目标时带上的预设值随目标走", () => {
    const run = makeRun();
    expect(startGoal(run, "x", 50).maxAutoTurns).toBe(50);
    expect(startGoal(run, "x", 0).maxAutoTurns).toBeNull();
    expect(startGoal(run, "x").maxAutoTurns).toBe(300);
  });

  test("改上限只动这个字段", () => {
    const run = makeRun();
    startGoal(run, "x", 50);
    expect(setGoalMaxTurns(run, 800)!.maxAutoTurns).toBe(800);
    expect(getGoal(run.threadId)!.status).toBe("active");
  });

  test("调低到已跑轮数以下会顺手暂停，不留「上限 50 却跑了 120 轮」的自相矛盾", () => {
    const run = makeRun();
    const goal = startGoal(run, "x", 500);
    commitGoal(run, { ...goal, turnCount: 120 });
    const after = setGoalMaxTurns(run, 50)!;
    expect(after.status).toBe("paused");
    expect(after.pauseReason).toContain("automatic turn limit lowered");
  });

  test("无目标时返回 undefined", () => {
    expect(setGoalMaxTurns(makeRun(), 10)).toBeUndefined();
  });
});

/** 造一个「run 上攒了 pending」的视图（真实累加点在 stream.ts / settleDelegation） */
function saveRunWithPending(run: Running, pending: number): Running {
  return { ...run, usagePending: pending };
}

describe("目标 token 账（现累器语义）", () => {
  test("已结算的数 + run 上未结算的增量", () => {
    const run = makeRun();
    const goal = startGoal(run, "x");
    commitGoal(run, { ...goal, tokensUsed: 500 });
    expect(goalTokensUsed(saveRunWithPending(run, 120))).toBe(620);
  });

  test("无目标时读数就是 run 上的增量（不会凭空读出一个会话总量）", () => {
    expect(goalTokensUsed(saveRunWithPending(makeRun(), 42))).toBe(42);
  });

  test("轮边界结算：增量折进目标并清零累加器（同一笔不会记两次）", () => {
    const run = makeRun();
    startGoal(run, "x");
    run.usagePending = 300;
    continueGoalTurn(run, { role: "assistant", content: [{ type: "text", text: "干了点活" }], stopReason: "stop" });
    expect(getGoal(run.threadId)!.tokensUsed).toBe(300);
    expect(run.usagePending).toBe(0);
    // 再结算一次没有新增，账不变
    continueGoalTurn(run, { role: "assistant", content: [{ type: "text", text: "又干了点" }], stopReason: "stop" });
    expect(getGoal(run.threadId)!.tokensUsed).toBe(300);
  });

  test("暂停期间攒下的增量**不**记进目标（用户接管那一轮的开销不算目标的）", () => {
    const run = makeRun();
    const goal = startGoal(run, "x");
    commitGoal(run, { ...goal, status: "paused", tokensUsed: 100 });
    run.usagePending = 9_999; // 模拟暂停期间用户自己聊了几轮
    continueGoalTurn(run, { role: "assistant", content: [{ type: "text", text: "回答用户的题外话" }], stopReason: "stop" });
    expect(getGoal(run.threadId)!.tokensUsed).toBe(100);
    expect(run.usagePending).toBe(0);
  });

  test("建目标清零累加器：之前同一 run 里花的不算这条目标的", () => {
    const run = makeRun();
    run.usagePending = 5_000;
    const goal = startGoal(run, "x");
    expect(goal.tokensUsed).toBe(0);
    expect(run.usagePending).toBe(0);
  });

  test("惰性累加值单调：结算出来的数永远不会比上一次小", () => {
    const run = makeRun();
    startGoal(run, "x");
    let last = 0;
    for (const pending of [100, 50, 1_000]) {
      run.usagePending = pending;
      continueGoalTurn(run, { role: "assistant", content: [{ type: "text", text: `第 ${pending} 轮` }], stopReason: "stop" });
      const now = getGoal(run.threadId)!.tokensUsed;
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect(last).toBe(1_150);
  });
});

describe("会话偏好作为兜底预设", () => {
  test("请求没带值 → 用会话偏好", () => {
    const run = makeRun({ goalMaxTurns: 120 });
    expect(startGoal(run, "x").maxAutoTurns).toBe(120);
  });

  test("请求带了值 → 覆盖会话偏好（用户当场填的优先）", () => {
    const run = makeRun({ goalMaxTurns: 120 });
    expect(startGoal(run, "x", 50).maxAutoTurns).toBe(50);
  });

  test("会话偏好是「不限」(null) 时不能回落默认 300", () => {
    const run = makeRun({ goalMaxTurns: null });
    expect(startGoal(run, "x").maxAutoTurns).toBeNull();
  });

  test("会话偏好从未定过 (undefined) → 默认 300", () => {
    expect(startGoal(makeRun(), "x").maxAutoTurns).toBe(300);
  });

  test("首条消息即目标时同款取值顺序", () => {
    const run = makeRun({ goalMaxTurns: 77 });
    syncGoalOnUserPrompt(run, "把 README 补全");
    expect(getGoal(run.threadId)!.maxAutoTurns).toBe(77);
  });
});

describe("会话偏好列的编解码（三态分得开）", () => {
  test('"0" 解成不限，NULL/空串/脏值解成「从未定过」', () => {
    expect(parseGoalMaxTurnsPref("0")).toBeNull();
    for (const raw of [null, undefined, "", "  ", "abc", "-3"]) {
      expect(parseGoalMaxTurnsPref(raw)).toBeUndefined();
    }
    expect(parseGoalMaxTurnsPref("120")).toBe(120);
  });
});

describe("重启恢复", () => {
  test("回放出的 active 降级为 paused——驱动它的 run 已经随进程没了", () => {
    // readGoalState 从 JSONL 回放，这里直接灌一条 active 目标模拟「关进程时在跑」
    const run = makeRun({ sessionId: "s-restore-active" });
    const goal = { ...createGoal("把 README 补全", 700), turnCount: 12, tokensUsed: 500 };
    appendGoalStateRow(run.sessionId, goal);

    restoreGoal(run.threadId, run.sessionId);
    const restored = getGoal(run.threadId)!;
    expect(restored.status).toBe("paused");
    expect(restored.pauseReason).toContain("sidecar restarted");
    // 上限与计数原样带回来：重启不该偷偷放宽安全阀，也不该把账清了
    expect(restored.maxAutoTurns).toBe(700);
    expect(restored.turnCount).toBe(12);
  });

  test("token 账随目标行原样回来（单调累加值，不需要任何基线补偿）", () => {
    const run = makeRun({ sessionId: "s-restore-baseline" });
    const goal = { ...createGoal("x", 100), tokensUsed: 123_456 };
    appendGoalStateRow(run.sessionId, goal);

    restoreGoal(run.threadId, run.sessionId);
    expect(goalTokensUsed(run)).toBe(123_456);
    expect(goalTokensUsed(saveRunWithPending(run, 1_000))).toBe(124_456);
  });
});
