import { afterAll, describe, expect, mock, test } from "bun:test";

import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * 往上翻一窗（§6 懒加载）的核心契约：
 *  - 旧窗前插到当前消息流之前：链成 旧窗 → 当前窗，headId 不变；
 *  - **返回值 = 真正并入的消息条数**（调用方据此平移检查点/压缩线的下标锚点）。
 *    这条是修过的 bug：早先调用方用"前后消息总数相减"推导平移量，加载期间新到的
 *    消息会被算进去（平移过头）。这里锁住"由并入那一窗给出条数"的契约。
 * 传输层打桩：piRequest 只服务 get_history；history 窗口元数据用内存表。
 */
const historyRows: {
  messages: { id: string; role: string; parts: unknown[] }[];
  meta: { firstSeq: number | null; hasMore: boolean };
} = { messages: [], meta: { firstSeq: 10, hasMore: true } };

mockModule("@/lib/pi/pi-bridge", () => ({
  piRequest: async (req: { type: string; beforeSeq?: number }) => {
    if (req.type !== "get_history") throw new Error(`unexpected ${req.type}`);
    return {
      type: "history",
      messages: historyRows.messages,
      pending: [],
      firstSeq: historyRows.meta.firstSeq,
      lastSeq: 99,
      hasMore: historyRows.meta.hasMore,
    } satisfies Record<string, unknown>;
  },
}));
mockModule("@/lib/pi/pi-history-window", () => {
  const meta = new Map<string, { firstSeq: number | null; hasMore: boolean }>();
  return {
    HISTORY_PAGE_ROWS: 200,
    HISTORY_TAIL_ROWS: 800,
    getHistoryWindowMeta: (remoteId: string) => meta.get(remoteId),
    setHistoryWindowMeta: (remoteId: string, m: { firstSeq: number | null; hasMore: boolean }) =>
      meta.set(remoteId, m),
    clearHistoryWindowMeta: (remoteId: string) => meta.delete(remoteId),
    fetchHistoryWindow: async (remoteId: string, opts: { beforeSeq?: number }) => {
      const res = (await (
        await import("@/lib/pi/pi-bridge")
      ).piRequest({ type: "get_history", ...opts })) as {
        messages: unknown[];
        firstSeq?: number | null;
        hasMore?: boolean;
      };
      const m = {
        firstSeq: typeof res.firstSeq === "number" ? res.firstSeq : null,
        hasMore: res.hasMore === true,
      };
      meta.set(remoteId, m);
      return { messages: res.messages, pending: [], meta: m };
    },
    seedHistoryTurnTimings: () => {},
  };
});

const { loadOlderPiHistory } = await import("@/lib/pi/pi-thread-adapter");

afterAll(() => restoreAllMocks());

/** 造一个可断言的最小 aui：只记录 import 收到的仓库 */
function fakeAui(current: {
  headId: string | null;
  messages: { parentId: string | null; message: { id: string; role: string; content: unknown[] } }[];
}) {
  const calls: typeof current[] = [];
  return {
    calls,
    thread: {
      export: () => current,
      import: (repo: typeof current) => calls.push(repo),
    },
  };
}

describe("loadOlderPiHistory", () => {
  test("旧窗并入：链接到当前窗之前、headId 保持，返回并入条数", async () => {
    historyRows.messages = [
      { id: "old-1", role: "user", parts: [{ type: "text", text: "更早的问题" }] },
      { id: "old-2", role: "assistant", parts: [{ type: "text", text: "更早的回答" }] },
    ];
    historyRows.meta = { firstSeq: 10, hasMore: true };
    const current = {
      headId: "cur-2",
      messages: [
        { parentId: null, message: { id: "cur-1", role: "user" as const, content: [] } },
        { parentId: "cur-1", message: { id: "cur-2", role: "assistant" as const, content: [] } },
      ],
    };
    // 先让窗口表里有游标（首窗装载的等价物）
    const aui = fakeAui(current);
    const { loadOlderPiHistory: _load } = await import("@/lib/pi/pi-thread-adapter");
    const bridged = (await import("@/lib/pi/pi-history-window")) as {
      setHistoryWindowMeta: (remoteId: string, m: { firstSeq: number | null; hasMore: boolean }) => void;
    };
    bridged.setHistoryWindowMeta("sess-1", { firstSeq: 10, hasMore: true });

    const added = await _load(aui as never, "sess-1", "thread-1");

    expect(added).toBe(2); // ← 平移量由这一窗给出，与"总数相减"解耦
    expect(aui.calls).toHaveLength(1);
    const merged = aui.calls[0];
    expect(merged.headId).toBe("cur-2"); // 头不变（尾部还是最新）
    expect(merged.messages.map((m) => m.message.id)).toEqual([
      "old-1",
      "old-2",
      "cur-1",
      "cur-2",
    ]);
    // 旧窗尾 → 当前窗首的链条不断
    expect(merged.messages[2].parentId).toBe("old-2");
    expect(merged.messages[0].parentId).toBeNull();
  });

  test("没有更早历史 / 无游标：返回 0 且不 import", async () => {
    const aui = fakeAui({ headId: null, messages: [] });
    const bridged = (await import("@/lib/pi/pi-history-window")) as {
      setHistoryWindowMeta: (remoteId: string, m: { firstSeq: number | null; hasMore: boolean }) => void;
    };
    bridged.setHistoryWindowMeta("sess-2", { firstSeq: 5, hasMore: false });
    expect(await loadOlderPiHistory(aui as never, "sess-2", "thread-2")).toBe(0);
    expect(aui.calls).toHaveLength(0);
  });
});
