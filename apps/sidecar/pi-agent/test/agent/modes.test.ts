import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  APPROVAL_REQUIRED_TOOLS,
  ASK_NEEDS_WORK_TOOL_NAME,
  PLAN_TOOL_NAMES,
  applyMode,
  approvalBeforeToolCall,
  clearPendingToolApprovals,
  composeModeSystemPrompt,
  composeRunPrompt,
  ensureGoalMode,
  modeBeforeToolCall,
  normalizeSessionMode,
  planningPayload,
  resolveToolApproval,
  toolsForMode,
} from "../../src/agent/modes";
import { GOAL_TOOL_NAMES, proposeCriteria } from "../../src/goal/goal-state";
import { WORKFLOW_TOOL_NAMES } from "../../src/workflow/plan-state";
import { commitGoal, confirmGoalCriteria, getGoal, resume, startGoal } from "../../src/goal/goal";
import {
  registerAutomationThread,
  unregisterAutomationThread,
} from "../../src/automation/policy";
import { SYSTEM_PROMPT_CORE, systemPromptCore, workspacePromptLine } from "../../src/tools/tools";
import { createRetryBudget } from "../../src/model/provider-retry";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Running, SessionMode } from "../../src/types";

const BASE_NAMES = [
  "read",
  "glob",
  "grep",
  "bash",
  "write",
  "edit",
  "ls",
  "WebFetch",
  "WebSearch",
  "Question",
];

// 个性化身份文件实时读盘：钉到空目录，提示词基线不受开发者真实 ~/.kova/ 影响
// workspace-write 档的边界测试要真实目录（realpath 会解软链接，虚构路径判不出来）
const WS_ROOT = mkdtempSync(join(tmpdir(), "modes-ws-"));
const WS = join(WS_ROOT, "project");
const OUTSIDE = join(WS_ROOT, "other");
mkdirSync(join(WS, "src"), { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });

const prevIdentityDir = process.env.PI_IDENTITY_DIR;
beforeAll(() => {
  process.env.PI_IDENTITY_DIR = join(tmpdir(), "pi-agent-modes-identity");
});
afterAll(() => {
  if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
  else process.env.PI_IDENTITY_DIR = prevIdentityDir;
});

const fakeTool = (name: string): AgentTool =>
  ({
    name,
    label: name,
    description: name,
    parameters: { type: "object" },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  }) as unknown as AgentTool;

function makeRun(
  mode: SessionMode = "agent",
  appMode: "work" | "code" | "design" = "code",
): Running {
  return {
    // 0.99 起 fake state 需带 messages：applyMode 经 setLeadingSystemMessage
    // 改写转录首条 system 消息（state.systemPrompt 是只读回放，fake 上不可写）
    agent: { state: { messages: [] } } as unknown as Running["agent"],
    threadId: "t-modes",
    sessionId: "s",
    cwd: ".",
    persistedSeq: 0,
    jsonlSeq: 0,
    compactionGeneration: 0,
    pendingOverflowRecovery: false,
    providerRetry: createRetryBudget(),
    retryCapture: {},
    providerRetryChunkId: "retry-1",
    providerRetryActive: false,
    providerRetryTurnSeq: 1,
    delegations: new Map(),
    stopRequested: false,
    mode,
    approvalLevel: "ask",
    appMode,
    planning: mode === "plan" ? "planning" : "inactive",
    baseTools: BASE_NAMES.map(fakeTool),
    subagentTools: [fakeTool("task"), fakeTool("task_wait")],
    pendingToolApprovals: new Map(),
    lastSeenAt: Date.now(),
    usagePending: 0,
  };
}

let goalRunSeq = 0;

/**
 * 目标槽位是模块级 Map（threadId → Goal），而 makeRun 的 threadId 固定为 "t-modes"。
 * 凡是要建目标的用例都用这个：否则目标会泄漏给同文件后续用例，表现为
 * 「还没有目标」那类断言假失败。
 */
function freshGoalRun(mode: SessionMode = "goal"): Running {
  goalRunSeq += 1;
  const run = makeRun(mode);
  run.threadId = `t-modes-goal-${goalRunSeq}`;
  return run;
}

function ctx(
  toolName: string,
  batch: string[] = [toolName],
  args: Record<string, unknown> = {},
): BeforeToolCallContext {
  return {
    assistantMessage: {
      content: batch.map((name) => ({ type: "toolCall", name, id: name, arguments: args })),
    },
    toolCall: { name: toolName, id: toolName, arguments: args },
    args,
  } as unknown as BeforeToolCallContext;
}

const toolResultText = (res: unknown): string => {
  const content = (res as { content: Array<{ text?: string }> }).content;
  return content.map((c) => c.text ?? "").join("");
};

/** 等审批挂起项注册完成（plan_exit execute 挂起前还有一次计划文件读取 IO） */
async function waitPending(run: Running): Promise<void> {
  for (let i = 0; i < 50 && run.pendingToolApprovals.size === 0; i++) {
    await Bun.sleep(5);
  }
}

describe("modeBeforeToolCall", () => {
  test("plan_enter/plan_exit 与其它工具同批时被拦", () => {
    const run = makeRun("agent");
    const res = modeBeforeToolCall(run, ctx(PLAN_TOOL_NAMES.enter, ["read", PLAN_TOOL_NAMES.enter]));
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("must be the only tool call");
  });

  test("plan_write 不要求独占，可与其他工具并批", () => {
    const run = makeRun("plan");
    expect(
      modeBeforeToolCall(run, ctx(PLAN_TOOL_NAMES.write, ["read", PLAN_TOOL_NAMES.write])),
    ).toBeUndefined();
  });

  test("plan_enter 仅 agent 模式可用", () => {
    expect(modeBeforeToolCall(makeRun("plan"), ctx(PLAN_TOOL_NAMES.enter))?.block).toBe(true);
    expect(modeBeforeToolCall(makeRun("agent"), ctx(PLAN_TOOL_NAMES.enter))).toBeUndefined();
  });

  test("plan_write/plan_exit 仅 plan 模式可用", () => {
    expect(modeBeforeToolCall(makeRun("agent"), ctx(PLAN_TOOL_NAMES.write))?.block).toBe(true);
    expect(modeBeforeToolCall(makeRun("plan"), ctx(PLAN_TOOL_NAMES.write))).toBeUndefined();
    expect(modeBeforeToolCall(makeRun("agent"), ctx(PLAN_TOOL_NAMES.exit))?.block).toBe(true);
    expect(modeBeforeToolCall(makeRun("plan"), ctx(PLAN_TOOL_NAMES.exit))).toBeUndefined();
  });

  test("普通工具不拦截", () => {
    expect(modeBeforeToolCall(makeRun("plan"), ctx("read"))).toBeUndefined();
  });
});

describe("toolsForMode", () => {
  test("agent 模式 = 基础 + Task 组 + plan_enter，无 write/exit", () => {
    const names = toolsForMode(makeRun("agent")).map((t) => t.name);
    expect(names).toContain("write");
    expect(names).toContain("task");
    expect(names).toContain(PLAN_TOOL_NAMES.enter);
    expect(names).not.toContain(PLAN_TOOL_NAMES.write);
    expect(names).not.toContain(PLAN_TOOL_NAMES.exit);
  });

  test("plan 模式 = 只读子集 + plan_write/plan_exit，无写入工具与 plan_enter", () => {
    const names = toolsForMode(makeRun("plan")).map((t) => t.name);
    for (const n of ["read", "glob", "grep", "bash", PLAN_TOOL_NAMES.write, PLAN_TOOL_NAMES.exit]) {
      expect(names).toContain(n);
    }
    for (const n of ["write", "edit", "task", PLAN_TOOL_NAMES.enter]) {
      expect(names).not.toContain(n);
    }
  });

  test("goal 模式 = 完整基础集 + Task 组 + 按契约阶段给的出口，无 plan 三件套", () => {
    // 必须用独立 threadId：目标槽位是模块级 Map，而 makeRun 的 threadId 是固定的，
    // 复用会把目标泄漏给同文件后续用例（下面那条「还没有目标」就会假失败）
    const run = freshGoalRun();
    const goal = startGoal(run, "把 README 补全");
    // 完整工具集（含写与 bash）：目标模式的价值是「放手做完」，只读就退化成 plan。
    // 写类工具在协商阶段由 modeBeforeToolCall 拦，不在表里缺席——表是快照，
    // 轮中变档时模型手里可能还带着旧 schema，缺了它反而给不出「为什么不能用」的理由
    const names = toolsForMode(run).map((t) => t.name);
    for (const n of ["read", "write", "edit", "bash", "task"]) {
      expect(names).toContain(n);
    }
    // 新目标从协商轮起步：这一阶段只有 propose，没有收工的口子
    expect(names).toContain(GOAL_TOOL_NAMES.propose);
    expect(names).not.toContain(GOAL_TOOL_NAMES.complete);
    expect(names).not.toContain(GOAL_TOOL_NAMES.blocked);
    for (const n of [PLAN_TOOL_NAMES.enter, PLAN_TOOL_NAMES.write, PLAN_TOOL_NAMES.exit]) {
      expect(names).not.toContain(n);
    }
    expect(goal.acceptance?.status).toBe("pending");

    // 契约生效后才交出两个出口工具
    commitGoal(run, proposeCriteria(goal, ["测试全绿"])!);
    commitGoal(run, confirmGoalCriteria(run)!);
    const confirmedNames = toolsForMode(run).map((t) => t.name);
    expect(confirmedNames).toContain(GOAL_TOOL_NAMES.complete);
    expect(confirmedNames).toContain(GOAL_TOOL_NAMES.blocked);
    expect(confirmedNames).not.toContain(GOAL_TOOL_NAMES.propose);
  });

  test("goal 档还没有目标时不给任何目标工具（刚切档、还没说第一句话）", () => {
    expect(toolsForMode(makeRun("goal")).map((t) => t.name)).not.toContain(
      GOAL_TOOL_NAMES.complete,
    );
  });
});

describe("ensureGoalMode：目标只能在 goal 档跑", () => {
  test("已经在 goal 档什么都不做（返回 false，不重复落偏好）", () => {
    const run = freshGoalRun();
    expect(ensureGoalMode(run)).toBe(false);
    expect(run.mode).toBe("goal");
  });

  test("不在 goal 档就扶正：这是「继续这条目标」的前提", () => {
    // 不扶正的后果不是"少切一次档"，而是补起的那一轮没有目标工具、跑完没人再续，
    // 目标停在 active 而条上写着「进行中」——没有异常也没有报错的一类谎报
    for (const from of ["agent", "plan", "ask"] as const) {
      const run = freshGoalRun();
      applyMode(run, from);
      expect(ensureGoalMode(run)).toBe(true);
      expect(run.mode).toBe("goal");
    }
  });

  test("扶正后：档位、目标工具、目标模式段一起回来", () => {
    const run = freshGoalRun();
    startGoal(run, "把 README 补全");
    // 走出 goal 档（目标随之被暂停，与本用例无关）
    applyMode(run, "agent");
    expect(toolsForMode(run).map((t) => t.name)).not.toContain(GOAL_TOOL_NAMES.propose);

    ensureGoalMode(run);
    // 工具表按档位重建：目标工具回来了
    expect(toolsForMode(run).map((t) => t.name)).toContain(GOAL_TOOL_NAMES.propose);
    // 提示词的模式段也回来了（具体的目标块取决于目标状态，那是另一回事）
    expect(composeRunPrompt(run)).toContain("You are operating in Goal mode");
  });

  test("用户报的那个症状：切权限被踢出 goal 档 → 继续 → 目标真的能跑", () => {
    // 修复前的完整链条：切权限发的是 set_mode(mode:"agent") → 目标被暂停 →
    // 点「继续」把目标搬回 active，但档位还是 agent → 续跑判定被 run.mode === "goal"
    // 门着，那一轮跑完再没有任何东西续它 → 条上「进行中」，实际永远不动
    const run = freshGoalRun();
    startGoal(run, "把 README 补全");
    applyMode(run, "agent");

    // 「继续」= 先把档位扶正（kickGoalLoop 里的 ensureGoalMode），再搬状态
    ensureGoalMode(run);
    const resumed = resume(run)!;
    expect(run.mode).toBe("goal");
    expect(resumed.status).toBe("active");
    // 两条都对了，这一轮的提示词才是「接着协商/接着干」而不是「已暂停，别自作主张」
    expect(composeRunPrompt(run)).toContain("goal_propose_criteria");
  });
});

describe("applyMode 离开 goal 档", () => {  test("切走时目标转 paused——否则它会永远挂在 active，条上说在跑而实际没跑", () => {
    const run = makeRun("goal");
    startGoal(run, "把 README 补全");
    applyMode(run, "agent");
    const goal = getGoal(run.threadId)!;
    expect(goal.status).toBe("paused");
    expect(goal.pauseReason).toContain("user left goal mode");
  });

  test("切进来（agent → goal）不动目标", () => {
    const run = makeRun("agent");
    startGoal(run, "把 README 补全");
    applyMode(run, "goal");
    expect(getGoal(run.threadId)!.status).toBe("active");
  });

  test("goal → goal 不动目标", () => {
    const run = makeRun("goal");
    startGoal(run, "把 README 补全");
    applyMode(run, "goal");
    expect(getGoal(run.threadId)!.status).toBe("active");
  });
});

describe("goal 模式门控", () => {
  test("目标出口工具必须独占批次", () => {
    const run = makeRun("goal");
    const res = modeBeforeToolCall(
      run,
      ctx(GOAL_TOOL_NAMES.complete, ["bash", GOAL_TOOL_NAMES.complete]),
    );
    expect(res?.block).toBe(true);
    // 独占批次时放行
    expect(modeBeforeToolCall(run, ctx(GOAL_TOOL_NAMES.complete))).toBeUndefined();
  });

  test("目标出口工具仅在 goal 档可用（轮中切档的兜底闸）", () => {
    for (const mode of ["agent", "plan", "ask"] as const) {
      expect(modeBeforeToolCall(makeRun(mode), ctx(GOAL_TOOL_NAMES.complete))?.block).toBe(
        true,
      );
    }
    expect(modeBeforeToolCall(makeRun("goal"), ctx(GOAL_TOOL_NAMES.blocked))).toBeUndefined();
  });

  test("goal 档在执行阶段保留写入能力，契约未落定时结构性只读", () => {
    // 执行阶段：契约定下来之后就该放手做完
    const run = freshGoalRun();
    const goal = startGoal(run, "把 README 补全");
    commitGoal(run, proposeCriteria(goal, ["测试全绿"])!);
    commitGoal(run, confirmGoalCriteria(run)!);
    expect(modeBeforeToolCall(run, ctx("write"))).toBeUndefined();
    expect(modeBeforeToolCall(run, ctx("edit"))).toBeUndefined();
    expect(modeBeforeToolCall(run, ctx("bash"))).toBeUndefined();

    // 协商阶段：这一轮的产出是契约不是代码。只拦 write/edit——bash 要留着，
    // 「测试跑不跑得起来」正是拟定可验证标准的前提（与 plan 档同一取舍）
    const negotiating = freshGoalRun();
    startGoal(negotiating, "把 README 补全");
    const writeBlocked = modeBeforeToolCall(negotiating, ctx("write"));
    expect(writeBlocked?.block).toBe(true);
    expect(writeBlocked?.reason).toContain("acceptance criteria");
    expect(modeBeforeToolCall(negotiating, ctx("edit"))?.block).toBe(true);
    expect(modeBeforeToolCall(negotiating, ctx("bash"))).toBeUndefined();
  });

  test("等用户确认期间（proposed）同样只读：模型能在同一轮里先提交标准再动手", () => {
    // 只拦 pending 是漏的：goal_propose_criteria 只要求独占**那一批**，之后模型
    // 完全可以继续用后续批次改文件，而用户还在看清单。「等确认期间不动手」若只靠
    // 提示词，就是一句随时会被跨过的建议
    const run = freshGoalRun();
    const goal = startGoal(run, "把 README 补全");
    commitGoal(run, proposeCriteria(goal, ["测试全绿"])!);
    expect(modeBeforeToolCall(run, ctx("write"))?.block).toBe(true);
    expect(modeBeforeToolCall(run, ctx("edit"))?.block).toBe(true);
    // bash 仍放行（与协商阶段同一取舍）
    expect(modeBeforeToolCall(run, ctx("bash"))).toBeUndefined();
  });

  test("goal 档还没有目标时不拦写（空白消息那一轮按普通请求跑）", () => {
    // syncGoalOnUserPrompt 对空白消息不建目标，那一轮是普通请求，
    // 被协商只读规则拦住就把正常对话也堵死了
    expect(modeBeforeToolCall(freshGoalRun(), ctx("write"))).toBeUndefined();
  });

  test("无人值守自动化 turn 里目标出口工具不可达", () => {
    const run = makeRun("goal");
    run.threadId = "t-auto-goal";
    registerAutomationThread(run.threadId, "workspace-write");
    try {
      const res = modeBeforeToolCall(run, ctx(GOAL_TOOL_NAMES.complete));
      expect(res?.block).toBe(true);
      expect(res?.reason).toContain("goal mode is unavailable");
    } finally {
      unregisterAutomationThread(run.threadId);
    }
  });

  test("planning 态在 goal 档是 inactive（枚举扩容塌陷点）", () => {
    const run = makeRun("goal");
    applyMode(run, "goal");
    expect(planningPayload(run).planning).toBe("inactive");
  });
});

describe("applyMode", () => {
  test("切换模式热替换提示词/工具并推进计划状态", () => {
    const run = makeRun("agent");
    applyMode(run, "plan");
    expect(run.mode).toBe("plan");
    expect(run.planning).toBe("planning");
    // 0.99：提示词落在转录首条 system 消息上
    const head = run.agent.state.messages[0] as { role: string; content: string };
    expect(head.role).toBe("system");
    expect(head.content).toContain("Plan mode");
    expect((run.agent.state as { tools?: AgentTool[] }).tools?.map((t) => t.name)).toContain(PLAN_TOOL_NAMES.write);

    applyMode(run, "agent");
    expect(run.planning).toBe("inactive");
    expect((run.agent.state as { tools?: AgentTool[] }).tools?.map((t) => t.name)).toContain("task");
  });
});

describe("plan_enter 执行", () => {
  test("切到 plan 模式并重置计划文件路径", async () => {
    const run = makeRun("agent");
    run.planFilePath = "/tmp/stale.md";
    run.planTitle = "stale";
    const enter = toolsForMode(run).find((t) => t.name === PLAN_TOOL_NAMES.enter)!;
    await enter.execute!("tc", {} as never);
    expect(run.mode).toBe("plan");
    expect(run.planning).toBe("planning");
    expect(run.planFilePath).toBeUndefined();
    expect(run.planTitle).toBeUndefined();
    expect(planningPayload(run).mode).toBe("plan");
  });
});


/**
 * 可写根清单（workspace-write 档的「额外放行目录」）。
 *
 * 单独成组是因为信任清单是**模块级内存 + kv** 的存量状态：不每个用例重置的话，
 * 前一个用例授信过的根会让后一个用例直接放行，症状是「拒绝后仍被放行」这种
 * 看起来像安全漏洞的假失败（实际只是测试之间串了状态）。
 */
/**
 * 可写根清单（workspace-write 档的「额外放行目录」）。
 *
 * 单独成组：每条用例都在工作区里建/删清单文件，清干净才不串状态。
 */
describe("approvalBeforeToolCall：可写根清单", () => {
  const clearConfig = () => {
    rmSync(join(WS, ".kova", "permissions.json"), { force: true });
    rmSync(join(WS, ".kova", "permissions.local.json"), { force: true });
  };
  beforeEach(clearConfig);
  afterEach(clearConfig);

  test("本地层声明的目录免确认（那是你自己机器上的文件，声明即授权）", async () => {
    mkdirSync(join(WS, ".kova"), { recursive: true });
    writeFileSync(
      join(WS, ".kova", "permissions.local.json"),
      JSON.stringify({ writeRoots: ["../other"] }),
    );
    const run = makeRun("agent");
    run.approvalLevel = "workspace-write";
    run.cwd = WS;
    await expect(
      approvalBeforeToolCall(run, ctx("write", ["write"], { file_path: join(OUTSIDE, "s.ts") })),
    ).resolves.toBeUndefined();
    expect(run.pendingToolApprovals.size).toBe(0);
  });

  test("**项目层声明不生效**，只弹卡说明；点「允许并记住」才写进本机清单", async () => {
    mkdirSync(join(WS, ".kova"), { recursive: true });
    writeFileSync(
      join(WS, ".kova", "permissions.json"),
      JSON.stringify({ writeRoots: ["../other"] }),
    );
    const run = makeRun("agent");
    run.approvalLevel = "workspace-write";
    run.cwd = WS;

    // 项目声明不能自己生效：仍然要问
    const first = approvalBeforeToolCall(
      run,
      ctx("write", ["write"], { file_path: join(OUTSIDE, "s.ts") }),
    );
    await Bun.sleep(0);
    expect(run.pendingToolApprovals.size).toBe(1);
    const [id] = [...run.pendingToolApprovals.keys()];
    // 带可写根上下文 → 卡上会有第三个按钮
    expect(run.pendingToolApprovals.get(id)?.rememberRoot).toBe(realpathSync(OUTSIDE));
    resolveToolApproval(run, id, true, true); // 允许并记住
    await expect(first).resolves.toBeUndefined();

    // 落进了「你自己机器上的」那份文件，而不是项目共享那份
    const local = JSON.parse(
      readFileSync(join(WS, ".kova", "permissions.local.json"), "utf8"),
    ) as { writeRoots: string[] };
    expect(local.writeRoots).toEqual(["../other"]);
    const project = JSON.parse(
      readFileSync(join(WS, ".kova", "permissions.json"), "utf8"),
    ) as { writeRoots: string[] };
    expect(project.writeRoots).toEqual(["../other"]); // 原样未动

    // 记过之后不再问
    await expect(
      approvalBeforeToolCall(run, ctx("write", ["write"], { file_path: join(OUTSIDE, "t.ts") })),
    ).resolves.toBeUndefined();
    expect(run.pendingToolApprovals.size).toBe(0);
  });

  test("只点「允许」（不带记住）不落任何盘：下一次仍然问", async () => {
    const run = makeRun("agent");
    run.approvalLevel = "workspace-write";
    run.cwd = WS;
    const hook = approvalBeforeToolCall(
      run,
      ctx("write", ["write"], { file_path: join(OUTSIDE, "s.ts") }),
    );
    await Bun.sleep(0);
    const [id] = [...run.pendingToolApprovals.keys()];
    resolveToolApproval(run, id, true, false);
    await expect(hook).resolves.toBeUndefined();
    expect(existsSync(join(WS, ".kova", "permissions.local.json"))).toBe(false);

    const again = approvalBeforeToolCall(
      run,
      ctx("write", ["write"], { file_path: join(OUTSIDE, "t.ts") }),
    );
    await Bun.sleep(0);
    expect(run.pendingToolApprovals.size).toBe(1);
    const [id2] = [...run.pendingToolApprovals.keys()];
    resolveToolApproval(run, id2, true, true);
    await expect(again).resolves.toBeUndefined();
  });

  test("拒绝不留痕：不写文件，文件写不进去", async () => {
    const run = makeRun("agent");
    run.approvalLevel = "workspace-write";
    run.cwd = WS;
    const hook = approvalBeforeToolCall(
      run,
      ctx("write", ["write"], { file_path: join(OUTSIDE, "s.ts") }),
    );
    await Bun.sleep(0);
    const [id] = [...run.pendingToolApprovals.keys()];
    resolveToolApproval(run, id, false, true); // 拒绝 + 记住 → 记住必须无效
    expect((await hook)?.block).toBe(true);
    expect(existsSync(join(WS, ".kova", "permissions.local.json"))).toBe(false);
  });

  test("bash 的卡带的是「记住这条命令」，记完就免确认（逐字相等）", async () => {
    const run = makeRun("agent");
    run.approvalLevel = "workspace-write";
    run.cwd = WS;
    const cmd = "cd /tmp && cat package.json";
    const first = approvalBeforeToolCall(run, ctx("bash", ["bash"], { command: cmd }));
    await Bun.sleep(0);
    const [id] = [...run.pendingToolApprovals.keys()];
    // 没有可记住的**路径**（判不出来），但记住了**命令**
    expect(run.pendingToolApprovals.get(id)?.rememberRoot).toBeUndefined();
    expect(run.pendingToolApprovals.get(id)?.rememberCommand).toBe(cmd);
    resolveToolApproval(run, id, true, true); // 允许并记住这条命令
    await expect(first).resolves.toBeUndefined();

    // 同一条命令再来：直接放行，不再问
    await expect(
      approvalBeforeToolCall(run, ctx("bash", ["bash"], { command: cmd })),
    ).resolves.toBeUndefined();
    expect(run.pendingToolApprovals.size).toBe(0);

    // 前缀相同、整串不同（重定向！）必须重新问——这就是不做前缀匹配的理由
    const sneaky = approvalBeforeToolCall(
      run,
      ctx("bash", ["bash"], { command: `${cmd} > /tmp/out` }),
    );
    await Bun.sleep(0);
    expect(run.pendingToolApprovals.size).toBe(1);
    const [id2] = [...run.pendingToolApprovals.keys()];
    resolveToolApproval(run, id2, false);
    await expect(sneaky).resolves.toBeTruthy();
  });

  test("记不上盘也不能拦住这次执行（用户批准的是执行，记住只是附带的账）", async () => {
    // 把工作区做成只读：writeRoots 落盘必失败
    mkdirSync(join(WS, ".kova"), { recursive: true });
    chmodSync(join(WS, ".kova"), 0o500);
    try {
      const run = makeRun("agent");
      run.approvalLevel = "workspace-write";
      run.cwd = WS;
      const hook = approvalBeforeToolCall(
        run,
        ctx("write", ["write"], { file_path: join(OUTSIDE, "s.ts") }),
      );
      await Bun.sleep(0);
      const [id] = [...run.pendingToolApprovals.keys()];
      resolveToolApproval(run, id, true, true); // 允许并记住 → 落盘失败
      // 仍然放行（否则工具会莫名报错，而卡片已经消失）
      await expect(hook).resolves.toBeUndefined();
    } finally {
      chmodSync(join(WS, ".kova"), 0o700);
    }
  });

  test("对照：同一路径在 auto-edit 档下是放行的（新档确实更严）", async () => {
    const run = makeRun("agent");
    run.approvalLevel = "auto-edit";
    run.cwd = WS;
    await expect(
      approvalBeforeToolCall(run, ctx("write", ["write"], { file_path: join(OUTSIDE, "s.ts") })),
    ).resolves.toBeUndefined();
    expect(run.pendingToolApprovals.size).toBe(0);
  });
});

describe("approvalBeforeToolCall", () => {
  test("bash 需要审批，read 不需要", async () => {
    expect(APPROVAL_REQUIRED_TOOLS.has("bash")).toBe(true);
    expect(APPROVAL_REQUIRED_TOOLS.has("write")).toBe(true);
    expect(APPROVAL_REQUIRED_TOOLS.has("edit")).toBe(true);
    expect(APPROVAL_REQUIRED_TOOLS.has("read")).toBe(false);

    // read 直接放行
    const run = makeRun("agent");
    await expect(approvalBeforeToolCall(run, ctx("read"))).resolves.toBeUndefined();
    expect(run.pendingToolApprovals.size).toBe(0);
  });

  test("bash 挂起等用户批准后放行", async () => {
    const run = makeRun("agent");
    const hook = approvalBeforeToolCall(run, ctx("bash"));
    // 挂起期间注册表有一条记录（data-toolApproval chunk 无活跃请求时被丢弃，不影响）
    await Bun.sleep(0);
    expect(run.pendingToolApprovals.size).toBe(1);
    const [approvalId] = [...run.pendingToolApprovals.keys()];
    resolveToolApproval(run, approvalId, true);
    await expect(hook).resolves.toBeUndefined();
    expect(run.pendingToolApprovals.size).toBe(0);
  });

  test("拒绝后返回 block 结果", async () => {
    const run = makeRun("agent");
    const hook = approvalBeforeToolCall(run, ctx("bash"));
    await Bun.sleep(0);
    const [approvalId] = [...run.pendingToolApprovals.keys()];
    resolveToolApproval(run, approvalId, false);
    const res = await hook;
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("rejected");
  });

  test("workspace-write：工作区内的 write/edit 免确认", async () => {
    const run = makeRun("agent");
    run.approvalLevel = "workspace-write";
    run.cwd = WS;
    await expect(
      approvalBeforeToolCall(run, ctx("write", ["write"], { file_path: "src/a.ts" })),
    ).resolves.toBeUndefined();
    await expect(
      approvalBeforeToolCall(run, ctx("edit", ["edit"], { file_path: join(WS, "b.ts") })),
    ).resolves.toBeUndefined();
    // 完全没弹过确认
    expect(run.pendingToolApprovals.size).toBe(0);
  });

  test("workspace-write：工作区外（含别的项目）要确认——这正是它比 auto-edit 严的地方", async () => {
    const run = makeRun("agent");
    run.approvalLevel = "workspace-write";
    run.cwd = WS;
    for (const args of [
      { file_path: "../other/secret.ts" },
      { file_path: join(OUTSIDE, "secret.ts") },
    ]) {
      const hook = approvalBeforeToolCall(run, ctx("write", ["write"], args));
      await Bun.sleep(0);
      expect(run.pendingToolApprovals.size).toBe(1);
      const [id] = [...run.pendingToolApprovals.keys()];
      resolveToolApproval(run, id, true);
      await expect(hook).resolves.toBeUndefined();
    }
  });

  test("workspace-write：bash 照常确认（参数里看不出它会写到哪）", async () => {
    const run = makeRun("agent");
    run.approvalLevel = "workspace-write";
    run.cwd = WS;
    const hook = approvalBeforeToolCall(run, ctx("bash", ["bash"], { command: "touch x" }));
    await Bun.sleep(0);
    expect(run.pendingToolApprovals.size).toBe(1);
    const [id] = [...run.pendingToolApprovals.keys()];
    resolveToolApproval(run, id, true);
    await expect(hook).resolves.toBeUndefined();
  });

  test("对照：同一路径在 auto-edit 档下是放行的（新档确实更严）", async () => {
    const run = makeRun("agent");
    run.approvalLevel = "auto-edit";
    run.cwd = WS;
    await expect(
      approvalBeforeToolCall(run, ctx("write", ["write"], { file_path: join(OUTSIDE, "s.ts") })),
    ).resolves.toBeUndefined();
    expect(run.pendingToolApprovals.size).toBe(0);
  });

  test("resolveToolApproval 未知 id 返回 false；clearPendingToolApprovals 全部按拒绝结算", async () => {
    const run = makeRun("agent");
    expect(resolveToolApproval(run, "nope", true)).toBe(false);

    const hooks = [
      approvalBeforeToolCall(run, ctx("bash")),
      approvalBeforeToolCall(run, ctx("write")),
    ];
    await Bun.sleep(0);
    expect(run.pendingToolApprovals.size).toBe(2);
    clearPendingToolApprovals(run);
    for (const h of hooks) {
      expect((await h)?.block).toBe(true);
    }
    expect(run.pendingToolApprovals.size).toBe(0);
  });

  test("模式门控优先于审批（plan_write 在 agent 模式被拦且不产生挂起项）", async () => {
    const run = makeRun("agent");
    const res = await approvalBeforeToolCall(run, ctx(PLAN_TOOL_NAMES.write));
    expect(res?.block).toBe(true);
    expect(run.pendingToolApprovals.size).toBe(0);
  });

  test("auto 级别全部放行", async () => {
    const run = makeRun("agent");
    run.approvalLevel = "auto";
    await expect(approvalBeforeToolCall(run, ctx("bash"))).resolves.toBeUndefined();
    await expect(approvalBeforeToolCall(run, ctx("write"))).resolves.toBeUndefined();
    expect(run.pendingToolApprovals.size).toBe(0);
  });

  test("auto-edit 级别放行 write/edit，bash 仍需确认", async () => {
    const run = makeRun("agent");
    run.approvalLevel = "auto-edit";
    await expect(approvalBeforeToolCall(run, ctx("write"))).resolves.toBeUndefined();
    await expect(approvalBeforeToolCall(run, ctx("edit"))).resolves.toBeUndefined();
    const hook = approvalBeforeToolCall(run, ctx("bash"));
    await Bun.sleep(0);
    expect(run.pendingToolApprovals.size).toBe(1);
    const [approvalId] = [...run.pendingToolApprovals.keys()];
    resolveToolApproval(run, approvalId, true);
    await expect(hook).resolves.toBeUndefined();
  });
});

describe("plan_write 落盘", () => {
  test("首写定名 plan-<标题>-<sessionId>-<时间>.md，重复写覆盖同一文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kova-plan-test-"));
    try {
      const run = makeRun("plan");
      run.cwd = dir;
      run.sessionId = "sess_test123";
      const write = toolsForMode(run).find((t) => t.name === PLAN_TOOL_NAMES.write)!;

      await write.execute!("tc1", {
        title: "Fix login bug",
        markdown: "## 步骤\n1. 修改 a.ts",
      } as never);
      const firstPath = run.planFilePath!;
      expect(firstPath).toBeTruthy();
      expect(firstPath).toContain(join(dir, ".kova", "plans"));
      expect(basename(firstPath)).toMatch(
        /^plan-Fix-login-bug-sess_test123-\d{8}-\d{6}\.md$/,
      );
      const first = await readFile(firstPath, "utf8");
      expect(first).toContain("# Fix login bug");
      expect(first).toContain("修改 a.ts");

      // 二次写：路径与标题都不变，内容整体替换
      await write.execute!("tc2", {
        title: "另一个标题",
        markdown: "## 修订\n2. 改 b.ts",
      } as never);
      expect(run.planFilePath).toBe(firstPath);
      const second = await readFile(firstPath, "utf8");
      expect(second).not.toContain("修改 a.ts");
      expect(second).toContain("改 b.ts");
      expect(run.planTitle).toBe("Fix login bug");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("缺 title 时用 Markdown 首个标题兜底", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kova-plan-test-"));
    try {
      const run = makeRun("plan");
      run.cwd = dir;
      const write = toolsForMode(run).find((t) => t.name === PLAN_TOOL_NAMES.write)!;
      await write.execute!("tc", { markdown: "# 登录修复方案\n内容" } as never);
      expect(basename(run.planFilePath!)).toMatch(/^plan-登录修复方案-/);
      expect(run.planTitle).toBe("登录修复方案");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("空 markdown 抛错", async () => {
    const run = makeRun("plan");
    const write = toolsForMode(run).find((t) => t.name === PLAN_TOOL_NAMES.write)!;
    expect(write.execute!("tc", { markdown: "  " } as never)).rejects.toThrow("markdown is required");
  });
});

describe("plan_exit HITL", () => {
  test("未写计划时调用被拒（抛错引导先 plan_write）", async () => {
    const run = makeRun("plan");
    const exit = toolsForMode(run).find((t) => t.name === PLAN_TOOL_NAMES.exit)!;
    expect(exit.execute!("tc", { rationale: "ready" } as never)).rejects.toThrow("plan_write");
    expect(run.mode).toBe("plan");
  });

  test("批准后回 agent 模式并返回 approved 结果（同轮实施）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kova-plan-test-"));
    try {
      const run = makeRun("plan");
      run.cwd = dir;
      const tools = toolsForMode(run);
      const write = tools.find((t) => t.name === PLAN_TOOL_NAMES.write)!;
      await write.execute!("tc_w", { title: "My Plan", markdown: "内容" } as never);

      const exit = tools.find((t) => t.name === PLAN_TOOL_NAMES.exit)!;
      const pending = exit.execute!("tc_e", { rationale: "计划就绪" } as never);
      await waitPending(run);
      // 挂起期间注册一条 pendingToolApprovals（审批卡经 data-toolApproval 展示）
      expect(run.pendingToolApprovals.size).toBe(1);
      const [approvalId, record] = [...run.pendingToolApprovals.entries()][0];
      expect(record.toolName).toBe(PLAN_TOOL_NAMES.exit);
      resolveToolApproval(run, approvalId, true);

      const res = await pending;
      expect(run.mode).toBe("agent");
      expect(run.planning).toBe("inactive");
      expect((res as { details?: { approved?: boolean } }).details?.approved).toBe(true);
      expect(toolResultText(res)).toContain("approved");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Stop/新 prompt 清理（settledBy=clear）：按拒绝结算、留在 plan、不额外 abort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kova-plan-test-"));
    try {
      const run = makeRun("plan");
      run.cwd = dir;
      let aborted = false;
      (run.agent as { abort?: () => void }).abort = () => {
        aborted = true;
      };
      const tools = toolsForMode(run);
      const write = tools.find((t) => t.name === PLAN_TOOL_NAMES.write)!;
      await write.execute!("tc_w", { title: "T", markdown: "M" } as never);

      const exit = tools.find((t) => t.name === PLAN_TOOL_NAMES.exit)!;
      const pending = exit.execute!("tc_e", { rationale: "r" } as never);
      await waitPending(run);
      clearPendingToolApprovals(run); // 用户 Stop / 新 prompt 的兜底：全部按拒绝结算

      const res = await pending;
      expect(run.mode).toBe("plan");
      expect((res as { details?: { approved?: boolean } }).details?.approved).toBe(false);
      expect(toolResultText(res)).toContain("cleared");
      expect(aborted).toBe(false);
      // 只是打断：计划文件与路径保留，续改时 plan_write 覆盖同一文件
      expect(run.planFilePath).toBeTruthy();
      expect(await readFile(run.planFilePath!, "utf8")).toContain("M");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("用户点拒绝（tool_confirm approved=false）：删计划文件 + abort 终止本轮，留在 plan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kova-plan-test-"));
    try {
      const run = makeRun("plan");
      run.cwd = dir;
      let aborted = false;
      (run.agent as { abort?: () => void }).abort = () => {
        aborted = true;
      };
      const tools = toolsForMode(run);
      const write = tools.find((t) => t.name === PLAN_TOOL_NAMES.write)!;
      await write.execute!("tc_w", { title: "T", markdown: "M" } as never);

      const exit = tools.find((t) => t.name === PLAN_TOOL_NAMES.exit)!;
      const planPath = run.planFilePath!;
      const pending = exit.execute!("tc_e", { rationale: "r" } as never);
      await waitPending(run);
      const [approvalId] = [...run.pendingToolApprovals.keys()];
      resolveToolApproval(run, approvalId!, false); // 审批卡上点「拒绝并停止」

      const res = await pending;
      expect(run.mode).toBe("plan");
      expect((res as { details?: { approved?: boolean } }).details?.approved).toBe(false);
      expect(toolResultText(res)).toContain("rejected");
      expect(aborted).toBe(true);
      // 计划作废：磁盘文件删除、路径重置（后续 plan_write 重新定名）
      expect(run.planFilePath).toBeUndefined();
      expect(run.planTitle).toBeUndefined();
      await expect(readFile(planPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("plan 模式结构性只读与轮中热换", () => {
  test("write/edit 在 plan 模式一律拦截（不依赖工具表新鲜度）", () => {
    const run = makeRun("plan");
    expect(modeBeforeToolCall(run, ctx("write"))?.block).toBe(true);
    expect(modeBeforeToolCall(run, ctx("edit"))?.block).toBe(true);
    // 勘察工具不受影响
    expect(modeBeforeToolCall(run, ctx("read"))).toBeUndefined();
    expect(modeBeforeToolCall(run, ctx("bash"))).toBeUndefined();
    // agent 模式下 write 不走这条门（由审批级别决定）
    expect(modeBeforeToolCall(makeRun("agent"), ctx("write"))).toBeUndefined();
  });

  test("approvalBeforeToolCall 捕获活循环上下文", async () => {
    const run = makeRun("agent");
    const live = {
      messages: [
        { role: "system", content: "s", timestamp: 0 },
      ] as unknown as import("@earendil-works/pi-agent-core").AgentMessage[],
      tools: [],
    };
    const c = ctx("read");
    (c as unknown as { context: unknown }).context = live;
    await approvalBeforeToolCall(run, c);
    expect(run.loopContext).toBe(live);
  });

  test("applyMode 同步改写活循环上下文：轮中切换本轮立即生效", () => {
    const run = makeRun("agent");
    run.loopContext = {
      messages: [
        { role: "system", content: "old", timestamp: 0 },
      ] as unknown as import("@earendil-works/pi-agent-core").AgentMessage[],
      tools: [...run.baseTools, ...run.subagentTools],
    };
    applyMode(run, "plan");
    const names = (run.loopContext!.tools ?? []).map((t) => t.name);
    expect(names).toContain(PLAN_TOOL_NAMES.write);
    expect(names).toContain(PLAN_TOOL_NAMES.exit);
    expect(names).not.toContain(PLAN_TOOL_NAMES.enter);
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    // 0.99 起提示词由转录首条 system 消息承载
    const head = run.loopContext!.messages[0] as { role: string; content: string };
    expect(head.role).toBe("system");
    expect(head.content).toContain("Plan mode");

    // plan_exit 批准回 agent：同一活上下文重新拿到 write/edit
    applyMode(run, "agent");
    const back = (run.loopContext!.tools ?? []).map((t) => t.name);
    expect(back).toContain("write");
    expect(back).toContain(PLAN_TOOL_NAMES.enter);
    expect(back).not.toContain(PLAN_TOOL_NAMES.write);
  });
});

describe("系统提示词结构（缓存友好）", () => {
  const CWD = "/tmp/ws";
  const workspaceLine = workspacePromptLine(CWD);

  test("静态核心不含 cwd / 时间戳，跨会话字节级稳定", () => {
    expect(SYSTEM_PROMPT_CORE).not.toContain(CWD);
    expect(SYSTEM_PROMPT_CORE).not.toContain("workspace directory");
    expect(SYSTEM_PROMPT_CORE).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // 静态核心以身份声明开头
    expect(SYSTEM_PROMPT_CORE.startsWith("You are")).toBe(true);
  });

  test("composeModeSystemPrompt：静态核心在前、模式段夹中间、cwd 行在最尾", () => {
    const modeMarker: Record<SessionMode, string> = {
      agent: "Agent mode",
      plan: "Plan mode",
      ask: "Ask mode",
      goal: "Goal mode",
      workflow: "Workflow mode",
    };
    // 问答档的静态核心是子集（剔掉任务追踪与子代理两段），其余档用全量核心；
    // 四档共有的不变式是"静态核心在最前、模式段居中、cwd 行在最尾"
    const coreFor = (mode: SessionMode): string =>
      mode === "ask"
        ? systemPromptCore(["identity", "discipline", "communication"])
        : SYSTEM_PROMPT_CORE;
    for (const mode of ["agent", "plan", "ask", "goal"] as const) {
      const prompt = composeModeSystemPrompt(mode, CWD, "code");
      const coreEnd = prompt.indexOf(coreFor(mode));
      const modePos = prompt.indexOf(modeMarker[mode]);
      const cwdPos = prompt.indexOf(workspaceLine);
      expect(coreEnd).toBe(0); // 静态核心在最前
      expect(modePos).toBeGreaterThan(0); // 模式段在核心之后
      expect(cwdPos).toBeGreaterThan(modePos); // cwd 行在模式段之后
      expect(prompt.endsWith(workspaceLine)).toBe(true); // cwd 行在最尾
    }
  });

  test("plan 模式提示词指向三件套", () => {
    const prompt = composeModeSystemPrompt("plan", CWD, "code");
    expect(prompt).toContain(PLAN_TOOL_NAMES.write);
    expect(prompt).toContain(PLAN_TOOL_NAMES.exit);
    expect(prompt).not.toContain("SubmitPlan");
    expect(prompt).not.toContain("SubmitGoal");
  });

  test("cwd 只在末段出现一次", () => {
    const prompt = composeModeSystemPrompt("agent", CWD, "code");
    expect(prompt.split(CWD).length - 1).toBe(1);
  });

  test("同一模式不同 cwd：静态前缀保持一致（仅末段不同）", () => {
    const a = composeModeSystemPrompt("plan", "/tmp/a", "code");
    const b = composeModeSystemPrompt("plan", "/tmp/b", "code");
    expect(a.slice(0, a.lastIndexOf("\n\n"))).toBe(b.slice(0, b.lastIndexOf("\n\n")));
    expect(a).not.toBe(b);
  });

  test("环境事实块：日期/模型/OS 在模式段之后、cwd 行之前，cwd 行仍在最尾", () => {
    const prompt = composeModeSystemPrompt("agent", CWD, "code", {
      provider: "acme",
      id: "m-1",
      name: "Model One",
    });
    const modePos = prompt.indexOf("Agent mode");
    expect(prompt).toContain("Environment (host facts):");
    expect(prompt).toMatch(/- Today's date is \d{4}-\d{2}-\d{2} \(\w+\)/);
    expect(prompt).toContain("- Model: Model One (acme/m-1).");
    expect(prompt).toMatch(/- Host: \w+ \(\w+ \w+\); shell: \S+\./);
    expect(prompt.indexOf("Environment (host facts):")).toBeGreaterThan(modePos);
    expect(prompt.indexOf(workspaceLine)).toBeGreaterThan(
      prompt.indexOf("Environment (host facts):"),
    );
    expect(prompt.endsWith(workspaceLine)).toBe(true);
  });

  test("环境事实块：无模型时省略 Model 行；模型名与 id 相同时不重复标注", () => {
    expect(composeModeSystemPrompt("agent", CWD, "code")).not.toContain("- Model:");
    expect(composeModeSystemPrompt("agent", CWD, "code", { provider: "acme", id: "m-1" })).toContain(
      "- Model: acme/m-1.",
    );
  });

  test("同参数连续组装字节级一致（环境块无秒级抖动，缓存前缀稳定）", () => {
    const a = composeModeSystemPrompt("agent", CWD, "code");
    const b = composeModeSystemPrompt("agent", CWD, "code");
    expect(a).toBe(b);
  });
});

/* ------------------------------- 问答模式 ------------------------------- */

describe("问答模式工具集", () => {
  test("只下发只读子集：没有 bash / write / edit，也没有子代理与 plan 三件套", () => {
    const names = toolsForMode(makeRun("ask")).map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).toContain("WebSearch");
    // bash 能写工作区，留着就破了只读边界
    expect(names).not.toContain("bash");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    // 子代理组与计划三件套整批不下发
    expect(names).not.toContain("task");
    expect(names).not.toContain("task_wait");
    for (const n of Object.values(PLAN_TOOL_NAMES)) {
      expect(names).not.toContain(n);
    }
  });

  test("带出口工具 ask_needs_work", () => {
    const names = toolsForMode(makeRun("ask")).map((t) => t.name);
    expect(names).toContain(ASK_NEEDS_WORK_TOOL_NAME);
  });

  test("plan 档仍带 bash（勘察承诺），两档工具集不同", () => {
    const plan = toolsForMode(makeRun("plan")).map((t) => t.name);
    expect(plan).toContain("bash");
    expect(plan).not.toContain(ASK_NEEDS_WORK_TOOL_NAME);
  });
});

describe("问答模式结构性只读", () => {
  test("write / edit / bash 一律拦截，即使轮中切换前模型还带着旧 schema", () => {
    const run = makeRun("ask");
    for (const name of ["write", "edit", "bash"]) {
      const res = modeBeforeToolCall(run, ctx(name));
      expect(res?.block).toBe(true);
    }
  });

  test("只读工具放行", () => {
    const run = makeRun("ask");
    for (const name of ["read", "glob", "grep", "WebSearch", ASK_NEEDS_WORK_TOOL_NAME]) {
      expect(modeBeforeToolCall(run, ctx(name))).toBeUndefined();
    }
  });

  test("ask_needs_work 与其它工具同批时被拦（模式切换必须独占）", () => {
    const run = makeRun("ask");
    const res = modeBeforeToolCall(
      run,
      ctx(ASK_NEEDS_WORK_TOOL_NAME, ["read", ASK_NEEDS_WORK_TOOL_NAME]),
    );
    expect(res?.block).toBe(true);
  });

  test("非问答档调 ask_needs_work 被拦", () => {
    for (const mode of ["agent", "plan"] as const) {
      const res = modeBeforeToolCall(makeRun(mode), ctx(ASK_NEEDS_WORK_TOOL_NAME));
      expect(res?.block).toBe(true);
    }
  });

  test("agent / plan 档不受问答拦截影响", () => {
    expect(modeBeforeToolCall(makeRun("agent"), ctx("write"))).toBeUndefined();
  });
});

describe("applyMode：问答档的计划状态", () => {
  test("ask → planning 为 inactive（不能继承 planning 态被渲染成「正在计划」）", () => {
    const run = makeRun("agent");
    applyMode(run, "ask");
    expect(run.mode).toBe("ask");
    expect(run.planning).toBe("inactive");
  });

  test("三档的计划状态映射互不串档", () => {
    const run = makeRun("agent");
    applyMode(run, "plan");
    expect(run.planning).toBe("planning");
    applyMode(run, "ask");
    expect(run.planning).toBe("inactive");
    applyMode(run, "agent");
    expect(run.planning).toBe("inactive");
  });

  test("问答档的对外快照带 ask", () => {
    const run = makeRun("agent");
    applyMode(run, "ask");
    const payload = planningPayload(run);
    expect(payload.mode).toBe("ask");
    expect(payload.planning).toBe("inactive");
  });
});

describe("问答模式提示词", () => {
  const CWD = "/tmp/ws";

  test("剔掉任务追踪与子代理两段", () => {
    const prompt = composeModeSystemPrompt("ask", CWD, "code");
    expect(prompt).not.toContain("Task tracking:");
    expect(prompt).not.toContain("Subagents:");
    expect(prompt).not.toContain("subagents_save");
  });

  test("保留读码纪律与沟通纪律，并指向出口工具", () => {
    const prompt = composeModeSystemPrompt("ask", CWD, "code");
    expect(prompt).toContain("Code change discipline:");
    expect(prompt).toContain("Reply in the same language the user writes in.");
    expect(prompt).toContain(ASK_NEEDS_WORK_TOOL_NAME);
  });

  test("agent / plan 档仍带任务追踪与子代理两段（分段未误伤）", () => {
    for (const mode of ["agent", "plan"] as const) {
      const prompt = composeModeSystemPrompt(mode, CWD, "code");
      expect(prompt).toContain("Task tracking:");
      expect(prompt).toContain("Subagents:");
    }
  });

  test("问答档显著短于 agent 档", () => {
    const ask = composeModeSystemPrompt("ask", CWD, "code");
    const agent = composeModeSystemPrompt("agent", CWD, "code");
    expect(ask.length).toBeLessThan(agent.length);
  });

  test("拆分静态核心未改 code/plan 档的字节（缓存前缀不变）", () => {
    const agent = composeModeSystemPrompt("agent", CWD, "code");
    expect(agent.startsWith(SYSTEM_PROMPT_CORE)).toBe(true);
    expect(agent).toBe(composeModeSystemPrompt("agent", CWD, "code"));
  });
});

describe("normalizeSessionMode", () => {
  test("四档透传，其余回落 agent", () => {
    expect(normalizeSessionMode("ask")).toBe("ask");
    expect(normalizeSessionMode("plan")).toBe("plan");
    expect(normalizeSessionMode("agent")).toBe("agent");
    expect(normalizeSessionMode("goal")).toBe("goal");
    expect(normalizeSessionMode("nope")).toBe("agent");
    expect(normalizeSessionMode(undefined)).toBe("agent");
    expect(normalizeSessionMode(3)).toBe("agent");
  });
});

describe("workflow 档工具表与门控(实机反馈修复)", () => {
  test("工具表:含勘察只读集 + subagents_list + 提案工具;不含写类/Task 组", () => {
    const run = makeRun("workflow");
    // 管理组挂在 subagentTools(不在 baseTools):夹具补上只读的 list
    run.subagentTools = [...run.subagentTools, fakeTool("subagents_list")];
    // 无运行槽位:buildWorkflowTools 返回提案+跑剧本两个工具
    const names = toolsForMode(run).map((t) => t.name);
    expect(names).toContain("bash"); // 勘察放行(plan 档同款)
    expect(names).toContain("read");
    expect(names).toContain("subagents_list"); // 编排器写 delegate 前要能查定义名
    expect(names).toContain(WORKFLOW_TOOL_NAMES.propose);
    expect(names).toContain(WORKFLOW_TOOL_NAMES.runPlaybook);
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("task"); // 编排器不委派,活是执行器的
    expect(names).not.toContain("subagents_save");
    expect(names).not.toContain("subagents_delete");
  });

  test("门控:bash 放行(勘察);write/edit 结构性拦;提案工具只在 workflow 档", () => {
    const workflowRun = makeRun("workflow");
    const bashGated = modeBeforeToolCall(workflowRun, ctx("bash"));
    expect(bashGated).toBeUndefined();
    const writeGated = modeBeforeToolCall(workflowRun, ctx("write"));
    expect(writeGated?.block).toBe(true);

    const agentRun = makeRun("agent");
    const proposeGated = modeBeforeToolCall(agentRun, ctx(WORKFLOW_TOOL_NAMES.propose));
    expect(proposeGated?.block).toBe(true);
  });
});
