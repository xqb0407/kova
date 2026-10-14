import type { ReactNode } from "react";

/** 单元格坐标：列（周）与行（日），均零基，行 0 = 周一。 */
export type HeatCalendarCell = { w: number; d: number };

export interface HeatCalendarSelection {
  start: HeatCalendarCell;
  end?: HeatCalendarCell;
}

export interface HeatCalendarProps {
  /** 计数单位名词，跟在数字后面，如 "tokens"、"次"。 */
  unit?: string;
  /** 周列数。 */
  weeks?: number;
  /** 强度 1 的格子代表的计数；格子读数 = 强度 × maxCount。 */
  maxCount?: number;
  /** `values[周][日]` 强度 0~1，每列 7 天，缺省按 0 处理。 */
  values?: number[][];
  /** 网格最后一天。缺省为挂载后的今天；显式传入则各时区渲染一致。 */
  endDate?: Date;
  /** 单一色相：任意 CSS 颜色，深浅只表示量级，不引入第二种颜色。 */
  color?: string;
  className?: string;
  children?: ReactNode;
  /** 受控选中；传 null 清除。坐标为零基的 周/日（周一开头）。 */
  selection?: HeatCalendarSelection | null;
  defaultSelection?: HeatCalendarSelection | null;
  onSelectionChange?: (selection: HeatCalendarSelection | null) => void;
}
