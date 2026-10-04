"use client";

import { useCallback, useEffect, type FC } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  setUiPref,
  useUiPrefs,
  type AccentName,
  type ThemeMode,
} from "@/lib/settings/ui-prefs";
import { useOnboarding } from "../onboarding-flow";
import { StepFooter, StepHeading } from "./step-parts";
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

/**
 * 外观：主题（浅/深/跟随系统）+ 强调色。改的是 ui-prefs 那份 localStorage 偏好，
 * 与「设置 → 外观」同一份数据，applyPrefs 会即时生效，不需要重启。
 */

const THEMES: { value: ThemeMode; label: string; icon: FC<{ className?: string }> }[] = [
  { value: "system", label: "跟随系统", icon: MonitorIcon },
  { value: "light", label: "浅色", icon: SunIcon },
  { value: "dark", label: "深色", icon: MoonIcon },
];

/** 强调色预设：色值与 globals.css 的 :root[data-accent] --primary 保持一致 */
const ACCENTS: { value: AccentName; label: string; color: string | null }[] = [
  { value: "default", label: "默认（单色）", color: null },
  { value: "blue", label: "蓝色", color: "oklch(0.55 0.22 257)" },
  { value: "violet", label: "紫色", color: "oklch(0.55 0.21 292)" },
  { value: "green", label: "绿色", color: "oklch(0.55 0.16 155)" },
  { value: "orange", label: "橙色", color: "oklch(0.62 0.18 55)" },
  { value: "rose", label: "玫红", color: "oklch(0.58 0.21 350)" },
  { value: "periwinkle", label: "长春花蓝", color: "oklch(0.606 0.136 269)" },
];

export const AppearanceStep: FC = () => {
  const { next, back, patch } = useOnboarding();
  const prefs = useUiPrefs();

  // 主题与强调色都有默认值，走完这一步就算配过了；完成清单要显示成什么样
  const themeLabel = THEMES.find((t) => t.value === prefs.theme)?.label ?? "跟随系统";
  const accentLabel = ACCENTS.find((a) => a.value === prefs.accent)?.label ?? "默认（单色）";
  useEffect(() => {
    patch("appearance", { done: true, summary: `${themeLabel} · ${accentLabel}` });
  }, [patch, themeLabel, accentLabel]);

  const chooseTheme = useCallback((theme: ThemeMode) => {
    setUiPref("theme", theme);
  }, []);

  const chooseAccent = useCallback((accent: AccentName) => {
    setUiPref("accent", accent);
  }, []);

  return (
    <div className="flex flex-col">
      <StepHeading
        title="挑个顺眼的样子"
        desc="只是起点，之后在「设置 → 外观」里随时能改，浅深、字号、对话宽度都有。"
      />

      <div className="flex flex-col gap-5">
        <div>
          <div className="text-muted-foreground mb-2 text-xs">主题</div>
          <div className="grid grid-cols-3 gap-2">
            {THEMES.map((t) => {
              const active = prefs.theme === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => chooseTheme(t.value)}
                  className={cn(
                    "hover:bg-muted/70 flex h-16 flex-col items-center justify-center gap-1.5 rounded-2xl border text-sm transition-colors",
                    active && "border-primary/40 bg-muted/60",
                  )}
                >
                  <t.icon className="text-muted-foreground size-4" />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="text-muted-foreground mb-2 text-xs">强调色</div>
          <div className="flex flex-wrap items-center gap-3">
            {ACCENTS.map((accent) => {
              const active = prefs.accent === accent.value;
              return (
                <button
                  key={accent.value}
                  type="button"
                  title={accent.label}
                  aria-label={accent.label}
                  onClick={() => chooseAccent(accent.value)}
                  className={cn(
                    "relative size-8 rounded-full border border-black/10 transition-transform active:scale-90",
                    active && "scale-110 outline-2 outline-offset-2 outline-primary",
                  )}
                  style={
                    accent.color
                      ? { background: accent.color }
                      : {
                          background:
                            "linear-gradient(135deg, var(--color-foreground) 50%, var(--color-muted-foreground) 50%)",
                        }
                  }
                >
                  {active && (
                    <CheckIcon className="absolute inset-0 m-auto size-3.5 text-white mix-blend-difference" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <StepFooter onBack={back} onSkip={next}>
        <Button onClick={next}>下一步</Button>
      </StepFooter>
    </div>
  );
};
