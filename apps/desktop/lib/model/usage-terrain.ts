/**
 * Token 活动地形图（ActivityTerrain）的数据换算：把 sidecar 的逐日 usage
 * 序列换算成组件需要的「逐日 tokens（最早的在前）+ 末日日期」。
 *
 * 强度口径与旧热力图保持一致：
 * - daily      = 当日 tokens
 * - weekly     = 与地形图列分桶一致——窗口首日起每连续 7 天合计（整列同值）。
 *                地形图的列由 buildCells 的 7 天连续分桶决定，不是自然周
 * - cumulative = 迄该日累计
 *
 * 日期键沿用 sidecar 的本地日历日：UTC 字段承载本地日期（与旧热力图
 * localToday 同口径，东八区凌晨也不会错位一天）。
 */
import type { UsageStatsDay } from "./usage-stats";

export type HeatGranularity = "daily" | "weekly" | "cumulative";

/** 展示窗口：26 周（182 天），设置页卡片宽度下每列约 20px */
export const TERRAIN_WEEKS = 26;

const DAY_MS = 86_400_000;

/** 本地「今天」在 UTC 字段上的表示（旧热力图同款：HeatCalendar/地形图按 UTC 取字段） */
export function localTodayUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

const dayKey = (date: Date): string => date.toISOString().slice(0, 10);

export function buildTerrainData(
  days: UsageStatsDay[],
  granularity: HeatGranularity,
  weeks = TERRAIN_WEEKS,
  today = localTodayUtc(),
): { data: number[]; endDate: string } {
  const tokensByDate = new Map(days.map((d) => [d.date, d.tokens]));
  const count = weeks * 7;
  const start = new Date(today.getTime() - (count - 1) * DAY_MS);
  const raw = Array.from({ length: count }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS);
    return tokensByDate.get(dayKey(date)) ?? 0;
  });
  if (granularity === "daily") {
    return { data: raw, endDate: dayKey(today) };
  }
  if (granularity === "cumulative") {
    let sum = 0;
    return { data: raw.map((tokens) => (sum += tokens)), endDate: dayKey(today) };
  }
  // ActivityTerrain.buildCells 的分桶：slot = index + offset，列 = floor(slot / 7)，
  // offset = 窗口首日的星期（周一为 0）。按同一分桶合计即「整列同值」。
  const offset = (start.getUTCDay() + 6) % 7;
  const columnOf = (index: number) => Math.floor((index + offset) / 7);
  const sums = new Map<number, number>();
  raw.forEach((tokens, index) => {
    const column = columnOf(index);
    sums.set(column, (sums.get(column) ?? 0) + tokens);
  });
  return {
    data: raw.map((_, index) => sums.get(columnOf(index)) ?? 0),
    endDate: dayKey(today),
  };
}
