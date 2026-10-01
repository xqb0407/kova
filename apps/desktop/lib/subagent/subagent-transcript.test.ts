import { describe, expect, test } from "bun:test";
import type { SubagentBlock, SubagentRunState } from "./subagent-runs";
import { buildSubagentTranscript, groupSubagentContent } from "./subagent-transcript";

const baseRun = (over: Partial<SubagentRunState> = {}): SubagentRunState => ({
  delegationId: "d1",
  agentName: "explorer",
  status: "running",
  startedAt: 1000,
  turns: 0,
  toolCalls: 0,
  blocks: [],
  hydrated: true,
  expired: false,
  ...over,
});

const turn = (n: number, at: number): SubagentBlock => ({ kind: "turn", n, at });
const text = (id: string, body: string, at: number, done = true): SubagentBlock => ({
  kind: "text",
  id,
  text: body,
  done,
  startedAt: at,
  ...(done ? { endedAt: at + 10 } : {}),
});
const tool = (id: string, at: number): SubagentBlock => ({
  kind: "tool",
  toolCallId: id,
  toolName: "read",
  done: true,
  at,
});

describe("buildSubagentTranscript", () => {
  test("首条固定是 user 消息，携带派活说明与 startedAt", () => {
    const out = buildSubagentTranscript(baseRun(), "扫一遍仓库");
    expect(out[0]).toMatchObject({ role: "user", text: "扫一遍仓库", at: 1000 });
  });

  test("无 brief 时 user 消息仍存在（text undefined，由视图兜底占位）", () => {
    const out = buildSubagentTranscript(baseRun());
    expect(out[0]!.role).toBe("user");
    expect(out[0]!.text).toBeUndefined();
  });

  test("turn 块切段：每轮一条 assistant 消息，段内块保序", () => {
    const out = buildSubagentTranscript(
      baseRun({
        blocks: [turn(1, 1100), text("t1", "先看目录", 1110), tool("c1", 1120), turn(2, 1200), text("t2", "再看文件", 1210)],
      }),
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(out[1]!.turn).toBe(1);
    expect(out[1]!.blocks!.map((b) => b.kind)).toEqual(["text", "tool"]);
    expect(out[2]!.turn).toBe(2);
    expect(out[2]!.blocks!.map((b) => b.kind)).toEqual(["text"]);
  });

  test("空段被过滤（连续 turn 边界不产出空 assistant 消息）", () => {
    const out = buildSubagentTranscript(
      baseRun({ blocks: [turn(1, 1100), turn(2, 1200), text("t2", "正文", 1210)] }),
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out[1]!.turn).toBe(2);
  });

  test("无 turn 块（事件序缺 turn_start）：按首块时间补隐式段，轮号 undefined", () => {
    const out = buildSubagentTranscript(
      baseRun({ blocks: [text("t1", "只有正文", 1110)] }),
    );
    const seg = out[1]!;
    expect(seg.role).toBe("assistant");
    expect(seg.turn).toBeUndefined();
    expect(seg.at).toBe(1110);
    expect(seg.blocks!.map((b) => b.kind)).toEqual(["text"]);
  });

  test("结算且有报告：追加末条报告消息（带 completedAt）", () => {
    const out = buildSubagentTranscript(
      baseRun({
        status: "completed",
        completedAt: 5000,
        report: "结论：无异常",
        blocks: [turn(1, 1100), text("t1", "过程", 1110)],
      }),
    );
    const last = out[out.length - 1]!;
    expect(last).toMatchObject({ role: "assistant", report: true, text: "结论：无异常", at: 5000 });
  });

  test("运行中：不追加报告段（即使 report 字段已有值）", () => {
    const out = buildSubagentTranscript(
      baseRun({ status: "running", report: "半成品", blocks: [turn(1, 1100), text("t1", "过程", 1110)] }),
    );
    expect(out.every((m) => !m.report)).toBe(true);
  });

  test("结算但无报告：不追加空报告段", () => {
    const out = buildSubagentTranscript(
      baseRun({ status: "failed", blocks: [turn(1, 1100), text("t1", "过程", 1110)] }),
    );
    expect(out.every((m) => !m.report)).toBe(true);
  });
});

describe("groupSubagentContent", () => {
  const thinking = (id: string, at: number): SubagentBlock => ({
    kind: "thinking",
    id,
    text: "想",
    done: true,
    startedAt: at,
  });

  test("连续 tool 合并成一组，其余块各自成单元", () => {
    const units = groupSubagentContent([
      text("t1", "a", 1),
      tool("c1", 2),
      tool("c2", 3),
      text("t2", "b", 4),
      tool("c3", 5),
    ]);
    expect(units.map((u) => u.kind)).toEqual(["block", "tools", "block", "tools"]);
    const first = units[1]!;
    expect(first.kind === "tools" && first.tools.map((t) => t.toolCallId)).toEqual(["c1", "c2"]);
    const second = units[3]!;
    expect(second.kind === "tools" && second.tools.map((t) => t.toolCallId)).toEqual(["c3"]);
  });

  test("空数组返回空；全是 tool 合成单组", () => {
    expect(groupSubagentContent([])).toEqual([]);
    const units = groupSubagentContent([tool("c1", 1), tool("c2", 2)]);
    expect(units).toHaveLength(1);
    expect(units[0]!.kind).toBe("tools");
  });

  test("thinking 打断分组（不与 tool 混在同一组）", () => {
    const units = groupSubagentContent([tool("c1", 1), thinking("k1", 2), tool("c2", 3)]);
    expect(units.map((u) => u.kind)).toEqual(["tools", "block", "tools"]);
  });
});
