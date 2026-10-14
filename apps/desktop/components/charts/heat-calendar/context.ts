"use client";

import { useReducedMotion } from "motion/react";
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useHoverCapable } from "@/lib/hooks/use-hover-capable";
import type { HeatCalendarCell, HeatCalendarProps, HeatCalendarSelection } from "./types";
import { addDays, CELL, EMPTY, fmtMonth, GAP, MONTH_ROW, mondayOf, PITCH, STEPS, startOfDay } from "./utils";

/**
 * 一年的活跃度网格：单一色相的深浅表示量级，月份标签替眼睛定位日期，
 * 不需要图例也能读出数。格子沿对角线波浪式入场；悬浮一格时它和邻格轻微抬起，
 * tooltip 跟着滑到该格并给出日期与准确计数；点击钉住该格，
 * 触屏和键盘因此也能读到同样的读数；钉住后网格变暗、悬浮即预览
 * 「从钉子到指针」这段区间的合计，第二次点击锁定、第三次清除；悬浮图例某一级
 * 可把网格过滤成只剩该强度。抬起效果只在真有悬浮能力的设备上生效，
 * 减弱动效时只保留淡入淡出。
 */
export function useHeatCalendarModel({
  unit = "commits",
  weeks = 16,
  maxCount = 14,
  values,
  endDate,
  color = "var(--primary)",
  selection: controlledSelection,
  defaultSelection = null,
  onSelectionChange,
}: HeatCalendarProps) {
  const reduce = useReducedMotion();
  const canHover = useHoverCapable();
  const [storedHover, setHover] = useState<HeatCalendarCell | null>(null);
  const [internalSelection, setInternalSelection] = useState(defaultSelection);
  const requestedSelection = controlledSelection === undefined ? internalSelection : controlledSelection;
  const setSelection = (next: HeatCalendarSelection | null) => {
    if (controlledSelection === undefined) setInternalSelection(next);
    onSelectionChange?.(next);
  };
  const gridRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [step, setStep] = useState<number | null>(null);
  // 入场波浪落地前由它控制格子，落地后换成悬浮涟漪
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), reduce ? 0 : (weeks + 7) * 18 + 500);
    return () => clearTimeout(t);
  }, [weeks, reduce]);

  // “今天”在挂载后才读：服务端与另一个日期的访客必须产出同一份 HTML，
  // 于是网格先渲染、日期随后在客户端填充；显式传入 endDate 则不经过这一步。
  const [today, setToday] = useState<Date | null>(null);
  useEffect(() => setToday(startOfDay(new Date())), []);
  const end = useMemo(() => (endDate ? startOfDay(endDate) : today), [endDate, today]);
  const start = useMemo(() => (end ? addDays(mondayOf(end), -(weeks - 1) * 7) : null), [end, weeks]);

  const level = (w: number, d: number) => Math.max(0, Math.min(1, values?.[w]?.[d] ?? 0));
  const bucket = (v: number) => Math.min(4, Math.floor(v * 5));
  const fill = (b: number) => (b === 0 ? EMPTY : `color-mix(in srgb, ${color} ${STEPS[b]}%, transparent)`);
  const count = (v: number) => Math.round(v * maxCount);
  const dateOf = (w: number, d: number) => (start ? addDays(start, w * 7 + d) : null);
  const future = (w: number, d: number) => {
    const date = dateOf(w, d);
    return end !== null && date !== null && date > end;
  };

  const validCell = (cell: HeatCalendarCell) =>
    Number.isInteger(cell.w) &&
    Number.isInteger(cell.d) &&
    cell.w >= 0 &&
    cell.w < weeks &&
    cell.d >= 0 &&
    cell.d < 7 &&
    !future(cell.w, cell.d);
  const selection =
    requestedSelection &&
    validCell(requestedSelection.start) &&
    (!requestedSelection.end || validCell(requestedSelection.end))
      ? requestedSelection
      : null;
  if (requestedSelection && !selection && controlledSelection === undefined) setInternalSelection(null);
  const pinned = selection?.start ?? null;
  const spanEnd = selection?.end ?? null;
  const hover = storedHover && validCell(storedHover) ? storedHover : null;
  if (storedHover && !hover) setHover(null);

  // 每月一个标签，落在该月的第一列；若下个月在两周内就开始，则让出首位，
  // 保证两个标签不会叠在一起
  const cols = useMemo(() => {
    const list = Array.from({ length: weeks }, (_, w) => {
      const date = start ? addDays(start, w * 7) : null;
      const m = date ? date.getUTCMonth() : -1;
      const fresh =
        start !== null && date !== null && (w === 0 || addDays(start, (w - 1) * 7).getUTCMonth() !== m);
      return { id: `w${w}`, w, m, label: fresh && date ? fmtMonth.format(date) : null };
    });
    if (list[1]?.label || list[2]?.label) list[0].label = null;
    return list;
  }, [start, weeks]);

  // 一次点击把某格钉成区间起点并让其余格子变暗；随后悬浮会预览从该格到指针的
  // 区间并实时合计，第二次点击锁定区间（指针移开数字仍留在屏幕上）
  const idx = (c: HeatCalendarCell) => c.w * 7 + c.d;
  const clear = () => {
    setSelection(null);
  };
  const spanTo = spanEnd ?? (pinned ? (hover ?? pinned) : null);
  const span =
    pinned && spanTo
      ? { lo: Math.min(idx(pinned), idx(spanTo)), hi: Math.max(idx(pinned), idx(spanTo)) }
      : null;
  let spanTotal = 0;
  if (span) {
    for (let i = span.lo; i <= span.hi; i++) {
      if (future(Math.floor(i / 7), i % 7)) break;
      spanTotal += count(level(Math.floor(i / 7), i % 7));
    }
  }
  const select = (cell: HeatCalendarCell) => {
    // 已锁定的区间在任意处再点一次即清除，离开它只需一次按压
    if (spanEnd) {
      clear();
    } else if (pinned && idx(pinned) === idx(cell)) {
      setSelection(null);
    } else if (pinned) {
      setSelection({ start: pinned, end: cell });
    } else {
      setSelection({ start: cell });
    }
  };
  /** 网格真正回应的格子：抬起、涟漪和月份高亮都跟随指针 */
  const hot = hover ?? spanEnd ?? pinned;
  /** tooltip 挂靠的格子：区间锁定后停在它的终点 */
  const tip = spanEnd ?? hover ?? pinned;
  const tipDate = tip ? dateOf(tip.w, tip.d) : null;
  const hotMonth = hot ? (dateOf(hot.w, hot.d)?.getUTCMonth() ?? null) : null;
  const tipX = tip ? tip.w * PITCH + CELL / 2 : 0;
  const tipY = tip ? MONTH_ROW + GAP + tip.d * PITCH : 0;
  const tooltip =
    tip && tipDate
      ? {
          date: tipDate,
          count: count(level(tip.w, tip.d)),
          total: spanTotal,
          startDate: start && span ? addDays(start, span.lo) : tipDate,
          endDate: start && span ? addDays(start, span.hi) : tipDate,
          days: span ? span.hi - span.lo + 1 : 1,
        }
      : null;

  return {
    unit,
    weeks,
    reduce,
    canHover,
    hover,
    pinned,
    spanEnd,
    step,
    setStep,
    settled,
    start,
    end,
    level,
    bucket,
    fill,
    count,
    dateOf,
    future,
    cols,
    clear,
    span,
    spanTotal,
    select,
    hot,
    tip,
    tipDate,
    hotMonth,
    tipX,
    tipY,
    setHover,
    gridRef,
    tooltipId,
    tooltip,
    selection,
    setSelection,
  };
}

export const HeatCalendarContext = createContext<ReturnType<typeof useHeatCalendarModel> | null>(null);

/** 在 HeatCalendar 的任意后代里读取共享数据与选中态。 */
export function useHeatCalendar() {
  const context = useContext(HeatCalendarContext);
  if (!context) throw new Error("HeatCalendar parts must be inside HeatCalendar");
  return context;
}
