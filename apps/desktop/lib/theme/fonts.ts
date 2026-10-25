/**
 * 字体档位目录（外观设置 · UI 字体 / 代码字体共用）。
 *
 * UI 字体沿用 globals.css `:root[data-font]` 的档位：value 即 data-font，
 * stack 用于下拉触发器与选项的即时预览。
 * 代码字体只在这里维护一份，最终落到 html 的 --app-font-mono；CodeMirror、
 * diff、终端都消费同一个变量。
 */
export type FontFamilyName =
  | "default"
  | "inter"
  | "segoe"
  | "yahei"
  | "roboto"
  | "open-sans"
  | "noto-sans-sc"
  | "serif"
  | "noto-serif-sc"
  | "kai"
  | "wenkai"
  | "mono"
  | "jetbrains";

/** 代码字体："theme" = 跟随主题预设，其余为具体字体栈 */
export type CodeFontFamilyName = "theme" | "jetbrains" | "cascadia" | "mono";

export type FontOption<T extends string> = {
  value: T;
  label: string;
  stack: string;
};

/** 默认代码字体栈：改名/改值只影响"跟随主题"和"系统等宽"两档 */
export const DEFAULT_CODE_FONT_STACK =
  '"Cascadia Mono", Consolas, Menlo, "JetBrains Mono", "PingFang SC", "Microsoft YaHei", monospace';

/** UI 字体档位；default = 跟随当前主题预设，预设未指定时回退系统栈 */
export const UI_FONT_OPTIONS: FontOption<FontFamilyName>[] = [
  { value: "default", label: "跟随主题", stack: "var(--app-font-sans)" },
  { value: "inter", label: "Inter", stack: '"Inter", sans-serif' },
  { value: "segoe", label: "Segoe UI", stack: '"Segoe UI", sans-serif' },
  {
    value: "yahei",
    label: "微软雅黑",
    stack: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  },
  { value: "roboto", label: "Roboto", stack: '"Roboto", sans-serif' },
  { value: "open-sans", label: "Open Sans", stack: '"Open Sans", sans-serif' },
  {
    value: "noto-sans-sc",
    label: "思源黑体",
    stack: '"Noto Sans SC", sans-serif',
  },
  { value: "serif", label: "衬线", stack: 'Georgia, "Songti SC", serif' },
  {
    value: "noto-serif-sc",
    label: "思源宋体",
    stack: '"Noto Serif SC", serif',
  },
  { value: "kai", label: "楷体", stack: '"Kaiti SC", KaiTi, serif' },
  { value: "wenkai", label: "霞鹜文楷", stack: '"LXGW WenKai", serif' },
  { value: "mono", label: "等宽", stack: 'Consolas, Menlo, monospace' },
  {
    value: "jetbrains",
    label: "JetBrains Mono",
    stack: '"JetBrains Mono", monospace',
  },
];

export const CODE_FONT_OPTIONS: FontOption<CodeFontFamilyName>[] = [
  { value: "theme", label: "跟随主题", stack: DEFAULT_CODE_FONT_STACK },
  {
    value: "jetbrains",
    label: "JetBrains Mono",
    stack: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  },
  {
    value: "cascadia",
    label: "Cascadia Code",
    stack: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  },
  {
    value: "mono",
    label: "系统等宽",
    stack:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  },
];

/** UI 字体 → 完整字体栈（写进 --app-font-sans） */
export const UI_FONT_STACKS: Record<FontFamilyName, string> = (() => {
  const map = {} as Record<FontFamilyName, string>;
  for (const option of UI_FONT_OPTIONS) {
    // default 档的 stack 是 var(--app-font-sans)，写回会造成自引用；
    // 真正生效的栈由 resolveUiFontValue 在预设/系统之间决定
    map[option.value] =
      option.value === "default"
        ? '"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"'
        : option.stack;
  }
  return map;
})();

/** 代码字体 → 完整字体栈（写进 --app-font-mono） */
export const CODE_FONT_STACKS: Record<CodeFontFamilyName, string> = (() => {
  const map = {} as Record<CodeFontFamilyName, string>;
  for (const option of CODE_FONT_OPTIONS) map[option.value] = option.stack;
  return map;
})();

/** 这两档字体 hinting 弱，Windows 小字号发虚；根节点补 500 字重（沿用旧行为） */
export const FONT_WEIGHT_BOOST: Partial<Record<FontFamilyName, number>> = {
  "noto-sans-sc": 500,
  "noto-serif-sc": 500,
};

/** 解析实际生效的 UI 字体档位：跟随主题时取预设声明，否则原样返回 */
export function resolveUiFontValue(
  family: FontFamilyName,
  presetFont: FontFamilyName | undefined,
): FontFamilyName {
  return family === "default" ? (presetFont ?? "default") : family;
}

/** 解析实际生效的代码字体档位：跟随主题时取预设声明，否则原样返回 */
export function resolveCodeFontValue(
  family: CodeFontFamilyName,
  presetFont: CodeFontFamilyName | undefined,
): CodeFontFamilyName {
  // 预设没声明代码字体时回落到 "theme" 档（默认 Cascadia/Consolas 栈）
  return family === "theme" ? (presetFont ?? "theme") : family;
}
