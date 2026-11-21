/**
 * 内置主题与强调色目录（设置页与引导页共用，单一事实源）。
 *
 * 主题只声明「浅/深两套背景 + 前景 + 强调色 + 圆角 + 字体配对」，
 * 其余语义色（card/muted/border/sidebar…）全部由 palette.ts 派生，
 * 这样任意自定义色都能得到一套自洽的界面，而不是只换一个主色。
 */
import type {
  AccentName,
  ThemePreset,
  ThemePresetName,
} from "./types";

export type AccentTokens = {
  primary: string;
  primaryForeground: string;
  ring: string;
};

export type AccentPreset = {
  value: AccentName;
  /** 展示名走词典（settings.appearance.presets.accent.*），模块求值期不能调 t() */
  labelKey: string;
  /** 色点展示色；null = 单色（用前景色斜切示意） */
  color: string | null;
  light?: AccentTokens;
  dark?: AccentTokens;
};

/** 命名强调色：浅/深两档值沿用 globals.css 里原有的 primary/ring 配比 */
export const ACCENT_PRESETS: AccentPreset[] = [
  { value: "default", labelKey: "settings.appearance.presets.accent.default", color: null },
  {
    value: "blue",
    labelKey: "settings.appearance.presets.accent.blue",
    color: "oklch(0.55 0.22 257)",
    light: {
      primary: "oklch(0.55 0.22 257)",
      primaryForeground: "oklch(0.98 0.01 257)",
      ring: "oklch(0.62 0.19 257)",
    },
    dark: {
      primary: "oklch(0.65 0.19 257)",
      primaryForeground: "oklch(0.16 0.03 257)",
      ring: "oklch(0.55 0.16 257)",
    },
  },
  {
    value: "violet",
    labelKey: "settings.appearance.presets.accent.violet",
    color: "oklch(0.55 0.21 292)",
    light: {
      primary: "oklch(0.55 0.21 292)",
      primaryForeground: "oklch(0.98 0.01 292)",
      ring: "oklch(0.62 0.18 292)",
    },
    dark: {
      primary: "oklch(0.66 0.18 292)",
      primaryForeground: "oklch(0.16 0.03 292)",
      ring: "oklch(0.55 0.16 292)",
    },
  },
  {
    value: "green",
    labelKey: "settings.appearance.presets.accent.green",
    color: "oklch(0.55 0.16 155)",
    light: {
      primary: "oklch(0.55 0.16 155)",
      primaryForeground: "oklch(0.98 0.02 155)",
      ring: "oklch(0.6 0.14 155)",
    },
    dark: {
      primary: "oklch(0.65 0.16 155)",
      primaryForeground: "oklch(0.16 0.03 155)",
      ring: "oklch(0.55 0.14 155)",
    },
  },
  {
    value: "orange",
    labelKey: "settings.appearance.presets.accent.orange",
    color: "oklch(0.62 0.18 55)",
    light: {
      primary: "oklch(0.62 0.18 55)",
      primaryForeground: "oklch(0.98 0.02 55)",
      ring: "oklch(0.68 0.15 55)",
    },
    dark: {
      primary: "oklch(0.7 0.16 55)",
      primaryForeground: "oklch(0.18 0.03 55)",
      ring: "oklch(0.6 0.14 55)",
    },
  },
  {
    value: "rose",
    labelKey: "settings.appearance.presets.accent.rose",
    color: "oklch(0.58 0.21 350)",
    light: {
      primary: "oklch(0.58 0.21 350)",
      primaryForeground: "oklch(0.98 0.01 350)",
      ring: "oklch(0.64 0.18 350)",
    },
    dark: {
      primary: "oklch(0.66 0.19 350)",
      primaryForeground: "oklch(0.16 0.03 350)",
      ring: "oklch(0.56 0.16 350)",
    },
  },
  {
    value: "periwinkle",
    labelKey: "settings.appearance.presets.accent.periwinkle",
    color: "oklch(0.606 0.136 269)",
    light: {
      primary: "oklch(0.606 0.136 269)",
      primaryForeground: "oklch(0.98 0.01 269)",
      ring: "oklch(0.67 0.12 269)",
    },
    dark: {
      primary: "oklch(0.7 0.13 269)",
      primaryForeground: "oklch(0.16 0.03 269)",
      ring: "oklch(0.6 0.12 269)",
    },
  },
];

export const ACCENT_VALUES: AccentName[] = ACCENT_PRESETS.map((a) => a.value);

/** 内置主题（顺序即设置页展示顺序） */
export const THEME_PRESETS: Record<ThemePresetName, ThemePreset> = {
  kova: {
    id: "kova",
    labelKey: "settings.appearance.presets.theme.kova.label",
    descKey: "settings.appearance.presets.theme.kova.desc",
    accent: null,
    radius: 10,
    light: { background: "#ffffff", foreground: "#171717" },
    dark: { background: "#0a0a0a", foreground: "#fafafa" },
  },
  paper: {
    id: "paper",
    labelKey: "settings.appearance.presets.theme.paper.label",
    descKey: "settings.appearance.presets.theme.paper.desc",
    accent: "#a16207",
    radius: 6,
    light: { background: "#f7f2e8", foreground: "#2b2620" },
    dark: { background: "#17130e", foreground: "#ece4d6" },
    // 思源宋体已移出随包字体，paper 的衬线意图改走系统衬线链（mac 宋体 / win SimSun）
    fonts: { ui: "serif" },
  },
  mist: {
    id: "mist",
    labelKey: "settings.appearance.presets.theme.mist.label",
    descKey: "settings.appearance.presets.theme.mist.desc",
    accent: "#3b82c4",
    radius: 12,
    light: { background: "#eef3f8", foreground: "#1b2733" },
    dark: { background: "#0c141c", foreground: "#dbe6f0" },
    fonts: { ui: "inter" },
  },
  forest: {
    id: "forest",
    labelKey: "settings.appearance.presets.theme.forest.label",
    descKey: "settings.appearance.presets.theme.forest.desc",
    accent: "#3f7d4e",
    radius: 10,
    light: { background: "#f1f5ee", foreground: "#1d2a1e" },
    dark: { background: "#0c140d", foreground: "#d7e6d4" },
    fonts: { ui: "noto-sans-sc" },
  },
  sunset: {
    id: "sunset",
    labelKey: "settings.appearance.presets.theme.sunset.label",
    descKey: "settings.appearance.presets.theme.sunset.desc",
    accent: "#d2691e",
    radius: 14,
    light: { background: "#fdf1e7", foreground: "#33231a" },
    dark: { background: "#170f0b", foreground: "#f2ddd0" },
    fonts: { ui: "open-sans" },
  },
  sakura: {
    id: "sakura",
    labelKey: "settings.appearance.presets.theme.sakura.label",
    descKey: "settings.appearance.presets.theme.sakura.desc",
    accent: "#d15f85",
    radius: 16,
    light: { background: "#fdf1f4", foreground: "#2f1f24" },
    dark: { background: "#190f13", foreground: "#f4dfe5" },
    fonts: { ui: "noto-sans-sc" },
  },
  midnight: {
    id: "midnight",
    labelKey: "settings.appearance.presets.theme.midnight.label",
    descKey: "settings.appearance.presets.theme.midnight.desc",
    accent: "#5b7bea",
    radius: 10,
    light: { background: "#eef1f8", foreground: "#1a2436" },
    dark: { background: "#070b16", foreground: "#dde5f5" },
    fonts: { ui: "inter", code: "jetbrains" },
  },
  graphite: {
    id: "graphite",
    labelKey: "settings.appearance.presets.theme.graphite.label",
    descKey: "settings.appearance.presets.theme.graphite.desc",
    accent: "#6b7280",
    radius: 6,
    light: { background: "#f3f3f4", foreground: "#171717" },
    dark: { background: "#101010", foreground: "#ebebeb" },
  },
  atlassian: {
    id: "atlassian",
    labelKey: "settings.appearance.presets.theme.atlassian.label",
    descKey: "settings.appearance.presets.theme.atlassian.desc",
    accent: "#0c66e4",
    radius: 6,
    light: { background: "#ffffff", foreground: "#172b4d" },
    dark: { background: "#1d2125", foreground: "#dee4ea" },
    fonts: { ui: "inter" },
  },
  executor: {
    id: "executor",
    labelKey: "settings.appearance.presets.theme.executor.label",
    descKey: "settings.appearance.presets.theme.executor.desc",
    accent: null,
    radius: 8,
    light: { background: "#ffffff", foreground: "#111111" },
    dark: { background: "#0a0a0a", foreground: "#ededed" },
  },
  quiverai: {
    id: "quiverai",
    labelKey: "settings.appearance.presets.theme.quiverai.label",
    descKey: "settings.appearance.presets.theme.quiverai.desc",
    accent: null,
    radius: 10,
    light: { background: "#fafafa", foreground: "#0a0a0a" },
    dark: { background: "#0a0a0a", foreground: "#fafafa" },
  },
  oxide: {
    id: "oxide",
    labelKey: "settings.appearance.presets.theme.oxide.label",
    descKey: "settings.appearance.presets.theme.oxide.desc",
    accent: "#00d892",
    radius: 4,
    light: { background: "#fdfdfd", foreground: "#303235" },
    dark: { background: "#0b0e12", foreground: "#bababb" },
  },
  food: {
    id: "food",
    labelKey: "settings.appearance.presets.theme.food.label",
    descKey: "settings.appearance.presets.theme.food.desc",
    accent: "#ff8714",
    radius: 8,
    light: { background: "#f5f5f5", foreground: "#000000" },
    dark: { background: "#121212", foreground: "#f5f5f5" },
  },
  juspay: {
    id: "juspay",
    labelKey: "settings.appearance.presets.theme.juspay.label",
    descKey: "settings.appearance.presets.theme.juspay.desc",
    accent: "#2b7fff",
    accentForeground: "#ffffff",
    radius: 8,
    light: { background: "#ffffff", foreground: "#0e121b" },
    dark: { background: "#0e121b", foreground: "#f5f7fa" },
    fonts: { ui: "inter" },
  },
  kaizen: {
    id: "kaizen",
    labelKey: "settings.appearance.presets.theme.kaizen.label",
    descKey: "settings.appearance.presets.theme.kaizen.desc",
    accent: "#844587",
    radius: 4,
    light: { background: "#ffffff", foreground: "#2f2438" },
    dark: { background: "#2f2438", foreground: "#f4edf8" },
    fonts: { ui: "inter" },
  },
  antd: {
    id: "antd",
    labelKey: "settings.appearance.presets.theme.antd.label",
    descKey: "settings.appearance.presets.theme.antd.desc",
    accent: "#1677ff",
    accentForeground: "#ffffff",
    radius: 6,
    light: { background: "#ffffff", foreground: "#1f1f1f" },
    dark: { background: "#141414", foreground: "#d9d9d9" },
  },
};

export const THEME_PRESET_LIST: ThemePreset[] = Object.values(THEME_PRESETS);
export const THEME_PRESET_IDS = Object.keys(THEME_PRESETS) as ThemePresetName[];

/** 预设缩略图渐变：浅底 → 强调色 → 深底（主题选择器的色条） */
export function presetGradient(preset: ThemePreset): string {
  const accent = preset.accent ?? preset.light.foreground;
  return `linear-gradient(135deg, ${preset.light.background} 0%, ${preset.light.background} 32%, ${accent} 58%, ${preset.dark.background} 100%)`;
}
