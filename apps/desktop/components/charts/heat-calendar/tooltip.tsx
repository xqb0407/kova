"use client";

import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";
import { useHeatCalendar } from "./context";
import { fmtDay, fmtRange } from "./utils";

/** 浮层与视口边缘的最小距离（也用于宽度上限）。 */
const EDGE = 18;

/**
 * 悬浮读数：贴住被指到的格子（上方放不下就翻到下方），越界时夹回视口，
 * 滚动或缩放后重新贴合。默认内容是「计数 + 日期/区间」，也可以用 children
 * 函数接管渲染（移植时用 `NumberTicker` 滚动数字，这里改为普通文本）。
 */
export function HeatCalendarTooltip({
  children,
  className,
}: {
  children?: ReactNode | ((data: NonNullable<ReturnType<typeof useHeatCalendar>["tooltip"]>) => ReactNode);
  className?: string;
}) {
  const { gridRef, tooltipId, tip, tooltip, unit, reduce } = useHeatCalendar();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // 浮层尺寸随内容变化，量到差值才写 state，最多两帧收敛（都在绘制前）
  useLayoutEffect(() => {
    const box = bubbleRef.current;
    if (!box) return;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
  });

  useLayoutEffect(() => {
    if (!tip) return; // 关闭时保留上一次位置，退场动画在原地淡出而不是跳回原点
    const place = () => {
      const cell = gridRef.current?.querySelector<HTMLElement>(`[data-heat-cell="${tip.w}-${tip.d}"]`);
      if (!cell) return;
      const r = cell.getBoundingClientRect();
      // 留 18px 边距：既是贴边的缓冲，也避开页面自身的滚动条（贴到 8px 时浮层会压在上面）
      const x = Math.min(
        Math.max(r.left + r.width / 2 - size.w / 2, EDGE),
        Math.max(EDGE, window.innerWidth - size.w - EDGE),
      );
      const above = r.top - size.h - 10;
      setPos({ x, y: above >= EDGE ? above : r.bottom + 10 });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [gridRef, tip, size.w, size.h]);

  return (
    <AnimatePresence>
      {tooltip ? (
        <motion.div
          key="tip"
          ref={bubbleRef}
          id={tooltipId}
          role="tooltip"
          initial={reduce ? false : { opacity: 0, scale: 0.96, y: 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1, ease: EASE_OUT } }}
          transition={{ duration: 0.16, ease: EASE_OUT }}
          className={cn(
            // w-max 是关键：固定定位元素不给宽度时按 shrink-to-fit 收窄到「视口 − left」，
            // 靠近右缘的浮层会被压成多行、看着像被挤住的滚动文本；宽度必须与位置无关
            "bg-popover text-popover-foreground pointer-events-none fixed z-50 w-max rounded-lg border px-2.5 py-1.5 text-xs whitespace-nowrap shadow-md",
            className,
          )}
          style={{
            left: pos?.x ?? 0,
            top: pos?.y ?? 0,
            maxWidth: `calc(100vw - ${EDGE * 2}px)`,
            visibility: pos ? "visible" : "hidden",
          }}
        >
          <span className="flex flex-wrap items-center gap-1.5">
            {typeof children === "function" ? (
              children(tooltip)
            ) : children !== undefined ? (
              children
            ) : (
              <>
                <span className="font-mono tabular-nums">
                  {tooltip.count} {unit}
                </span>
                <span className="text-muted-foreground">
                  {tooltip.days > 1 && tooltip.startDate && tooltip.endDate
                    ? `${fmtRange.format(tooltip.startDate)} – ${fmtRange.format(tooltip.endDate)}`
                    : fmtDay.format(tooltip.date)}
                </span>
                {tooltip.days > 1 ? (
                  <span className="text-muted-foreground">{tooltip.days} 天</span>
                ) : null}
              </>
            )}
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
