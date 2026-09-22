/**
 * 事件水印计数器单测（设计文档 §3）：播种幂等、单调、代际隔离。
 */
import { describe, expect, test } from "bun:test";
import {
  seedEventSeq,
  nextEventSeq,
  withEventSeq,
  dropEventSeq,
} from "../../src/protocol/event-seq";

describe("event-seq", () => {
  test("未播种从 1 起单调递增，会话间互不串号", () => {
    expect(nextEventSeq("seq-a")).toBe(1);
    expect(nextEventSeq("seq-a")).toBe(2);
    expect(nextEventSeq("seq-b")).toBe(1);
  });

  test("播种只生效一次（重绑/重复 resolve 幂等）", () => {
    seedEventSeq("seq-c", 41);
    expect(nextEventSeq("seq-c")).toBe(42);
    seedEventSeq("seq-c", 0); // 再播不动
    expect(nextEventSeq("seq-c")).toBe(43);
  });

  test("withEventSeq 保留原帧字段并盖号", () => {
    seedEventSeq("seq-d", 100);
    const frame = withEventSeq("seq-d", { type: "session_state", sessionId: "seq-d", phase: "idle" });
    expect(frame).toEqual({
      type: "session_state",
      sessionId: "seq-d",
      phase: "idle",
      eventSeq: 101,
    });
  });

  test("dropEventSeq 后重新从 1 起（会话删除代际）", () => {
    expect(nextEventSeq("seq-e")).toBe(1);
    dropEventSeq("seq-e");
    expect(nextEventSeq("seq-e")).toBe(1);
  });
});
