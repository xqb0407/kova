import { describe, expect, test } from "bun:test";
import {
  applyBgTaskEvent,
  bgTasksSnapshotForTest,
} from "./pi-bg-tasks";
import { piSessionRegistry } from "./pi-thread-adapter";

/**
 * 后台任务 store 场景测试：thread_event 帧入口的写入/校验/键映射。
 * store 统一按 sessionId 作键；读取经 piStoreKeyForThread(threadId)——
 * 绑定线程解析出的就是 sessionId，两侧必须同键，否则徽标永远不动。
 */

const task = (taskId: number, running: boolean, exitCode: number | null = null) => ({
  taskId,
  command: `cmd-${taskId}`,
  source: "explicit" as const,
  startedAt: 1_000 + taskId,
  running,
  exitCode,
});

describe("applyBgTaskEvent（thread_event 入口）", () => {
  test("合法快照写入；按线程键可读（绑定线程走 sessionId 键）", () => {
    // 唯一 id：piSessionRegistry 是跨测试文件共享的单例，撞名会被别的
    // 测试文件的登记污染（单测独跑通过、全量跑失败的现场）
    const threadId = "bg-test-thread-1";
    const sessionId = "bg-test-sess-1";
    piSessionRegistry.set(threadId, sessionId);
    try {
      applyBgTaskEvent(sessionId, [task(1, true)]);
      expect(bgTasksSnapshotForTest(threadId).length).toBe(1);
      expect(bgTasksSnapshotForTest(threadId)[0]).toMatchObject({
        taskId: 1,
        running: true,
        source: "explicit",
      });
    } finally {
      piSessionRegistry.delete(threadId);
    }
  });

  test("未绑定线程：sessionId 即键（草稿语义）", () => {
    applyBgTaskEvent("bg-test-raw-sess", [task(2, false, 0)]);
    expect(bgTasksSnapshotForTest("bg-test-raw-sess")).toMatchObject([
      { taskId: 2, running: false, exitCode: 0 },
    ]);
  });

  test("非法行被剔除；非数组整体回空清单", () => {
    applyBgTaskEvent("bg-test-raw-sess", [{ taskId: "x" }, task(3, true)]);
    const rows = bgTasksSnapshotForTest("bg-test-raw-sess");
    expect(rows.length).toBe(1);
    expect(rows[0].taskId).toBe(3);
    applyBgTaskEvent("bg-test-raw-sess", "garbage");
    expect(bgTasksSnapshotForTest("bg-test-raw-sess")).toEqual([]);
  });

  test("空数组是合法快照（sidecar 重启后台账为空的合法态）", () => {
    applyBgTaskEvent("bg-test-raw-sess", [task(4, true)]);
    expect(bgTasksSnapshotForTest("bg-test-raw-sess").length).toBe(1);
    applyBgTaskEvent("bg-test-raw-sess", []);
    expect(bgTasksSnapshotForTest("bg-test-raw-sess")).toEqual([]);
  });
});

describe("键归一（草稿线程 → sessionId）", () => {
  test("事件按草稿 id 到达时落到会话键，读取（草稿 id）同源可见", () => {
    // 本会话新建的线程：sidecar 的 thread_event 带草稿 threadId，
    // 读取侧经 piStoreKeyForThread 归一成 sessionId——写入必须同键
    const draft = "__LOCALID_bg-draft-1";
    const sessionId = "bg-draft-sess-1";
    piSessionRegistry.set(draft, sessionId);
    try {
      applyBgTaskEvent(draft, [task(7, true)]);
      // 读取经草稿 id → 归一后命中
      expect(bgTasksSnapshotForTest(draft)).toMatchObject([
        { taskId: 7, running: true },
      ]);
    } finally {
      piSessionRegistry.delete(draft);
    }
  });
});
