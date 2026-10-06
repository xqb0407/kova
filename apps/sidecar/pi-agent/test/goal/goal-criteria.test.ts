/**
 * 完成对账硬门的矩阵。
 *
 * 这一层挡的是自治循环最贵的一类错：模型把「范围缩小后的结果」或「一段总结」
 * 当成完成宣布。循环里没有人在旁边核对，所以判定必须落在代码上——
 * 提示词只负责让模型知道该交什么，这里负责它交不对时不给过。
 *
 * 三条被钉住的因果：
 * 1. 缺条目一律拒（含 id 不认识、重复、一个字都没交）；
 * 2. 有 unmet 就不算完成——目标继续跑，不能靠标几个 false 蒙混收工；
 * 3. 整条目标没调过任何非目标工具时拒——完成声明背后必须有动作。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGoalTools,
  commitGoal,
  confirmGoalCriteria,
  getGoal,
  goalStatePayload,
  markGoalWorkSeen,
  rejectGoalCriteria,
  startGoal,
} from "../../src/goal/goal";
import { sanitizeFileName } from "../../src/agent/artifact-naming";
import { flushGoalArtifactsForTest } from "../../src/goal/goal-artifact";
import { GOAL_TOOL_NAMES, MAX_CRITERIA, proposeCriteria, type Goal } from "../../src/goal/goal-state";
import type { Running } from "../../src/types";
import type { AgentTool } from "@earendil-works/pi-agent-core";

let seq = 0;
/** 本文件所有 run 的 cwd 落点：产物是 fire-and-forget 写的，指到真实工作区
 *  会往仓库里撒 .kova/goals/*.md（曾经就是这么撒的） */
let scratchDir = "";

beforeAll(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), "goal-criteria-cwd-"));
});

afterAll(async () => {
  // 先等在飞的写入落定再删目录：删早了会让 fire-and-forget 的写失败并刷一条
  // logErr，看起来像真错误
  await flushGoalArtifactsForTest();
  if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
});

function makeRun(over: Partial<Running> = {}): Running {
  seq += 1;
  return {
    agent: { state: { messages: [] }, followUp: () => {} } as unknown as Running["agent"],
    threadId: `t-crit-${seq}`,
    // 刻意不给 sessionId：给了就会往工作区追加 goal_state 行（commitGoal 的落盘
    // 分支），本文件测的不是持久化。要测回放的是 goal-lifecycle
    cwd: scratchDir,
    mode: "goal",
    usagePending: 0,
    ...over,
  } as unknown as Running;
}

/** 建目标 → 提议 → 确认，拿到执行阶段的工具表 */
function confirmedRun(items = ["pnpm test 全绿", "README 有 API 章节"]) {
  const run = makeRun();
  const goal = startGoal(run, "把 README 补全");
  commitGoal(run, proposeCriteria(goal, items)!);
  const confirmed = confirmGoalCriteria(run)!;
  const tools = buildGoalTools(run);
  const complete = tools.find((t) => t.name === GOAL_TOOL_NAMES.complete) as AgentTool;
  return { run, goal: confirmed, complete };
}

/** 调一次 goal_complete，返回它回给模型的文本 */
async function complete(
  tool: AgentTool,
  goalId: string,
  params: Record<string, unknown>,
): Promise<string> {
  const result = (await tool.execute("call-1", {
    goal_id: goalId,
    summary: "做完了",
    ...params,
  })) as { content: Array<{ type: string; text?: string }> };
  return result.content.map((c) => c.text ?? "").join("");
}

describe("协商阶段的工具表", () => {
  test("pending 只给 propose，proposed 一个都不给，confirmed 给 complete/blocked", () => {
    const run = makeRun();
    const goal: Goal = startGoal(run, "x");
    expect(buildGoalTools(run).map((t) => t.name)).toEqual([GOAL_TOOL_NAMES.propose]);

    const proposed = proposeCriteria(goal, ["a"])!;
    commitGoal(run, proposed);
    // 等用户确认期间循环停着，留着出口工具只会诱使模型自己收工
    expect(buildGoalTools(run).map((t) => t.name)).toEqual([]);

    commitGoal(run, confirmGoalCriteria(run)!);
    expect(buildGoalTools(run).map((t) => t.name).sort()).toEqual([
      GOAL_TOOL_NAMES.blocked,
      GOAL_TOOL_NAMES.complete,
    ]);
  });

  test("无目标时不给任何目标工具", () => {
    expect(buildGoalTools(makeRun())).toEqual([]);
  });
});

describe("提议的清洗", () => {
  test("分配服务端 id、丢空串、按归一化文本去重、条数截断", () => {
    const run = makeRun();
    const goal = startGoal(run, "x");
    const proposed = proposeCriteria(goal, [
      "  测试全绿  ",
      "",
      "   ",
      "测试全绿", // 与第一条只差首尾空白 → 丢
      "测试  全绿", // 空白串折叠成单个空格后仍是「测试 全绿」——与「测试全绿」
      //              不同（中间有没有那个空格是实质差异），所以这条**保留**
      "README 有章节",
    ])!;
    const items = proposed.acceptance?.status === "proposed" ? proposed.acceptance.items : [];
    expect(items.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(items.map((c) => c.text)).toEqual(["测试全绿", "测试  全绿", "README 有章节"]);
  });

  test("去重只看归一化后的文本：大小写与空白串的差异不算新标准", () => {
    const run = makeRun();
    const goal = startGoal(run, "x");
    const proposed = proposeCriteria(goal, ["Run pnpm test", "run  pnpm   test"])!;
    const items = proposed.acceptance?.status === "proposed" ? proposed.acceptance.items : [];
    expect(items.length).toBe(1);
  });

  test("超过条数上限时截断（契约不是清单）", () => {
    const run = makeRun();
    const goal = startGoal(run, "x");
    const many = Array.from({ length: MAX_CRITERIA + 5 }, (_, i) => `标准 ${i}`);
    const proposed = proposeCriteria(goal, many)!;
    expect(
      proposed.acceptance?.status === "proposed" ? proposed.acceptance.items.length : 0,
    ).toBe(MAX_CRITERIA);
  });

  test("全是空串 → 拒绝（不能建出一份空契约）", () => {
    const run = makeRun();
    const goal = startGoal(run, "x");
    expect(proposeCriteria(goal, ["", "   "])).toBeUndefined();
  });

  test("非数组 → 拒绝", () => {
    const run = makeRun();
    const goal = startGoal(run, "x");
    expect(proposeCriteria(goal, "测试全绿")).toBeUndefined();
  });
});

describe("完成对账：缺条目一律拒", () => {
  test("完全没交 results → 拒，并把清单回给模型", async () => {
    const { run, goal, complete: tool } = confirmedRun();
    markGoalWorkSeen(run);
    const text = await complete(tool, goal.id, {});
    expect(text).toContain("goal_complete rejected");
    expect(text).toContain("results is required");
    expect(text).toContain("c1");
    expect(text).toContain("c2");
  });

  test("只交了一部分 → 拒，并点名缺哪几条", async () => {
    const { run, goal, complete: tool } = confirmedRun();
    markGoalWorkSeen(run);
    const text = await complete(tool, goal.id, {
      results: [{ id: "c1", met: true, evidence: "34 passed" }],
    });
    expect(text).toContain("missing 1 of 2");
    expect(text).toContain("c2");
  });

  test("id 不认识 → 拒（不是静默忽略）", async () => {
    const { run, goal, complete: tool } = confirmedRun();
    markGoalWorkSeen(run);
    const text = await complete(tool, goal.id, {
      results: [
        { id: "c1", met: true, evidence: "e" },
        { id: "c9", met: true, evidence: "e" },
      ],
    });
    expect(text).toContain("unknown criterion id");
  });

  test("同一条交两次 → 拒", async () => {
    const { run, goal, complete: tool } = confirmedRun();
    markGoalWorkSeen(run);
    const text = await complete(tool, goal.id, {
      results: [
        { id: "c1", met: true, evidence: "e" },
        { id: "c1", met: true, evidence: "e" },
      ],
    });
    expect(text).toContain("more than once");
  });

  test("evidence 为空 → 拒（没有证据的结论不算结论）", async () => {
    const { run, goal, complete: tool } = confirmedRun();
    markGoalWorkSeen(run);
    const text = await complete(tool, goal.id, {
      results: [
        { id: "c1", met: true, evidence: "   " },
        { id: "c2", met: true, evidence: "有" },
      ],
    });
    expect(text).toContain("results is required");
  });

  test("条目数对但 id 顺序打乱 → 放行（按 id 匹配，不按位置）", async () => {
    const { run, goal, complete: tool } = confirmedRun();
    markGoalWorkSeen(run);
    const text = await complete(tool, goal.id, {
      results: [
        { id: "c2", met: true, evidence: "README 第 4 节" },
        { id: "c1", met: true, evidence: "34 passed" },
      ],
    });
    expect(text).toContain("Goal complete");
  });
});

describe("完成对账：unmet 不算完成", () => {
  test("有一条 unmet → 目标保持 active 继续跑，缺口回给模型", async () => {
    const { run, goal, complete: tool } = confirmedRun();
    markGoalWorkSeen(run);
    const text = await complete(tool, goal.id, {
      results: [
        { id: "c1", met: true, evidence: "34 passed" },
        { id: "c2", met: false, evidence: "README 还没动" },
      ],
    });
    expect(text).toContain("1 of 2 acceptance criteria are not met");
    expect(text).toContain("c2");
  });

  test("全 met → 转 complete，对账明细随目标存下来", async () => {
    const { run, goal, complete: tool } = confirmedRun();
    markGoalWorkSeen(run);
    const text = await complete(tool, goal.id, {
      results: [
        { id: "c1", met: true, evidence: "34 passed" },
        { id: "c2", met: true, evidence: "README 第 4 节" },
      ],
    });
    expect(text).toContain("Goal complete");
  });
});

describe("目标产物落盘", () => {
  test("建目标写出一份可读契约，确认后重写同一路径（不新建第二份）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "goal-artifact-"));
    try {
      const run = makeRun({ cwd: dir });
      const goal = startGoal(run, "把 README 补全");
      commitGoal(run, proposeCriteria(goal, ["pnpm test 全绿"])!);
      commitGoal(run, confirmGoalCriteria(run)!);
      // 写盘是 fire-and-forget（状态机不该为写文件变成异步），这里用测试缝等它落定
      await flushGoalArtifactsForTest();

      const path = run.goalFilePath!;
      expect(path).toContain(join(dir, ".kova", "goals"));
      expect(path.endsWith(".md")).toBe(true);
      const text = await readFile(path, "utf8");
      expect(text).toContain("把 README 补全");
      expect(text).toContain("c1 — pnpm test 全绿");

      // 再变更一次仍是同一份文件（覆盖写，不堆版本）
      commitGoal(run, { ...getGoal(run.threadId)!, completionSummary: "做完了" });
      await flushGoalArtifactsForTest();
      expect(run.goalFilePath).toBe(path);
      expect(await readFile(path, "utf8")).toContain("做完了");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("连续变更不写坏文件：并发覆盖写必须串行（曾经读到过 NUL 撕裂）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "goal-artifact-race-"));
    try {
      const run = makeRun({ cwd: dir });
      const goal = startGoal(run, "把 README 补全");
      const next = proposeCriteria(goal, ["a", "b", "c"])!;
      // 连着压四次写，不等待中间任何一次
      commitGoal(run, next);
      commitGoal(run, confirmGoalCriteria(run)!);
      commitGoal(run, { ...getGoal(run.threadId)!, compositionSummary: undefined } as Goal);
      commitGoal(run, { ...getGoal(run.threadId)!, completionSummary: "最终一份" });
      await flushGoalArtifactsForTest();

      const text = await readFile(run.goalFilePath!, "utf8");
      expect(text).not.toContain("\u0000");
      expect(text).toContain("最终一份"); // 最后落地的是最新盘面
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("文件名过得掉 Windows 非法字符与斜杠", () => {
    // slug 由 sanitizeFileName 清洗：目标原文里的 / 与 : 不能进文件名，
    // 否则在 Windows 上直接写失败
    expect(sanitizeFileName('修复 a/b:c 的问题')).toBe("修复-a-b-c-的问题");
    expect(sanitizeFileName("   ")).toBe("");
  });
});

describe("协议投影：UI 看不到就等于这个特性不存在", () => {
  test("四个契约阶段都带 acceptance，且只带 UI 要用的字段", () => {
    const run = makeRun();
    const goal = startGoal(run, "x");

    // pending：常驻条据此写「正在拟定验收标准」
    expect(goalStatePayload(run.threadId).goal?.acceptance?.status).toBe("pending");

    // proposed：待确认卡片靠它渲染清单——漏投影的后果是条上只显示「进行中」，
    // 没有任何确认入口，而循环正停着等确认（整个目标卡死）
    const items = proposeCriteria(goal, ["测试全绿"])!;
    commitGoal(run, items);
    const proposed = goalStatePayload(run.threadId).goal?.acceptance;
    expect(proposed?.status).toBe("proposed");
    expect(proposed?.items).toEqual([{ id: "c1", text: "测试全绿" }]);

    // confirmed：执行期仍要能看到契约
    commitGoal(run, confirmGoalCriteria(run)!);
    expect(goalStatePayload(run.threadId).goal?.acceptance?.status).toBe("confirmed");

    // skipped
    const skipped = makeRun();
    const g2 = startGoal(skipped, "x");
    commitGoal(skipped, { ...g2, acceptance: { status: "skipped" } });
    expect(goalStatePayload(skipped.threadId).goal?.acceptance?.status).toBe("skipped");
  });

  test("内部判据不进协议（对账明细、工作台账、协商计数）", () => {
    const run = makeRun();
    startGoal(run, "x");
    const payload = JSON.stringify(goalStatePayload(run.threadId));
    expect(payload).not.toContain("workSeen");
    expect(payload).not.toContain("completionAudit");
    expect(payload).not.toContain("negotiationTurns");
  });

  test("驳回意见进协议（条上要能告诉用户「模型没懂哪一点」）", () => {
    const run = makeRun();
    const goal = startGoal(run, "x");
    commitGoal(run, proposeCriteria(goal, ["测试全绿"])!);
    rejectGoalCriteria(run, "太宽泛");
    const acceptance = goalStatePayload(run.threadId).goal?.acceptance;
    expect(acceptance?.status).toBe("pending");
    expect(acceptance?.feedback).toBe("太宽泛");
  });
});

describe("完成对账：完成声明背后必须有动作", () => {
  test("整条目标没调过任何非目标工具 → 拒", async () => {
    // 这是「纯靠一段总结宣布完成」的兜底：模型可以读一堆文件然后声称做完了，
    // 但没有任何一个动作能被验收标准核对
    const { goal, complete: tool } = confirmedRun();
    const text = await complete(tool, goal.id, {
      results: [
        { id: "c1", met: true, evidence: "应该是过了" },
        { id: "c2", met: true, evidence: "应该是写了" },
      ],
    });
    expect(text).toContain("no tool has been used to work on this goal yet");
  });

  test("跳过标准的目标准入门槛不适用（没有契约就没有这条要求）", async () => {
    const run = makeRun();
    const goal = startGoal(run, "x");
    commitGoal(run, { ...goal, acceptance: { status: "skipped" } });
    const tools = buildGoalTools(run);
    const tool = tools.find((t) => t.name === GOAL_TOOL_NAMES.complete) as AgentTool;
    const text = await complete(tool, goal.id, {});
    expect(text).toContain("Goal complete");
  });
});
