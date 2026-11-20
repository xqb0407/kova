/**
 * 字体档位目录（外观设置 · UI 字体 / 代码字体共用）。
 *
 * UI 字体沿用 globals.css `:root[data-font]` 的档位：value 即 data-font，
 * stack 用于下拉触发器与选项的即时预览。
 * 代码字体只在这里维护一份，最终落到 html 的 --app-font-mono；CodeMirror、
 * diff、终端都消费同一个变量。
 *
 * 中文回退是跨平台关键：mac 优先苹方；Windows/Linux 在苹方缺席时使用随包的
 * 思源黑体（400/500/600/700 全部有真实字面），避免落到只有 400/700 的微软雅黑
 * 导致 font-medium(500) 掉成 400、font-semibold(600) 跳成 700。
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

/** UI 中文回退顺序：苹方（mac）→ 思源黑体（随包）→ 雅黑（系统兜底） */
const CJK_FALLBACK =
  '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei"';

/** 代码字体只回退系统 CJK：代码块不额外拉思源黑体，省一套字体加载 */
const CODE_CJK_FALLBACK =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei"';

/** 默认代码字体栈：改名/改值只影响"跟随主题"和"系统等宽"两档 */
export const DEFAULT_CODE_FONT_STACK =
  `"Cascadia Mono", Consolas, Menlo, "JetBrains Mono", ${CODE_CJK_FALLBACK}, monospace`;

/** UI 字体档位；default = 跟随当前主题预设，预设未指定时回退系统栈 */
export const UI_FONT_OPTIONS: FontOption<FontFamilyName>[] = [
  { value: "default", label: "跟随主题", stack: "var(--app-font-sans)" },
  {
    value: "inter",
    label: "Inter",
    stack: `"Inter", ${CJK_FALLBACK}, sans-serif`,
  },
  {
    value: "segoe",
    label: "Segoe UI",
    // 显式西文系统档：Windows 上中文仍走随包思源，避免雅黑 500/600 错位；
    // 其他平台自然回退系统 CJK
    stack:
      '"Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  },
  {
    value: "yahei",
    label: "微软雅黑",
    stack:
      '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
  },
  {
    value: "roboto",
    label: "Roboto",
    stack: `"Roboto", ${CJK_FALLBACK}, sans-serif`,
  },
  {
    value: "open-sans",
    label: "Open Sans",
    stack: `"Open Sans", ${CJK_FALLBACK}, sans-serif`,
  },
  {
    value: "noto-sans-sc",
    label: "思源黑体",
    stack:
      '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  },
  {
    value: "serif",
    label: "衬线",
    // 思源宋体已按体积决策移出随包字体（只随包黑体 + 文楷）：mac 落系统宋体
    // Songti SC，Windows 退 SimSun——小字号观感差些，纯体积权衡（13MB）
    stack:
      'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
  },
  {
    value: "kai",
    label: "楷体",
    stack: '"Kaiti SC", "STKaiti", KaiTi, "DFKai-SB", serif',
  },
  {
    value: "wenkai",
    label: "霞鹜文楷",
    stack: '"LXGW WenKai", "Kaiti SC", KaiTi, serif',
  },
  {
    value: "mono",
    label: "等宽",
    stack:
      'ui-monospace, "Cascadia Code", Consolas, Menlo, "PingFang SC", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", monospace',
  },
  {
    value: "jetbrains",
    label: "JetBrains Mono",
    stack:
      '"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, "PingFang SC", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", monospace',
  },
];

export const CODE_FONT_OPTIONS: FontOption<CodeFontFamilyName>[] = [
  { value: "theme", label: "跟随主题", stack: DEFAULT_CODE_FONT_STACK },
  {
    value: "jetbrains",
    label: "JetBrains Mono",
    stack: `"JetBrains Mono", "Cascadia Mono", Consolas, ${CODE_CJK_FALLBACK}, monospace`,
  },
  {
    value: "cascadia",
    label: "Cascadia Code",
    stack: `"Cascadia Code", "Cascadia Mono", Consolas, ${CODE_CJK_FALLBACK}, monospace`,
  },
  {
    value: "mono",
    label: "系统等宽",
    stack:
      `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", ${CODE_CJK_FALLBACK}, monospace`,
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
        ? `"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, ${CJK_FALLBACK}, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", sans-serif`
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

/** 思源黑体 hinting 弱，Windows 小字号发虚；根节点补 500 字重。
 *  500 已随包提供，因此这里终于能命中真实字面而不是退回 400。 */
export const FONT_WEIGHT_BOOST: Partial<Record<FontFamilyName, number>> = {
  "noto-sans-sc": 500,
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
