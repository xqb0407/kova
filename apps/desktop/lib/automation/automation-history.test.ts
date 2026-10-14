import { describe, expect, it } from "bun:test";
import {
  filterHistoryItems,
  filterTasks,
  flattenRunHistory,
  groupHistoryByDay,
  historyStatusLabel,
  localDayKey,
  type HistoryItem,
} from "./automation-history";

/** 本地时刻构造 ISO（断言与时区无关） */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo, d, h, mi).toISOString();

const item = (over: Partial<HistoryItem>): HistoryItem => ({
  runId: "r",
  taskId: "t",
  taskName: "任务",
  status: "success",
  createdAt: at(2026, 8, 15, 10, 0),
  ...over,
});

describe("automation-history", () => {
  it("historyStatusLabel 已知状态翻中文，未知原样", () => {
    expect(historyStatusLabel("success")).toBe("成功");
    expect(historyStatusLabel("queued")).toBe("排队中");
    expect(historyStatusLabel("custom-thing")).toBe("custom-thing");
  });

  it("flattenRunHistory 摊平补任务名并按时间倒序", () => {
    const tasks = [
      {
        id: "a",
        name: "晨报",
        runHistory: [
          { id: "a1", status: "success", createdAt: at(2026, 8, 14, 9, 0) },
          { id: "a2", status: "error", createdAt: at(2026, 8, 15, 9, 0) },
        ],
      },
      { id: "b", runHistory: [{ id: "b1", status: "success", createdAt: at(2026, 8, 15, 8, 0) }] },
      { id: "c" },
    ];
    const flat = flattenRunHistory(tasks);
    expect(flat.map((i) => i.runId)).toEqual(["a2", "b1", "a1"]);
    expect(flat[1]?.taskName).toBe("未命名任务");
    expect(flat[0]?.message).toBeUndefined();
  });

  it("groupHistoryByDay 今天/昨天/更早标签，组内保持倒序", () => {
    const now = new Date(2026, 8, 15, 23, 0).getTime();
    const groups = groupHistoryByDay(
      [
        item({ runId: "x1", createdAt: at(2026, 8, 15, 20, 0) }),
        item({ runId: "x2", createdAt: at(2026, 8, 15, 8, 0) }),
        item({ runId: "x3", createdAt: at(2026, 8, 14, 22, 0) }),
        item({ runId: "x4", createdAt: at(2025, 8, 14, 10, 0) }),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(["今天", "昨天", "2025年9月14日"]);
    expect(groups[0]?.items.map((i) => i.runId)).toEqual(["x1", "x2"]);
  });

  it("localDayKey 用本地日历日", () => {
    expect(localDayKey(at(2026, 8, 15, 23, 59))).toBe("2026-09-15");
    expect(localDayKey("not-a-date")).toBe("invalid");
  });

  it("filterTasks 关键词命中名称/指令，状态按启用/暂停/失败", () => {
    const tasks = [
      { id: "1", name: "每日晨报", prompt: "汇总日程", enabled: true, lastStatus: "success" },
      { id: "2", name: "备份", prompt: "打包 CHANGELOG 归档", enabled: false, lastStatus: "error" },
      { id: "3", name: "", prompt: "清理临时文件", enabled: true },
    ];
    expect(filterTasks(tasks, "晨报", "all").map((t) => t.id)).toEqual(["1"]);
    expect(filterTasks(tasks, "changelog", "all").map((t) => t.id)).toEqual(["2"]);
    expect(filterTasks(tasks, "", "paused").map((t) => t.id)).toEqual(["2"]);
    expect(filterTasks(tasks, "", "error").map((t) => t.id)).toEqual(["2"]);
    expect(filterTasks(tasks, "", "enabled").map((t) => t.id)).toEqual(["1", "3"]);
  });

  it("filterHistoryItems 命中任务名或状态中文", () => {
    const items = [
      item({ runId: "1", taskName: "晨报", status: "success" }),
      item({ runId: "2", taskName: "备份", status: "error" }),
    ];
    expect(filterHistoryItems(items, "晨报").map((i) => i.runId)).toEqual(["1"]);
    expect(filterHistoryItems(items, "失败").map((i) => i.runId)).toEqual(["2"]);
    expect(filterHistoryItems(items, "  ")).toHaveLength(2);
  });
});
