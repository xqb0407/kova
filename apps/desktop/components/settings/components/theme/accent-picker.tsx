"use client";

import { useState, type FC } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ACCENT_PRESETS } from "@/lib/theme/presets";
import type { AccentName } from "@/lib/theme/types";
import { cn } from "@/lib/utils";
import { ColorField } from "./color-field";
import { useT } from "@/lib/i18n";


/**
 * 强调色：命名色点 + 任意自定义色。
 * 自定义色优先于命名色；色点在选中态用外环标记，自定义入口用彩虹环示意。
 */
export const AccentPicker: FC<{
  value: AccentName;
  custom: string | null;
  /** 「默认」色点展示当前主题预设的强调色；主题无强调色时用单色斜切 */
  presetAccent?: string | null;
  onSelect: (value: AccentName) => void;
  onCustom: (hex: string | null) => void;
}> = ({ value, custom, presetAccent, onSelect, onCustom }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const customActive = !!custom;
  const customPreview = custom ?? "conic-gradient(from 210deg, #f87171, #fbbf24, #4ade80, #38bdf8, #a78bfa, #f472b6, #f87171)";

  return (
    <div className="flex items-center gap-1.5">
      {ACCENT_PRESETS.map((accent) => {
        const active = !customActive && accent.value === value;
        return (
          <button
            key={accent.value}
            type="button"
            title={accent.label}
            aria-label={accent.label}
            aria-pressed={active}
            onClick={() => onSelect(accent.value)}
            className={cn(
              "size-5 rounded-full border border-black/10 transition-transform enabled:active:scale-[0.96]",
              active && "scale-110 outline-2 outline-offset-2 outline-primary",
            )}
            style={
              accent.color
                ? { background: accent.color }
                : accent.value === "default" && presetAccent
                  ? { background: presetAccent }
                  : {
                      background:
                        "linear-gradient(135deg, var(--color-foreground) 50%, var(--color-muted-foreground) 50%)",
                    }
            }
          />
        );
      })}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              title={t("settings.appearance.accentCustom")}
              aria-label={t("settings.appearance.accentCustom")}
              className={cn(
                "size-5 rounded-full border border-border/30  transition-transform enabled:active:scale-[0.96]",
                customActive && "scale-110 outline-2 outline-offset-2 outline-primary",
              )}
              style={{ background: customPreview }}
            />
          }
        />
        <PopoverContent align="end" className="min-w-64 p-3">
          <div className="text-sm font-medium">{t("settings.appearance.accentCustom")}</div>
          <p className="text-muted-foreground mt-1 text-[13px] leading-5">
            {t("settings.appearance.accentCustomDesc")}
          </p>
          <ColorField
            value={custom ?? "#3b82f6"}
            overridden={customActive}
            onChange={(hex) => onCustom(hex)}
            onReset={() => onCustom(null)}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
};
