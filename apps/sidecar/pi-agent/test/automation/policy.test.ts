/**
 * 本地测试（非 vendored）：无人值守审批档位的即时裁决矩阵。
 * 直接驱动 modes.ts 的 beforeToolCall 与 Question 工具的 execute，
 * 断言"永不挂起"：每个调用都同步（await 立即）返回放行/拦截结果。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { Running } from "../../src/types";
import { approvalBeforeToolCall } from "../../src/agent/modes";
import { buildQuestionTool } from "../../src/tools/question-tools";
import { SUBAGENT_MGMT_TOOL_NAMES } from "../../src/subagent/subagent-mgmt-tools";
import {
  getAutomationPolicy,
  normalizeToolPolicyProfile,
  registerAutomationThread,
  unregisterAutomationThread,
  type AutomationToolPolicy,
} from "../../src/automation/policy";

const THREAD = "automation:t1:h1";

function fakeRun(threadId: string): Running {
  return {
    threadId,
    mode: "agent",
    approvalLevel: "ask", // 交互式默认档：若自动化分支失效会挂起（测试超时可见）
    stopRequested: false,
    pendingToolApprovals: new Map(),
  } as unknown as Running;
}

function ctxFor(toolName: string, args: Record<string, unknown> = {}): BeforeToolCallContext {
  return {
    toolCall: { type: "toolCall", id: `call-${toolName}`, name: toolName },
    assistantMessage: {
      content: [{ type: "toolCall", id: `call-${toolName}`, name: toolName }],
    },
    args,
  } as unknown as BeforeToolCallContext;
}

async function gate(
  profile: AutomationToolPolicy,
  toolName: string,
): Promise<BeforeToolCallResult | undefined> {
  registerAutomationThread(THREAD, profile);
  try {
    return await approvalBeforeToolCall(fakeRun(THREAD), ctxFor(toolName));
  } finally {
    unregisterAutomationThread(THREAD);
  }
}

describe("automation tool policy tiers", () => {
  afterEach(() => unregisterAutomationThread(THREAD));

  it("read-only：bash/write/edit 全部即时拒绝", async () => {
    for (const tool of ["bash", "write", "edit"]) {
      const res = await gate("read-only", tool);
      expect(res?.block).toBe(true);
      expect(String(res?.reason)).toContain("auto-denied");
    }
  });

  it("read-only：免审批只读工具（read）放行", async () => {
    expect(await gate("read-only", "read")).toBeUndefined();
  });

  it("workspace-write：工作区内 write/edit 放行；工作区外、bash、配置类工具拒绝", async () => {
    // 档位名承诺的边界必须是真的：以前这一档只把 bash 拒掉，write/edit 与配置类
    // 工具（子代理/技能/主题/插件增删）一律放行——写得到工作区外，
    // 与交互式同名档位差着一整条边界
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "auto-ws-")));
    registerAutomationThread(THREAD, "workspace-write");
    try {
      const run = fakeRun(THREAD);
      run.cwd = ws;
      expect(
        await approvalBeforeToolCall(run, ctxFor("write", { file_path: join(ws, "a.ts") })),
      ).toBeUndefined();
      expect(
        await approvalBeforeToolCall(run, ctxFor("edit", { file_path: join(ws, "b.ts") })),
      ).toBeUndefined();
      const outside = await approvalBeforeToolCall(
        run,
        ctxFor("write", { file_path: join(ws, "..", "outside.ts") }),
      );
      expect(outside?.block).toBe(true);
      expect(String(outside?.reason)).toContain("outside the workspace");
      expect((await approvalBeforeToolCall(run, ctxFor("bash", { command: "ls" })))?.block).toBe(
        true,
      );
      expect(
        (await approvalBeforeToolCall(run, ctxFor(SUBAGENT_MGMT_TOOL_NAMES.save)))?.block,
      ).toBe(true);
      expect(run.pendingToolApprovals.size).toBe(0); // 永不挂起
    } finally {
      unregisterAutomationThread(THREAD);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("full：需审批工具也放行", async () => {
    expect(await gate("full", "bash")).toBeUndefined();
    expect(await gate("full", "write")).toBeUndefined();
  });

  it("plan_enter 在无人值守下被拦截（plan_exit HITL 不可达）", async () => {
    const res = await gate("read-only", "plan_enter");
    expect(res?.block).toBe(true);
    expect(String(res?.reason)).toContain("plan mode is unavailable");
  });

  it("Question 工具即时返回取消指引、不挂起", async () => {
    registerAutomationThread(THREAD, "read-only");
    try {
      const tool = buildQuestionTool(THREAD);
      const result = await tool.execute("call-q", {
        questions: [{ title: "选哪个？", options: [{ title: "A" }, { title: "B" }] }],
      });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(text).toContain("无人值守");
      expect((result.details as { cancelled?: boolean }).cancelled).toBe(true);
    } finally {
      unregisterAutomationThread(THREAD);
    }
  });

  it("注销后线程不再命中策略（交互式会话行为恢复）", () => {
    unregisterAutomationThread(THREAD);
    expect(getAutomationPolicy(THREAD)).toBeUndefined();
  });

  it("归一化：未知/缺失档位回落最严 read-only", () => {
    expect(normalizeToolPolicyProfile("workspace-write")).toBe("workspace-write");
    expect(normalizeToolPolicyProfile("yolo")).toBe("read-only");
    expect(normalizeToolPolicyProfile(undefined)).toBe("read-only");
  });
});
