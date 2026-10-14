"use client";

import type { FC } from "react";
import { cn } from "@/lib/utils";

/**
 * 指标磁贴里的迷你走势（纯 SVG，不引图表库）。
 *
 * 用 `viewBox` + `preserveAspectRatio="none"` 拉伸填充，配合
 * `vectorEffect="non-scaling-stroke"` 让线宽不随拉伸变形——这是不引库画走势的
 * 关键一步，否则非等比缩放会把线拉成粗细不均的一条。
 * 采样不足两点时画基线，避免刚打开窗口时出现断线或空块。
 */
export const Sparkline: FC<{
  /** 采样值（百分比 0..100，时间顺序，末尾为最新） */
  values: number[];
  /** 纵轴上限，默认 100 */
  max?: number;
  className?: string;
}> = ({ values, max = 100, className }) => {
  const W = 100;
  const H = 28;
  const points = values.slice(-40);
  const clamp = (v: number) => Math.max(0, Math.min(1, v / max));
  const coords =
    points.length > 1
      ? points
          .map((v, i) => {
            const x = (i / (points.length - 1)) * W;
            const y = H - 2 - clamp(v) * (H - 4);
            return `${x.toFixed(2)},${y.toFixed(2)}`;
          })
          .join(" ")
      : `${0},${H - 2} ${W},${H - 2}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden
      className={cn("h-7 w-full", className)}
    >
      <polyline
        points={coords}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};
