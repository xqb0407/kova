import { describe, test, expect } from "bun:test";
import { findUnansweredSteers } from "../../src/protocol/prompt-pipeline";
import type { Running, SteerEntry } from "../../src/types";

/** 最小假 Running：只给 findUnansweredSteers 用到的三处——
 *  agent.steeringQueue（messages + clear，pi-core PendingMessageQueue 运行时形状）、
 *  agent.state.messages（转录，按消息对象身份判定）、compactionGeneration */
function fakeRun(
  steeringMessages: unknown[],
  transcript: unknown[],
  entries: SteerEntry[] | undefined,
  gen = 0,
): { run: Running; cleared: () => number } {
  let clearCount = 0;
  const run = {
    compactionGeneration: gen,
    steerEntries: entries,
    agent: {
      steeringQueue: {
        messages: steeringMessages,
        clear: () => {
          clearCount += 1;
          steeringMessages.length = 0;
        },
      },
      state: { messages: transcript },
    },
  } as unknown as Running;
  return { run, cleared: () => clearCount };
}

const userMsg = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistantMsg = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
/** 中止的残缺 assistant：有消息但零内容（注入后轮次被 Stop 的形态） */
const emptyAssistantMsg = () => ({ role: "assistant", content: [] });

const entry = (message: unknown): SteerEntry => ({
  reqId: `r-${JSON.stringify(message).length}`,
  msg: { text: "注入正文" },
  message,
  gen: 0,
});

describe("findUnansweredSteers（并入轮末回收检测）", () => {
  test("无登记：空数组，且不触碰 steering 队列", () => {
    const steering: unknown[] = [userMsg("无关残留")];
    const { run, cleared } = fakeRun(steering, [], undefined);
    expect(findUnansweredSteers(run)).toEqual([]);
    expect(cleared()).toBe(0);
    expect(steering).toHaveLength(1); // 未清空
  });

  test("滞留在 steering 队列（边界从未抵达）：回收 + 清空防双份投递", () => {
    const m = userMsg("[[queued-steer]] B");
    const steering = [m];
    const { run, cleared } = fakeRun(steering, [], [entry(m)]);
    const out = findUnansweredSteers(run);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toBe(m);
    expect(cleared()).toBe(1);
    expect(steering).toEqual([]);
  });

  test("已进转录且其后有内容的 assistant 回应：不回收（并入成功）", () => {
    const m = userMsg("[[queued-steer]] B");
    const transcript = [userMsg("A"), m, assistantMsg("回应")];
    const { run } = fakeRun([], transcript, [entry(m)]);
    expect(findUnansweredSteers(run)).toEqual([]);
  });

  test("已进转录但其后无任何消息：回收（注入点恰在轮末）", () => {
    const m = userMsg("[[queued-steer]] B");
    const transcript = [userMsg("A"), m];
    const { run } = fakeRun([], transcript, [entry(m)]);
    expect(findUnansweredSteers(run)).toHaveLength(1);
  });

  test("已进转录但其后只有零内容 assistant（中止残缺轮）：回收", () => {
    const m = userMsg("[[queued-steer]] B");
    const transcript = [userMsg("A"), m, emptyAssistantMsg()];
    const { run } = fakeRun([], transcript, [entry(m)]);
    expect(findUnansweredSteers(run)).toHaveLength(1);
  });

  test("转录找不到且压缩代数已变：不回收（注入被折进轮间压缩摘要）", () => {
    const m = userMsg("[[queued-steer]] B");
    const e = entry(m); // e.gen = 0
    const { run } = fakeRun([], [userMsg("A")], [e], 1); // run 代数已进 1
    expect(findUnansweredSteers(run)).toEqual([]);
  });

  test("转录找不到且压缩代数未变：回收（消息凭空缺席按未回应处理）", () => {
    const m = userMsg("[[queued-steer]] B");
    const { run } = fakeRun([], [userMsg("A")], [entry(m)], 0);
    expect(findUnansweredSteers(run)).toHaveLength(1);
  });

  test("多条注入各按自身状态判定（滞留/已回应混合，one-at-a-time 也不漏检）", () => {
    const m1 = userMsg("[[queued-steer]] 第一条");
    const m2 = userMsg("[[queued-steer]] 第二条");
    // m1 已被边界消费并获回应；m2 仍滞留队列（mode=one-at-a-time 下
    // 公开 peek/drain 只看队首，全量快照 .messages 才能两条都检出）
    const transcript = [userMsg("A"), m1, assistantMsg("回应一")];
    const steering = [m2];
    const { run } = fakeRun(steering, transcript, [entry(m1), entry(m2)]);
    const out = findUnansweredSteers(run);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toBe(m2);
    expect(steering).toEqual([]);
  });
});
