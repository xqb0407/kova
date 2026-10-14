"use client";
// 移植自 kova-search（web/src/components/charts/heat-calendar，上游 beui.dev/charts/heat-calendar），
// 改动仅为适配本仓库：cn 解析为产物中的工具函数、日期与图例文案改中文、色相默认取主题色。

import { cn } from "@/lib/utils";
import { HeatCalendarContext, useHeatCalendarModel } from "./heat-calendar/context";
import { HeatCalendarGrid } from "./heat-calendar/grid";
import { HeatCalendarLegend } from "./heat-calendar/legend";
import { HeatCalendarTooltip } from "./heat-calendar/tooltip";
import type { HeatCalendarProps } from "./heat-calendar/types";

/** 组合 Grid、Tooltip 与 Legend；不传 children 时给出完整图表。 */
export function HeatCalendar({ children, className, ...props }: HeatCalendarProps) {
  const model = useHeatCalendarModel(props);
  return (
    <HeatCalendarContext.Provider value={model}>
      <div className={cn("w-fit max-w-full", className)}>
        {children === undefined ? (
          <>
            <HeatCalendarGrid>
              <HeatCalendarTooltip />
            </HeatCalendarGrid>
            <HeatCalendarLegend />
          </>
        ) : (
          children
        )}
      </div>
    </HeatCalendarContext.Provider>
  );
}

export { useHeatCalendar } from "./heat-calendar/context";
export { HeatCalendarGrid } from "./heat-calendar/grid";
export { HeatCalendarLegend } from "./heat-calendar/legend";
export { HeatCalendarTooltip } from "./heat-calendar/tooltip";
export type { HeatCalendarCell, HeatCalendarProps, HeatCalendarSelection } from "./heat-calendar/types";
