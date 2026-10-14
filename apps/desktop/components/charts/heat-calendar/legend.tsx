"use client";

import { cn } from "@/lib/utils";
import { useHeatCalendar } from "./context";
import { fmtDay, fmtRange, STEPS } from "./utils";

export function HeatCalendarLegend({ className }: { className?: string }) {
  const { start, end, step, setStep, fill, canHover, reduce } = useHeatCalendar();
  // 跨年时两端都带上年份，否则「10月6日 – 10月11日」会把整年读成五天
  const crossedYear = start !== null && end !== null && start.getUTCFullYear() !== end.getUTCFullYear();
  return (
    <div className={cn("mt-3 flex flex-wrap items-center justify-between gap-3", className)}>
      <span className="text-muted-foreground text-xs">
        {start && end
          ? `${crossedYear ? fmtDay.format(start) : fmtRange.format(start)} – ${
              crossedYear ? fmtDay.format(end) : fmtRange.format(end)
            }`
          : "\u00a0"}
      </span>
      {/* 悬浮某一级时只留下该强度的格子，图例同时充当过滤器 */}
      <span className="flex items-center gap-1" onPointerLeave={() => setStep(null)}>
        <span className="text-muted-foreground mr-0.5 text-xs">少</span>
        {STEPS.map((s, i) => (
          <button
            type="button"
            aria-label={`只看第 ${i} 级活跃度`}
            aria-pressed={step === i}
            key={s}
            onPointerEnter={() => {
              if (canHover) setStep(i);
            }}
            onFocus={() => setStep(i)}
            onBlur={() => setStep(null)}
            onClick={() => setStep(step === i ? null : i)}
            className="size-3 rounded-[3px] transition-transform duration-150"
            style={{ background: fill(i), transform: !reduce && step === i ? "scale(1.25)" : undefined }}
          />
        ))}
        <span className="text-muted-foreground ml-0.5 text-xs">多</span>
      </span>
    </div>
  );
}
