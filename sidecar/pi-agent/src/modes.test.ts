import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_REQUIRED_TOOLS,
  applyMode,
  approvalBeforeToolCall,
  clearPendingToolApprovals,
  closeProposalOnNewPrompt,
  composeModeSystemPrompt,
  modeBeforeToolCall,
  planningPayload,
  resolveToolApproval,
  toolsForMode,
} from "./modes";
import { SYSTEM_PROMPT_CORE, workspacePromptLine } from "./tools";
import { createRetryBudget } from "./provider-retry";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PlanningState, Running, SessionMode } from "./types";

const BASE_NAMES = ["read", "glob", "grep", "bash", "write", "edit", "ls"];

const fakeTool = (name: string): AgentTool =>
  ({
    name,
    label: name,
    description: name,
    parameters: { type: "object" },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  }) as unknown as AgentTool;

function makeRun(mode: SessionMode = "agent"): Running {
  return {
    agent: { state: {} } as unknown as Running["agent"],
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
    planning: mode === "agent" ? "inactive" : "planning",
    proposal: null,
    baseTools: BASE_NAMES.map(fakeTool),
    subagentTools: [fakeTool("task"), fakeTool("task_wait")],
    pendingToolApprovals: new Map(),
  };
}

function ctx(toolName: string, batch: string[] = [toolName]): BeforeToolCallContext {
  return {
    assistantMessage: {
      content: batch.map((name) => ({ type: "toolCall", name, id: name, arguments: {} })),
    },
    toolCall: { name: toolName, id: toolName, arguments: {} },
  } as unknown as BeforeToolCallContext;
}

describe("modeBeforeToolCall", () => {
  test("模式切换工具与其它工具同批时被拦", () => {
    const run = makeRun("agent");
    const res = modeBeforeToolCall(run, ctx("EnterPlanMode", ["read", "EnterPlanMode"]));
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("must be the only tool call");
  });

  test("EnterPlanMode 仅 agent 模式可用", () => {
    expect(modeBeforeToolCall(makeRun("plan"), ctx("EnterPlanMode"))?.block).toBe(true);
    expect(modeBeforeToolCall(makeRun("agent"), ctx("EnterPlanMode"))).toBeUndefined();
  });

  test("SubmitPlan 仅 plan 模式可用，SubmitGoal 仅 goal 模式可用", () => {
    expect(modeBeforeToolCall(makeRun("agent"), ctx("SubmitPlan"))?.block).toBe(true);
    expect(modeBeforeToolCall(makeRun("plan"), ctx("SubmitPlan"))).toBeUndefined();
    expect(modeBeforeToolCall(makeRun("plan"), ctx("SubmitGoal"))?.block).toBe(true);
    expect(modeBeforeToolCall(makeRun("goal"), ctx("SubmitGoal"))).toBeUndefined();
  });

  test("普通工具不拦截", () => {
    expect(modeBeforeToolCall(makeRun("plan"), ctx("read"))).toBeUndefined();
  });
});

describe("toolsForMode", () => {
  test("agent 模式 = 基础 + Task 组 + 两个 Enter 工具", () => {
    const names = toolsForMode(makeRun("agent")).map((t) => t.name);
    expect(names).toContain("write");
    expect(names).toContain("task");
    expect(names).toContain("EnterPlanMode");
    expect(names).toContain("EnterGoalMode");
    expect(names).not.toContain("SubmitPlan");
  });

  test("plan 模式 = 只读子集 + SubmitPlan，无写入工具", () => {
    const names = toolsForMode(makeRun("plan")).map((t) => t.name);
    for (const n of ["read", "glob", "grep", "bash", "SubmitPlan"]) {
      expect(names).toContain(n);
    }
    for (const n of ["write", "edit", "task", "EnterPlanMode", "SubmitGoal"]) {
      expect(names).not.toContain(n);
    }
  });
});

describe("applyMode", () => {
  test("切换模式热替换提示词/工具并推进审批状态机", () => {
    const run = makeRun("agent");
    applyMode(run, "plan");
    expect(run.mode).toBe("plan");
    expect(run.planning).toBe("planning");
    expect(run.proposal).toBeNull();
    const state = run.agent.state as { systemPrompt?: string; tools?: AgentTool[] };
    expect(state.systemPrompt).toContain("Plan mode");
    expect(state.tools?.map((t) => t.name)).toContain("SubmitPlan");

    applyMode(run, "agent");
    expect(run.planning).toBe("inactive");
    expect((run.agent.state as { tools?: AgentTool[] }).tools?.map((t) => t.name)).toContain("task");
  });
});

describe("closeProposalOnNewPrompt", () => {
  test("awaiting_approval 时新输入隐式回到 planning", () => {
    const run = makeRun("plan");
    run.planning = "awaiting_approval";
    run.proposal = { kind: "plan", title: "t", markdown: "m", question: "q" };
    closeProposalOnNewPrompt(run);
    expect(run.planning as PlanningState).toBe("planning");
    expect(run.proposal).toBeNull();
    expect(planningPayload(run).mode).toBe("plan");
  });

  test("inactive 时不动作", () => {
    const run = makeRun("agent");
    closeProposalOnNewPrompt(run);
    expect(run.planning).toBe("inactive");
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

  test("模式门控优先于审批（SubmitPlan 在 agent 模式被拦且不产生挂起项）", async () => {
    const run = makeRun("agent");
    const res = await approvalBeforeToolCall(run, ctx("SubmitPlan"));
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

describe("SubmitPlan 落盘", () => {
  test("plan 模式提交时写入 .xulux/plans/，proposal 携带 filePath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xulux-plan-test-"));
    try {
      const run = makeRun("plan");
      run.cwd = dir;
      run.sessionId = "sess_test123";
      const submit = toolsForMode(run).find((t) => t.name === "SubmitPlan")!;
      await submit.execute!("tc1", {
        title: "Fix: login bug",
        markdown: "## 步骤\n1. 修改 a.ts",
        question: "是否批准？",
      } as never);
      expect(run.planning).toBe("awaiting_approval");
      expect(run.proposal?.filePath).toBeTruthy();
      expect(run.proposal?.filePath!).toContain(join(dir, ".xulux", "plans"));
      expect(run.proposal?.filePath!).toMatch(/^plan-Fix-login-bug-sess_test123-\d{8}-\d{6}\.md$/);
      const content = await readFile(run.proposal!.filePath!, "utf8");
      expect(content).toContain("# Fix: login bug");
      expect(content).toContain("修改 a.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("goal 模式提交不落盘", async () => {
    const run = makeRun("goal");
    const submit = toolsForMode(run).find((t) => t.name === "SubmitGoal")!;
    await submit.execute!("tc2", {
      title: "g",
      markdown: "goal body",
      question: "q",
    } as never);
    expect(run.proposal?.filePath).toBeUndefined();
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
      goal: "Goal mode",
    };
    for (const mode of ["agent", "plan", "goal"] as const) {
      const prompt = composeModeSystemPrompt(mode, CWD);
      const coreEnd = prompt.indexOf(SYSTEM_PROMPT_CORE);
      const modePos = prompt.indexOf(modeMarker[mode]);
      const cwdPos = prompt.indexOf(workspaceLine);
      expect(coreEnd).toBe(0); // 静态核心在最前
      expect(modePos).toBeGreaterThan(0); // 模式段在核心之后
      expect(cwdPos).toBeGreaterThan(modePos); // cwd 行在模式段之后
      expect(prompt.endsWith(workspaceLine)).toBe(true); // cwd 行在最尾
    }
  });

  test("cwd 只在末段出现一次", () => {
    const prompt = composeModeSystemPrompt("agent", CWD);
    expect(prompt.split(CWD).length - 1).toBe(1);
  });

  test("同一模式不同 cwd：静态前缀保持一致（仅末段不同）", () => {
    const a = composeModeSystemPrompt("plan", "/tmp/a");
    const b = composeModeSystemPrompt("plan", "/tmp/b");
    expect(a.slice(0, a.lastIndexOf("\n\n"))).toBe(b.slice(0, b.lastIndexOf("\n\n")));
    expect(a).not.toBe(b);
  });
});
