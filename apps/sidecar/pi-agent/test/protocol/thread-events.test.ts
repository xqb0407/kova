import { describe, expect, test } from "bun:test";
import { hasRunningDelegations, isPartialAlreadyPersisted } from "../../src/protocol/thread-events";
import type { Running } from "../../src/types";

/**
 * thread_snapshot 的 partial 去重：message_end 的落盘（订阅在前）与台账清理
 * （订阅在后）之间隔着 persist 的异步写库——窗口内到达的快照会同时看到
 * 「转录里刚落盘的行」和「尚未清理的 partial」，不去重就是同一条消息两份，
 * 前端渲染成两条气泡（慢存储时几乎必中，2026-10-27 队列消息重复报障）。
 */

const user = (text: string, timestamp = 1): Record<string, unknown> => ({
  role: "user",
  content: text,
  timestamp,
});
const assistantRow = (timestamp = 0): Record<string, unknown> => ({
  role: "assistant",
  content: [],
  timestamp,
});

describe("agent_end 的委派收敛标记", () => {
  const fakeRun = (statuses: string[]) =>
    ({
      delegations: new Map(
        statuses.map((status, index) => [`d${index}`, { status }]),
      ),
    }) as unknown as Running;

  test("仍有 running delegation：本轮没有真正结束，agent_end 应带 willRetry", () => {
    expect(hasRunningDelegations(fakeRun(["running"]))).toBe(true);
    expect(hasRunningDelegations(fakeRun(["running", "completed"]))).toBe(true);
  });

  test("没有 running delegation：可直接判定 idle", () => {
    expect(hasRunningDelegations(fakeRun([]))).toBe(false);
    expect(hasRunningDelegations(fakeRun(["completed", "stopped"]))).toBe(false);
  });
});

describe("isPartialAlreadyPersisted", () => {
  test("partial 与转录末行是同一消息 → 判定重复", () => {
    expect(
      isPartialAlreadyPersisted([assistantRow(), user("hi", 5)], user("hi", 5)),
    ).toBe(true);
  });

  test("内容/时间戳/角色任一不同 → 不是同一条", () => {
    expect(isPartialAlreadyPersisted([user("hi", 5)], user("hi2", 5))).toBe(false);
    expect(isPartialAlreadyPersisted([user("hi", 5)], user("hi", 6))).toBe(false);
    expect(
      isPartialAlreadyPersisted([user("hi", 5)], {
        role: "assistant",
        content: "hi",
        timestamp: 5,
      }),
    ).toBe(false);
  });

  test("尾部是 compaction/modelChange 行 → 跳过它们，与最后一条消息行比对", () => {
    expect(
      isPartialAlreadyPersisted(
        [
          user("hi", 5),
          { role: "compactionSummary", content: null, timestamp: 0 },
          { role: "modelChange", content: null, timestamp: 0 },
        ],
        user("hi", 5),
      ),
    ).toBe(true);
  });

  test("转录里没有任何消息行 → 不重复（正常追加 partial）", () => {
    expect(isPartialAlreadyPersisted([], user("hi", 5))).toBe(false);
    expect(
      isPartialAlreadyPersisted(
        [{ role: "compactionSummary", content: null, timestamp: 0 }],
        user("hi", 5),
      ),
    ).toBe(false);
  });
});
