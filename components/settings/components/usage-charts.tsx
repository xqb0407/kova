"use client";

import { useMemo, type FC } from "react";
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatTokens,
  modelColor,
  usageDayKey,
  type UsageStatsDay,
} from "@/lib/usage-stats";

/**
 * 使用统计图表（recharts）：每日 Token 趋势（近7/近30日，分模型）+ 模型用量环形图。
 * 经 next/dynamic 懒加载（recharts 不进设置页首屏包）；时间范围切换由父级传入。
 */

const TREND_SERIES_LIMIT = 6;
const OTHER_KEY = "其他";

const tooltipStyle = {
  borderRadius: 12,
  border: "1px solid var(--color-border)",
  background: "var(--color-popover)",
  color: "var(--color-popover-foreground)",
  fontSize: 12,
} as const;

const UsageCharts: FC<{
  days: UsageStatsDay[];
  rangeDays: 7 | 30;
}> = ({ days, rangeDays }) => {  const { trendData, seriesKeys, donutData, total } = useMemo(() => {
    const byDate = new Map(days.map((d) => [d.date, d]));

    // 范围内逐日补零序列（今天收尾）
    const cursor = new Date();
    cursor.setDate(cursor.getDate() - (rangeDays - 1));
    const rangeDays7: UsageStatsDay[] = [];
    const inRange: UsageStatsDay[] = [];
    for (let i = 0; i < rangeDays; i += 1) {
      const key = usageDayKey(cursor);
      const day = byDate.get(key);
      if (day) inRange.push(day);
      rangeDays7.push(
        day ?? {
          date: key,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          tokens: 0,
          messages: 0,
          byModel: {},
        },
      );
      cursor.setDate(cursor.getDate() + 1);
    }

    // 范围内模型按总量排名，取前 N，其余并入「其他」
    const totals = new Map<string, number>();
    for (const day of inRange) {
      for (const [model, tokens] of Object.entries(day.byModel)) {
        totals.set(model, (totals.get(model) ?? 0) + tokens);
      }
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, TREND_SERIES_LIMIT).map(([m]) => m);
    const rest = ranked.slice(TREND_SERIES_LIMIT);
    const seriesKeys = [...top];
    if (rest.length > 0) seriesKeys.push(OTHER_KEY);
    const restTokens = rest.reduce((s, [, v]) => s + v, 0);

    const trendData = rangeDays7.map((day) => {
      const d = new Date(`${day.date}T00:00:00`);
      const row: Record<string, number | string> = {
        label: `${d.getMonth() + 1}月${d.getDate()}日`,
      };
      let other = 0;
      for (const [model, tokens] of Object.entries(day.byModel)) {
        if (top.includes(model)) row[model] = tokens;
        else other += tokens;
      }
      if (rest.length > 0) row[OTHER_KEY] = other;
      return row;
    });

    const donutData = [
      ...top.map((model) => ({ name: model, value: totals.get(model) ?? 0 })),
      ...(rest.length > 0 ? [{ name: OTHER_KEY, value: restTokens }] : []),
    ].filter((d) => d.value > 0);

    const total = inRange.reduce((s, d) => s + d.tokens, 0);
    return { trendData, seriesKeys, donutData, total };
  }, [days, rangeDays]);

  if (total === 0) {
    return (
      <div className="text-muted-foreground flex h-40 items-center justify-center rounded-2xl text-sm">
        所选时间范围内暂无用量
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 每日 Token 趋势 */}
      <div className="bg-muted/50 rounded-2xl p-4">
        <h3 className="mb-3 text-sm font-semibold">
          {rangeDays === 7 ? "近 7 日" : "近 30 日"} Token 趋势图
        </h3>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="var(--color-border)"
            />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              width={52}
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => formatTokens(v)}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v) => `${formatTokens(Number(v))} tokens`}
            />
            {seriesKeys.map((key, i) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={modelColor(i)}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
        {/* 图例（自定义，与环形图配色一致） */}
        <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {seriesKeys.map((key, i) => (
            <span key={key} className="flex items-center gap-1.5">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: modelColor(i) }}
              />
              {key}
            </span>
          ))}
        </div>
      </div>

      {/* 模型用量环形图 */}
      <div className="bg-muted/50 rounded-2xl p-4">
        <h3 className="mb-3 text-sm font-semibold">模型用量</h3>
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          {/* 固定宽度收缩容器：ResponsiveContainer 直接进 flex 行会把图例挤溢出 */}
          <div className="h-56 w-full shrink-0 sm:w-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={donutData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="62%"
                  outerRadius="88%"
                  paddingAngle={2}
                  stroke="none"
                >
                  {donutData.map((entry, i) => (
                    <Cell key={entry.name} fill={modelColor(i)} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v, name) => [
                    `${formatTokens(Number(v))} tokens`,
                    String(name),
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {/* 限宽：图例行保持紧凑（名称与数值相邻），不随卡片宽度拉满 */}
          <div className="flex w-full min-w-0 flex-1 flex-col gap-2 sm:max-w-md">
            {donutData.map((entry, i) => {
              const percent = total > 0 ? Math.round((entry.value / total) * 100) : 0;
              return (
                <div key={entry.name} className="flex items-center gap-2 text-sm">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: modelColor(i) }}
                  />
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={entry.name}
                  >
                    {entry.name}
                  </span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {formatTokens(entry.value)} tokens · {percent}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default UsageCharts;
