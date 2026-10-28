import { describe, expect, test } from "bun:test";
import { reactionForAgentEvent } from "./agent-mapping";

describe("reactionForAgentEvent（事件映射）", () => {
  test("过程态：开始→working、停止→idle，只切动作不弹泡", () => {
    expect(reactionForAgentEvent("agent.turn.started")).toMatchObject({ motion: "working" });
    expect(reactionForAgentEvent("agent.turn.started")?.bubble).toBeUndefined();
    expect(reactionForAgentEvent("agent.turn.stopped")).toMatchObject({ motion: "idle" });
    expect(reactionForAgentEvent("agent.turn.stopped")?.bubble).toBeUndefined();
  });

  test("agent 会话终态：完成/出错/等审批/等回答", () => {
    expect(reactionForAgentEvent("agent.turn.completed")).toMatchObject({
      motion: "waving",
      bubble: "任务完成",
    });
    expect(reactionForAgentEvent("agent.turn.error")).toMatchObject({ motion: "failed" });
    expect(reactionForAgentEvent("agent.approval.pending")).toMatchObject({
      motion: "waiting",
      bubble: "等你审批",
    });
    expect(reactionForAgentEvent("agent.question.pending")).toMatchObject({ motion: "waiting" });
  });

  test("气泡带任务上下文（data 摘要）", () => {
    expect(reactionForAgentEvent("agent.turn.completed", { prompt: "帮我写一个官网首页落地页" })).toMatchObject({
      bubble: "完成：帮我写一个官网首页落地页",
    });
    expect(reactionForAgentEvent("agent.turn.error", { message: "pi agent error" })).toMatchObject({
      bubble: "出错：pi agent error",
    });
    expect(reactionForAgentEvent("agent.approval.pending", { toolName: "bash" })).toMatchObject({
      bubble: "等你审批：bash",
    });
    expect(reactionForAgentEvent("agent.question.pending", { count: 3, firstTitle: "选哪个方案" })).toMatchObject({
      bubble: "等你回答：选哪个方案",
    });
    // data 缺失/空串时回落固定文案
    expect(reactionForAgentEvent("agent.turn.completed", { prompt: "  " })?.bubble).toBe("任务完成");
  });

  test("定时任务事件：完成跳庆祝、失败回落 failed", () => {
    expect(reactionForAgentEvent("automation.task.completed")).toMatchObject({ motion: "jumping" });
    expect(reactionForAgentEvent("automation.task.failed")).toMatchObject({ motion: "failed" });
  });

  test("未知事件返回 null（前向兼容：新事件不乱切动作）", () => {
    expect(reactionForAgentEvent("agent.turn.finished")).toBeNull();
    expect(reactionForAgentEvent("system.test")).toBeNull();
    expect(reactionForAgentEvent("")).toBeNull();
  });
});
