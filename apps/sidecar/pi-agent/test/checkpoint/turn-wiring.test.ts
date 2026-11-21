import { describe, test, expect } from "bun:test";
import {
  currentTurnOf,
  hasConcurrentTurn,
  isTurnShared,
  noteActiveTurn,
  running,
} from "../../src/sessions/registry";
import type { Running } from "../../src/types";

/**
 * 检查点回合键的接线路径：tools.ts 在 write/edit execute 里经 currentTurnOf 取
 * {sessionId, requestId} 作为 store 的会话/回合键。这里锁住两端的契约：
 * noteActiveTurn 登记什么，currentTurnOf 就能给工具什么；轮结束即清空——
 * 工具若在轮外执行拿到空对象，会降级为不记（绝不猜测归属）。
 *
 * （不用 mock.module 造假宿主走完整 execute：那是进程级 mock，本仓测试纪律
 * 禁止——见 test/agent/summarize-request.test.ts 头注。）
 */

describe("checkpoint turn wiring", () => {
  test("round trip: noteActiveTurn → currentTurnOf → clear", () => {
    const thread = "thread-cp-wiring";
    expect(currentTurnOf(thread)).toEqual({});

    noteActiveTurn(thread, true, "sess-1", "req-42");
    expect(currentTurnOf(thread)).toEqual({ sessionId: "sess-1", requestId: "req-42" });

    // steer 注入不携带新 id：requestId 保持首轮（卡片按首轮 turnId 查全部编辑）
    noteActiveTurn(thread, true, "sess-1", undefined);
    expect(currentTurnOf(thread).sessionId).toBe("sess-1");
    expect(currentTurnOf(thread).requestId).toBeUndefined();

    // 恢复：下一次带 id 的通报重新写回
    noteActiveTurn(thread, true, "sess-1", "req-43");
    expect(currentTurnOf(thread).requestId).toBe("req-43");

    noteActiveTurn(thread, false);
    expect(currentTurnOf(thread)).toEqual({});
  });

  test("同工作区并发轮次标 shared；不同 cwd 不标；轮结束后仍可查", () => {
    const run = (threadId: string, cwd: string): Running =>
      ({
        threadId,
        sessionId: `sess-${threadId}`,
        cwd,
        agent: {},
      }) as unknown as Running;

    running.set("cp-a", run("cp-a", "/w"));
    running.set("cp-b", run("cp-b", "/w/")); // 尾斜杠归一化后同一工作区
    running.set("cp-c", run("cp-c", "/other"));

    noteActiveTurn("cp-a", true, "sess-cp-a", "req-a");
    expect(isTurnShared("sess-cp-a", "req-a")).toBe(false);

    // 后来者在同 cwd 开轮：双方都置 shared
    noteActiveTurn("cp-b", true, "sess-cp-b", "req-b");
    expect(isTurnShared("sess-cp-a", "req-a")).toBe(true);
    expect(isTurnShared("sess-cp-b", "req-b")).toBe(true);

    // 不同工作区互不影响
    noteActiveTurn("cp-c", true, "sess-cp-c", "req-c");
    expect(isTurnShared("sess-cp-c", "req-c")).toBe(false);
    expect(hasConcurrentTurn("sess-cp-c", "/other")).toBe(false);

    // 边界窗口：A 先结束、B 还在跑 → A 的 settle 仍应看到同 cwd 活跃轮
    noteActiveTurn("cp-a", false);
    expect(hasConcurrentTurn("sess-cp-a", "/w")).toBe(true);
    expect(hasConcurrentTurn("sess-cp-b", "/w")).toBe(false); // 只剩 C（不同 cwd）

    // 轮结束（settle 可能晚于 noteActiveTurn(false)）：标记保留供结算查询
    noteActiveTurn("cp-b", false);
    noteActiveTurn("cp-c", false);
    expect(isTurnShared("sess-cp-a", "req-a")).toBe(true);
    expect(isTurnShared("sess-cp-c", "req-c")).toBe(false);

    running.delete("cp-a");
    running.delete("cp-b");
    running.delete("cp-c");
  });
});
