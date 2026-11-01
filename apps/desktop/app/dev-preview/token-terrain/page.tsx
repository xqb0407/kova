"use client";

/**
 * 【校对页】Token 活动地形图（ActivityTerrain）：/dev-preview/token-terrain
 *
 * 跑法：cd apps/desktop && bun run dev → http://localhost:3000/dev-preview/token-terrain
 *
 * 设置页「Token 活动」面板的等价复刻：PanelCard 外壳 + 每日/每周/累计粒度 +
 * 平面/地形视图 + 悬浮提示块。数据用确定性夹具（工作日忙、周末闲、偶尔断档），
 * 便于校对主题色阶、地形高度、悬浮块位置与拖动抛掷翻转。
 */

import { useMemo, useState } from "react";
import ActivityTerrain from "@/components/kokonutui/activity-terrain";
import { Segmented } from "@/components/custom-ui/segmented";
import {
  buildTerrainData,
  localTodayUtc,
  type HeatGranularity,
} from "@/lib/model/usage-terrain";
import type { UsageStatsDay } from "@/lib/model/usage-stats";

/** 确定性夹具：近 200 天，工作日忙、周末闲、偶有断档 */
function fixtureDays(): UsageStatsDay[] {
  const today = localTodayUtc();
  const out: UsageStatsDay[] = [];
  for (let i = 199; i >= 0; i--) {
    const date = new Date(today.getTime() - i * 86_400_000);
    const weekday = (date.getUTCDay() + 6) % 7; // 0 = 周一
    const weekend = weekday >= 5;
    const wave = 0.5 + 0.5 * Math.sin(i / 17);
    const quiet = (i * 37) % 11 === 0;
    const tokens = quiet
      ? 0
      : Math.round((weekend ? 2_000 : 9_000) * wave + ((i * 2_371) % 7_000));
    out.push({
      date: date.toISOString().slice(0, 10),
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokens,
      messages: Math.round(tokens / 900),
      byModel: {},
    });
  }
  return out;
}

export default function TokenTerrainPreview() {
  const days = useMemo(fixtureDays, []);
  const [granularity, setGranularity] = useState<HeatGranularity>("daily");
  const [flat, setFlat] = useState(false);
  const terrain = useMemo(
    () => buildTerrainData(days, granularity),
    [days, granularity],
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 py-8">
      <h1 className="text-2xl font-bold tracking-tight">Token 活动（校对）</h1>
      <section className="bg-muted/50 flex flex-col rounded-2xl p-2">
        <header className="flex min-h-10 items-center justify-between gap-3 px-2.5">
          <h2 className="text-sm font-semibold">Token 活动</h2>
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
            <Segmented<"flat" | "terrain">
              value={flat ? "flat" : "terrain"}
              options={[
                { value: "flat", label: "平面" },
                { value: "terrain", label: "地形" },
              ]}
              onChange={(v) => setFlat(v === "flat")}
            />
          </div>
        </header>
        <div className="bg-background flex flex-1 flex-col rounded-xl p-4">
          <ActivityTerrain
            data={terrain.data}
            endDate={terrain.endDate}
            showHeader={false}
            chrome={false}
            flat={flat}
            onFlatChange={setFlat}
            tooltip
            className="w-full"
          />
        </div>
      </section>
    </div>
  );
}
