import { describe, expect, test } from "bun:test";
import {
  bgTasksSnapshot,
  markBgThreadClosed,
  migrateBgTasks,
  observeBgTaskExit,
  observeBgToolResult,
  reconcileBgTasksWithHost,
  refreshBgTasks,
  resetBgTasksForTest,
  stopBgTasksForSession,
} from "../../src/tools/bg-tasks";
import {
  getTransport,
  setTransport,
} from "../../src/storage/hostdb/transport";

const THREAD = "bg-t1";

/**
 * 后台任务台账场景测试。observe 路径纯内存（不碰宿主）；refresh 的探测走
 * hostToolCall——测试环境没有宿主，调用必然抛错，正好覆盖「探测失败按退出
 * 结算」的兜底分支（宿主回收任务 = 任务不再运行）。
 */

/** 显式 runInBackground 的宿主返回形状：不带 running 字段（tool-exec.ts:499） */
const explicitBgData = (taskId: number) => ({
  output: `Started in background (task ${taskId}).`,
  taskId,
  sandbox: { backend: "none" },
});

/** 超时转后台的宿主返回形状：显式 running:true + exitCode:null + timedOut（诊断码数据源） */
const timeoutBgData = (taskId: number) => ({
  output: `[timeout after 120s — converted to background task ${taskId}]`,
  taskId,
  running: true,
  timedOut: true,
  exitCode: null,
  truncated: false,
  cancelled: false,
});

describe("observeBgToolResult", () => {
  test("bash 结果注册任务：runInBackground 与超时转后台区分来源", () => {
    resetBgTasksForTest();
    // 用宿主真实返回形状（显式后台不带 running 字段）——回归覆盖：
    // 注册逻辑曾写成 data.running === true，显式后台任务被错记成已结束
    observeBgToolResult(THREAD, "/w", "bash", { command: "bun test", runInBackground: true }, explicitBgData(1));
    observeBgToolResult(THREAD, "/w", "bash", { command: "sleep 300" }, timeoutBgData(2));
    const snap = bgTasksSnapshot(THREAD);
    expect(snap.length).toBe(2);
    expect(snap[0]).toMatchObject({ taskId: 1, source: "explicit", running: true });
    expect(snap[1]).toMatchObject({ taskId: 2, source: "timeout", running: true });
    expect(snap[1].command).toBe("sleep 300");
  });

  test("task_output 回写状态；task_stop 结算；未知任务忽略", () => {
    resetBgTasksForTest();
    observeBgToolResult(THREAD, "/w", "bash", { command: "bun run build" }, explicitBgData(7));
    observeBgToolResult(
      THREAD,
      "/w",
      "task_output",
      { taskId: 7 },
      { output: "done", running: false, exitCode: 0 },
    );
    expect(bgTasksSnapshot(THREAD)[0]).toMatchObject({ running: false, exitCode: 0 });
    // task_stop 结算（exitCode 保持最近已知值）
    observeBgToolResult(THREAD, "/w", "bash", { command: "sleep 9" }, explicitBgData(8));
    observeBgToolResult(THREAD, "/w", "task_stop", { taskId: 8 }, { output: "killed", running: false });
    expect(bgTasksSnapshot(THREAD).find((t) => t.taskId === 8)?.running).toBe(false);
    // 台账里没有的任务（别的会话/重启前）：忽略不抛
    observeBgToolResult(THREAD, "/w", "task_output", { taskId: 999 }, { running: true });
    expect(bgTasksSnapshot(THREAD).length).toBe(2);
  });

  test("快照按 startedAt 升序稳定；重复注册保留首发时间与命令", () => {
    resetBgTasksForTest();
    observeBgToolResult(THREAD, "/w", "bash", { command: "first" }, explicitBgData(3));
    // 同 taskId 再次落位（模型重发 task_output 场景之外的信封回放）：不刷新时间
    observeBgToolResult(THREAD, "/w", "bash", { command: "first" }, explicitBgData(3));
    observeBgToolResult(THREAD, "/w", "bash", { command: "second" }, explicitBgData(4));
    const snap = bgTasksSnapshot(THREAD);
    expect(snap.map((t) => t.command)).toEqual(["first", "second"]);
  });
});

describe("refreshBgTasks（轮边界探测）", () => {
  test("宿主明确回收（no such background task）：按退出结算", async () => {
    resetBgTasksForTest();
    observeBgToolResult(THREAD, "/w", "bash", { command: "sleep 5" }, explicitBgData(9));
    expect(bgTasksSnapshot(THREAD)[0].running).toBe(true);
    const previous = getTransport();
    setTransport(async () => {
      throw new Error(
        "no such background task: 9 (it may have been reaped after completion)",
      );
    });
    try {
      await refreshBgTasks(THREAD);
      expect(bgTasksSnapshot(THREAD)[0].running).toBe(false);
    } finally {
      setTransport(previous);
    }
  });

  test("传输类失败（超时/宿主忙）：保持运行中，等下一轮探测或宿主推送", async () => {
    resetBgTasksForTest();
    observeBgToolResult(THREAD, "/w", "bash", { command: "sleep 5" }, explicitBgData(19));
    const previous = getTransport();
    setTransport(async () => {
      throw new Error("host_query timeout: task_output");
    });
    try {
      await refreshBgTasks(THREAD);
      // 不能因为一次瞬时失败把仍在跑的任务标成已停止（会与推送/后续探测来回跳）
      expect(bgTasksSnapshot(THREAD)[0].running).toBe(true);
    } finally {
      setTransport(previous);
    }
  });

  test("无运行中任务：不发探测，直接返回", async () => {
    resetBgTasksForTest();
    // 空台账与全退出台账都不抛
    await refreshBgTasks(THREAD);
    observeBgToolResult(THREAD, "/w", "bash", { command: "x" }, explicitBgData(10));
    observeBgToolResult(THREAD, "/w", "task_output", { taskId: 10 }, { running: false, exitCode: 1 });
    await refreshBgTasks(THREAD);
    expect(bgTasksSnapshot(THREAD)[0].running).toBe(false);
  });
});

describe("observeBgTaskExit（宿主退出推送）", () => {
  test("运行中任务被宿主结算：立即转终态，exitCode 落账", () => {
    resetBgTasksForTest();
    observeBgToolResult(THREAD, "/w", "bash", { command: "npm run dev" }, explicitBgData(11));
    observeBgTaskExit(THREAD, { taskId: 11, exitCode: 143, stopped: false });
    expect(bgTasksSnapshot(THREAD)[0]).toMatchObject({
      taskId: 11,
      running: false,
      exitCode: 143,
    });
  });

  test("幂等：同一终态重复推送不改变台账（重复 Inbox 由 upsert 兜底）", () => {
    resetBgTasksForTest();
    observeBgToolResult(THREAD, "/w", "bash", { command: "sleep 1" }, explicitBgData(12));
    observeBgTaskExit(THREAD, { taskId: 12, exitCode: 0 });
    const after = bgTasksSnapshot(THREAD);
    observeBgTaskExit(THREAD, { taskId: 12, exitCode: 0 });
    expect(bgTasksSnapshot(THREAD)).toEqual(after);
  });

  test("台账里没有的任务（sidecar 重启后才退出）：按通知字段补一条终态", () => {
    resetBgTasksForTest();
    observeBgTaskExit(THREAD, {
      taskId: 13,
      exitCode: 0,
      command: "bun run build",
      source: "timeout",
      startedAt: 123,
    });
    expect(bgTasksSnapshot(THREAD)).toMatchObject([
      { taskId: 13, command: "bun run build", source: "timeout", startedAt: 123, running: false },
    ]);
  });

  test("退出通知先于工具结果（命令秒退）：注册不能把终态重新点亮", () => {
    resetBgTasksForTest();
    // 宿主可能先写出 bg_task_exit（子进程已退），再由 host_result 回 bash 结果
    observeBgTaskExit(THREAD, {
      taskId: 16,
      exitCode: 0,
      command: "echo hi",
      source: "explicit",
      startedAt: 1,
    });
    observeBgToolResult(
      THREAD,
      "/w",
      "bash",
      { command: "echo hi", runInBackground: true },
      explicitBgData(16),
    );
    expect(bgTasksSnapshot(THREAD)[0]).toMatchObject({
      taskId: 16,
      running: false,
      exitCode: 0,
    });
  });
});

describe("migrateBgTasks（线程改绑）", () => {
  test("台账随线程键迁移，旧键清空、新键可读", () => {
    resetBgTasksForTest();
    observeBgToolResult("bg-old-thread", "/w", "bash", { command: "vite" }, explicitBgData(14));
    migrateBgTasks("bg-old-thread", "bg-new-thread");
    expect(bgTasksSnapshot("bg-old-thread")).toEqual([]);
    expect(bgTasksSnapshot("bg-new-thread")).toMatchObject([
      { taskId: 14, command: "vite", running: true },
    ]);
  });

  test("同键/空键迁移是 no-op", () => {
    resetBgTasksForTest();
    observeBgToolResult(THREAD, "/w", "bash", { command: "x" }, explicitBgData(15));
    migrateBgTasks(THREAD, THREAD);
    migrateBgTasks("", THREAD);
    expect(bgTasksSnapshot(THREAD).length).toBe(1);
  });
});

describe("reconcileBgTasksWithHost（水合并发宿主对账）", () => {
  test("宿主表里的存活任务补回台账；终态纠偏", async () => {
    resetBgTasksForTest();
    type HostRow = {
      taskId: number;
      command: string;
      source: "explicit" | "timeout";
      startedAt: number;
      running: boolean;
      exitCode: number | null;
    };
    let rows: HostRow[] = [
      { taskId: 21, command: "npm run dev", source: "explicit", startedAt: 10, running: true, exitCode: null },
    ];
    const previous = getTransport();
    setTransport(async (kind) => {
      if (kind === "bg_tasks_list") return rows;
      throw new Error(`unexpected kind: ${kind}`);
    });
    try {
      await reconcileBgTasksWithHost(THREAD, "sess-1");
      expect(bgTasksSnapshot(THREAD)).toMatchObject([
        { taskId: 21, command: "npm run dev", running: true, sessionId: "sess-1" },
      ]);
      // 宿主说已结束：本地状态被纠偏（错过退出推送的重启窗口）
      rows = [
        { taskId: 21, command: "npm run dev", source: "explicit", startedAt: 10, running: false, exitCode: 0 },
      ];
      await reconcileBgTasksWithHost(THREAD);
      expect(bgTasksSnapshot(THREAD)[0]).toMatchObject({ running: false, exitCode: 0 });
    } finally {
      setTransport(previous);
    }
  });

  test("宿主不可用（本地模式/无传输）：静默保留内存快照", async () => {
    resetBgTasksForTest();
    observeBgToolResult(THREAD, "/w", "bash", { command: "keep" }, explicitBgData(22));
    const previous = getTransport();
    setTransport(null);
    try {
      await reconcileBgTasksWithHost(THREAD);
      expect(bgTasksSnapshot(THREAD)[0]).toMatchObject({ taskId: 22, running: true });
    } finally {
      setTransport(previous);
    }
  });
});

describe("stopBgTasksForSession（会话删除）", () => {
  test("停掉该会话名下的运行中任务并清台账，不碰别的会话", async () => {
    resetBgTasksForTest();
    observeBgToolResult(
      "bg-del-thread",
      "/w",
      "bash",
      { command: "npm run dev" },
      explicitBgData(31),
      "sess-del",
    );
    observeBgToolResult(
      "bg-keep-thread",
      "/w",
      "bash",
      { command: "keep" },
      explicitBgData(32),
      "sess-keep",
    );
    const calls: Array<{ name?: unknown; toolParams?: Record<string, unknown>; owner?: unknown }> = [];
    const previous = getTransport();
    setTransport(async (kind, params) => {
      if (kind !== "tool") throw new Error(`unexpected kind: ${kind}`);
      const p = params as {
        name?: unknown;
        owner?: unknown;
        params?: Record<string, unknown>;
      };
      calls.push({ name: p.name, toolParams: p.params, owner: p.owner });
      return { output: "killed" };
    });
    try {
      await stopBgTasksForSession("sess-del");
      expect(calls.length).toBe(1);
      expect(calls[0]?.name).toBe("task_stop");
      expect(calls[0]?.toolParams?.taskId).toBe(31);
      expect(calls[0]?.owner).toBe("bg-del-thread");
      // 删除的会话台账清空；其它会话不受影响
      expect(bgTasksSnapshot("bg-del-thread")).toEqual([]);
      expect(bgTasksSnapshot("bg-keep-thread")[0]).toMatchObject({ taskId: 32, running: true });
    } finally {
      setTransport(previous);
    }
  });

  test("会话只有终态任务：不发宿主调用，但台账整组清掉（删会话不留历史行）", async () => {
    resetBgTasksForTest();
    observeBgToolResult(THREAD, "/w", "bash", { command: "done" }, explicitBgData(33), "sess-x");
    observeBgToolResult(THREAD, "/w", "task_output", { taskId: 33 }, { running: false, exitCode: 0 });
    let calls = 0;
    const previous = getTransport();
    setTransport(async (kind) => {
      calls += 1;
      throw new Error(`unexpected kind: ${kind}`);
    });
    try {
      await stopBgTasksForSession("sess-x");
      expect(calls).toBe(0);
      // 会话行都删了：终态行没人能看见，只占内存——一并清
      expect(bgTasksSnapshot(THREAD)).toEqual([]);
    } finally {
      setTransport(previous);
    }
  });
});

describe("会话删除墓碑（迟到退出通知）", () => {
  test("已删线程的未知任务通知不补登记；未删但非驻留的线程照常补", () => {
    resetBgTasksForTest();
    markBgThreadClosed("bg-closed-thread");
    observeBgTaskExit("bg-closed-thread", {
      taskId: 41,
      exitCode: 0,
      command: "x",
    });
    expect(bgTasksSnapshot("bg-closed-thread")).toEqual([]);
    // 会话未物化（未打开/被驱逐/重启后）不等于已删除：终态必须记账，
    // 否则后台任务跑完却没有完成提醒
    observeBgTaskExit("bg-not-resident", {
      taskId: 42,
      exitCode: 0,
      command: "y",
    });
    expect(bgTasksSnapshot("bg-not-resident")).toHaveLength(1);
  });
});
