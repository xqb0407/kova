"use client";

import { piRequest } from "@/lib/pi/pi-bridge";
import type { PiUsageStats, PiUsageStatsDay } from "@/lib/pi/pi-bridge";

/**
 * 全局使用统计（设置 → 使用统计）的数据层：sidecar usage_stats 命令返回逐日
 * 聚合序列——数据物化在 SQLite（usage_daily / usage_scan 表，按转录 mtime 增量
 * 维护），查询时从库聚合。连续天数/峰值等派生指标与展示格式化在此完成。
 * 只在设置页消费，不建全局 store（进页面拉一次 + 手动重试）。
 */
export type UsageStats = PiUsageStats;
export type UsageStatsDay = PiUsageStatsDay;

/** 拉取全局使用统计 */
export async function fetchUsageStats(): Promise<UsageStats> {
  const res = await piRequest<{ type: "usage_stats"; stats: UsageStats }>({
    type: "usage_stats",
  });
  return res.stats;
}

/** 模型序列配色（按用量排名取色；与截图一致的蓝/绿/紫/红/橙/青系） */
export const MODEL_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#a855f7",
  "#ef4444",
  "#f97316",
  "#14b8a6",
  "#eab308",
  "#ec4899",
];

export function modelColor(index: number): string {
  return MODEL_COLORS[index % MODEL_COLORS.length];
}

/* ------------------------------ 指标派生与格式化 ------------------------------ */

const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export { dayKey as usageDayKey };

/** 连续活跃天数：活跃 = 当日 tokens > 0。current 自今天回溯（今天还没用不断签，
 *  从昨天起算）；longest 取全程最长连续段 */
export function computeStreaks(
  days: UsageStatsDay[],
  now = new Date(),
): { current: number; longest: number } {
  const active = new Set(
    days.filter((d) => d.tokens > 0).map((d) => d.date),
  );
  const isDay = (d: Date) => active.has(dayKey(d));
  const isSameOrNext = (a: Date, b: Date) =>
    Math.round((b.getTime() - a.getTime()) / 86_400_000) === 1;

  let current = 0;
  const cursor = new Date(now);
  if (!isDay(cursor)) cursor.setDate(cursor.getDate() - 1);
  while (isDay(cursor)) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  const sorted = [...active].sort();
  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const key of sorted) {
    const d = new Date(`${key}T00:00:00`);
    run = prev && isSameOrNext(prev, d) ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest: Math.max(longest, current) };
}

/** token 数中文格式化：亿/万（29.7 亿 / 8000 万 / 999） */
export function formatTokens(n: number): string {
  if (n >= 1e8) return `${trimZero((n / 1e8).toFixed(1))} 亿`;
  if (n >= 1e4) return `${trimZero((n / 1e4).toFixed(1))} 万`;
  return String(Math.round(n));
}

/** 单日峰值 token 数 */
export function peakTokens(days: UsageStatsDay[]): number {
  return days.reduce((max, d) => Math.max(max, d.tokens), 0);
}

/** 毫秒 → 「13 小时 54 分钟」；不足 1 小时 → 「X 分钟」；0 → 「—」 */
export function formatChatDuration(ms: number): string {
  if (ms <= 0) return "—";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  if (hours <= 0) return `${minutes} 分钟`;
  return `${hours} 小时 ${minutes} 分钟`;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}
