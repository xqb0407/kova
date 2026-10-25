import { afterEach, describe, expect, test } from "bun:test";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import {
  __fingerprintForTest,
  loopGuardCapability,
} from "../../src/agent/assembly/capabilities/loop-guard";
import { CapabilityRegistry } from "../../src/agent/assembly/registry";
import type {
  TurnEndInfo,
  TurnSnapshot,
} from "../../src/agent/assembly/contracts";
import {
  resetCapabilitySettingsForTest,
  setCapabilitySettingsForTest,
} from "../../src/agent/assembly/settings";

const turn: TurnSnapshot = {
  sessionId: "session-loop",
  threadId: "thread-loop",
  cwd: "/tmp/ws",
  mode: "agent",
  appMode: "code",
  model: null,
  turnId: "turn-loop",
  messages: [],
  userText: "fix it",
  approvalLevel: "ask",
};

function failure(toolName = "bash", args: unknown = { command: "npm test" }): AfterToolCallContext {
  return {
    assistantMessage: { role: "assistant", content: [], timestamp: 0 },
    toolCall: { type: "toolCall", id: `call-${toolName}`, name: toolName, arguments: args },
    args,
    result: { content: [{ type: "text", text: "boom" }] },
    isError: true,
    context: {},
  } as unknown as AfterToolCallContext;
}

function success(toolName = "bash"): AfterToolCallContext {
  return {
    ...failure(toolName),
    result: { content: [{ type: "text", text: "ok" }] },
    isError: false,
  } as unknown as AfterToolCallContext;
}

async function planFor(mode: "shadow" | "steer", threshold = 2) {
  setCapabilitySettingsForTest({
    enabled: { "loop-guard": true },
    params: { "loop-guard": { mode, threshold } },
  });
  const registry = new CapabilityRegistry();
  registry.register(loopGuardCapability());
  await registry.installAll();
  registry.setEnabled("loop-guard", true);
  return registry.assembleTurn(turn);
}

function endInfo(queued: string[]): TurnEndInfo {
  return {
    stopRequested: false,
    toolResults: [
      { toolName: "bash", isError: true, text: "boom" },
      { toolName: "bash", isError: true, text: "boom" },
    ],
    queueReminder: (text) => queued.push(text),
  };
}

afterEach(() => resetCapabilitySettingsForTest());

describe("loop-guard 能力", () => {
  test("超大参数下的 fingerprint 仍有长度上界", () => {
    const fingerprint = __fingerprintForTest(
      failure("write", { file_path: "/tmp/a", content: "x".repeat(1_000_000) }),
    );
    expect(fingerprint.length).toBeLessThanOrEqual(512);
    expect(fingerprint).toContain("write:");
  });

  test("连续同一失败达到阈值后只注入一次提醒", async () => {
    const plan = await planFor("steer");
    const observe = plan.hooks.toolAfter[0].handler;
    const end = plan.hooks.turnEnd[0].handler;
    const queued: string[] = [];

    await observe(failure(), plan.snapshot);
    await observe(failure(), plan.snapshot);
    await end(endInfo(queued), plan.snapshot);
    expect(queued).toHaveLength(1);

    await end(endInfo(queued), plan.snapshot);
    expect(queued).toHaveLength(1);
  });

  test("shadow 模式只观察不注入", async () => {
    const plan = await planFor("shadow");
    const observe = plan.hooks.toolAfter[0].handler;
    const end = plan.hooks.turnEnd[0].handler;
    const queued: string[] = [];

    await observe(failure(), plan.snapshot);
    await observe(failure(), plan.snapshot);
    await end(endInfo(queued), plan.snapshot);
    expect(queued).toHaveLength(0);
  });

  test("达到阈值后出现成功调用：待提醒状态作废，本轮不注入", async () => {
    const plan = await planFor("steer");
    const observe = plan.hooks.toolAfter[0].handler;
    const end = plan.hooks.turnEnd[0].handler;
    const queued: string[] = [];

    await observe(failure(), plan.snapshot);
    await observe(failure(), plan.snapshot);
    await observe(success(), plan.snapshot);
    await end(endInfo(queued), plan.snapshot);
    expect(queued).toHaveLength(0);
  });

  test("出现一次成功调用后计数清零，不会误报", async () => {
    const plan = await planFor("steer");
    const observe = plan.hooks.toolAfter[0].handler;
    const end = plan.hooks.turnEnd[0].handler;
    const queued: string[] = [];

    await observe(failure(), plan.snapshot);
    await observe(success(), plan.snapshot);
    await observe(failure(), plan.snapshot);
    await end(endInfo(queued), plan.snapshot);
    expect(queued).toHaveLength(0);
  });
});
