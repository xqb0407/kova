import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  Capability,
  CapabilityHost,
  SessionSnapshot,
  TurnSnapshot,
} from "../../src/agent/assembly/contracts";
import { CapabilityRegistry } from "../../src/agent/assembly/registry";

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
  sessionId: "session-1",
  threadId: "thread-1",
  cwd: "/tmp/ws",
  mode: "agent",
  appMode: "code",
  model: null,
};

const turn: TurnSnapshot = {
  ...session,
  turnId: "turn-1",
  messages: [],
  userText: "hello",
  approvalLevel: "ask",
};

function capability(
  id: string,
  install: (host: CapabilityHost) => void,
): Capability {
  return { id, install };
}

describe("CapabilityRegistry 生命周期与注册窗口", () => {
  test("duplicate capability id 在注册期拒绝", () => {
    const registry = new CapabilityRegistry();
    registry.register(capability("a", () => undefined));
    expect(() => registry.register(capability("a", () => undefined))).toThrow(
      /duplicate capability id/,
    );
  });

  test("安装结束后再注册直接抛错", async () => {
    const registry = new CapabilityRegistry();
    registry.register(capability("a", () => undefined));
    await registry.installAll();
    expect(() => registry.register(capability("b", () => undefined))).toThrow(
      /requires state "new"/,
    );
  });

  test("把 host 存下来在安装窗口外补注册会被拒绝", async () => {
    let leaked: CapabilityHost | undefined;
    const registry = new CapabilityRegistry();
    registry.register(
      capability("leaky", (host) => {
        leaked = host;
      }),
    );
    await registry.installAll();
    expect(() => leaked?.systemText(() => "late")).toThrow(
      /outside its install\(\) window/,
    );
  });

  test("单个能力安装失败被隔离，其余能力照常装配", async () => {
    const registry = new CapabilityRegistry();
    registry.register(capability("boom", () => {
      throw new Error("install failed");
    }));
    registry.register(
      capability("good", (host) => host.systemText(() => "GOOD_BLOCK")),
    );
    await registry.installAll();
    expect(registry.lifecycleState()).toBe("ready");
    expect(registry.list().map((item) => item.id)).toEqual(["good"]);
    expect(registry.failedCapabilities()).toEqual([
      { id: "boom", message: "install failed" },
    ]);

    registry.setEnabled("good", true);
    const plan = await registry.assembleSession(session, []);
    expect(plan.systemSuffix).toBe("GOOD_BLOCK");
  });
});

describe("CapabilityRegistry 开关", () => {
  test("默认关闭；全局开关生效；会话覆盖优先；dispose 后回落", async () => {
    const registry = new CapabilityRegistry();
    registry.register(
      capability("text", (host) => host.systemText(() => "CAPABILITY_BLOCK")),
    );
    await registry.installAll();

    let plan = await registry.assembleSession(session, []);
    expect(plan.systemSuffix).toBe("");
    expect(plan.diagnostics.disabled).toEqual(["text"]);

    registry.setEnabled("text", true);
    plan = await registry.assembleSession(session, []);
    expect(plan.systemSuffix).toBe("CAPABILITY_BLOCK");

    registry.setEnabled("text", false, session.sessionId);
    plan = await registry.assembleSession(session, []);
    expect(plan.systemSuffix).toBe("");

    registry.disposeSession(session.sessionId);
    plan = await registry.assembleSession(session, []);
    expect(plan.systemSuffix).toBe("CAPABILITY_BLOCK");
  });

  test("未知能力 id 的开关请求抛错", async () => {
    const registry = new CapabilityRegistry();
    registry.register(capability("a", () => undefined));
    await registry.installAll();
    expect(() => registry.setEnabled("nope", true)).toThrow(/unknown capability id/);
  });

  test("disposeSession 清理会话覆盖并调用能力清理钩子", async () => {
    const disposed: string[] = [];
    const registry = new CapabilityRegistry();
    registry.register({
      id: "cleanup",
      install: () => undefined,
      disposeSession: (sessionId) => {
        disposed.push(sessionId);
      },
    });
    await registry.installAll();
    registry.setEnabled("cleanup", true, "session-1");
    expect(registry.isEnabled("cleanup", "session-1")).toBe(true);

    registry.disposeSession("session-1");
    expect(disposed).toEqual(["session-1"]);
    expect(registry.isEnabled("cleanup", "session-1")).toBe(false);
  });
});

describe("CapabilityRegistry 装配", () => {
  test("默认配置下工具与种子逐项相同、系统后缀为空", async () => {
    const registry = new CapabilityRegistry();
    registry.register(
      capability("off", (host) => {
        host.tool(() => fakeTool("extra"));
        host.systemText(() => "unused");
      }),
    );
    await registry.installAll();
    const seeded = [fakeTool("bash"), fakeTool("read")];
    const plan = await registry.assembleSession(session, seeded);
    expect(plan.tools).toEqual(seeded);
    expect(plan.systemSuffix).toBe("");
  });

  test("重复工具名直接失败", async () => {
    const registry = new CapabilityRegistry();
    registry.register(
      capability("dup", (host) => {
        host.tool(() => fakeTool("bash"));
      }),
    );
    await registry.installAll();
    registry.setEnabled("dup", true);
    await expect(registry.assembleSession(session, [fakeTool("bash")])).rejects.toThrow(
      /duplicate tool "bash"/,
    );
  });

  test("回合级提醒按优先级排序并按 key 去重，钩子按 order 排序", async () => {
    const registry = new CapabilityRegistry();
    registry.register(
      capability("all", (host) => {
        host.reminder(() => ({ text: "low", priority: 1, key: "same" }));
        host.reminder(() => ({ text: "high", priority: 10, key: "same" }));
        host.reminder(() => ({ text: "other", priority: 5, key: "other" }));
        host.userText(() => "PREFIX");
        host.onToolAfter(() => undefined, 300);
        host.onToolAfter(() => undefined, 100);
        host.onTurnEnd(() => undefined, 50);
      }),
    );
    await registry.installAll();
    registry.setEnabled("all", true);

    const plan = await registry.assembleTurn(turn);
    expect(plan.userPrefix).toBe("PREFIX");
    expect(plan.reminders.map((reminder) => reminder.text)).toEqual(["high", "other"]);
    expect(plan.hooks.toolAfter.map((entry) => entry.order)).toEqual([100, 300]);
    expect(plan.hooks.turnEnd.map((entry) => entry.order)).toEqual([50]);
  });

  test("会话级开关在回合装配中同样生效", async () => {
    const registry = new CapabilityRegistry();
    registry.register(
      capability("r", (host) => host.reminder(() => ({ text: "reminder" }))),
    );
    await registry.installAll();
    registry.setEnabled("r", true, session.sessionId);
    const plan = await registry.assembleTurn(turn);
    expect(plan.reminders).toHaveLength(1);
  });
});
