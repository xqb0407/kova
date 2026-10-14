/**
 * 长度截断自动续跑（stopReason "length" 且零 toolCall）：
 * vendor 循环把该轮当自然收尾 → 任务"到一半停下"。turn_end 监听里注入
 * followUp 续跑消息，带每轮预算封顶；注入消息对 UI 双面不可见。
 */
import { describe, test, expect } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
  makeAutoContinueMessage,
  MAX_LENGTH_CONTINUES,
  needsLengthContinuation,
  needsStreamBreakContinuation,
} from "../../src/agent/context";
import { onAgentEvent } from "../../src/protocol/stream";
import { AUTO_CONTINUE_PREFIX, toUiMessage } from "../../src/sessions/transcript";
import type { Running } from "../../src/types";

const ev = (e: Record<string, unknown>) => e as unknown as AgentEvent;

const truncatedTurn = (
  content: Array<Record<string, unknown>> = [
    { type: "thinking", thinking: "接下来我要写游戏文件" },
    { type: "text", text: "让我创建完整的 Canvas 游戏……" },
  ],
) => ({
  role: "assistant",
  stopReason: "length",
  content,
});

describe("needsLengthContinuation", () => {
  test("截断且无 toolCall → 需要续跑", () => {
    expect(needsLengthContinuation(ev(truncatedTurn()) as never)).toBe(true);
  });
  test("截断但带 toolCall → 不需要（vendor 自己失败重试）", () => {
    expect(
      needsLengthContinuation(
        ev(
          truncatedTurn([
            { type: "text", text: "我先写文件" },
            { type: "toolCall", id: "t1", name: "write", arguments: {} },
          ]),
        ) as never,
      ),
    ).toBe(false);
  });
  test("正常收尾 / aborted / error 都不触发", () => {
    for (const stopReason of ["stop", "aborted", "error"]) {
      expect(
        needsLengthContinuation(
          ev({ role: "assistant", stopReason, content: [] }) as never,
        ),
      ).toBe(false);
    }
  });
  test("非 assistant 消息不触发", () => {
    expect(
      needsLengthContinuation(
        ev({ role: "user", content: [{ type: "text", text: "hi" }] }) as never,
      ),
    ).toBe(false);
  });
});

describe("makeAutoContinueMessage", () => {
  test("user 角色 + 哨兵前缀", () => {
    const m = makeAutoContinueMessage(1) as unknown as {
      role: string;
      content: { text: string }[];
    };
    expect(m.role).toBe("user");
    expect(m.content[0].text.startsWith(AUTO_CONTINUE_PREFIX)).toBe(true);
  });
  test("流中断的措辞：说清是传输问题，别让模型道歉或复述", () => {
    const m = makeAutoContinueMessage(1, "stream") as unknown as {
      content: { text: string }[];
    };
    const text = m.content[0].text;
    expect(text.startsWith(AUTO_CONTINUE_PREFIX)).toBe(true);
    expect(text.includes("传输中被中断")).toBe(true);
    expect(text.includes("输出 token 上限")).toBe(false);
    expect(text.includes("不要道歉或评论这次中断")).toBe(true);
  });
  test("第 1 次续跑不带反长思考指引", () => {
    const m = makeAutoContinueMessage(1) as unknown as {
      content: { text: string }[];
    };
    expect(m.content[0].text.includes("输出预算有限")).toBe(false);
  });
  test("第 2 次起追加反长思考指引（实测弱模型会整轮烧在 reasoning 上）", () => {
    for (const continues of [2, 3]) {
      const m = makeAutoContinueMessage(continues) as unknown as {
        content: { text: string }[];
      };
      expect(m.content[0].text.includes("输出预算有限")).toBe(true);
      expect(m.content[0].text.includes("不要再进行长篇思考")).toBe(true);
    }
  });
});

describe("needsStreamBreakContinuation（provider 流中断 + 零 toolCall）", () => {
  const broken = (
    errorMessage = "Stream ended without finish_reason",
    content: Array<Record<string, unknown>> = [{ type: "text", text: "半截回答" }],
  ) => ({ role: "assistant", stopReason: "error", errorMessage, content });

  test("可重试类错误且无 toolCall → 需要续跑（线上'回答到一半'场景）", () => {
    expect(needsStreamBreakContinuation(ev(broken()) as never)).toBe(true);
    expect(
      needsStreamBreakContinuation(ev(broken("503 service unavailable")) as never),
    ).toBe(true);
  });

  test("带 toolCall → 不自动续（重发可能重复执行已跑过的工具）", () => {
    expect(
      needsStreamBreakContinuation(
        ev(
          broken("Stream ended without finish_reason", [
            { type: "text", text: "我先写文件" },
            { type: "toolCall", id: "t1", name: "write", arguments: {} },
          ]),
        ) as never,
      ),
    ).toBe(false);
  });

  test("确定性失败（配额/鉴权）不自动续：重发只会再撞同一堵墙", () => {
    expect(
      needsStreamBreakContinuation(ev(broken("insufficient_quota")) as never),
    ).toBe(false);
    expect(
      needsStreamBreakContinuation(ev(broken("invalid api key")) as never),
    ).toBe(false);
  });

  test("非 error 停止原因 / 非 assistant 消息都不触发", () => {
    expect(
      needsStreamBreakContinuation(
        ev({ role: "assistant", stopReason: "length", content: [] }) as never,
      ),
    ).toBe(false);
    expect(
      needsStreamBreakContinuation(
        ev({ role: "user", content: [{ type: "text", text: "hi" }] }) as never,
      ),
    ).toBe(false);
  });
});

describe("toUiMessage 对续跑消息的隐藏", () => {
  const msg = makeAutoContinueMessage(1) as unknown as Parameters<
    typeof toUiMessage
  >[0];
  test("续跑 user 消息不投影 UI（历史不可见）", () => {
    expect(toUiMessage(msg, 1)).toBeNull();
  });
  test("普通 user 消息照常投影", () => {
    expect(
      toUiMessage(
        { role: "user", content: [{ type: "text", text: "做个游戏" }], timestamp: 0 } as never,
        2,
      )?.parts.length,
    ).toBe(1);
  });
});

describe("onAgentEvent turn_end 续跑注入", () => {
  const fakeRun = (lengthContinues?: number) => {
    const followUps: unknown[] = [];
    const run = {
      agent: { followUp: (m: unknown) => followUps.push(m), state: {} },
      threadId: "th-ac",
      sessionId: "s",
      cwd: ".",
      persistedSeq: 0,
      lengthContinues,
    } as unknown as Running;
    return { run, followUps };
  };
  const turnEnd = truncatedTurn();

  test("截断轮注入一条续跑消息并计数（无活跃请求也要注入——旁路运行同样受害）", async () => {
    const { run, followUps } = fakeRun(0);
    await onAgentEvent(ev({ type: "turn_end", message: turnEnd, toolResults: [] }), run);
    expect(followUps.length).toBe(1);
    expect(run.lengthContinues).toBe(1);
  });

  test("缺省计数视为 0", async () => {
    const { run, followUps } = fakeRun(undefined);
    await onAgentEvent(ev({ type: "turn_end", message: turnEnd, toolResults: [] }), run);
    expect(followUps.length).toBe(1);
    expect(run.lengthContinues).toBe(1);
  });

  test("预算耗尽后不再注入", async () => {
    const { run, followUps } = fakeRun(MAX_LENGTH_CONTINUES);
    await onAgentEvent(ev({ type: "turn_end", message: turnEnd, toolResults: [] }), run);
    expect(followUps.length).toBe(0);
    expect(run.lengthContinues).toBe(MAX_LENGTH_CONTINUES);
  });

  test("带 toolCall 的截断轮不注入（交给 vendor 失败重试）", async () => {
    const { run, followUps } = fakeRun(0);
    await onAgentEvent(
      ev({
        type: "turn_end",
        message: truncatedTurn([
          { type: "toolCall", id: "t1", name: "write", arguments: {} },
        ]),
        toolResults: [],
      }),
      run,
    );
    expect(followUps.length).toBe(0);
  });

  test("provider 流中断（可重试、零 toolCall）注入续跑并计数——'回答到一半'自愈", async () => {
    const { run, followUps } = fakeRun(0);
    await onAgentEvent(
      ev({
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Stream ended without finish_reason",
          content: [{ type: "text", text: "半截回答" }],
        },
        toolResults: [],
      }),
      run,
    );
    expect(followUps.length).toBe(1);
    expect(run.lengthContinues).toBe(1);
    const injected = followUps[0] as { content: { text: string }[] };
    expect(injected.content[0].text.includes("传输中被中断")).toBe(true);
  });

  test("配额耗尽（确定性失败）不注入续跑", async () => {
    const { run, followUps } = fakeRun(0);
    await onAgentEvent(
      ev({
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "insufficient_quota",
          content: [{ type: "text", text: "半截回答" }],
        },
        toolResults: [],
      }),
      run,
    );
    expect(followUps.length).toBe(0);
  });

  test("流中断同样受共享预算约束（网关持续抖动不会无限续）", async () => {
    const { run, followUps } = fakeRun(MAX_LENGTH_CONTINUES);
    await onAgentEvent(
      ev({
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Stream ended without finish_reason",
          content: [{ type: "text", text: "半截回答" }],
        },
        toolResults: [],
      }),
      run,
    );
    expect(followUps.length).toBe(0);
    expect(run.lengthContinues).toBe(MAX_LENGTH_CONTINUES);
  });
});
