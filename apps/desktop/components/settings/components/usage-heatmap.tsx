"use client";

import { useMemo, type FC } from "react";
import {
  HeatCalendar,
  HeatCalendarGrid,
  HeatCalendarLegend,
  HeatCalendarTooltip,
} from "@/components/charts/heat-calendar";
import { addDays, mondayOf } from "@/components/charts/heat-calendar/utils";
import { NumberTicker } from "@/components/custom-ui/number-ticker";
import { formatTokens, type UsageStatsDay } from "@/lib/model/usage-stats";

/**
 * Token 活动热力图（平面视图）：把逐日 token 序列换算成 HeatCalendar 的
 * 「周 × 7」强度矩阵后，交给移植来的热力日历渲染——单色相深浅表示量级、
 * 波浪入场、悬浮涟漪与 tooltip、点击钉住区间并实时合计，图例兼作强度过滤。
 *
 * 强度口径按粒度换算：每日=当日 tokens / 每周=整周合计 / 累计=迄当日累计，
 * 峰值记 1，其余按比例；maxCount 反向取峰值，tooltip 因此能给出真实量级。
 * 网格口径与 HeatCalendar 内部一致（周一为每列起点、末格为今天），日期键取
 * 本地日历日，与 sidecar 的逐日聚合键一一对应。
 *
 * 本文件下半部分（HEAT_RAMP / heatColor / buildHeatGrid / adaptiveWeeks）是
 * 3D 视图（usage-heatmap-3d）自建网格所依赖的旧实现，继续保留。
 */
export const UsageHeatmap: FC<{
  days: UsageStatsDay[];
  granularity: HeatGranularity;
  /** 覆盖色相；缺省跟随主题色（--primary）。 */
  color?: string;
  className?: string;
}> = ({ days, granularity, color, className }) => {
  const { values, maxCount, messagesByDay } = useMemo(
    () => buildMatrix(days, granularity),
    [days, granularity],
  );
  return (
    // key 让切换粒度时重放入场波浪，和 3D 视图「切粒度重新生长」一致
    <HeatCalendar
      key={granularity}
      weeks={FLAT_WEEKS}
      values={values}
      maxCount={maxCount}
      unit="tokens"
      color={color}
      endDate={localToday()}
      className={className}
    >
      <HeatCalendarGrid>
        <HeatCalendarTooltip>
          {(data) => (
            <HeatTooltipBody
              data={data}
              granularity={granularity}
              messagesByDay={messagesByDay}
            />
          )}
        </HeatCalendarTooltip>
      </HeatCalendarGrid>
      <HeatCalendarLegend />
    </HeatCalendar>
  );
};

/** 平面视图的周数。格子边长 18px 时 53 周需要约 1160px，而设置页卡片内宽约 928px，
 *  网格会被压回 13px 左右——想要更大的格子又不想横向滚动，就只能是更短的区间：
 *  42 周（约 10 个月）正好 920px 铺满卡片且一格不压。要回整年就把这里改回 53。 */
const FLAT_WEEKS = 42;

type TooltipData = {
  date: Date;
  count: number;
  total: number;
  startDate: Date;
  endDate: Date;
  days: number;
};

const dayKeyOf = (d: Date): string => d.toISOString().slice(0, 10);

const shortDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "UTC",
  month: "long",
  day: "numeric",
});
const fmtShort = (d: Date): string => shortDate.format(d);

/** 本地“今天”在 UTC 字段上的表示：HeatCalendar 按 UTC 取字段，这样网格里的
 *  日期就是本地日历日，和 sidecar 的日期键对得上（东八区凌晨也不例外）。 */
function localToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function buildMatrix(days: UsageStatsDay[], granularity: HeatGranularity) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const end = localToday();
  const start = addDays(mondayOf(end), -(FLAT_WEEKS - 1) * 7);

  const raw: number[][] = [];
  const messagesByDay = new Map<string, number>();
  let cumulative = 0;
  let max = 0;
  for (let w = 0; w < FLAT_WEEKS; w++) {
    // 先取整周合计（每周粒度整列同值），再按日序推进累计
    const week = Array.from({ length: 7 }, (_, d) => {
      const key = dayKeyOf(addDays(start, w * 7 + d));
      return { key, day: byDate.get(key) };
    });
    const weekSum = week.reduce((s, c) => s + (c.day?.tokens ?? 0), 0);
    const row: number[] = [];
    for (const { key, day } of week) {
      const tokens = day?.tokens ?? 0;
      cumulative += tokens;
      const value =
        granularity === "daily" ? tokens : granularity === "weekly" ? weekSum : cumulative;
      max = Math.max(max, value);
      messagesByDay.set(key, day?.messages ?? 0);
      row.push(value);
    }
    raw.push(row);
  }

  const peak = Math.max(1, max);
  return {
    values: raw.map((row) => row.map((v) => v / peak)),
    maxCount: peak,
    messagesByDay,
  };
}

/** tooltip 读数：数字走滚轮（数字位滚动、万/亿 与小数点静止），并点明当前粒度下这个数字的口径。 */
const HeatTooltipBody: FC<{
  data: TooltipData;
  granularity: HeatGranularity;
  messagesByDay: Map<string, number>;
}> = ({ data, granularity, messagesByDay }) => {
  const span = data.days > 1;
  const value = span ? data.total : data.count;
  // 每周粒度单格是整周的量，日期也就读成一整周
  const range = span
    ? `${fmtShort(data.startDate)} – ${fmtShort(data.endDate)}`
    : granularity === "weekly"
      ? `${fmtShort(mondayOf(data.date))} – ${fmtShort(addDays(mondayOf(data.date), 6))}`
      : fmtShort(data.date);
  // 消息轮数只有「每日」口径下才与数字同义，区间则整段求和
  let messages: number | null = null;
  if (granularity === "daily") {
    messages = 0;
    for (let d = new Date(data.startDate); d <= data.endDate; d = addDays(d, 1)) {
      messages += messagesByDay.get(dayKeyOf(d)) ?? 0;
    }
  }
  return (
    <>
      <span className="font-mono font-medium">
        <NumberTicker value={value} format={formatTokens} duration={0.4} startOnView={false} />
        {" tokens"}
      </span>
      <span className="text-muted-foreground">{range}</span>
      {granularity === "weekly" ? (
        <span className="text-muted-foreground">{span ? `${data.days} 天` : "当周合计"}</span>
      ) : granularity === "cumulative" ? (
        <span className="text-muted-foreground">{span ? `${data.days} 天` : "累计"}</span>
      ) : (
        <span className="text-muted-foreground">
          {span ? `${data.days} 天 · ` : ""}
          <NumberTicker value={messages ?? 0} duration={0.4} startOnView={false} />
          {" 轮消息"}
        </span>
      )}
    </>
  );
};

/* ------------------------------ 3D 视图共用（保留） ------------------------------ */

/**
 * 强度色带（蓝系，3D 视图专用；平面视图改用 HeatCalendar 的单色相渐变）。
 */
export const HEAT_RAMP = ["#dbeafe", "#bfdbfe", "#93c5fd", "#60a5fa"];

export function heatColor(ratio: number): string {
  if (ratio <= 0) return "";
  const i = Math.min(HEAT_RAMP.length - 1, Math.floor(ratio * HEAT_RAMP.length));
  return HEAT_RAMP[i];
}

/** 强度口径（平面与 3D 共用同一套粒度假定） */
export type HeatGranularity = "daily" | "weekly" | "cumulative";

export type HeatCell = {
  date: string;
  col: number;
  row: number;
  /** 当前粒度下的强度值 */
  value: number;
  /** 当日真实 tokens（tooltip 用） */
  tokens: number;
  messages: number;
  /** value / max，0~1 */
  ratio: number;
};

export type HeatGrid = {
  /** 列主序（col * 7 + row），只覆盖今天之前（含今天） */
  cells: HeatCell[];
  cols: number;
  monthLabels: { col: number; label: string }[];
  max: number;
};

const CELL = 14;
const GAP = 3;
const WEEKS_MAX = 53;
const WEEKS_MIN = 4;

/** 3D 视图专用：展示周数自适应数据，从最早活跃日往前推整周到今天（最少 4 周、
 *  最多 53 周），保证瓦片在画面里足够大；平面视图不用它，恒为 53 周全年 */
export function adaptiveWeeks(
  days: UsageStatsDay[],
  now = new Date(),
): number {
  let first: string | null = null;
  for (const d of days) {
    if (d.tokens > 0 && (first === null || d.date < first)) first = d.date;
  }
  if (!first) return WEEKS_MIN;
  const [y, m, dd] = first.split("-").map(Number);
  const daysSince = Math.floor(
    (now.getTime() - new Date(y, (m ?? 1) - 1, dd ?? 1).getTime()) / 86_400_000,
  );
  return Math.min(
    WEEKS_MAX,
    Math.max(WEEKS_MIN, Math.ceil((daysSince + 1) / 7)),
  );
}

/** 3D 视图自建网格用：按日聚合序列铺成列主序的瓦片网格（3D 的 tile 位置即由它给出）。 */
export function buildHeatGrid(
  days: UsageStatsDay[],
  granularity: HeatGranularity,
  weeks: number = WEEKS_MAX,
  now = new Date(),
): HeatGrid {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const end = new Date(now);
  const raw = new Date(now);
  raw.setDate(raw.getDate() - (weeks * 7 - 1));
  // 对齐到周一（列边界）
  raw.setDate(raw.getDate() - ((raw.getDay() + 6) % 7));

  const monday = (d: Date) => {
    const c = new Date(d);
    c.setDate(c.getDate() - ((c.getDay() + 6) % 7));
    return c;
  };
  const start = monday(raw);
  const cols = Math.ceil(
    (Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1) / 7,
  );

  // 逐日 tokens（缺日 = 0）与每周合计
  const dayTokens: number[] = [];
  const dayMeta: { date: string; tokens: number; messages: number }[] = [];
  const weekSum: number[] = new Array(cols).fill(0);
  const cursor = new Date(start);
  let index = 0;
  while (cursor <= end) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const day = byDate.get(key);
    const tokens = day?.tokens ?? 0;
    const col = Math.floor(index / 7);
    dayTokens.push(tokens);
    dayMeta.push({ date: key, tokens, messages: day?.messages ?? 0 });
    weekSum[col] += tokens;
    cursor.setDate(cursor.getDate() + 1);
    index += 1;
  }

  // 按粒度取强度
  let cumulative = 0;
  const cells: HeatCell[] = [];
  for (let i = 0; i < dayTokens.length; i += 1) {
    const col = Math.floor(i / 7);
    const row = i % 7;
    cumulative += dayTokens[i];
    const value =
      granularity === "daily"
        ? dayTokens[i]
        : granularity === "weekly"
          ? weekSum[col]
          : cumulative;
    cells.push({ ...dayMeta[i], col, row, value, ratio: 0 });
  }

  const max = cells.reduce((m, c) => Math.max(m, c.value), 0);
  if (max > 0) for (const c of cells) c.ratio = c.value / max;

  // 月份标签：列首月份相对上一列变化处
  const monthLabels: { col: number; label: string }[] = [];
  let lastMonth = -1;
  for (let col = 0; col < cols; col += 1) {
    const d = new Date(start);
    d.setDate(d.getDate() + col * 7);
    if (d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth();
      monthLabels.push({ col, label: `${lastMonth + 1}月` });
    }
  }

  return { cells, cols, monthLabels, max };
}
