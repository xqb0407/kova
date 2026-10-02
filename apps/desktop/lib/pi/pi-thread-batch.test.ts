/**
 * 批量模式 store 测试：模式开关、跨 tab 勾选保留、全选可见集注册、
 * 退出清空。ephemeral store，无持久化。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  enterThreadBatch,
  exitThreadBatch,
  getThreadBatchState,
  setThreadBatchSelection,
  setThreadBatchVisible,
  toggleThreadBatchSelect,
} from "./pi-thread-batch";

beforeEach(() => exitThreadBatch());

describe("pi-thread-batch", () => {
  test("进入/退出：退出清空选择", () => {
    enterThreadBatch();
    expect(getThreadBatchState().active).toBe(true);
    toggleThreadBatchSelect("a");
    exitThreadBatch();
    expect(getThreadBatchState().active).toBe(false);
    expect(getThreadBatchState().selected).toEqual([]);
  });

  test("勾选跨 tab 保留（统一集合）", () => {
    enterThreadBatch();
    toggleThreadBatchSelect("task-1");
    toggleThreadBatchSelect("proj-1");
    toggleThreadBatchSelect("task-1"); // 再点取消
    const { selected } = getThreadBatchState();
    expect(selected).toEqual(["proj-1"]);
  });

  test("未开启模式时勾选/全选被忽略（防误触兜底）", () => {
    toggleThreadBatchSelect("x");
    setThreadBatchSelection(["y"]);
    expect(getThreadBatchState().selected).toEqual([]);
  });

  test("可见集注册与全选：只选当前 tab 的可见项", () => {
    enterThreadBatch();
    setThreadBatchVisible("tasks", ["t1", "t2", "t3"]);
    setThreadBatchVisible("projects", ["p1"]);
    setThreadBatchSelection(getThreadBatchState().visible.tasks ?? []);
    expect(getThreadBatchState().selected).toEqual(["t1", "t2", "t3"]);
    // 列表重渲染（搜索过滤后）同步更新，全选随新可见集收敛
    setThreadBatchVisible("tasks", ["t1"]);
    setThreadBatchSelection(getThreadBatchState().visible.tasks ?? []);
    expect(getThreadBatchState().selected).toEqual(["t1"]);
  });

  test("重复进入不重复置位", () => {
    enterThreadBatch();
    toggleThreadBatchSelect("a");
    enterThreadBatch();
    expect(getThreadBatchState().selected).toEqual(["a"]);
  });
});
