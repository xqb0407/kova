import { describe, expect, test, afterEach } from "bun:test";

import {
  applyQueueStateChunk,
  cancelQueueItem,
  getQueueSnapshot,
  getQueuedMessageIds,
  hasPendingTurn,
  registerQueuedMessage,
  resetQueueForTests,
  setQueueSyncListener,
  steerQueueItem,
  unregisterQueuedMessage,
  type QueueSnapshot,
  type RegisteredMessage,
} from "./pi-queue";

const THREAD = "thread-1";

/** 造快照：单条 queued 条目 */
function snapshotOf(
  items: { reqId: string; text: string; id?: number }[],
  paused = false,
): QueueSnapshot {
  return {
    version: 2,
    threadId: THREAD,
    items: items.map((item, i) => ({
      id: item.id ?? i + 1,
      reqId: item.reqId,
      text: item.text,
      createdAt: "2026-01-01T00:00:00Z",
      state: "queued" as const,
    })),
    paused,
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
  test("新条目入快照：入抑制集 + 触发 remove（消息摘除信号）", () => {
    registerQueuedMessage("req-1", THREAD, userMessage("msg-1", "hello"));
    const events = collect();

    applyQueueStateChunk(
      THREAD,
      snapshotOf([{ reqId: "req-1", text: "hello" }]),
    );

    expect(events.map((e) => ({ kind: e.kind, messageId: e.reg.messageId }))).toEqual([
      { kind: "remove", messageId: "msg-1" },
    ]);
    expect(getQueuedMessageIds()).toEqual(new Set(["msg-1"]));
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
    expect(getQueuedMessageIds().size).toBe(0);
    expect(hasPendingTurn(THREAD)).toBe(true);

    // 该请求流收尾：清空窗标记
    unregisterQueuedMessage("req-1", THREAD);
    expect(hasPendingTurn(THREAD)).toBe(false);
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
    cancelQueueItem("req-1").catch(() => {});
    applyQueueStateChunk(THREAD, snapshotOf([]));

    expect(events).toEqual([]);
    expect(getQueuedMessageIds().size).toBe(0);
  });

  test("steered：出快照后保持抑制，流收尾时才回填", () => {
    registerQueuedMessage("req-1", THREAD, userMessage("msg-1", "hello"));
    applyQueueStateChunk(THREAD, snapshotOf([{ reqId: "req-1", text: "hello" }]));
    steerQueueItem("req-1").catch(() => {});
    applyQueueStateChunk(THREAD, snapshotOf([]));

    const events = collect();
    // 快照进一步变化（如其他条目变动）：steered 项不触发回填
    applyQueueStateChunk(THREAD, snapshotOf([]));
    expect(events).toEqual([]);
    // 仍在抑制集（消息保持摘除）
    expect(getQueuedMessageIds()).toEqual(new Set(["msg-1"]));

    // 宿主轮流收尾：此刻回填
    unregisterQueuedMessage("req-1", THREAD);
    expect(events.map((e) => e.kind)).toEqual(["reveal"]);
    expect(getQueuedMessageIds().size).toBe(0);
  });
});

describe("未登记条目（刷新恢复）", () => {
  test("快照条目无注册：按快照文本重建（queued-<id>），派发出队照常回填", () => {
    applyQueueStateChunk(
      THREAD,
      snapshotOf([{ reqId: "req-9", text: "rebuilt", id: 7 }]),
    );
    expect(getQueuedMessageIds()).toEqual(new Set(["queued-7"]));

    const events = collect();
    applyQueueStateChunk(THREAD, snapshotOf([]));
    expect(events.map((e) => e.kind)).toEqual(["reveal"]);
    expect(events[0]!.reg.message?.parts[0]).toEqual({
      type: "text",
      text: "rebuilt",
    });
  });
});

describe("多线程隔离", () => {
  test("其他线程的快照不影响本线程", () => {
    applyQueueStateChunk(
      "thread-other",
      snapshotOf([{ reqId: "req-o", text: "other" }]),
    );
    expect(getQueueSnapshot(THREAD).items).toHaveLength(0);
    expect(hasPendingTurn("thread-other")).toBe(false);
    expect(hasPendingTurn(THREAD)).toBe(false);
  });
});

describe("暂停", () => {
  test("快照携带暂停态：镜像可见", () => {
    applyQueueStateChunk(
      THREAD,
      snapshotOf([{ reqId: "req-1", text: "hello" }], true),
    );
    expect(getQueueSnapshot(THREAD).paused).toBe(true);
    expect(getQueueSnapshot(THREAD).items).toHaveLength(1);
  });
});
