"use client";

import type { FC } from "react";
import { CheckIcon } from "lucide-react";
import type { ThemeMode } from "@/lib/settings/ui-prefs";
import type { ThemeColors } from "@/lib/theme/types";
import { cn } from "@/lib/utils";

/** 迷你界面缩略：用预设的底色/前景色画几条抽象内容，不依赖真实组件 */
const ThumbContent: FC<{ bg: string; fg: string; withDivider?: boolean }> = ({
  bg,
  fg,
  withDivider,
}) => (
  <div
    className={cn("relative h-full w-full p-1.5", withDivider && "border-r")}
    style={{ background: bg, borderColor: `${fg}22` }}
  >
    <div className="flex items-center gap-0.5">
      <span className="size-1 rounded-[1px]" style={{ background: fg, opacity: 0.7 }} />
      <span className="h-0.5 w-4 rounded-full" style={{ background: fg, opacity: 0.3 }} />
    </div>
    <div className="mt-1.5 h-0.5 w-3/4 rounded-full" style={{ background: fg, opacity: 0.22 }} />
    <div className="mt-1 h-0.5 w-1/2 rounded-full" style={{ background: fg, opacity: 0.15 }} />
    <div
      className="absolute inset-x-1 bottom-1 flex h-2 items-center rounded-[3px] px-0.5"
      style={{ background: fg, opacity: 0.09 }}
    >
      <span className="h-0.5 w-5 rounded-full" style={{ background: fg }} />
    </div>
  </div>
);

const MODE_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色模式" },
  { value: "dark", label: "深色模式" },
  { value: "system", label: "跟随系统" },
];

/** 明暗模式选择：三张紧凑的可视预览卡（跟随系统用左右分屏示意） */
export const ModeCards: FC<{
  value: ThemeMode;
  /** 浅/深两套实际生效的底色（已含用户覆盖） */
  light: ThemeColors;
  dark: ThemeColors;
  onChange: (value: ThemeMode) => void;
}> = ({ value, light, dark, onChange }) => (
  <div className="flex flex-wrap items-center gap-3">
    {MODE_OPTIONS.map((option) => {
      const active = option.value === value;
      return (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={active}
          className="group flex flex-col items-center gap-1.5 outline-none"
        >
          <div
            className={cn(
              "relative h-12 w-20 overflow-hidden rounded-lg border-2 transition-all",
              active
                ? "border-primary shadow-sm"
                : "border-border/80 group-hover:border-muted-foreground/40",
            )}
          >
            {option.value === "system" ? (
              <div className="grid h-full grid-cols-2">
                <ThumbContent
                  bg={light.background}
                  fg={light.foreground}
                  withDivider
                />
                <ThumbContent bg={dark.background} fg={dark.foreground} />
              </div>
            ) : (
              <ThumbContent
                bg={
                  option.value === "light"
                    ? light.background
                    : dark.background
                }
                fg={
                  option.value === "light"
                    ? light.foreground
                    : dark.foreground
                }
              />
            )}
            {active && (
              <span className="bg-primary text-primary-foreground absolute top-0.5 right-0.5 grid size-3.5 place-items-center rounded-full">
                <CheckIcon className="size-2" strokeWidth={3} />
              </span>
            )}
          </div>
          <span
            className={cn(
              "text-xs transition-colors",
              active
                ? "text-foreground font-medium"
                : "text-muted-foreground group-hover:text-foreground",
            )}
          >
            {option.label}
          </span>
        </button>
      );
    })}
  </div>
);
