"use client";

import { type FC } from "react";
import { CodeMirrorCode } from "@/components/code/cm-code";
import {
  CODE_THEME_DARK_OPTIONS,
  CODE_THEME_LIGHT_OPTIONS,
} from "@/lib/markdown/code-theme";
import { useHtmlDark } from "@/lib/settings/use-html-dark";
import { useUiPrefs, type CodeThemeName } from "@/lib/settings/ui-prefs";
import { cn } from "@/lib/utils";

/** 预览示例：一小段带类型/字符串/数字的 TS，覆盖常见高亮元素 */
const SAMPLE = `const themePreview: ThemeConfig = {
  surface: "sidebar",
  accent: "#339CFF",
  contrast: 45,
};`;

function themeLabel(
  options: { value: CodeThemeName; label: string }[],
  value: CodeThemeName,
): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

const PreviewCard: FC<{
  title: string;
  themeName: string;
  active: boolean;
  forceDark: boolean;
}> = ({ title, themeName, active, forceDark }) => (
  <div className="bg-card rounded-xl border border-border/60 p-3">
    <div className="mb-2 flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-muted-foreground truncate text-xs">{themeName}</div>
      </div>
      <span
        className={cn(
          "shrink-0 rounded-md px-2 py-0.5 text-xs",
          active
            ? "bg-muted text-foreground font-medium"
            : "bg-muted/50 text-muted-foreground",
        )}
      >
        {active ? "当前生效" : forceDark ? "深色" : "浅色"}
      </span>
    </div>
    <div className="overflow-hidden rounded-lg border border-border/40">
      <CodeMirrorCode value={SAMPLE} path="theme-preview.ts" forceDark={forceDark} />
    </div>
  </div>
);

/**
 * 代码预览：同时渲染浅色与深色两套主题（forceDark 固定各自配色，
 * 不跟随界面），当前界面实际生效的一侧标记"当前生效"。
 */
export const CodeThemePreview: FC = () => {
  const prefs = useUiPrefs();
  const dark = useHtmlDark();
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <PreviewCard
        title="浅色预览"
        themeName={themeLabel(CODE_THEME_LIGHT_OPTIONS, prefs.codeThemeLight)}
        active={!dark}
        forceDark={false}
      />
      <PreviewCard
        title="深色预览"
        themeName={themeLabel(CODE_THEME_DARK_OPTIONS, prefs.codeThemeDark)}
        active={dark}
        forceDark
      />
    </div>
  );
};
