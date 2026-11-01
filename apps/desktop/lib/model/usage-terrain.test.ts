import { describe, expect, test } from "bun:test";
import { buildTerrainData } from "@/lib/model/usage-terrain";
import type { UsageStatsDay } from "@/lib/model/usage-stats";

/** 只填 buildTerrainData 读取的两个字段 */
const day = (date: string, tokens: number): UsageStatsDay =>
  ({ date, tokens }) as UsageStatsDay;

// 2026-11-01 是周日；窗口 2 周 = 14 天，起点 2026-10-19（周一）
const TODAY = new Date(Date.UTC(2026, 10, 1));

describe("buildTerrainData", () => {
  test("daily：按日对齐窗口，缺失日补 0，endDate = 今天", () => {
    const { data, endDate } = buildTerrainData(
      [day("2026-11-01", 30), day("2026-10-25", 7)],
      "daily",
      2,
      TODAY,
    );
    expect(endDate).toBe("2026-11-01");
    expect(data).toHaveLength(14);
    expect(data[13]).toBe(30); // 今天
    expect(data[6]).toBe(7); // 2026-10-25
    expect(data[0]).toBe(0); // 窗口首日无数据
  });

  test("weekly：同一 7 日分桶内整列同值（合计），跨桶独立", () => {
    const { data } = buildTerrainData(
      [day("2026-10-19", 1), day("2026-10-20", 2), day("2026-10-26", 10)],
      "weekly",
      2,
      TODAY,
    );
    // 起点是周一 → offset 0，前 7 个索引一列、后 7 个一列
    expect(data.slice(0, 7).every((v) => v === 3)).toBe(true);
    expect(data.slice(7).every((v) => v === 10)).toBe(true);
  });

  test("weekly 分桶跟随窗口首日星期（非周一起点）", () => {
    // 起点 2026-10-22（周四）→ offset 3：索引 4 起进入下一列
    const today = new Date(Date.UTC(2026, 10, 4)); // 11-04，窗口 2 周起点 10-22
    const { data } = buildTerrainData(
      [day("2026-10-22", 5), day("2026-10-28", 7)],
      "weekly",
      2,
      today,
    );
    expect(data.slice(0, 4).every((v) => v === 5)).toBe(true); // 10-22..10-25
    expect(data.slice(4, 11).every((v) => v === 7)).toBe(true); // 10-26..11-01
    expect(data.slice(11).every((v) => v === 0)).toBe(true); // 11-02..11-04（空列）
  });

  test("cumulative：逐日累加，末位 = 区间合计", () => {
    const { data } = buildTerrainData(
      [day("2026-10-30", 3), day("2026-10-31", 4), day("2026-11-01", 5)],
      "cumulative",
      2,
      TODAY,
    );
    expect(data[10]).toBe(0); // 10-29
    expect(data[11]).toBe(3);
    expect(data[12]).toBe(7);
    expect(data[13]).toBe(12);
  });
});
