import { describe, expect, test } from "bun:test";
import type { PiTraceRun } from "@/lib/pi/pi-bridge";
import { traceRunToSpanData } from "./trace-adapter";

const TRACE_ID = "c".repeat(32);
const TURN_ID = "b".repeat(16);
const LLM_ID = "1".repeat(16);
const TOOL_ID = "2".repeat(16);

const run: PiTraceRun = {
  traceId: TRACE_ID,
  runId: TRACE_ID,
  sessionId: "s1",
  source: "ui",
  startMs: 1000,
  endMs: 3000,
  status: "ok",
  model: "p/m",
  spans: [
    {
      spanId: TURN_ID,
      kind: "turn",
      startMs: 1100,
      endMs: 1200,
      status: "ok",
      attrs: { index: 1 },
      children: [
        {
          spanId: LLM_ID,
          parentSpanId: TURN_ID,
          kind: "llm_call",
          startMs: 1110,
          endMs: 1150,
          status: "ok",
          attrs: { model: "p/m" },
        },
        {
          spanId: TOOL_ID,
          parentSpanId: TURN_ID,
          kind: "tool_call",
          name: "bash",
          startMs: 1150,
          endMs: 1180,
          status: "ok",
        },
      ],
    },
  ],
};

describe("traceRunToSpanData", () => {
  test("id 直接用持久化 spanId，父子关系与 OTLP 同源", () => {
    const { spans } = traceRunToSpanData(run);
    const byId = new Map(spans.map((s) => [s.id, s]));
    const rootId = TRACE_ID.slice(0, 16);

    expect(byId.has(rootId)).toBe(true);
    expect(byId.get(rootId)!.parentSpanId).toBeNull();
    // turn 无 parentSpanId → 挂在 run 根下
    expect(byId.get(TURN_ID)!.parentSpanId).toBe(rootId);
    // 同轮子 span 挂到 turn
    expect(byId.get(LLM_ID)!.parentSpanId).toBe(TURN_ID);
    expect(byId.get(TOOL_ID)!.parentSpanId).toBe(TURN_ID);
    // 面板 span 集合 = 记录 spanId 集合（逐 span 可与导出对齐）
    expect(new Set(spans.map((s) => s.id))).toEqual(
      new Set([rootId, TURN_ID, LLM_ID, TOOL_ID]),
    );
  });

  test("旧记录（无 traceId/spanId）回退：根 id 取 runId 前缀、子 span 走 DFS，不抛", () => {
    const legacy: PiTraceRun = {
      runId: "a".repeat(32),
      sessionId: "s2",
      source: "ui",
      startMs: 1,
      endMs: 2,
      status: "ok",
      spans: [
        {
          kind: "turn",
          startMs: 1,
          endMs: 2,
          status: "ok",
          children: [{ kind: "tool_call", name: "bash", startMs: 1, endMs: 2, status: "ok" }],
        },
      ],
    };
    const { spans } = traceRunToSpanData(legacy);
    expect(spans).toHaveLength(3);
    const rootId = "a".repeat(16);
    expect(spans[0]!.id).toBe(rootId);
    expect(spans[0]!.parentSpanId).toBeNull();
    const tool = spans.find((s) => s.type === "tool")!;
    expect(tool.parentSpanId).not.toBeNull();
  });
});
