/**
 * 侧栏时间筛选 store 测试：区间起点的自然日口径（今天 / 近 7 天 / 近 10 天）
 * 与切换写入。ephemeral store，无持久化。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  getThreadTimeRange,
  setThreadTimeRange,
  threadRangeStart,
  threadTimeRangeLabel,
} from "./pi-thread-filter";

beforeEach(() => setThreadTimeRange("all"));

describe("pi-thread-filter", () => {
  test("切换写入与同值短路", () => {
    expect(getThreadTimeRange()).toBe("all");
    setThreadTimeRange("7d");
    expect(getThreadTimeRange()).toBe("7d");
  });

  test("全部时间不过滤（起点为 null）", () => {
    expect(threadRangeStart("all")).toBeNull();
  });

  test("区间按自然日切：今天 = 当天 0 点；近 N 天含今天共 N 天", () => {
    // 固定一个晚上 23:30 的时刻：验证的是自然日边界，不是 now - 24h
    const now = new Date(2026, 9, 8, 23, 30);
    const today = new Date(2026, 9, 8, 0, 0).getTime();
    const d3 = new Date(2026, 9, 6, 0, 0).getTime(); // 8 号往前数 2 天
    const d7 = new Date(2026, 9, 2, 0, 0).getTime(); // 8 号往前数 6 天
    const d10 = new Date(2026, 8, 29, 0, 0).getTime(); // 8 号往前数 9 天

    expect(threadRangeStart("today", now)).toBe(today);
    expect(threadRangeStart("3d", now)).toBe(d3);
    expect(threadRangeStart("7d", now)).toBe(d7);
    expect(threadRangeStart("10d", now)).toBe(d10);
  });

  test("跨月边界不越界", () => {
    const now = new Date(2026, 10, 3, 8, 0); // 11 月 3 日
    expect(threadRangeStart("7d", now)).toBe(new Date(2026, 9, 28, 0, 0).getTime());
  });

  test("标签查表兜底", () => {
    expect(threadTimeRangeLabel("today")).toBe("今天");
    expect(threadTimeRangeLabel("all")).toBe("全部时间");
  });
});
