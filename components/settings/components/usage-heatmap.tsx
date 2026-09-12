"use client";

import { useMemo, useState, type FC } from "react";
import { cn } from "@/lib/utils";
import { formatTokens, type UsageStatsDay } from "@/lib/usage-stats";

/**
 * Token 活动热力图（2D）：GitHub contributions 同款周列布局（列 = 周，行 = 周一..周日）。
 * 网格构建 buildHeatGrid 同时导出给 3D 视图（three.js skyline）复用；
 * 强度按粒度换算：每日=当日 tokens / 每周=整周合计 / 累计=迄当日累计。
 */
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

/** 强度色带（蓝系，2D/3D/图例共用；浅色档为主，最高档避免过深） */
export const HEAT_RAMP = ["#dbeafe", "#bfdbfe", "#93c5fd", "#60a5fa"];

export function heatColor(ratio: number): string {
  if (ratio <= 0) return "";
  const i = Math.min(HEAT_RAMP.length - 1, Math.floor(ratio * HEAT_RAMP.length));
  return HEAT_RAMP[i];
}

const CELL = 14;
const GAP = 3;
const WEEKS_DEFAULT = 53;

export function buildHeatGrid(
  days: UsageStatsDay[],
  granularity: HeatGranularity,
  weeks: number = WEEKS_DEFAULT,
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

const formatDateCN = (date: string): string => {
  const [y, m, d] = date.split("-");
  return `${y}年${Number(m)}月${Number(d)}日`;
};

export const UsageHeatmap: FC<{
  days: UsageStatsDay[];
  granularity: HeatGranularity;
}> = ({ days, granularity }) => {
  const grid = useMemo(() => buildHeatGrid(days, granularity), [days, granularity]);
  const [tip, setTip] = useState<{ x: number; y: number; cell: HeatCell } | null>(
    null,
  );

  return (
    <div className="relative" onMouseLeave={() => setTip(null)}>
      {/* 网格 + 月份标签共用一个滚动容器（标签随网格滚动对齐）；
          mx-auto 居中，溢出时 margin auto 不裁切起点（justify-center 会） */}
      <div className="overflow-x-auto pb-1">
        <div className="mx-auto w-max">
          <div className="flex gap-[3px]">
            {Array.from({ length: grid.cols }, (_, col) => (
              <div
                key={col}
                className="flex flex-col gap-[3px]"
                style={{ width: CELL }}
              >
                {Array.from({ length: 7 }, (_, row) => {
                  const cell = grid.cells[col * 7 + row];
                  if (!cell) return <div key={row} style={{ height: CELL }} />;
                  return (
                    <button
                      key={row}
                      type="button"
                      aria-label={`${formatDateCN(cell.date)} ${formatTokens(cell.tokens)} tokens`}
                      onMouseEnter={(e) =>
                        setTip({ x: e.clientX, y: e.clientY, cell })
                      }
                      className={cn(
                        "rounded-[3px] transition-colors",
                        cell.ratio <= 0 && "bg-muted",
                        tip?.cell.date === cell.date && "ring-foreground/40 ring-1",
                      )}
                      style={{
                        width: CELL,
                        height: CELL,
                        ...(cell.ratio > 0
                          ? { backgroundColor: heatColor(cell.ratio) }
                          : {}),
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {/* 月份标签：与列对齐（列宽 CELL + GAP） */}
          <div className="text-muted-foreground relative mt-1.5 h-4 text-[10px]">
            {grid.monthLabels.map(({ col, label }) => (
              <span
                key={col}
                className="absolute top-0 whitespace-nowrap"
                style={{ left: col * (CELL + GAP) }}
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
      {tip && (
        <div
          className="bg-popover text-popover-foreground pointer-events-none fixed z-50 rounded-lg border px-3 py-1.5 text-xs shadow-md"
          style={{
            left: Math.min(tip.x + 12, window.innerWidth - 180),
            top: Math.max(tip.y - 52, 8),
          }}
        >
          <div className="font-medium">{formatDateCN(tip.cell.date)}</div>
          <div className="text-muted-foreground">
            {formatTokens(tip.cell.tokens)} · {tip.cell.messages} 轮消息
          </div>
        </div>
      )}
    </div>
  );
};
