import { afterEach, describe, expect, test } from "bun:test";

import {
  applyQueueChunk,
  cancelQueuedPrompt,
  getQueuedMessageIds,
  hasPendingTurn,
  peekThreadQueue,
  registerQueuedPrompt,
  setQueueSyncListener,
  unregisterQueuedPrompt,
  type QueuedPrompt,
} from "./pi-queue";

const THREAD = "thread-1";

/** 造 user 消息桩 */
const userMessage = (id: string, text: string) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

function register(requestId: string, messageId: string, text = "hello") {
  registerQueuedPrompt({
    requestId,
    threadId: THREAD,
    messageId,
    text,
    message: userMessage(messageId, text),
  });
}

function registerOn(threadId: string, requestId: string, messageId: string) {
  registerQueuedPrompt({
    requestId,
    threadId,
    messageId,
    text: "hello",
    message: userMessage(messageId, "hello"),
  });
}

/** 收集同步监听事件（queued/reveal 次序与负载） */
function collect() {
  const events: { kind: "queued" | "reveal"; entry: QueuedPrompt }[] = [];
  setQueueSyncListener({
    onQueued: (entry) => events.push({ kind: "queued", entry }),
    onReveal: (entry) => events.push({ kind: "reveal", entry }),
  });
  return events;
}

afterEach(() => {
  // 清空 store：注销该线程全部条目（含 active/ghost）
  unregisterQueuedPrompt("req-1", THREAD);
  unregisterQueuedPrompt("req-2", THREAD);
  unregisterQueuedPrompt("req-ghost", THREAD);
  unregisterQueuedPrompt("req-1", "thread-other");
  setQueueSyncListener(null);
});

describe("排队确认与消息同步监听", () => {
  test("首次确认（0→>0）触发 onQueued（消息摘除信号）", () => {
    register("req-1", "msg-1");
    const events = collect();

    applyQueueChunk("req-1", THREAD, { phase: "queued", position: 2 });
    expect(events.map((e) => `${e.kind}:${e.entry.messageId}`)).toEqual([
      "queued:msg-1",
    ]);
    expect(events[0]!.entry.message?.parts[0]).toEqual({
      type: "text",
      text: "hello",
    });
    expect(peekThreadQueue(THREAD).map((e) => e.position)).toEqual([2]);
  });

  test("位置重发（promote 重排等）不重复触发摘除信号，仅更新序号", () => {
    register("req-1", "msg-1");
    applyQueueChunk("req-1", THREAD, { phase: "queued", position: 2 });

    const events = collect();
    applyQueueChunk("req-1", THREAD, { phase: "queued", position: 1 });
    expect(events).toEqual([]);
    expect(peekThreadQueue(THREAD).map((e) => e.position)).toEqual([1]);
  });
});

describe("激活开跑（data-queue active）", () => {
  test("置位 active 退出排队条、触发 onReveal、进入 pendingTurn", () => {
    register("req-1", "msg-1");
    applyQueueChunk("req-1", THREAD, { phase: "queued", position: 1 });

    const events = collect();
    applyQueueChunk("req-1", THREAD, { phase: "active" });

    // active 条目保留登记（对账/收尾用）但置位 active——排队条渲染（useThreadQueue
    // 按 !active 过滤）不再显示
    expect(peekThreadQueue(THREAD).map((e) => e.active)).toEqual([true]);
    expect(events.map((e) => e.kind)).toEqual(["reveal"]);
    expect(events[0]!.entry.active).toBe(true);
    expect(events[0]!.entry.message?.id).toBe("msg-1");
    expect(hasPendingTurn(THREAD)).toBe(true);
    // 开跑后移出消息抑制集（回填数组自然可见）
    expect(getQueuedMessageIds().has("msg-1")).toBe(false);
  });

  test("流收尾：移除条目并清除 pendingTurn", () => {
    register("req-1", "msg-1");
    applyQueueChunk("req-1", THREAD, { phase: "queued", position: 1 });
    applyQueueChunk("req-1", THREAD, { phase: "active" });
    expect(hasPendingTurn(THREAD)).toBe(true);

    unregisterQueuedPrompt("req-1", THREAD);
    expect(hasPendingTurn(THREAD)).toBe(false);
    expect(peekThreadQueue(THREAD)).toEqual([]);
  });
});

describe("未开跑就收尾（Stop/清队等路径）", () => {
  test("触发 onReveal 恢复消息，不残留 pendingTurn", () => {
    register("req-1", "msg-1");
    applyQueueChunk("req-1", THREAD, { phase: "queued", position: 1 });

    const events = collect();
    unregisterQueuedPrompt("req-1", THREAD);

    expect(events.map((e) => e.kind)).toEqual(["reveal"]);
    expect(events[0]!.entry.active).toBe(false);
    expect(hasPendingTurn(THREAD)).toBe(false);
    expect(peekThreadQueue(THREAD)).toEqual([]);
  });

  test("steered 条目（position 0 未确认排队，消息未摘除）收尾不触发恢复", () => {
    register("req-1", "msg-1");
    const events = collect();

    unregisterQueuedPrompt("req-1", THREAD);
    expect(events).toEqual([]);
  });

  test("用户删除（cancelled 标记）后收尾不恢复消息——收尾 chunk 先于 invoke 回复到达的竞态", async () => {
    register("req-1", "msg-1");
    applyQueueChunk("req-1", THREAD, { phase: "queued", position: 1 });

    // cancelQueuedPrompt 在 invoke 前置位 cancelled 标记；测试环境无 Tauri 通道，
    // request 会拒绝——标记已打上，模拟「收尾 chunk 先于回复被消费」
    const events = collect();
    await cancelQueuedPrompt("req-1").catch(() => {});

    // 本地条目仍在（invoke 失败未走本地摘除分支），手动补 unregister 模拟收尾
    unregisterQueuedPrompt("req-1", THREAD);
    expect(events).toEqual([]);
  });
});

describe("并入当前轮（steered）", () => {
  test("steered 标记：退出排队条显示、保持消息抑制，收尾时经 restore 回填", () => {
    register("req-1", "msg-1");
    applyQueueChunk("req-1", THREAD, { phase: "queued", position: 1 });
    // 排队确认后消息已被摘除（抑制集中）
    expect(getQueuedMessageIds()).toEqual(new Set(["msg-1"]));

    const events = collect();
    applyQueueChunk("req-1", THREAD, { phase: "steered" });

    // steered 条目退出排队条与抑制集，但仍登记到宿主轮收尾
    expect(peekThreadQueue(THREAD).map((e) => e.steered)).toEqual([true]);
    expect(getQueuedMessageIds().size).toBe(0);

    // 宿主轮收尾：经 restore 回填消息
    unregisterQueuedPrompt("req-1", THREAD);
    expect(events.map((e) => e.kind)).toEqual(["reveal"]);
    expect(events[0]!.entry.steered).toBe(true);
    expect(peekThreadQueue(THREAD)).toEqual([]);
  });

  test("未登记请求的 steered chunk（刷新重放）：忽略", () => {
    const events = collect();
    applyQueueChunk("req-ghost", THREAD, { phase: "steered" });
    expect(events).toEqual([]);
    expect(peekThreadQueue(THREAD)).toEqual([]);
  });
});

describe("多线程隔离", () => {
  test("其他线程的激活不影响本线程 pendingTurn 与抑制集", () => {
    registerOn("thread-other", "req-1", "msg-other");
    applyQueueChunk("req-1", "thread-other", { phase: "active" });

    expect(hasPendingTurn("thread-other")).toBe(true);
    expect(hasPendingTurn(THREAD)).toBe(false);
    expect(getQueuedMessageIds().has("msg-other")).toBe(false);

    unregisterQueuedPrompt("req-1", "thread-other");
    expect(hasPendingTurn("thread-other")).toBe(false);
  });
});

describe("ghost 条目（刷新重连重放）", () => {
  test("未注册请求的 queued chunk 建档占位：不进可见条、不触发同步、不进抑制集", () => {
    const events = collect();
    applyQueueChunk("req-ghost", THREAD, { phase: "queued", position: 1 });

    expect(events).toEqual([]);
    expect(peekThreadQueue(THREAD)).toEqual([]);
    expect(getQueuedMessageIds().size).toBe(0);
  });

  test("ghost 激活：进入 pendingTurn（加载动画有效），收尾清除", () => {
    applyQueueChunk("req-ghost", THREAD, { phase: "active" });
    expect(hasPendingTurn(THREAD)).toBe(true);

    unregisterQueuedPrompt("req-ghost", THREAD);
    expect(hasPendingTurn(THREAD)).toBe(false);
  });
});

describe("useQueuedMessageIds 语义", () => {
  test("确认排队且未开跑的条目才进抑制集", () => {
    register("req-1", "msg-1");
    register("req-2", "msg-2");

    // req-2 未确认（position 0）不进
    applyQueueChunk("req-1", THREAD, { phase: "queued", position: 1 });
    expect(getQueuedMessageIds()).toEqual(new Set(["msg-1"]));

    unregisterQueuedPrompt("req-1", THREAD);
    unregisterQueuedPrompt("req-2", THREAD);
    expect(getQueuedMessageIds().size).toBe(0);
  });
});
