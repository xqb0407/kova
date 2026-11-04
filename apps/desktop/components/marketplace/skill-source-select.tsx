"use client";

/**
 * 技能源切换控件：由 skill-market-toolbar 统一摆在工具行右端（刷新按钮左侧），
 * 不单独占一行 tabs。选择本身持久化在 skill-market.tsx 的包装层。
 */

import type { FC } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SkillSource = "kovahub" | "clawhub" | "github";

const SOURCE_OPTIONS: { value: SkillSource; label: string }[] = [
  { value: "kovahub", label: "KovaHub" },
  { value: "clawhub", label: "ClawHub" },
  { value: "github", label: "GitHub 仓库" },
];

export const SkillSourceSelect: FC<{
  value: SkillSource;
  onChange: (value: SkillSource) => void;
  className?: string;
}> = ({ value, onChange, className }) => (
  <Select
    value={value}
    onValueChange={(next) => {
      if (next === "kovahub" || next === "clawhub" || next === "github")
        onChange(next);
    }}
    items={SOURCE_OPTIONS}
  >
    <SelectTrigger
      size="sm"
      className={cn("h-8 w-32 border bg-background", className)}
      title="切换技能来源"
      aria-label="切换技能来源"
    >
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {SOURCE_OPTIONS.map((option) => (
        <SelectItem key={option.value} value={option.value}>
          {option.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);
