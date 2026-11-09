"use client";

/**
 * 引导顶栏的语言切换：两个小段钮（中文 / EN），/welcome 与各步骤右上角常驻。
 * 写 ui.prefs.locale（lib/i18n），词典即时生效，不需要刷新——当前步骤文案
 * 随 useT 重渲染直接换语言。
 *
 * 顶栏是窗口拖拽区（data-drag-region="deep" 会把整棵子树的 mousedown 劫持成
 * 拖动），按钮必须显式标 "false" 退出，否则点不动（与「跳过」同款处理）。
 */
import type { FC } from "react";
import { cn } from "@/lib/utils";
import { useLocale, setLocalePref } from "@/lib/i18n";

export const LanguageToggle: FC = () => {
  const locale = useLocale();
  return (
    <div
      role="group"
      aria-label="Language"
      className="bg-muted/70 flex items-center rounded-full p-0.5"
    >
      {(
        [
          { value: "zh", label: "中文" },
          { value: "en", label: "EN" },
        ] as const
      ).map((opt) => {
        const active = locale === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            data-drag-region="false"
            aria-pressed={active}
            onClick={() => setLocalePref(opt.value)}
            className={cn(
              "rounded-full px-2 py-0.5 text-xs transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
};
