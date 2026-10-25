import { describe, expect, test } from "bun:test";
import type { AfterToolCallContext, AgentTool } from "@earendil-works/pi-agent-core";
import { composeModeSystemPrompt } from "../../src/agent/modes";
import {
  assembleSessionOrFallback,
  reminderMessages,
  runToolAfterHooks,
} from "../../src/agent/assembly/assemble";
import { CapabilityRegistry } from "../../src/agent/assembly/registry";
import type {
  SessionSnapshot,
  TurnPlan,
  TurnSnapshot,
} from "../../src/agent/assembly/contracts";
import { buildTools } from "../../src/tools/tools";

function fakeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: undefined }),
  } as unknown as AgentTool;
}

const session: SessionSnapshot = {
  sessionId: "session-plan",
  threadId: "thread-plan",
  cwd: "/tmp/kova-assembly-plan",
  mode: "agent",
  appMode: "code",
  model: null,
};

const turn: TurnSnapshot = {
  ...session,
  turnId: "turn-plan",
  messages: [],
  userText: "hello",
  approvalLevel: "ask",
};

describe("会话级装配 golden：默认零变化", () => {
  test("未安装任何能力时，工具表与 buildTools 逐项相同", async () => {
    const seed = buildTools(session.cwd, session.threadId);
    const registry = new CapabilityRegistry();
    const plan = await registry.assembleSession(session, seed);
    expect(plan.tools).toEqual(seed);
    expect(plan.systemSuffix).toBe("");
    expect(plan.diagnostics).toEqual({ enabled: [], disabled: [] });
  });

  test("能力装配失败时退回种子工具表，不阻断会话物化", async () => {
    const registry = new CapabilityRegistry();
    registry.register({
      id: "duplicate",
      defaultEnabled: true,
      install(host) {
        host.tool(() => fakeTool("bash"));
      },
    });
    await registry.installAll();
    const seed = [fakeTool("bash")];
    const plan = await assembleSessionOrFallback(registry, session, seed);
    expect(plan.tools).toEqual(seed);
    expect(plan.systemSuffix).toBe("");
  });

  test("系统提示词传入空后缀与不传后缀逐字节相同", () => {
    const without = composeModeSystemPrompt("agent", session.cwd, "code");
    const withEmpty = composeModeSystemPrompt(
      "agent",
      session.cwd,
      "code",
      undefined,
      undefined,
      undefined,
      [],
      "",
    );
    expect(withEmpty).toBe(without);
  });

  test("能力段插入在环境事实段之前，且不改变静态核心前缀", () => {
    const suffix = "CAPABILITY_STABLE_BLOCK";
    const prompt = composeModeSystemPrompt(
      "agent",
      session.cwd,
      "code",
      undefined,
      undefined,
      undefined,
      [],
      suffix,
    );
    expect(prompt).toContain(suffix);
    // 环境块以 workspace 行收尾（composeModeSystemPrompt 的最后一段）
    expect(prompt.indexOf(suffix)).toBeLessThan(
      prompt.indexOf("The workspace directory is"),
    );
  });

  test("收尾提醒带哨兵前缀转成 user 消息；空文本被剔除", () => {
    const messages = reminderMessages(["  keep going  ", "", "   "]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "user",
      content:
        "[[capability-reminder]] <system-reminder>\nkeep going\n</system-reminder>",
    });
  });

  test("tool:after 按 order 串行 reduce，后一个 handler 看到前一个的覆盖", async () => {
    const observed: string[] = [];
    const plan: TurnPlan = {
      snapshot: turn,
      userPrefix: "",
      reminders: [],
      hooks: {
        toolBefore: [],
        toolAfter: [
          {
            capabilityId: "a",
            order: 10,
            handler: () => ({ content: [{ type: "text", text: "first" }] }),
          },
          {
            capabilityId: "b",
            order: 20,
            handler: (context) => {
              observed.push(
                (context.result.content[0] as { type: string; text: string }).text,
              );
              return { details: { from: "b" } };
            },
          },
        ],
        turnEnd: [],
      },
      diagnostics: { enabled: [], disabled: [] },
    };
    const context = {
      assistantMessage: { role: "assistant", content: [], timestamp: 0 },
      toolCall: { type: "toolCall", id: "c1", name: "grep", arguments: {} },
      args: {},
      result: { content: [{ type: "text", text: "original" }] },
      isError: false,
      context: {},
    } as unknown as AfterToolCallContext;

    const override = await runToolAfterHooks(plan, context);
    expect(observed).toEqual(["first"]);
    expect(override?.content).toEqual([{ type: "text", text: "first" }]);
    expect(override?.details).toEqual({ from: "b" });
  });
});
