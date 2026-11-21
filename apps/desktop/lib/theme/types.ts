/**
 * 主题领域类型：预设 / 强调色 / 页面配色覆盖 / 壁纸。
 * 只放类型与常量，不放实现，避免 ui-prefs、palette、设置页之间循环依赖。
 */
import type { CodeFontFamilyName, FontFamilyName } from "./fonts";

export type ThemePresetName =
  | "kova"
  | "paper"
  | "mist"
  | "forest"
  | "sunset"
  | "sakura"
  | "china"
  | "qinghua"
  | "celadon"
  | "mowen"
  | "lacquer"
  | "midnight"
  | "graphite"
  | "atlassian"
  | "executor"
  | "quiverai"
  | "oxide"
  | "food"
  | "juspay"
  | "kaizen"
  | "antd";

export type ColorMode = "light" | "dark";

export type AccentName =
  | "default"
  | "blue"
  | "violet"
  | "green"
  | "orange"
  | "rose"
  | "periwinkle";

/** 单个模式下的自定义页面颜色；缺省字段表示沿用预设 */
export type PaletteOverride = {
  background?: string;
  foreground?: string;
};

export type ThemeColors = {
  background: string;
  foreground: string;
};

export type WallpaperMode = "both" | "light" | "dark";

export type WallpaperConfig = {
  enabled: boolean;
  /** 壁纸图透明度 0–100 */
  opacity: number;
  /** 模糊半径 px 0–40 */
  blur: number;
  /** 黑色遮罩浓度 0–80 */
  dim: number;
  /** 只在某个明暗模式下显示 */
  mode: WallpaperMode;
};

export type ThemePreset = {
  id: ThemePresetName;
  /** 展示名/描述走词典（settings.appearance.presets.theme.<id>.label/.desc） */
  labelKey: string;
  descKey: string;
  /** 预设的默认强调色；null = 单色（跟随前景） */
  accent: string | null;
  /** 强调色上的文字色；省略 = 按对比度自动选黑/白 */
  accentForeground?: string;
  /** 圆角半径 px */
  radius: number;
  light: ThemeColors;
  dark: ThemeColors;
  /** 主题附带的字体配对；"跟随主题"时生效 */
  fonts?: {
    ui?: FontFamilyName;
    code?: CodeFontFamilyName;
  };
  /**
   * 主题自带的壁纸：用户未设置壁纸时兜底展示，上传图片即被覆盖。
   * image 是随包静态资源 URL（public/ 下），不进主题导入导出（对方应用同样内置）。
   */
  wallpaper?: ThemeWallpaper;
};

/** 主题内置壁纸：图 + 默认观感；用户配置（含「关闭」）始终优先 */
export type ThemeWallpaper = {
  image: string;
  config: WallpaperConfig;
};

export const COLOR_MODES: ColorMode[] = ["light", "dark"];
