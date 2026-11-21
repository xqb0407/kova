"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId, useMemo, useState, type FC } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EASE_OUT } from "@/lib/ease";
import { usePiModels } from "@/lib/pi/pi-models";
import { cn } from "cn";
import { NumberTicker } from "@/components/custom-ui/number-ticker";
import {
  formatTokens,
  modelColor,
  MODEL_COLORS,
  usageDayKey,
  type UsageStatsDay,
} from "@/lib/model/usage-stats";

/**
 * 使用统计图表（recharts）：每日 Token 趋势（近7/近30日，分模型，带面积填充）
 * + 模型用量横向条形（长度=量级，名称写在条上）。
 * 经 next/dynamic 懒加载（recharts 不进设置页首屏包）；时间范围切换由父级传入。
 */

const TREND_SERIES_LIMIT = 6;
const OTHER_KEY = "其他";

/** 趋势图竖向刻度上界：把峰值抬到一个「整」数上，最高那条刻度线即图顶。
 *  否则 recharts 自动刻度可能只标到 2800 万而顶点在 4000 万——尖峰贴着顶边、
 *  看起来像被裁掉了。 */
function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (value <= m * base) return m * base;
  }
  return 10 * base;
}

/** 趋势图的悬浮读数：一行一个模型（色点 + 名称 + 数值），按数值降序、只列有量的模型。
 *  recharts 默认把颜色刷在整行文字上，长模型名读起来很散、框也大得盖住曲线。 */
type TrendTipRow = { dataKey?: unknown; value?: unknown; color?: unknown };
const TrendTooltip: FC<{
  active?: boolean;
  label?: unknown;
  payload?: readonly unknown[];
  modelLabel: (key: string) => string;
}> = ({ active, label, payload, modelLabel }) => {
  const rows = ((payload ?? []) as TrendTipRow[])
    .map((p) => ({
      key: String(p.dataKey ?? ""),
      value: Number(p.value ?? 0),
      color: typeof p.color === "string" ? p.color : "var(--color-muted-foreground)",
    }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  if (!active || rows.length === 0) return null;
  return (
    <div className="bg-popover text-popover-foreground rounded-lg border px-2.5 py-1.5 text-[13px] leading-5 shadow-md">
      <div className="text-muted-foreground mb-1 tabular-nums">{`${String(label ?? "")} · tokens`}</div>
      <div className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-1.5">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: r.color }} />
            <span className="max-w-44 truncate">{modelLabel(r.key)}</span>
            {/* min-w + 右对齐：数值滚动中位数变化（万 ↔ 亿）不让浮层宽度一直抖 */}
            <span className="ml-auto flex min-w-14 items-center justify-end pl-3 font-mono">
              <NumberTicker value={r.value} format={formatTokens} duration={0.4} startOnView={false} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

const UsageCharts: FC<{
  days: UsageStatsDay[];
  rangeDays: 7 | 30;
}> = ({ days, rangeDays }) => {
  const reduce = useReducedMotion();
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

  const { trendData, seriesKeys, modelTotals, total } = useMemo(() => {
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
    // 每天都给每个系列落一个数（当天没用这个模型就是 0），绝不留缺键：
    // byModel 只记当天有量的模型，缺键在 recharts 里是断点，折线/面积会在
    // 没用量的日子被撕成一段一段，看起来像图被裁掉了
    const trendData = trendDays.map((day) => {
      const d = new Date(`${day.date}T00:00:00`);
      const row: Record<string, number | string> = {
        label: `${d.getMonth() + 1}月${d.getDate()}日`,
      };
      for (const key of seriesKeys) row[key] = 0;
      for (const [model, tokens] of Object.entries(day.byModel)) {
        if (top.includes(model)) {
          row[model] = (row[model] as number) + tokens;
        } else if (rest.length > 0) {
          row[OTHER_KEY] = (row[OTHER_KEY] as number) + tokens;
        }
      }
      return row;
    });

    const modelTotals = [
      ...top.map((model) => ({ name: model, value: totals.get(model) ?? 0 })),
      ...(rest.length > 0 ? [{ name: OTHER_KEY, value: restTokens }] : []),
    ].filter((d) => d.value > 0);

    const total = inRange.reduce((s, d) => s + d.tokens, 0);
    return { trendData, seriesKeys, modelTotals, total };
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

  // 用量条的点击隐藏：隐藏项不参与占比重算（占比按可见项的合计算，隐藏 =
  // 暂时不看它，不改变其余项之间的真实比例）；同样至少保留一个可见项
  const visibleTotal = modelTotals
    .filter((d) => !hiddenSeries.has(d.name))
    .reduce((s, d) => s + d.value, 0);
  // 配色锚定在全量列表的下标上，隐藏/显示不串色
  const colorIndex = new Map(modelTotals.map((d, i) => [d.name, i] as const));
  // 条长按「最大项满格」归一（用全量最大值，切换隐藏时条长不跳）
  const maxTotal = modelTotals.reduce((m, d) => Math.max(m, d.value), 0);

  // 每个可见系列都带一层渐变背景（面积），系列之间重叠部分自然混色：
  // 描边不透明、填充很淡，所以谁大谁小依然一眼可比
  const fillId = `trend-fill-${useId().replace(/:/g, "")}`;
  const axisMax = useMemo(() => {
    let max = 0;
    for (const row of trendData) {
      for (const [key, value] of Object.entries(row)) {
        if (key === "label" || hiddenSeries.has(key)) continue;
        max = Math.max(max, Number(value) || 0);
      }
    }
    return niceCeil(max);
  }, [trendData, hiddenSeries]);
  const axisTicks = useMemo(
    () => Array.from({ length: 5 }, (_, i) => (axisMax * i) / 4),
    [axisMax],
  );
  // 点少时画出数据点：白心 + 系列色描边，和面积图/热力图的白描边语言一致。
  // 只画在有量的日期上：补零的日子也画点会在坐标轴上叠出一排色珠，反而像脏点
  const dot = (color: string) =>
    trendData.length <= 10
      ? ({ cx, cy, value }: { cx?: number; cy?: number; value?: number }) =>
          (Number(value) || 0) > 0 ? (
            <circle
              cx={cx}
              cy={cy}
              r={3}
              fill="var(--color-background)"
              stroke={color}
              strokeWidth={1.5}
            />
          ) : null
      : false;

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
      <div>
        <h3 className="mb-3 text-sm font-semibold">
          {rangeDays === 7 ? "近 7 日" : "近 30 日"} Token 趋势图
        </h3>
        <ResponsiveContainer width="100%" height={264}>
          <ComposedChart data={trendData} margin={{ top: 10, right: 14, bottom: 0, left: 0 }}>
            <defs>
              {/* id 必须按实例唯一：同一页面渲染两张趋势图时，固定 id 会让后一张的
                  填充解析到前一张的渐变上，面积直接不见。
                  渐变按「色位」固定整套常驻，绝不随系列排名/显隐增删：WKWebView 会
                  缓存 path 对 paint server 的解析结果，渐变元素一旦被替换（id 不变、
                  DOM 节点换了），面积路径仍指向已失效的旧节点 → 回退成黑色填充
                  （乘 fill-opacity 后呈灰块，切换显隐重挂载才恢复）。常驻不换节点即无此问题。 */}
              {Array.from({ length: MODEL_COLORS.length }, (_, i) => (
                <linearGradient key={i} id={`${fillId}-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={modelColor(i)} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={modelColor(i)} stopOpacity={0.01} />
                </linearGradient>
              ))}
            </defs>
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
              domain={[0, axisMax]}
              ticks={axisTicks}
              tickFormatter={(v: number) => formatTokens(v)}
            />
            <Tooltip
              cursor={{ stroke: "var(--color-border)" }}
              content={(props) => <TrendTooltip {...props} modelLabel={modelLabel} />}
            />
            {seriesKeys.map((key, i) =>
              hiddenSeries.has(key) ? null : (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  name={modelLabel(key)}
                  stroke={modelColor(i)}
                  strokeWidth={2}
                  fill={`url(#${fillId}-${i})`}
                  // 点少时画出数据点，一两个点的系列不会像断线
                  dot={dot(modelColor(i))}
                  activeDot={{ r: 4 }}
                />
              ),
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* 模型用量：横向条形（条长 = 量级，名称写在条上，右侧数值 + 占比）。
          份额用长度编码比角度准得多：偏态分布里 5% 和 1% 在环形图上都是一条看不见的缝，
          在条形上是两段明显不同的长度 */}
      <div>
        <h3 className="mb-3 text-sm font-semibold">模型用量</h3>
        <div className="flex flex-col gap-1.5">
          {modelTotals.map((entry, i) => {
            const hidden = hiddenSeries.has(entry.name);
            const color = modelColor(colorIndex.get(entry.name) ?? 0);
            const ratio = maxTotal > 0 ? entry.value / maxTotal : 0;
            const percent =
              !hidden && visibleTotal > 0
                ? Math.round((entry.value / visibleTotal) * 100)
                : null;
            return (
              <button
                key={entry.name}
                type="button"
                aria-pressed={!hidden}
                title={hidden ? "点击显示（已从趋势图隐藏）" : "点击隐藏"}
                onClick={() => toggleSeries(entry.name)}
                className={cn(
                  "flex w-full items-center gap-3 text-left text-sm transition-opacity",
                  !hidden && "hover:opacity-80",
                )}
              >
                <span className="min-w-0 flex-1 overflow-hidden">
                  {/* 条宽按占比，min-width 兜住名字：小份额的条也不会短到写不下模型名。
                      入场时每行错峰从 0 长到目标宽度（切换时间范围时是就地变形，
                      新出现的模型则重新长出来）；淡入同时盖住「短条先按文字宽度站位」那一下。
                      隐藏态整行压 35% 透明度会让文字糊成「像坏了」，改为条退成中性灰、
                      文字保持可读，状态由右侧数值列的占比消失表达。
                      名字比条形列还宽时 min-width(fit-content) 会赢过 max-width 把条
                      （连同文字）顶出列外压到右侧数值上（窄面板实测 ~50px）；WebKit 不认
                      min(100%, fit-content)，故由外层 overflow-hidden 在列边界裁断 */}
                  <motion.span
                    className="flex h-7 max-w-full min-w-0 items-center overflow-hidden rounded-lg px-2.5 transition-colors"
                    style={{
                      minWidth: "fit-content",
                      background: hidden
                        ? "color-mix(in srgb, var(--color-muted-foreground) 12%, transparent)"
                        : `color-mix(in srgb, ${color} 26%, transparent)`,
                    }}
                    initial={reduce ? false : { width: "0%", opacity: 0 }}
                    animate={{ width: `${ratio * 100}%`, opacity: 1 }}
                    transition={
                      reduce ? { duration: 0 } : { duration: 0.55, ease: EASE_OUT, delay: i * 0.05 }
                    }
                  >
                    {/* 名称只是条上的注记：字号压到 text-[13px] leading-5，让长度（颜色块）当主角 */}
                    <span
                      className={cn("min-w-0 truncate text-[13px] leading-5", hidden && "text-muted-foreground")}
                      title={entry.name}
                    >
                      {modelLabel(entry.name)}
                    </span>
                  </motion.span>
                </span>
                {/* 定宽数值列：各行条形起点与右端对齐，长度才可比。
                    宽度按最坏情况留足（「9999.9 万 tokens · 100%」）：隐藏大项后
                    剩余占比会重算成三位数，列太窄会让右对齐文本向左溢出压到条形上 */}
                <span className="text-muted-foreground w-44 shrink-0 text-right text-[13px] leading-5 tabular-nums whitespace-nowrap">
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
  );
};

export default UsageCharts;
