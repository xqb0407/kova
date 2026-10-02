"use client";

import { useMemo, useState, type FC } from "react";
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
import { usePiModels } from "@/lib/pi/pi-models";
import { cn } from "cn";
import {
  formatTokens,
  modelColor,
  usageDayKey,
  type UsageStatsDay,
} from "@/lib/model/usage-stats";

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
}> = ({ days, rangeDays }) => {
  // byModel 聚合键为 "providerId/modelId"（sidecar 按转录原值写入）；
  // 经模型目录解析成「服务名 · 模型名」展示，目录查不到（服务已删除等）时回退原键
  const models = usePiModels();
  const modelLabel = useMemo(() => {
    const providerNames = new Map<string, string>();
    const modelNames = new Map<string, string>();
    for (const m of models) {
      providerNames.set(m.provider, m.providerName);
      modelNames.set(`${m.provider}/${m.id}`, m.name || m.id);
    }
    return (key: string) => {
      if (key === OTHER_KEY) return key;
      const sep = key.indexOf("/");
      if (sep <= 0) return key;
      const providerId = key.slice(0, sep);
      const modelId = key.slice(sep + 1);
      if (providerId === "?" || modelId === "?") return key;
      return `${providerNames.get(providerId) ?? providerId} · ${modelNames.get(key) ?? modelId}`;
    };
  }, [models]);

  const { trendData, seriesKeys, donutData, total } = useMemo(() => {
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

    // 折线窗口收缩到范围内首个有用量的一天（含）：数据少时避免左边大片空白、
    // 折线悬在半空（与 3D 热力图自适应同理）
    const firstActive = rangeDays7.findIndex((d) => d.tokens > 0);
    const trendDays =
      firstActive > 0 ? rangeDays7.slice(firstActive) : rangeDays7;
    const trendData = trendDays.map((day) => {
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

  // 图例点击隐藏/显示系列：配色按下标绑定在 seriesKeys 上，藏掉的不渲染 Line
  // 但颜色不变；至少保留一个可见系列（全藏了图表空屏像坏了）
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(new Set());
  const toggleSeries = (key: string) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        if (next.size >= seriesKeys.length - 1) return prev;
        next.add(key);
      }
      return next;
    });
  };

  // 环形图的点击隐藏：隐藏项不参与占比重算（占比按可见项的合计算，隐藏 =
  // 暂时不看它，不改变其余项之间的真实比例）；同样至少保留一个可见项
  const visibleDonut = donutData.filter((d) => !hiddenSeries.has(d.name));
  const visibleDonutTotal = visibleDonut.reduce((s, d) => s + d.value, 0);
  // 配色锚定在全量列表的下标上，隐藏/显示不串色
  const donutColorIndex = new Map(donutData.map((d, i) => [d.name, i] as const));

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
        <ResponsiveContainer width="100%" height={264}>
          <LineChart data={trendData} margin={{ top: 10, right: 14, bottom: 0, left: 0 }}>
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
              width={64}
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => formatTokens(v)}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v) => `${formatTokens(Number(v))} tokens`}
            />
            {seriesKeys.map((key, i) =>
              hiddenSeries.has(key) ? null : (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  name={modelLabel(key)}
                  stroke={modelColor(i)}
                  strokeWidth={2}
                  // 点少时画出数据点，一两个点的系列不会像断线
                  dot={trendData.length <= 10 ? { r: 3, strokeWidth: 0 } : false}
                  activeDot={{ r: 3 }}
                />
              ),
            )}
          </LineChart>
        </ResponsiveContainer>
        {/* 图例（自定义，与环形图配色一致；点击隐藏/显示对应系列） */}
        <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {seriesKeys.map((key, i) => {
            const hidden = hiddenSeries.has(key);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={!hidden}
                title={hidden ? "点击显示" : "点击隐藏"}
                onClick={() => toggleSeries(key)}
                className={cn(
                  "flex items-center gap-1.5 transition-opacity",
                  hidden ? "opacity-35" : "hover:opacity-70",
                )}
              >
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: modelColor(i) }}
                />
                {modelLabel(key)}
              </button>
            );
          })}
        </div>
      </div>

      {/* 模型用量环形图 */}
      <div className="bg-muted/50 rounded-2xl p-4">
        <h3 className="mb-3 text-sm font-semibold">模型用量</h3>
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          {/* 固定宽度收缩容器：ResponsiveContainer 直接进 flex 行会把图例挤溢出 */}
          <div className="h-52 w-full shrink-0 sm:w-60">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={visibleDonut}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="62%"
                  outerRadius="88%"
                  paddingAngle={2}
                  stroke="none"
                >
                  {visibleDonut.map((entry) => (
                    <Cell
                      key={entry.name}
                      fill={modelColor(donutColorIndex.get(entry.name) ?? 0)}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v, name) => [
                    `${formatTokens(Number(v))} tokens`,
                    modelLabel(String(name)),
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {/* 限宽：图例行保持紧凑（名称与数值相邻），不随卡片宽度拉满。
              行可点击隐藏/显示：隐藏项置灰、不参与占比重算 */}
          <div className="flex w-full min-w-0 flex-1 flex-col gap-2 sm:max-w-md">
            {donutData.map((entry) => {
              const hidden = hiddenSeries.has(entry.name);
              const percent =
                !hidden && visibleDonutTotal > 0
                  ? Math.round((entry.value / visibleDonutTotal) * 100)
                  : null;
              return (
                <button
                  key={entry.name}
                  type="button"
                  aria-pressed={!hidden}
                  title={hidden ? "点击显示" : "点击隐藏"}
                  onClick={() => toggleSeries(entry.name)}
                  className={cn(
                    // text-left：button 默认居中，会把名称甩到行中间
                    "flex items-center gap-2 text-left text-sm transition-opacity",
                    hidden ? "opacity-35" : "hover:opacity-70",
                  )}
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: modelColor(donutColorIndex.get(entry.name) ?? 0),
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate" title={entry.name}>
                    {modelLabel(entry.name)}
                  </span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {formatTokens(entry.value)} tokens
                    {percent !== null
                      ? percent === 0 && entry.value > 0
                        ? " · <1%"
                        : ` · ${percent}%`
                      : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default UsageCharts;
