"use client";

import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/custom-ui/segmented";
import { NumberTicker } from "@/components/custom-ui/number-ticker";
import {
  computeStreaks,
  fetchUsageStats,
  formatChatDuration,
  formatTokens,
  peakTokens,
  type UsageStats,
} from "@/lib/model/usage-stats";
import {
  UsageHeatmap,
  HEAT_RAMP,
  type HeatGranularity,
} from "./usage-heatmap";

/* 3D 视图（three.js 全家桶）与 recharts 图表都走异步分块：切到对应视图才拉取 */
const UsageHeatmap3D = dynamic(() => import("./usage-heatmap-3d"), {
  ssr: false,
  loading: () => (
    <div className="text-muted-foreground flex h-80 items-center justify-center text-sm">
      3D 视图加载中…
    </div>
  ),
});
const UsageCharts = dynamic(() => import("./usage-charts"), {
  ssr: false,
  loading: () => (
    <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
      图表加载中…
    </div>
  ),
});

type HeatView = "flat" | "3d";

/** 使用统计页：全局 token 指标卡 + 活动热力图（平面/3D 切换）+ 分模型趋势与占比。
 *  数据来自 sidecar usage_stats（扫全部会话转录按日聚合），进页拉取、失败可重试。 */
export const UsageStatsSettings: FC = () => {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<HeatGranularity>("daily");
  const [view, setView] = useState<HeatView>("flat");
  const [range, setRange] = useState<"7" | "30">("7");

  const load = () => {
    setLoading(true);
    setError(null);
    fetchUsageStats()
      .then(setStats)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => load(), []);

  const streaks = useMemo(
    () => (stats ? computeStreaks(stats.days) : null),
    [stats],
  );
  const totalTokens = useMemo(
    () => stats?.days.reduce((s, d) => s + d.tokens, 0) ?? 0,
    [stats],
  );
  const peak = stats ? peakTokens(stats.days) : 0;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-6 self-center px-8 py-8">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">使用统计</h1>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground gap-1.5"
            onClick={load}
            disabled={loading}
          >
            <RefreshCwIcon className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
            刷新
          </Button>
        </div>

        {error ? (
          <PanelCard bodyClassName="text-muted-foreground flex min-h-40 flex-col items-center justify-center gap-3 text-sm">
            <span className="text-destructive">统计加载失败：{error}</span>
            <Button variant="outline" size="sm" onClick={load}>
              重试
            </Button>
          </PanelCard>
        ) : loading && !stats ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="bg-muted/50 rounded-2xl p-2">
                  <div className="bg-background h-16 animate-pulse rounded-xl" />
                </div>
              ))}
            </div>
            <div className="bg-muted/50 rounded-2xl p-2">
              <div className="bg-background h-48 animate-pulse rounded-xl" />
            </div>
            <div className="bg-muted/50 rounded-2xl p-2">
              <div className="bg-background h-56 animate-pulse rounded-xl" />
            </div>
          </>
        ) : (
          <>
            {/* 指标卡：同族两层磁贴——灰壳放标签，数字坐在内层面板里 */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard value={totalTokens} format={formatTokens} label="累计 Token 数" />
              <StatCard value={peak} format={formatTokens} label="峰值 Token 数" />
              <StatCard
                value={stats?.longestChatMs ?? 0}
                format={formatChatDuration}
                label="最长聊天时长"
              />
              <StatCard
                value={streaks?.current ?? 0}
                format={(n) => `${n} 天`}
                label="当前连续天数"
              />
              <StatCard
                value={streaks?.longest ?? 0}
                format={(n) => `${n} 天`}
                label="最长连续天数"
              />
            </div>

            {/* Token 活动热力图：平面 / 3D 切换 */}
            <PanelCard
              title="Token 活动"
              action={
                <div className="flex items-center gap-2">
                  <Segmented<HeatGranularity>
                    value={granularity}
                    options={[
                      { value: "daily", label: "每日" },
                      { value: "weekly", label: "每周" },
                      { value: "cumulative", label: "累计" },
                    ]}
                    onChange={setGranularity}
                  />
                  <Segmented<HeatView>
                    value={view}
                    options={[
                      { value: "flat", label: "平面" },
                      { value: "3d", label: "3D" },
                    ]}
                    onChange={setView}
                  />
                </div>
              }
              bodyClassName="flex flex-col gap-4"
            >
              {view === "flat" ? (
                <UsageHeatmap days={stats?.days ?? []} granularity={granularity} />
              ) : (
                <>
                  <UsageHeatmap3D days={stats?.days ?? []} granularity={granularity} />
                  {/* 色阶图例：只给 3D 用（蓝系固化色带）；平面视图由热力日历
                      自带的图例表示强度（单色相 + 悬浮过滤） */}
                  <div className="text-muted-foreground flex items-center justify-center gap-1.5 text-xs">
                    <span>少</span>
                    <span className="bg-muted size-3 rounded-[3px]" />
                    {HEAT_RAMP.map((color) => (
                      <span
                        key={color}
                        className="size-3 rounded-[3px]"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                    <span>多</span>
                  </div>
                </>
              )}
            </PanelCard>

            {/* 趋势/占比：时间范围切换收进标题行右侧动作区 */}
            <PanelCard
              title="时间范围"
              action={
                <Segmented<"7" | "30">
                  value={range}
                  options={[
                    { value: "7", label: "近 7 日" },
                    { value: "30", label: "近 30 日" },
                  ]}
                  onChange={setRange}
                />
              }
            >
              <UsageCharts days={stats?.days ?? []} rangeDays={range === "7" ? 7 : 30} />
            </PanelCard>
          </>
        )}
      </div>
    </div>
  );
};

/**
 * 分层面板卡（样式参考 kova-search PanelCard）：灰底外壳（标题行 + 右侧动作区）
 * + 内嵌反色内容面板。无边框、纯靠底色分层：外壳承担「分组」语义，内容永远坐在
 * 内层面板上；明暗主题自动反色（暗色下内层更深，同样是内凹感）。
 */
const PanelCard: FC<{
  title?: ReactNode;
  /** 标题行右侧的动作区（切换器等） */
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}> = ({ title, action, children, className, bodyClassName }) => (
  <section className={cn("bg-muted/50 flex flex-col rounded-2xl p-2", className)}>
    {(title != null || action != null) && (
      <header className="flex min-h-10 items-center justify-between gap-3 px-2.5">
        {title != null && <h2 className="text-sm font-semibold">{title}</h2>}
        {action}
      </header>
    )}
    <div className={cn("bg-background flex-1 rounded-xl p-4", bodyClassName)}>{children}</div>
  </section>
);

/**
 * KPI 磁贴：PanelCard 同族的两层结构——标签在灰壳上，数值坐在内层白面板里；
 * 面板 flex-1，保证同一行的磁贴等高、数值基线对齐。
 * 数值用 NumberTicker 按位滚动入场（刷新后新旧值之间也会滚过去），
 * 中文/单位等非数字字形保持静止。
 */
const StatCard: FC<{
  value: number;
  format: (n: number) => string;
  label: string;
}> = ({ value, format, label }) => (
  <div className="bg-muted/50 flex min-w-0 flex-col rounded-2xl p-2">
    <div className="text-muted-foreground px-2 pt-1.5 pb-2 text-xs">{label}</div>
    <div className="bg-background flex flex-1 flex-col justify-center rounded-xl px-3 py-2.5">
      <NumberTicker
        value={value}
        format={format}
        duration={0.6}
        className="text-xl leading-tight font-semibold tabular-nums"
      />
    </div>
  </div>
);
