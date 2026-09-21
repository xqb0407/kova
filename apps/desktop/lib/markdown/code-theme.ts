/**
 * 代码主题配置中枢（「外观 → 代码设置」的单一事实源）：
 * - codeThemeExtension：CodeMirror 侧（设置页代码预览 / 后续文件预览）；
 * - DIFF_SHIKI_THEME：@pierre/diffs 侧（右侧面板 git diff）的 Shiki 主题名映射。
 * 两套渲染引擎共用同一份三选档位，每个主题都是浅/深一对，跟随 .dark 类
 * 切换（由 ui-prefs 落到 html 根元素）。
 */
import { type Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { createTheme } from "@uiw/codemirror-themes";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import { tags as t } from "@lezer/highlight";
import type { CodeThemeName, UiPrefs } from "../settings/ui-prefs";

export const CODE_THEME_LIGHT_OPTIONS: { value: CodeThemeName; label: string }[] =
  [
    { value: "default", label: "GitHub Light" },
    { value: "vscode", label: "VS Code Light" },
    { value: "idea", label: "IntelliJ Light" },
  ];

export const CODE_THEME_DARK_OPTIONS: { value: CodeThemeName; label: string }[] =
  [
    { value: "default", label: "GitHub Dark" },
    { value: "vscode", label: "VS Code Dark+" },
    { value: "idea", label: "IntelliJ Darcula" },
  ];

/** 按当前深浅态取生效的代码主题档位 */
export function resolveCodeThemeName(
  prefs: Pick<UiPrefs, "codeThemeLight" | "codeThemeDark">,
  dark: boolean,
): CodeThemeName {
  return dark ? prefs.codeThemeDark : prefs.codeThemeLight;
}

/** 按文件路径懒加载语言扩展（未命中返回空数组 = 纯文本）；结果缓存 */
const langCache = new Map<string, Promise<Extension[]>>();
export function languageForPath(path: string): Promise<Extension[]> {
  const name = path.split(/[\\/]/).pop() ?? path;
  let pending = langCache.get(name);
  if (!pending) {
    pending = (async () => {
      const desc = LanguageDescription.matchFilename(languages, name);
      if (!desc) return [];
      const support = await desc.load();
      return [support];
    })();
    langCache.set(name, pending);
  }
  return pending;
}

/** IntelliJ Light：官方配色近似值（无现成 CM6 移植包） */
const ideaLight = createTheme({
  theme: "light",
  settings: {
    background: "#ffffff",
    foreground: "#080808",
    caret: "#000000",
    selection: "#add9ff",
    selectionMatch: "#d5e8ff",
    gutterBackground: "#f2f2f2",
    gutterForeground: "#a8a8a8",
    gutterBorder: "#ebebeb",
  },
  styles: [
    { tag: t.comment, color: "#808080" },
    { tag: [t.keyword, t.modifier, t.bool], color: "#0033b3" },
    { tag: t.string, color: "#067d17" },
    { tag: t.number, color: "#1750eb" },
    { tag: t.function(t.variableName), color: "#00627a" },
    { tag: t.propertyName, color: "#871094" },
    { tag: [t.className, t.typeName], color: "#000000", fontWeight: "bold" },
    { tag: t.operator, color: "#000000" },
  ],
});

/** Darcula：官方配色近似值 */
const ideaDark = createTheme({
  theme: "dark",
  settings: {
    background: "#2b2b2b",
    foreground: "#a9b7c6",
    caret: "#bbbbbb",
    selection: "#214283",
    selectionMatch: "#214283",
    gutterBackground: "#313335",
    gutterForeground: "#606366",
    gutterBorder: "#393b3d",
  },
  styles: [
    { tag: t.comment, color: "#808080" },
    { tag: [t.keyword, t.modifier, t.bool], color: "#cc7832" },
    { tag: t.string, color: "#6a8759" },
    { tag: t.number, color: "#6897bb" },
    { tag: t.function(t.variableName), color: "#ffc66d" },
    { tag: t.propertyName, color: "#9876aa" },
    { tag: [t.className, t.typeName], color: "#a9b7c6" },
    { tag: t.operator, color: "#cc7832" },
  ],
});

export function codeThemeExtension(
  name: CodeThemeName,
  dark: boolean,
): Extension {
  switch (name) {
    case "vscode":
      return dark ? vscodeDark : vscodeLight;
    case "idea":
      return dark ? ideaDark : ideaLight;
    case "default":
    default:
      return dark ? githubDark : githubLight;
  }
}

/**
 * 「代码主题」三选 → @pierre/diffs（Shiki 主题名，右侧面板 git diff 用）。
 * hernessX 同款渲染引擎。Shiki 没有 Darcula，idea 档取其官方插件家族的
 * Material 主题近似；vscode 档用 dark-plus/light-plus（VS Code 官方移植，
 * 比 CM 仿制版更正）。
 */
export const DIFF_SHIKI_THEME: Record<
  CodeThemeName,
  { light: string; dark: string }
> = {
  default: { light: "github-light", dark: "github-dark" },
  vscode: { light: "light-plus", dark: "dark-plus" },
  idea: { light: "material-theme-lighter", dark: "material-theme" },
};
