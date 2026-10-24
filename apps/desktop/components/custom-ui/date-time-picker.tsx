"use client";

/**
 * 日期时间选择器（custom-ui，基于 shadcn Popover + Button）：替代原生
 * input[type=datetime-local]。
 *
 * 值为本地时区的 "YYYY-MM-DDTHH:mm"；浮层左侧月历、右侧小时/分钟两列，
 * 点日期保留当前时刻、点时刻保留当前日期，改完即回吐，没有确认步。
 * 无值时触发器显示占位文案，内部以「此刻之后最近的整分钟」为起点，
 * 且过去的日期与时刻不可选（sidecar 校验会拒绝已过去的一次性时间）。
 */

import { useState, type FC } from "react";
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TimeColumns } from "@/components/custom-ui/time-picker";
import { cn } from "@/lib/utils";

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const;

const pad = (n: number) => String(n).padStart(2, "0");
const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();
const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

/** 此刻之后最近的整数分钟（+1 分钟抹掉秒）；跨天时日期一并后移。
 *  既做空值起点，也做「今天还剩不剩可选刻度」的判断依据 */
function nextSlot(now = new Date()): { date: Date; hour: number; minute: number } {
  const d = new Date(now.getTime() + 60_000);
  d.setSeconds(0, 0);
  return { date: startOfDay(d), hour: d.getHours(), minute: d.getMinutes() };
}

/** 组合日期+时刻；日期早于今天就先归到今天（过期值只可能来自外部数据） */
function slotOn(date: Date, hour: number, minute: number) {
  const today = startOfDay(new Date());
  const base = date.getTime() < today.getTime() ? today : date;
  return {
    date: base,
    at: new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      hour,
      minute,
    ),
  };
}

/** 点日期：日期以点的为准，时刻若当天已过去就顶到最近可用刻度。
 *  （不能改成「顺延到次日同一时刻」，否则点「今天」会跳到明天、再点还跳） */
function pickDate(date: Date, hour: number, minute: number) {
  const { date: base, at } = slotOn(date, hour, minute);
  if (at.getTime() > Date.now()) return { date: base, hour, minute };
  return nextSlot();
}

/** 点时刻：时刻以点的为准，日期若已过去就归到今天；该时刻今天已过则取次日同一时刻。
 *  保证点选后不会立刻报「Scheduled time is in the past」 */
function pickTime(date: Date, hour: number, minute: number) {
  const { date: base, at } = slotOn(date, hour, minute);
  if (at.getTime() > Date.now()) return { date: base, hour, minute };
  return {
    date: new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1),
    hour,
    minute,
  };
}

/** "YYYY-MM-DDTHH:mm" → Date + 时刻；空值/非法值回落到最近的可用刻度 */
function parseValue(value: string): { date: Date; hour: number; minute: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return nextSlot();
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return { date, hour: Number(m[4]), minute: Number(m[5]) };
}

/** 固定 6 行月历（含上/下月补位），避免换月时浮层高度跳动 */
function monthCells(year: number, month: number): Date[] {
  const offset = new Date(year, month, 1).getDay();
  return Array.from(
    { length: 42 },
    (_, i) => new Date(year, month, i - offset + 1),
  );
}

export type DateTimePickerProps = {
  /** 本地时区 "YYYY-MM-DDTHH:mm"，空串表示未选 */
  value: string;
  onChange: (next: string) => void;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
};

export const DateTimePicker: FC<DateTimePickerProps> = ({
  value,
  onChange,
  className,
  disabled,
  "aria-label": ariaLabel,
}) => {
  const { date, hour, minute } = parseValue(value);
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(date));

  // 每次打开都从当前值定位月份：外部快捷项（10 分钟后等）会改 value。
  // 值已过期时落在当前月，否则会正对一个整月全灰的日历
  const handleOpenChange = (next: boolean) => {
    if (next) setViewMonth(startOfMonth(pickDate(date, hour, minute).date));
    setOpen(next);
  };

  const commitTime = (nextHour: number, nextMinute: number) => {
    // 点小时会沿用当前分钟，可能拼出已过去的时刻，统一钳制到最近可用刻度
    const time = pickTime(date, nextHour, nextMinute);
    setViewMonth(startOfMonth(time.date));
    onChange(`${fmtDate(time.date)}T${pad(time.hour)}:${pad(time.minute)}`);
  };

  const commitDate = (next: Date) => {
    const time = pickDate(next, hour, minute);
    setViewMonth(startOfMonth(time.date));
    onChange(`${fmtDate(time.date)}T${pad(time.hour)}:${pad(time.minute)}`);
  };

  const cells = monthCells(viewMonth.getFullYear(), viewMonth.getMonth());
  const today = startOfDay(new Date());
  const next = nextSlot();
  // 今天还剩可选刻度（23:59 过后当天整列灰掉，无处可选）
  const hasFutureToday = sameDay(next.date, today);
  const isTodaySelected = value !== "" && sameDay(date, today);
  // 选中今天时禁用已经过去的时刻，避免提交即报「Scheduled time is in the past」
  const earliest =
    isTodaySelected && hasFutureToday
      ? { hour: next.hour, minute: next.minute }
      : undefined;
  const text = value ? `${fmtDate(date)} ${pad(hour)}:${pad(minute)}` : "";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={disabled}
            aria-label={ariaLabel ?? `运行时间 ${text || "未选择"}`}
            className={cn(
              "w-52 justify-start gap-2 px-3 font-normal tabular-nums",
              className,
            )}
          >
            <CalendarIcon className="text-muted-foreground size-3.5" />
            {value ? (
              text
            ) : (
              <span className="text-muted-foreground">选择日期时间</span>
            )}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-93 gap-0 p-0">
        {/* 右侧时刻列绝对定位贴住浮层上下缘：高度由月历自然撑出，
            列表用 flex-1 填满，不会在底部留白或反向撑高浮层 */}
        <div className="relative">
          <div className="w-65 p-3">
            <div className="mb-2 flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="上个月"
                onClick={() =>
                  setViewMonth(
                    new Date(
                      viewMonth.getFullYear(),
                      viewMonth.getMonth() - 1,
                      1,
                    ),
                  )
                }
              >
                <ChevronLeftIcon />
              </Button>
              <span className="text-sm font-medium tabular-nums">
                {viewMonth.getFullYear()}年{viewMonth.getMonth() + 1}月
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="下个月"
                onClick={() =>
                  setViewMonth(
                    new Date(
                      viewMonth.getFullYear(),
                      viewMonth.getMonth() + 1,
                      1,
                    ),
                  )
                }
              >
                <ChevronRightIcon />
              </Button>
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {WEEKDAY_LABELS.map((label) => (
                <span
                  key={label}
                  className="text-muted-foreground grid size-8 place-items-center text-xs"
                >
                  {label}
                </span>
              ))}
              {cells.map((cell) => {
                const inMonth = cell.getMonth() === viewMonth.getMonth();
                const selected = value !== "" && sameDay(cell, date);
                const past =
                  startOfDay(cell).getTime() < today.getTime() ||
                  (sameDay(cell, today) && !hasFutureToday);
                return (
                  <button
                    key={fmtDate(cell)}
                    type="button"
                    aria-label={fmtDate(cell)}
                    aria-pressed={selected}
                    disabled={past}
                    onClick={() => commitDate(cell)}
                    className={cn(
                      "size-8 rounded-md text-xs tabular-nums transition-colors disabled:pointer-events-none disabled:opacity-25",
                      selected
                        ? "bg-primary text-primary-foreground font-medium"
                        : inMonth
                          ? "hover:bg-hover"
                          : "text-muted-foreground/40 hover:bg-hover",
                      !selected &&
                        sameDay(cell, today) &&
                        "text-foreground ring-1 ring-primary/30",
                    )}
                  >
                    {cell.getDate()}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="absolute inset-y-0 inset-e-0 flex w-28 flex-col border-s p-1">
            <TimeColumns
              hour={hour}
              minute={minute}
              onCommit={commitTime}
              earliest={earliest}
              fill
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
