"use client";

import { memo, type FC } from "react";
import { cn } from "@/lib/utils";
import { pixelMascotRows } from "@/lib/projects/project-appearance";

/**
 * 8×8 单色像素吉祥物（与矢量吉祥物并列的一组成员）。
 *
 * 自己的实现，刻意保持极简：`#` 格按行合并成横条落成 rect，viewBox 8×8 +
 * `shapeRendering="crispEdges"` 保证像素边缘不糊；颜色取 `currentColor`，
 * 由宿主（徽章的着色 / 选择器的 tint）控制。不做多帧动画与阴影层——需要时再加。
 */
export const PixelMascot: FC<{
  id: string;
  className?: string;
}> = memo(({ id, className }) => {
  const rows = pixelMascotRows(id);
  if (!rows) return null;

  // 同一行相邻的 # 合并成一条 rect：一个 8×8 图案从 ~30 个节点降到十来个
  const bars: { x: number; y: number; w: number }[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") {
        x += 1;
        continue;
      }
      let w = 1;
      while (x + w < row.length && row[x + w] === "#") w += 1;
      bars.push({ x, y, w });
      x += w;
    }
  });

  return (
    <svg
      aria-hidden
      viewBox="0 0 8 8"
      shapeRendering="crispEdges"
      className={cn("size-4 shrink-0", className)}
    >
      {bars.map(({ x, y, w }) => (
        <rect
          key={`${x}-${y}-${w}`}
          x={x}
          y={y}
          width={w}
          height={1}
          fill="currentColor"
        />
      ))}
    </svg>
  );
});

PixelMascot.displayName = "PixelMascot";
