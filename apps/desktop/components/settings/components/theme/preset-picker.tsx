"use client";

import type { FC } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  THEME_PRESET_LIST,
  THEME_PRESETS,
  presetGradient,
} from "@/lib/theme/presets";
import type { ThemePreset, ThemePresetName } from "@/lib/theme/types";

/** 渐变缩略条：浅底 → 强调色 → 深底 */
const PresetSwatch: FC<{ preset: ThemePreset; className?: string }> = ({
  preset,
  className,
}) => (
  <span
    className={className ?? "h-5 w-9"}
    style={{
      background: presetGradient(preset),
      borderRadius: 4,
      boxShadow: "inset 0 0 0 1px rgb(0 0 0 / 0.08)",
    }}
  />
);

/**
 * 主题预设选择器：触发器与下拉项都带渐变缩略条。
 * 自定义过前景/背景后，触发器追加「已自定义」提示，但仍显示当前预设。
 */
export const PresetPicker: FC<{
  value: ThemePresetName;
  customized: boolean;
  onChange: (value: ThemePresetName) => void;
}> = ({ value, customized, onChange }) => {
  const current = THEME_PRESETS[value] ?? THEME_PRESETS.kova;
  return (
    <Select
      value={value}
      onValueChange={(next) => next && onChange(next as ThemePresetName)}
    >
      <SelectTrigger size="sm" className="bg-background w-52 border">
        <SelectValue>
          <span className="flex min-w-0 items-center gap-2">
            <PresetSwatch preset={current} />
            <span className="truncate">
              {current.label}
              {customized && (
                <span className="text-muted-foreground"> · 已自定义</span>
              )}
            </span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="w-72">
        {THEME_PRESET_LIST.map((preset) => (
          <SelectItem key={preset.id} value={preset.id}>
            <span className="flex items-center gap-2.5 py-0.5">
              <PresetSwatch preset={preset} className="h-6 w-10 shrink-0" />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm">{preset.label}</span>
                <span className="text-muted-foreground truncate text-xs">
                  {preset.description}
                </span>
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
