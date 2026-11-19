import { afterEach, describe, expect, test } from "bun:test";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import { silentTurnReminderCapability } from "../../src/agent/assembly/capabilities/silent-turn-reminder";
import { todoStaleReminderCapability } from "../../src/agent/assembly/capabilities/todo-stale-reminder";
import { CapabilityRegistry } from "../../src/agent/assembly/registry";
import type { TurnEndInfo, TurnPlan, TurnSnapshot } from "../../src/agent/assembly/contracts";
import {
  resetCapabilitySettingsForTest,
  setCapabilitySettingsForTest,
} from "../../src/agent/assembly/settings";
import { buildTodoTool, clearTodoState } from "../../src/todo/todo";

/**
 * 回合级行为提醒（silent-turn / todo-stale）：连续静默与任务清单停更的
 * 注入时机、重置语义与「每段一次」约束。骨架与 loop-guard 测试同款。
 */

function snapshotOf(sessionId: string, turnId: string, threadId = sessionId): TurnSnapshot {
  return {
    sessionId,
    threadId,
    cwd: "/tmp/ws",
    mode: "agent",
    appMode: "code",
    model: null,
    turnId,
    messages: [],
    userText: "do it",
    approvalLevel: "ask",
  };
}

function endInfo(overrides: Partial<TurnEndInfo> = {}): TurnEndInfo {
  return {
    stopRequested: false,
    assistantText: "",
    toolResults: [],
    queueReminder: () => {},
    ...overrides,
  };
}

async function planFor(id: string, capability: () => unknown, params?: Record<string, unknown>) {
  setCapabilitySettingsForTest({
    enabled: { [id]: true },
    params: params ? { [id]: params } : {},
  });
  const registry = new CapabilityRegistry();
  registry.register(capability() as never);
  await registry.installAll();
  registry.setEnabled(id, true);
  return registry.assembleTurn(snapshotOf("session-r", "run-1"));
}

afterEach(() => {
  resetCapabilitySettingsForTest();
  clearTodoState("session-r");
});

describe("silent-turn-reminder 能力", () => {
  async function silentPlan(threshold = 3) {
    return planFor("silent-turn-reminder", silentTurnReminderCapability, { threshold });
  }

  test("连续静默达到阈值注入一次；继续静默不再重复", async () => {
    const plan = await silentPlan(3);
    const end = plan.hooks.turnEnd[0].handler;
    const queued: string[] = [];
    const info = (text: string) =>
      endInfo({ assistantText: text, queueReminder: (t) => queued.push(t) });

    await end(info(""), plan.snapshot);
    await end(info(""), plan.snapshot);
    expect(queued).toHaveLength(0);
    await end(info(""), plan.snapshot);
    expect(queued).toHaveLength(1);

    // 第 4、5 轮仍静默：不重复提醒
    await end(info(""), plan.snapshot);
    await end(info(""), plan.snapshot);
    expect(queued).toHaveLength(1);
  });

  test("用户可见输出重置计数与提醒位；占位文本不算可见", async () => {
    const plan = await silentPlan(2);
    const end = plan.hooks.turnEnd[0].handler;
    const queued: string[] = [];
    const info = (text: string) =>
      endInfo({ assistantText: text, queueReminder: (t) => queued.push(t) });

    await end(info(""), plan.snapshot);
    await end(info("(no content)"), plan.snapshot); // 占位符也算静默
    expect(queued).toHaveLength(1);

    await end(info("找到了根因：缓存键没带上会话 id"), plan.snapshot);
    expect(queued).toHaveLength(1);

    // 可见输出后重新起算：再次达到阈值才第二次提醒
    await end(info(""), plan.snapshot);
    expect(queued).toHaveLength(1);
    await end(info(""), plan.snapshot);
    expect(queued).toHaveLength(2);
  });

  test("stopRequested 时不排队（最终轮提醒随轮末丢弃的语义保持）", async () => {
    const plan = await silentPlan(1);
    const end = plan.hooks.turnEnd[0].handler;
    const queued: string[] = [];
    await end(endInfo({ stopRequested: true, queueReminder: (t) => queued.push(t) }), plan.snapshot);
    expect(queued).toHaveLength(0);
  });
});

describe("todo-stale-reminder 能力", () => {
  async function todoPlan(threshold = 2) {
    return planFor("todo-stale-reminder", todoStaleReminderCapability, { threshold });
  }

  function todoObserve(plan: TurnPlan) {
    return plan.hooks.toolAfter.find((h) => h.capabilityId === "todo-stale-reminder")!.handler;
  }

  function todoCall(isError = false): AfterToolCallContext {
    return {
      assistantMessage: { role: "assistant", content: [], timestamp: 0 },
      toolCall: { type: "toolCall", id: "c-todo", name: "todo", arguments: { action: "update" } },
      args: { action: "update" },
      result: { content: [{ type: "text", text: "ok" }] },
      isError,
      context: {},
    } as unknown as AfterToolCallContext;
  }

  test("有 in_progress 任务 + 连续停更达到阈值 → 提醒一次", async () => {
    const plan = await todoPlan(2);
    const end = plan.hooks.turnEnd[0].handler;
    const queued: string[] = [];
    const info = () => endInfo({ queueReminder: (t) => queued.push(t) });

    // 种一个 in_progress 任务（走真实 todo 工具：create 恒为 pending，再 update）
    const todo = buildTodoTool("session-r");
    await todo.execute("seed", { action: "create", subject: "work" } as never);
    await todo.execute("seed", { action: "update", id: 1, status: "in_progress" } as never);

    await end(info(), plan.snapshot);
    await end(info(), plan.snapshot);
    expect(queued).toHaveLength(1);
    await end(info(), plan.snapshot);
    expect(queued).toHaveLength(1);
  });

  test("成功的 todo 写入重置计数；失败的写入不重置", async () => {
    const plan = await todoPlan(2);
    const observe = todoObserve(plan);
    const end = plan.hooks.turnEnd[0].handler;
    const queued: string[] = [];
    const info = () => endInfo({ queueReminder: (t) => queued.push(t) });

    const todo = buildTodoTool("session-r");
    await todo.execute("seed", { action: "create", subject: "work" } as never);
    await todo.execute("seed", { action: "update", id: 1, status: "in_progress" } as never);

    await end(info(), plan.snapshot);
    // 成功写入 → 计数清零
    await observe(todoCall(false), plan.snapshot);
    await end(info(), plan.snapshot);
    expect(queued).toHaveLength(0);

    // 失败的写入不清零：再一轮就到阈值
    await observe(todoCall(true), plan.snapshot);
    await end(info(), plan.snapshot);
    expect(queued).toHaveLength(1);
  });

  test("没有 in_progress 任务时不计数也不提醒", async () => {
    const plan = await todoPlan(1);
    const end = plan.hooks.turnEnd[0].handler;
    const queued: string[] = [];
    const info = () => endInfo({ queueReminder: (t) => queued.push(t) });

    const todo = buildTodoTool("session-r");
    // 只有 completed，无 in_progress
    await todo.execute("seed", { action: "create", subject: "done work", status: "completed" } as never);

    await end(info(), plan.snapshot);
    await end(info(), plan.snapshot);
    expect(queued).toHaveLength(0);
  });
});
