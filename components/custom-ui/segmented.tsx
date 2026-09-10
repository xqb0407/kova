"use client";

import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
};

/**
 * 分段选择器：胶囊容器内互斥单选，激活段以主色（--primary）高亮。
 * 泛型 T 由 options 的字面量值推断，onChange 直接回传具体联合类型。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-background/70 flex shrink-0 items-center gap-0.5 rounded-full border-[0.5] p-0.5",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => !active && onChange(opt.value)}
            data-active={active}
            className={cn(
              "h-7 rounded-full px-3 text-xs transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-60",
              // 按状态显式给类，避免 hover: 与 data-active:（以及两个 hover 背景）
              // 之间的变体排序不可控，选中段悬浮时出现主色底配近黑前景（黑底黑字）
              active
                ? "bg-primary text-primary-foreground hover:bg-primary/80"
                : "text-muted-foreground hover:bg-primary/10",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
