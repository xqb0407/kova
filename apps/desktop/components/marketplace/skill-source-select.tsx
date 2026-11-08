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
import { useT } from "@/lib/i18n";

export type SkillSource = "kovahub" | "clawhub" | "github";

const SOURCE_OPTIONS: { value: SkillSource; labelKey: string }[] = [
  { value: "kovahub", labelKey: "marketplace.source.kovahub" },
  { value: "clawhub", labelKey: "marketplace.source.clawhub" },
  { value: "github", labelKey: "marketplace.source.githubRepo" },
];

export const SkillSourceSelect: FC<{
  value: SkillSource;
  onChange: (value: SkillSource) => void;
  className?: string;
}> = ({ value, onChange, className }) => {
  const t = useT();
  const items = SOURCE_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next === "kovahub" || next === "clawhub" || next === "github")
          onChange(next);
      }}
      items={items}
    >
      <SelectTrigger
        size="sm"
        className={cn("h-8 w-32 border bg-background", className)}
        title={t("marketplace.source.switch")}
        aria-label={t("marketplace.source.switch")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
