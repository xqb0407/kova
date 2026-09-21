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
    const m = makeAutoContinueMessage() as unknown as {
      role: string;
      content: { text: string }[];
    };
    expect(m.role).toBe("user");
    expect(m.content[0].text.startsWith(AUTO_CONTINUE_PREFIX)).toBe(true);
  });
});

describe("toUiMessage 对续跑消息的隐藏", () => {
  const msg = makeAutoContinueMessage() as unknown as Parameters<
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
});
