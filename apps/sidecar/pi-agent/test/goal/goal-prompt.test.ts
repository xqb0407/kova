/**
 * 目标提示词块的状态敏感性。
 *
 * 回归的是一条真实症状：目标 paused 之后条上写着「已暂停」，但模型在用户的下一条
 * 消息里继续埋头干目标——因为静态模式段（GOAL_MODE_PROMPT）通篇是「别收手、别问、
 * 系统会自动续下一轮」，而它不随状态变化。动态块必须在停下时把这段话显式撤销。
 */
import { describe, expect, test } from "bun:test";
import { GOAL_MODE_PROMPT, goalPromptBlock } from "../../src/goal/prompt";
import { createGoal, type Goal } from "../../src/goal/goal-state";

const goal = (over: Partial<Goal> = {}): Goal => ({
  ...createGoal("把 README 补全"),
  ...over,
});

describe("active 目标块", () => {
  test("含目标原文与 goal_id", () => {
    const block = goalPromptBlock(goal({ turnCount: 4 }));
    expect(block).toContain("把 README 补全");
    expect(block).toContain("Goal id:");
  });

  test("跨轮字节稳定：轮次计数不得进系统块（前缀缓存回归）", () => {
    // 生产实测：goal 会话 439/442 个请求 cacheRead=0，两小时运行重复计费 2 千多万
    // tokens——系统消息里嵌了每轮 +1 的 `This is turn N of the goal.`，而服务端
    // 前缀缓存以系统消息为界，一个字节变了整段缓存全废。轮次改随续跑消息走尾部。
    const base = goal({ turnCount: 0 });
    const first = goalPromptBlock(base);
    const later = goalPromptBlock({ ...base, turnCount: 17 });
    expect(later).toBe(first);
    expect(first).not.toContain("This is turn");
  });

  test("含信任边界声明（目标文本是用户输入，可能带注入）", () => {
    expect(goalPromptBlock(goal())).toContain("user-provided task data");
  });
});

describe("非 active 目标块：撤销自治指令", () => {
  test("paused 时明确说没有循环在跑，且模式段那套纪律不适用", () => {
    const block = goalPromptBlock(goal({ status: "paused" }));
    expect(block).toContain('status="paused"');
    expect(block).toContain("no autonomous loop is running");
    // 必须逐条点名被撤销的是什么，否则模型仍会按模式段行事
    expect(block).toContain("do NOT apply right now");
    expect(block).toContain("Nothing will start the next turn automatically");
  });

  test("不再给出「这是第 N 轮」的推进读数——那是 active 的盘面", () => {
    expect(goalPromptBlock(goal({ status: "paused" }))).not.toContain("of the goal.");
  });

  test("blocked / complete 各有对应的状态句", () => {
    expect(goalPromptBlock(goal({ status: "blocked" }))).toContain("reported blocked");
    expect(goalPromptBlock(goal({ status: "complete" }))).toContain("already complete");
  });

  test("模型仍拿得到目标原文（它常是用户下一句话的指代对象）", () => {
    for (const status of ["paused", "blocked", "complete"] as const) {
      expect(goalPromptBlock(goal({ status }))).toContain("把 README 补全");
    }
  });

  test("不禁止模型回答用户，只禁止它自作主张续跑目标", () => {
    const block = goalPromptBlock(goal({ status: "paused" }));
    expect(block).toContain("answer that request normally");
    expect(block).toContain("Do not resume the goal on your own initiative");
  });
});

describe("无目标", () => {
  test("返回空串（静态模式段已承担契约，不能出现第二遍）", () => {
    expect(goalPromptBlock(null)).toBe("");
  });
});

describe("静态模式段的性质（这几点是动态块必须存在的理由）", () => {
  test("模式段确实在要求跨轮继续、不要问用户——所以停下时必须由动态块撤销", () => {
    expect(GOAL_MODE_PROMPT).toContain("automatically starts the next turn");
    expect(GOAL_MODE_PROMPT).toContain("Do not wrap up, hand back, or ask whether to continue");
  });
});
