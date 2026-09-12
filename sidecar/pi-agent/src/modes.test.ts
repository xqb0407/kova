import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  APPROVAL_REQUIRED_TOOLS,
  PLAN_TOOL_NAMES,
  applyMode,
  approvalBeforeToolCall,
  clearPendingToolApprovals,
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
import type { Running, SessionMode } from "./types";

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
    planning: mode === "agent" ? "inactive" : "planning",
    baseTools: BASE_NAMES.map(fakeTool),
    subagentTools: [fakeTool("task"), fakeTool("task_wait")],
    pendingToolApprovals: new Map(),
    lastSeenAt: Date.now(),
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
});

describe("applyMode", () => {
  test("切换模式热替换提示词/工具并推进计划状态", () => {
    const run = makeRun("agent");
    applyMode(run, "plan");
    expect(run.mode).toBe("plan");
    expect(run.planning).toBe("planning");
    const state = run.agent.state as { systemPrompt?: string; tools?: AgentTool[] };
    expect(state.systemPrompt).toContain("Plan mode");
    expect(state.tools?.map((t) => t.name)).toContain(PLAN_TOOL_NAMES.write);

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
    const dir = await mkdtemp(join(tmpdir(), "xulux-plan-test-"));
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
      expect(firstPath).toContain(join(dir, ".xulux", "plans"));
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
    const dir = await mkdtemp(join(tmpdir(), "xulux-plan-test-"));
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
    const dir = await mkdtemp(join(tmpdir(), "xulux-plan-test-"));
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
    const dir = await mkdtemp(join(tmpdir(), "xulux-plan-test-"));
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
    const dir = await mkdtemp(join(tmpdir(), "xulux-plan-test-"));
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
    const live = { systemPrompt: "s", messages: [], tools: [] };
    const c = ctx("read");
    (c as unknown as { context: unknown }).context = live;
    await approvalBeforeToolCall(run, c);
    expect(run.loopContext).toBe(live);
  });

  test("applyMode 同步改写活循环上下文：轮中切换本轮立即生效", () => {
    const run = makeRun("agent");
    run.loopContext = {
      systemPrompt: "old",
      messages: [],
      tools: [...run.baseTools, ...run.subagentTools],
    };
    applyMode(run, "plan");
    const names = (run.loopContext!.tools ?? []).map((t) => t.name);
    expect(names).toContain(PLAN_TOOL_NAMES.write);
    expect(names).toContain(PLAN_TOOL_NAMES.exit);
    expect(names).not.toContain(PLAN_TOOL_NAMES.enter);
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(run.loopContext!.systemPrompt).toContain("Plan mode");

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
    };
    for (const mode of ["agent", "plan"] as const) {
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

  test("plan 模式提示词指向三件套", () => {
    const prompt = composeModeSystemPrompt("plan", CWD);
    expect(prompt).toContain(PLAN_TOOL_NAMES.write);
    expect(prompt).toContain(PLAN_TOOL_NAMES.exit);
    expect(prompt).not.toContain("SubmitPlan");
    expect(prompt).not.toContain("SubmitGoal");
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

  test("环境事实块：日期/模型/OS 在模式段之后、cwd 行之前，cwd 行仍在最尾", () => {
    const prompt = composeModeSystemPrompt("agent", CWD, {
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
    expect(composeModeSystemPrompt("agent", CWD)).not.toContain("- Model:");
    expect(composeModeSystemPrompt("agent", CWD, { provider: "acme", id: "m-1" })).toContain(
      "- Model: acme/m-1.",
    );
  });

  test("同参数连续组装字节级一致（环境块无秒级抖动，缓存前缀稳定）", () => {
    const a = composeModeSystemPrompt("agent", CWD);
    const b = composeModeSystemPrompt("agent", CWD);
    expect(a).toBe(b);
  });
});
