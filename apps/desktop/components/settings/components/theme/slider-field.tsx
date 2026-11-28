"use client";

import type { FC } from "react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useThrottledCommit } from "./use-throttled-commit";

const firstNumber = (value: number | readonly number[]): number | null => {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "number" ? first : null;
};

/**
 * 设置页的滑杆控件：滑杆 + 左右刻度文案 + 当前值。
 * 拖动时只更新本地 preview（滑块和数值满帧），松手（onValueCommitted）
 * 才写 store 一次性应用主题；键盘步进会立即提交。
 */
export const SliderField: FC<{
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** 左/右刻度文案，例如「柔和 / 强烈」 */
  minLabel: string;
  maxLabel: string;
  /** 当前值的显示文案；用 preview 计算，拖动时不会落后 */
  formatValue?: (value: number) => string;
  className?: string;
}> = ({
  value,
  min,
  max,
  step = 1,
  onChange,
  minLabel,
  maxLabel,
  formatValue,
  className,
}) => {
  const { preview, schedule, commitNow } = useThrottledCommit(value, onChange);
  return (
    <div className={cn("w-56", className)}>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[preview]}
        onValueChange={(next) => {
          const first = firstNumber(next);
          if (first !== null) schedule(first);
        }}
        onValueCommitted={(next) => {
          const first = firstNumber(next);
          if (first !== null) commitNow(first);
        }}
      />
      <div className="text-muted-foreground mt-2 flex items-center justify-between text-ui leading-5">
        <span>{minLabel}</span>
        <span className="text-foreground tabular-nums">
          {formatValue ? formatValue(preview) : preview}
        </span>
        <span>{maxLabel}</span>
      </div>
    </div>
  );
};
