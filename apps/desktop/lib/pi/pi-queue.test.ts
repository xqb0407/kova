import { describe, expect, test, afterEach } from "bun:test";

import {
  applyQueueStateChunk,
  cancelQueueItem,
  getQueueSnapshot,
  getSteeredEntries,
  getThreadPendingTurn,
  notifyQueueStreamStart,
  optimisticallyRemoveQueuedMessage,
  registerQueuedMessage,
  resetQueueForTests,
  setQueueSyncListener,
  steerQueueItem,
  unregisterQueuedMessage,
  type QueueSnapshot,
  type RegisteredMessage,
} from "./pi-queue";

const THREAD = "thread-1";
const OTHER_THREAD = "thread-other";

/** 造快照（v3，无 paused / state 字段） */
function snapshotOf(
  items: { reqId: string; text: string; id?: number }[],
): QueueSnapshot {
  return {
    version: 2,
    threadId: THREAD,
    items: items.map((item, i) => ({
      id: item.id ?? i + 1,
      reqId: item.reqId,
      text: item.text,
      createdAt: "2026-01-01T00:00:00Z",
    })),
    nextId: items.length + 1,
  };
}

/** 造乐观 user 消息桩 */
const userMessage = (id: string, text: string) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

function collect() {
  const events: { reg: RegisteredMessage; kind: string }[] = [];
  setQueueSyncListener((reg, kind) => {
    events.push({ reg, kind });
  });
  return events;
}

afterEach(() => {
  resetQueueForTests();
  setQueueSyncListener(null);
});

describe("快照镜像（data-queue-state）", () => {
  test("新条目入快照：pending→queued，触发 remove（消息摘除信号）", () => {
    registerQueuedMessage("req-1", THREAD, userMessage("msg-1", "hello"));
    const events = collect();

    applyQueueStateChunk(THREAD, snapshotOf([{ reqId: "req-1", text: "hello" }]));

    expect(events.map((e) => ({ kind: e.kind, messageId: e.reg.messageId }))).toEqual([
      { kind: "remove", messageId: "msg-1" },
    ]);
    expect(getQueueSnapshot(THREAD).items).toHaveLength(1);
  });

  test("快照全量替换：条目消失即派发出队，触发 reveal + 派发空窗", () => {
    registerQueuedMessage("req-1", THREAD, userMessage("msg-1", "hello"));
    applyQueueStateChunk(THREAD, snapshotOf([{ reqId: "req-1", text: "hello" }]));

    const events = collect();
    applyQueueStateChunk(THREAD, snapshotOf([]));

    expect(events.map((e) => ({ kind: e.kind, messageId: e.reg.messageId }))).toEqual([
      { kind: "reveal", messageId: "msg-1" },
    ]);
    expect(getThreadPendingTurn(THREAD)).toBe(true);

    // 该请求流收尾：清空窗标记
    unregisterQueuedMessage("req-1", THREAD);
    expect(getThreadPendingTurn(THREAD)).toBe(false);
  });

  test("无变化快照重复应用：不触发事件（防渲染↔同步循环）", () => {
    registerQueuedMessage("req-1", THREAD, userMessage("msg-1", "hello"));
    const snap = snapshotOf([{ reqId: "req-1", text: "hello" }]);
    applyQueueStateChunk(THREAD, snap);

    const events = collect();
    applyQueueStateChunk(THREAD, snap);
    applyQueueStateChunk(THREAD, snap);
    expect(events).toEqual([]);
  });
});

describe("出快照分类", () => {
  test("用户删除（cancelled）：静默清理不回填", () => {
    registerQueuedMessage("req-1", THREAD, userMessage("msg-1", "hello"));
    applyQueueStateChunk(THREAD, snapshotOf([{ reqId: "req-1", text: "hello" }]));

    const events = collect();
    void cancelQueueItem("req-1").catch(() => {});
    applyQueueStateChunk(THREAD, snapshotOf([]));

    expect(events).toEqual([]);
    expect(getQueueSnapshot(THREAD).items).toHaveLength(0);
  });

  test("steered：宿主轮流收尾时只清登记不回填（并入内容已随回复呈现）", () => {
    registerQueuedMessage("req-1", THREAD, userMessage("msg-1", "hello"));
    applyQueueStateChunk(THREAD, snapshotOf([{ reqId: "req-1", text: "hello" }]));

    // 并入当前轮（catch 捕获异步失败：通道不存在不影响 phase 更新）
    void steerQueueItem("req-1").catch(() => {});

    // 条目消失于快照：由于 phase === "steered" ≠ "queued"，不会触发 reveal
    const events = collect();
    applyQueueStateChunk(THREAD, snapshotOf([]));
    expect(events).toEqual([]);

    // 仍可见于 steered entries（徽标数据源，消息在数组外）
    expect(getSteeredEntries(THREAD)).toEqual([{ reqId: "req-1", text: "hello" }]);

    // 宿主轮流收尾：徽标消失，气泡不回填
    unregisterQueuedMessage("req-1", THREAD);
    expect(events).toEqual([]);
    expect(getSteeredEntries(THREAD)).toEqual([]);
  });

  test("并入被拒：仍在快照的 steered 登记回退 queued（徽标自愈不滞留）", () => {
    registerQueuedMessage("req-1", THREAD, userMessage("msg-1", "hello"));
    applyQueueStateChunk(THREAD, snapshotOf([{ reqId: "req-1", text: "hello" }]));
    void steerQueueItem("req-1").catch(() => {});
    expect(getSteeredEntries(THREAD)).toHaveLength(1);

    // sidecar 拒绝并入（活跃轮恰好收尾等）：条目原位保留 → 下一份快照里
    // 它还在 → 登记回退 queued，徽标消失、排队条原样接住
    applyQueueStateChunk(THREAD, snapshotOf([{ reqId: "req-1", text: "hello" }]));
    expect(getSteeredEntries(THREAD)).toEqual([]);
    expect(getQueueSnapshot(THREAD).items).toHaveLength(1);
  });
});

describe("未登记条目（刷新恢复）", () => {
  test("快照条目无注册：按快照文本重建（queued-<id>），派发出队照常回填", () => {
    applyQueueStateChunk(THREAD, snapshotOf([{ reqId: "req-9", text: "rebuilt", id: 7 }]));

    const events = collect();
    applyQueueStateChunk(THREAD, snapshotOf([]));
    expect(events.map((e) => ({ kind: e.kind, messageId: e.reg.messageId }))).toEqual([
      { kind: "reveal", messageId: "queued-7" },
    ]);
    expect(events[0]!.reg.message?.parts[0]).toEqual({
      type: "text",
      text: "rebuilt",
    });
  });
});

describe("多线程隔离", () => {
  test("其他线程的快照不影响本线程", () => {
    applyQueueStateChunk(
      OTHER_THREAD,
      snapshotOf([{ reqId: "req-o", text: "other" }]),
    );
    expect(getQueueSnapshot(THREAD).items).toHaveLength(0);
    expect(getThreadPendingTurn(OTHER_THREAD)).toBe(false);
    expect(getThreadPendingTurn(THREAD)).toBe(false);
  });
});

describe("乐观摘除（消除快照往返闪现）", () => {
  test("登记后即刻摘除；确认快照幂等再摘（渲染侧 no-op），派发出快照回填", () => {
    registerQueuedMessage("req-1", THREAD, userMessage("msg-1", "hello"));
    const events = collect();

    optimisticallyRemoveQueuedMessage("req-1");
    expect(events.map((e) => e.kind)).toEqual(["remove"]);

    // 权威快照随后到达：再发一次 remove（幂等，消息已不在数组）
    applyQueueStateChunk(THREAD, snapshotOf([{ reqId: "req-1", text: "hello" }]));
    expect(events.map((e) => e.kind)).toEqual(["remove", "remove"]);

    // 派发出快照：正常回填 + 派发空窗标记
    applyQueueStateChunk(THREAD, snapshotOf([]));
    expect(events.map((e) => e.kind)).toEqual(["remove", "remove", "reveal"]);
    expect(getThreadPendingTurn(THREAD)).toBe(true);
  });

  test("乐观摘除判错（sidecar 直接开跑）：start chunk 回填并销登记", () => {
    registerQueuedMessage("req-2", THREAD, userMessage("msg-2", "race"));
    optimisticallyRemoveQueuedMessage("req-2");
    const events = collect();

    notifyQueueStreamStart("req-2");
    expect(events.map((e) => e.kind)).toEqual(["reveal"]);
    // 登记已销：后续收尾不重复回填
    events.length = 0;
    unregisterQueuedMessage("req-2", THREAD);
    expect(events).toEqual([]);
  });

  test("未入过快照的乐观摘除项不被无关快照的出列循环回填", () => {
    // req-1 确认排队；req-2 刚发出还在乐观摘除态（快照未到）
    registerQueuedMessage("req-1", THREAD, userMessage("msg-1", "a"));
    applyQueueStateChunk(THREAD, snapshotOf([{ reqId: "req-1", text: "a" }]));
    registerQueuedMessage("req-2", THREAD, userMessage("msg-2", "b"));
    optimisticallyRemoveQueuedMessage("req-2");
    const events = collect();

    // req-1 入队后又有广播（如 req-1 出列派发）：req-2 未进过快照，不该被牵连
    applyQueueStateChunk(THREAD, snapshotOf([]));
    expect(events.filter((e) => e.reg.messageId === "msg-2")).toEqual([]);
    expect(events.map((e) => e.reg.messageId)).toEqual(["msg-1"]);
  });

  test("乐观摘除后被拒（finish/error/abort 收尾）：末尾回填", () => {
    registerQueuedMessage("req-3", THREAD, userMessage("msg-3", "rejected"));
    optimisticallyRemoveQueuedMessage("req-3");
    const events = collect();

    unregisterQueuedMessage("req-3", THREAD);
    expect(events.map((e) => e.kind)).toEqual(["reveal"]);
  });

  test("普通直发（未乐观摘除）：start 销登记，收尾不再发事件", () => {
    registerQueuedMessage("req-4", THREAD, userMessage("msg-4", "direct"));
    // 直接开跑：start 发 reveal（消息仍在数组内，渲染侧 no-op）并销登记
    notifyQueueStreamStart("req-4");
    const events = collect();
    unregisterQueuedMessage("req-4", THREAD);
    expect(events).toEqual([]);
  });
});
