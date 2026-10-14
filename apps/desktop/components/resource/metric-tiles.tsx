"use client";

import type { FC } from "react";
import { cn } from "@/lib/utils";
import { Sparkline } from "./sparkline";

/** 一块指标磁贴：标题 + 大数字 + 一行附注 + 走势（或占比条） */
export type MetricTile = {
  id: string;
  label: string;
  value: string;
  /** 大数字右侧的灰字（"整机 62.0 GB / 64.0 GB"） */
  hint?: string;
  /** 占比条（0..100）；与 series 同时给出时只画走势 */
  barPct?: number;
  /** 迷你走势（0..100，时间顺序）——速率类指标（CPU）用它，容量类（内存）用 barPct */
  series?: number[];
};

/**
 * 顶部指标行：每块磁贴一个数字，横向排开。
 *
 * 取 Win11 任务管理器那种"先看趋势再看列表"的层级：速率类（CPU）给走势，
 * 容量类（内存）给占比条——两者关心的东西不同，用同一种图反而不好读。
 */
export const MetricTiles: FC<{ tiles: MetricTile[] }> = ({ tiles }) => (
  // lg（1024）就切三列：资源管理器窗口默认 1120 宽，用 xl 会让第三块掉到第二行
  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {tiles.map((tile) => (
      <div key={tile.id} className="bg-muted/50 flex flex-col gap-1.5 rounded-2xl px-4 py-3">
        <div className="text-muted-foreground truncate text-xs">{tile.label}</div>
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-2xl font-semibold whitespace-nowrap tabular-nums">
            {tile.value}
          </span>
          {tile.hint && (
            <span className="text-muted-foreground min-w-0 truncate text-xs whitespace-nowrap tabular-nums">
              {tile.hint}
            </span>
          )}
        </div>
        <div className="mt-auto">
          {tile.series && tile.series.length > 0 ? (
            <Sparkline
              values={tile.series}
              max={seriesMax(tile.series)}
              className="text-foreground/60"
            />
          ) : tile.barPct !== undefined ? (
            <div className="bg-background h-1.5 w-full overflow-hidden rounded-full">
              <div
                className={cn("bg-foreground h-full rounded-full")}
                style={{ width: `${Math.min(100, Math.max(0, tile.barPct))}%` }}
              />
            </div>
          ) : null}
        </div>
      </div>
    ))}
  </div>
);

/**
 * 走势纵轴上限：按窗口内峰值自适应，并留 10% 下限。
 *
 * 固定用 0~100 的话，5% 的 CPU 占用在磁贴里就是一条直线——量的是"有没有动"，
 * 静止的线什么也说明不了。数字本身照旧是绝对百分比（大字写在磁贴上），
 * 所以自适应纵轴不会造成误读；这也是 Win11 任务管理器每块磁贴各按自己的
 * 峰值缩放的做法。
 */
function seriesMax(values: number[]): number {
  return Math.max(10, Math.max(...values, 0) * 1.3);
}
