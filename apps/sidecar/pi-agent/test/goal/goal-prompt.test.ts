/**
 * 目标提示词块的状态敏感性。
 *
 * 两条真实症状把它钉在这里：
 * 1. 目标 paused 之后条上写着「已暂停」，但模型在用户的下一条消息里继续埋头干
 *    目标——静态模式段（GOAL_MODE_PROMPT）通篇是「别收手、别问、系统会自动续下
 *    一轮」，而它不随状态变化。动态块必须在停下时把这段话显式撤销。
 * 2. 契约阶段（协商中 / 等确认）同理：那两段里模型**不该动手**，而模式段整篇
 *    在鼓励动手，所以动态块必须逐条撤销，否则它会直接开始改文件。
 */
import { describe, expect, test } from "bun:test";
import { GOAL_MODE_PROMPT, goalPromptBlock } from "../../src/goal/prompt";
import { createGoal, skipCriteria, type Goal } from "../../src/goal/goal-state";

/** 执行阶段（用户跳过了验收标准）：本文件里「原有执行块」的那一组 */
const goal = (over: Partial<Goal> = {}): Goal => ({
  ...skipCriteria(createGoal("把 README 补全"))!,
  ...over,
});

/** 协商阶段：新目标还没提议标准 */
const negotiating = (over: Partial<Goal> = {}): Goal => ({
  ...createGoal("把 README 补全"),
  ...over,
});

/** 已确认契约的执行阶段 */
const confirmed = (over: Partial<Goal> = {}): Goal => ({
  ...createGoal("把 README 补全"),
  acceptance: {
    status: "confirmed",
    items: [
      { id: "c1", text: "pnpm test 全绿" },
      { id: "c2", text: "README 有 API 章节" },
    ],
    confirmedAt: 1,
  },
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

  test("契约生效后同样字节稳定：标准清单是静态契约，不进任何逐轮字段", () => {
    // 标准清单进系统块的前提就是它在确认那一刻定死了；轮次/用量/对账进度
    // 一律不得混进来，否则又回到「每轮全价重算」
    const base = confirmed({ turnCount: 0 });
    const first = goalPromptBlock(base);
    expect(goalPromptBlock({ ...base, turnCount: 42 })).toBe(first);
    expect(goalPromptBlock({ ...base, tokensUsed: 999_999 })).toBe(first);
    expect(first).not.toContain("This is turn");
  });

  test("含信任边界声明（目标文本是用户输入，可能带注入）", () => {
    expect(goalPromptBlock(goal())).toContain("user-provided task data");
  });
});

describe("契约阶段：协商中", () => {
  test("明确这一轮只读，并点名要调 goal_propose_criteria", () => {
    const block = goalPromptBlock(negotiating());
    expect(block).toContain("goal_propose_criteria");
    expect(block).toContain("READ-ONLY");
    // 必须显式撤销模式段的自治指令：那一段整篇在鼓励动手
    expect(block).toContain("do NOT apply yet");
    expect(block).toContain("Do not create, overwrite, delete");
  });

  test("带上了用户的驳回意见（模型无处可知哪里不满意）", () => {
    const block = goalPromptBlock(
      negotiating({ acceptance: { status: "pending", feedback: "第二条太空泛" } }),
    );
    expect(block).toContain("第二条太空泛");
    expect(block).toContain("Do not resubmit the same list unchanged");
  });

  test("没有意见时不留驳回段落", () => {
    expect(goalPromptBlock(negotiating())).not.toContain("rejected your previous criteria");
  });

  test("不给执行期纪律：此刻谈完成判定为时过早", () => {
    expect(goalPromptBlock(negotiating())).not.toContain("Goal-mode rules:");
  });
});

describe("契约阶段：等用户确认", () => {
  test("列出待确认的清单，并明确禁止动手与调用 goal_complete", () => {
    const block = goalPromptBlock(
      negotiating({
        acceptance: {
          status: "proposed",
          items: [{ id: "c1", text: "pnpm test 全绿" }],
        },
      }),
    );
    expect(block).toContain("c1. pnpm test 全绿");
    expect(block).toContain("waiting for the user");
    expect(block).toContain("do not call goal_complete");
    expect(block).toContain("No autonomous turn is running");
  });
});

describe("契约生效：执行块带对账纪律", () => {
  test("清单按 id 列出，且明说缺条目会被拒", () => {
    const block = goalPromptBlock(confirmed());
    expect(block).toContain("c1. pnpm test 全绿");
    expect(block).toContain("c2. README 有 API 章节");
    expect(block).toContain("rejected outright if any criterion is missing");
  });

  test("跳过标准时不出现对账段（用户已经明确不要这道门）", () => {
    const block = goalPromptBlock(goal());
    expect(block).not.toContain("Acceptance criteria");
    expect(block).toContain("Goal-mode rules:");
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
