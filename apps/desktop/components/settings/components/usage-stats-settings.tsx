"use client";

import { useEffect, useMemo, useState, type FC } from "react";
import dynamic from "next/dynamic";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/custom-ui/segmented";
import {
  computeStreaks,
  fetchUsageStats,
  formatChatDuration,
  formatTokens,
  peakTokens,
  type UsageStats,
} from "@/lib/usage-stats";
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
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
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
          <div className="bg-muted/50 text-muted-foreground flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl text-sm">
            <span className="text-destructive">统计加载失败：{error}</span>
            <Button variant="outline" size="sm" onClick={load}>
              重试
            </Button>
          </div>
        ) : loading && !stats ? (
          <div className="flex flex-col gap-6">
            <div className="bg-muted/50 h-24 animate-pulse rounded-2xl" />
            <div className="bg-muted/50 h-56 animate-pulse rounded-2xl" />
            <div className="bg-muted/50 h-64 animate-pulse rounded-2xl" />
          </div>
        ) : (
          <>
            {/* 指标卡 */}
            <div className="bg-muted/50 grid grid-cols-2 gap-1 rounded-2xl p-1 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard value={formatTokens(totalTokens)} label="累计 Token 数" />
              <StatCard value={formatTokens(peak)} label="峰值 Token 数" />
              <StatCard
                value={formatChatDuration(stats?.longestChatMs ?? 0)}
                label="最长聊天时长"
              />
              <StatCard
                value={streaks ? `${streaks.current} 天` : "—"}
                label="当前连续天数"
              />
              <StatCard
                value={streaks ? `${streaks.longest} 天` : "—"}
                label="最长连续天数"
              />
            </div>

            {/* Token 活动热力图：平面 / 3D 切换 */}
            <section className="bg-muted/50 flex flex-col gap-4 rounded-2xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Token 活动</h2>
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
              </div>
              {view === "flat" ? (
                <UsageHeatmap days={stats?.days ?? []} granularity={granularity} />
              ) : (
                <UsageHeatmap3D days={stats?.days ?? []} granularity={granularity} />
              )}
              {/* 色阶图例（平面/3D 共用同一色带） */}
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
            </section>

            {/* 时间范围 + 趋势/占比 */}
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">时间范围</h2>
                <Segmented<"7" | "30">
                  value={range}
                  options={[
                    { value: "7", label: "近 7 日" },
                    { value: "30", label: "近 30 日" },
                  ]}
                  onChange={setRange}
                />
              </div>
              <UsageCharts days={stats?.days ?? []} rangeDays={range === "7" ? 7 : 30} />
            </section>
          </>
        )}
      </div>
    </div>
  );
};

const StatCard: FC<{ value: string; label: string }> = ({ value, label }) => (
  <div className="flex min-w-0 flex-col items-center gap-1 rounded-xl px-3 py-4">
    <span className="truncate text-lg font-semibold tabular-nums">{value}</span>
    <span className="text-muted-foreground text-xs">{label}</span>
  </div>
);
