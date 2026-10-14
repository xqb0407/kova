"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { EASE_OUT, SPRING_PRESS } from "@/lib/ease";
import { cn } from "@/lib/utils";
import { useHeatCalendar } from "./context";
import { DAYS, fmtDay, GAP, LIFT, MONTH_ROW, PITCH } from "./utils";

export function HeatCalendarGrid({ children, className }: { children?: ReactNode; className?: string }) {
  const {
    weeks,
    reduce,
    canHover,
    pinned,
    step,
    settled,
    level,
    bucket,
    fill,
    count,
    dateOf,
    future,
    cols,
    clear,
    span,
    select,
    hot,
    hotMonth,
    setHover,
    gridRef,
    tooltipId,
    unit,
  } = useHeatCalendar();
  return (
    <div
      ref={gridRef}
      className={cn("relative grid", className)}
      style={{
        width: weeks * PITCH - GAP,
        maxWidth: "100%",
        gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))`,
        gridTemplateRows: `${MONTH_ROW}px repeat(7, auto)`,
        gap: GAP,
      }}
      onPointerLeave={() => setHover(null)}
    >
      {cols.map((c) =>
        c.label ? (
          <span
            key={c.id}
            className={cn(
              "whitespace-nowrap text-[10px] leading-none transition-colors duration-200",
              hotMonth === c.m ? "text-foreground" : "text-muted-foreground",
            )}
            style={{
              gridColumn: c.w + 1,
              gridRow: 1,
              // 拉伸布局下末列窄于标签文字，右对齐让溢出朝左（空白区），不被容器裁掉
              justifySelf: c.w === weeks - 1 ? "end" : undefined,
            }}
          >
            {c.label}
          </span>
        ) : null,
      )}
      {cols.map(({ id, w }) =>
        DAYS.map(({ id: dayId, d }) => {
          const date = dateOf(w, d);
          if (future(w, d)) return null;
          const v = level(w, d);
          const b = bucket(v);
          const i = w * 7 + d;
          const on = hot?.w === w && hot?.d === d;
          const isEnd = span ? i === span.lo || i === span.hi : pinned?.w === w && pinned?.d === d;
          const dim = (step !== null && step !== b) || (span !== null && (i < span.lo || i > span.hi));
          // 涟漪：被悬浮的格子抬得最多，围着它的一圈稍抬，再外一圈几乎不动
          const dist = hot ? Math.max(Math.abs(hot.w - w), Math.abs(hot.d - d)) : 9;
          const lift =
            reduce || !canHover ? 1 : dist === 0 ? LIFT[0] : canHover && dist < LIFT.length ? LIFT[dist] : 1;
          return (
            // 外层 span 承担图例变暗，避免和内部 transform 互相打架
            <span
              key={`${id}-${dayId}`}
              className="relative block aspect-square w-full transition-opacity duration-200"
              style={{
                gridColumn: w + 1,
                gridRow: d + 2,
                opacity: dim ? 0.25 : 1,
                zIndex: lift > 1 ? LIFT.length - dist : 0,
              }}
            >
              {/* 命中区是格子本身再向四周借半个间隙，网格里因此没有死区、快速的指针
                    不会从缝里漏过去；内部视觉层不接收指针事件，抬起的邻格也抢不走点击 */}
              <motion.button
                type="button"
                aria-label={
                  date ? `${fmtDay.format(date)} ${count(v)} ${unit}` : `${count(v)} ${unit}`
                }
                data-heat-cell={`${w}-${d}`}
                aria-pressed={isEnd}
                aria-describedby={on ? tooltipId : undefined}
                onPointerEnter={() => setHover({ w, d })}
                onFocus={() => setHover({ w, d })}
                onBlur={() => setHover(null)}
                onClick={() => select({ w, d })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") clear();
                }}
                className="absolute -inset-0.5 block rounded-[5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                whileTap={reduce ? undefined : { scale: 0.9, transition: SPRING_PRESS }}
              >
                <motion.span
                  className="pointer-events-none absolute inset-0.5 block rounded-[4px]"
                  style={{
                    background: fill(b),
                    boxShadow: isEnd ? "0 0 0 2px var(--background), 0 0 0 3.5px var(--foreground)" : "none",
                    transition: "box-shadow 150ms",
                  }}
                  // 对角波浪：每个格子比左上角晚 (w + d) 步入场；
                  // 落地后涟漪改为按距离从悬浮格向外扩散
                  initial={reduce ? false : { opacity: 0, scale: 0.4 }}
                  animate={
                    settled
                      ? {
                          opacity: 1,
                          scale: lift,
                          transition: { ...SPRING_PRESS, delay: Math.min(dist, 3) * 0.03 },
                        }
                      : {
                          opacity: 1,
                          scale: 1,
                          transition: reduce ? { duration: 0 } : { ...SPRING_PRESS, delay: (w + d) * 0.018 },
                        }
                  }
                >
                  {/* 描边画在格子内部：inset-0 正好铺满它的盒子、borderRadius:inherit
                        继承它的圆角，于是尺寸、缩放（含悬浮抬起）和圆角永远与格子一致，
                        无论外边怎么改样式都不会错位 */}
                  <AnimatePresence>
                    {on && !isEnd ? (
                      <motion.span
                        className="pointer-events-none absolute inset-0 block border-[1.5px]"
                        style={{
                          borderRadius: "inherit",
                          borderColor: "color-mix(in srgb, var(--foreground) 55%, transparent)",
                        }}
                        initial={reduce ? false : { opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.12, ease: EASE_OUT }}
                      />
                    ) : null}
                  </AnimatePresence>
                </motion.span>
              </motion.button>
            </span>
          );
        }),
      )}

      {children}
    </div>
  );
}
