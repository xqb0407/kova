import { describe, test, expect } from "bun:test";
import { currentTurnOf, noteActiveTurn } from "../../src/sessions/registry";

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
});
