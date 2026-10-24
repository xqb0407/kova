"use client";

/**
 * 时间选择器（custom-ui，基于 shadcn Popover + Button）：替代原生 input[type=time]。
 *
 * 触发器显示 HH:mm；浮层内小时/分钟两列可滚动点选，点选即回吐，没有确认步——
 * 与原生控件一样「改完即生效」。打开时把已选值滚到列中部，免得每次从 00 翻起。
 */

import { useLayoutEffect, useRef, type FC, type RefObject } from "react";
import { ClockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

const pad = (n: number) => String(n).padStart(2, "0");

/** "HH:mm" → 数值；越界/非法一律落回默认值，避免浮层里出现 NaN 行 */
function parsePart(raw: string | undefined, max: number, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
}

const Column: FC<{
  label: string;
  values: number[];
  value: number;
  listRef: RefObject<HTMLDivElement | null>;
  onSelect: (v: number) => void;
  isDisabled?: (v: number) => boolean;
  /** 撑满所在容器高度（日期时间浮层里跟月历等高，不留底部空白） */
  fill?: boolean;
}> = ({ label, values, value, listRef, onSelect, isDisabled, fill }) => (
  <div className="flex min-h-0 min-w-0 flex-col">
    <span className="text-muted-foreground px-1.5 py-1 text-center text-xs whitespace-nowrap">
      {label}
    </span>
    <div
      ref={listRef}
      className={cn(
        "relative overflow-y-auto px-1 pb-1",
        fill ? "min-h-0 flex-1" : "h-52",
      )}
    >
      {values.map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          disabled={isDisabled?.(v)}
          onClick={() => onSelect(v)}
          className={cn(
            "h-7 w-full rounded-md text-sm tabular-nums transition-colors disabled:pointer-events-none disabled:opacity-30",
            v === value
              ? "bg-selected text-foreground font-medium"
              : "text-muted-foreground hover:bg-hover hover:text-foreground",
          )}
        >
          {pad(v)}
        </button>
      ))}
    </div>
  </div>
);

export const TimeColumns: FC<{
  hour: number;
  minute: number;
  onCommit: (hour: number, minute: number) => void;
  /** 今天可选的最早时刻：小于该小时整列禁用；等于该小时时，更早的分钟禁用 */
  earliest?: { hour: number; minute: number };
  /** 撑满容器高度（与左侧月历等高），浮层底部不留空白 */
  fill?: boolean;
}> = ({ hour, minute, onCommit, earliest, fill }) => {
  const hourListRef = useRef<HTMLDivElement>(null);
  const minuteListRef = useRef<HTMLDivElement>(null);

  // 挂载即滚到当前值（PopoverContent 关闭即卸载，每次打开都是新挂载）
  useLayoutEffect(() => {
    for (const list of [hourListRef.current, minuteListRef.current]) {
      if (!list) continue;
      const selected = list.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (selected) {
        list.scrollTop =
          selected.offsetTop - list.clientHeight / 2 + selected.clientHeight / 2;
      }
    }
  }, []);

  return (
    <div className={cn("grid grid-cols-2 gap-1 p-1", fill && "h-full")}>
      <Column
        label="小时"
        values={HOURS}
        value={hour}
        listRef={hourListRef}
        onSelect={(h) => onCommit(h, minute)}
        isDisabled={(h) => earliest != null && h < earliest.hour}
        fill={fill}
      />
      <Column
        label="分钟"
        values={MINUTES}
        value={minute}
        listRef={minuteListRef}
        onSelect={(m) => onCommit(hour, m)}
        isDisabled={(m) =>
          earliest != null &&
          (hour < earliest.hour ||
            (hour === earliest.hour && m < earliest.minute))
        }
        fill={fill}
      />
    </div>
  );
};

export type TimePickerProps = {
  /** "HH:mm" */
  value: string;
  onChange: (next: string) => void;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
};

export const TimePicker: FC<TimePickerProps> = ({
  value,
  onChange,
  className,
  disabled,
  "aria-label": ariaLabel,
}) => {
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = parsePart(hourRaw, 23, 9);
  const minute = parsePart(minuteRaw, 59, 0);
  const text = `${pad(hour)}:${pad(minute)}`;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={disabled}
            aria-label={ariaLabel ?? `时间 ${text}`}
            className={cn(
              "w-32 justify-start gap-2 px-3 font-normal tabular-nums",
              className,
            )}
          >
            <ClockIcon className="text-muted-foreground size-3.5" />
            {text}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-42 gap-0 p-0">
        <TimeColumns
          hour={hour}
          minute={minute}
          onCommit={(h, m) => onChange(`${pad(h)}:${pad(m)}`)}
        />
      </PopoverContent>
    </Popover>
  );
};
