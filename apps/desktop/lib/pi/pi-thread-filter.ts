"use client";

import { useSyncExternalStore } from "react";

/**
 * 侧边栏会话列表的时间筛选（ephemeral，不持久化）。
 *
 * 只保留「最近活跃时间」落在所选区间内的会话；值由列表侧
 * （useThreadListGroups）读取，切换入口在 tabs 行右侧的筛选按钮。
 * 做成模块 store 而不是逐层传参：消费点有三处（任务列表、项目列表、
 * 壳里的「展开全部」判定），传参要把 props 穿过 ThreadListRoot 那一层。
 *
 * 区间按自然日切：今天 = 今天 0 点起；近 N 天 = 今天 0 点往前数 N-1 天
 * （含今天正好 N 个自然日）。用自然日而不是 now - N×24h，
 * 是为了让「今天」与「近 7 天」的分界看得懂，也不会因为点开筛选的时刻
 * 不同，让昨天下午的会话在边界上忽隐忽现。
 */

export type ThreadTimeRange = "all" | "today" | "3d" | "7d" | "10d";

/** 选项顺序即菜单顺序；label 同时用于按钮 tooltip 与空态文案 */
export const THREAD_TIME_RANGES: readonly {
  value: ThreadTimeRange;
  label: string;
}[] = [
  { value: "all", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "3d", label: "近 3 天" },
  { value: "7d", label: "近 7 天" },
  { value: "10d", label: "近 10 天" },
];

/** 「近 N 天」的天数；选项与这里必须同步增删 */
const RANGE_DAYS: Record<Exclude<ThreadTimeRange, "all" | "today">, number> = {
  "3d": 3,
  "7d": 7,
  "10d": 10,
};

let range: ThreadTimeRange = "all";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ThreadTimeRange {
  return range;
}

export function getThreadTimeRange(): ThreadTimeRange {
  return range;
}

export function setThreadTimeRange(next: ThreadTimeRange): void {
  if (range === next) return;
  range = next;
  for (const listener of listeners) listener();
}

export function useThreadTimeRange(): ThreadTimeRange {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 区间起点（毫秒时间戳）；"all" 返回 null = 不过滤 */
export function threadRangeStart(
  value: ThreadTimeRange,
  now: Date = new Date(),
): number | null {
  if (value === "all") return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (value === "today") return start.getTime();
  // 近 N 天 = 今天 0 点往前 N-1 天（含今天正好 N 个自然日）
  start.setDate(start.getDate() - (RANGE_DAYS[value] - 1));
  return start.getTime();
}

/** 当前区间的展示名（按钮 tooltip / 空态文案共用） */
export function threadTimeRangeLabel(value: ThreadTimeRange): string {
  return THREAD_TIME_RANGES.find((r) => r.value === value)?.label ?? "全部时间";
}
