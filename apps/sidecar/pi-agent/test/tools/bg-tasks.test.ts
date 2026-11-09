import { describe, expect, test } from "bun:test";
import {
  bgTasksSnapshot,
  observeBgToolResult,
  refreshBgTasks,
  resetBgTasksForTest,
} from "../../src/tools/bg-tasks";

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
  test("测试环境无宿主：探测失败按退出结算（兜底分支）", async () => {
    resetBgTasksForTest();
    observeBgToolResult(THREAD, "/w", "bash", { command: "sleep 5" }, explicitBgData(9));
    expect(bgTasksSnapshot(THREAD)[0].running).toBe(true);
    await refreshBgTasks(THREAD);
    const task = bgTasksSnapshot(THREAD)[0];
    expect(task.running).toBe(false); // 探测失败 → 不让徽标永远挂着
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
