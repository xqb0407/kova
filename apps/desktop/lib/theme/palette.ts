/**
 * 主题配色派生：从「预设 + 自定义覆盖 + 强调色 + 对比度」算出一份 CSS
 * 变量表，由 ui-prefs 内联到 <html>。所有语义色（card/muted/border/sidebar…）
 * 都由前景/背景两色派生，因此任意背景/前景组合都能得到自洽的界面。
 *
 * 百分比基准是现有中性主题反算出来的：对比度 50 时与旧观感基本一致；
 * 对比度滑杆只缩放这些比例，不改变色相。
 */
import { adaptAccent, normalizeHex, readableTextOn } from "./color";
import {
  CODE_FONT_STACKS,
  FONT_WEIGHT_BOOST,
  UI_FONT_STACKS,
  resolveCodeFontValue,
  resolveUiFontValue,
  type CodeFontFamilyName,
  type FontFamilyName,
} from "./fonts";
import { ACCENT_PRESETS, THEME_PRESETS } from "./presets";
import type {
  AccentName,
  ColorMode,
  PaletteOverride,
  ThemePresetName,
  WallpaperConfig,
} from "./types";

export type ThemeTokens = Record<string, string>;

export type ThemeInput = {
  themePreset: ThemePresetName;
  themeOverrides: Record<ColorMode, PaletteOverride>;
  accent: AccentName;
  accentCustom: string | null;
  /** 0–100，50 = 默认 */
  contrast: number;
  /** px；null = 跟随预设 */
  radius: number | null;
  fontFamily: FontFamilyName;
  codeFontFamily: CodeFontFamilyName;
  wallpaper: WallpaperConfig | null;
};

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

const pct = (v: number) => `${Math.round(v * 10) / 10}%`;

/** 当前主题的背景/前景（已应用覆盖色与合法性校验） */
export function resolveBaseColors(
  input: Pick<ThemeInput, "themePreset" | "themeOverrides">,
  mode: ColorMode,
): { background: string; foreground: string } {
  const preset = THEME_PRESETS[input.themePreset] ?? THEME_PRESETS.kova;
  const override = input.themeOverrides?.[mode] ?? {};
  return {
    background:
      normalizeHex(override.background ?? "") ?? preset[mode].background,
    foreground:
      normalizeHex(override.foreground ?? "") ?? preset[mode].foreground,
  };
}

export type ResolvedFonts = {
  ui: FontFamilyName;
  code: CodeFontFamilyName;
  uiStack: string;
  codeStack: string;
  /** Noto 系在 Windows 小字号下偏虚，根节点补的字重；null = 不覆盖 */
  weight: number | null;
};

export function resolveFonts(
  input: Pick<ThemeInput, "themePreset" | "fontFamily" | "codeFontFamily">,
): ResolvedFonts {
  const preset = THEME_PRESETS[input.themePreset] ?? THEME_PRESETS.kova;
  const ui = resolveUiFontValue(input.fontFamily, preset.fonts?.ui);
  const code = resolveCodeFontValue(input.codeFontFamily, preset.fonts?.code);
  return {
    ui,
    code,
    uiStack: UI_FONT_STACKS[ui],
    codeStack: CODE_FONT_STACKS[code],
    weight: FONT_WEIGHT_BOOST[ui] ?? null,
  };
}

type AccentTokens = {
  primary: string;
  primaryForeground: string;
  ring: string;
};

/** 强调色的最终取值：自定义 > 命名强调色 > 预设强调色 > 前景（单色） */
function resolveAccent(
  input: Pick<ThemeInput, "themePreset" | "accent" | "accentCustom">,
  mode: ColorMode,
  foreground: string,
  background: string,
  mixFg: (value: number) => string,
  neutralRingPct: number,
): AccentTokens {
  const custom = normalizeHex(input.accentCustom ?? "");
  if (custom) {
    const primary = adaptAccent(custom, mode) ?? custom;
    return {
      primary,
      primaryForeground: readableTextOn(primary),
      ring: primary,
    };
  }
  const named = ACCENT_PRESETS.find(
    (accent) => accent.value === input.accent && accent.value !== "default",
  );
  const namedTokens = named?.[mode];
  if (namedTokens) return namedTokens;

  const preset = THEME_PRESETS[input.themePreset] ?? THEME_PRESETS.kova;
  if (preset.accent) {
    const primary = adaptAccent(preset.accent, mode) ?? preset.accent;
    return {
      primary,
      primaryForeground: readableTextOn(primary),
      ring: primary,
    };
  }
  return {
    primary: foreground,
    primaryForeground: background,
    ring: mixFg(neutralRingPct),
  };
}

/**
 * 派生当前模式的全部令牌。
 * - 表面色用不透明背景参与 color-mix（壁纸只作用于聊天卡片，其余表面保持实色）
 * - 线条/悬停用前景 alpha
 */
export function resolveTheme(
  input: ThemeInput,
  mode: ColorMode,
): ThemeTokens {
  const { background, foreground } = resolveBaseColors(input, mode);
  const surfaceBase = background;
  const light = mode === "light";
  const k = 0.4 + (clamp(input.contrast, 0, 100) / 100) * 1.2;

  const mixFg = (value: number) =>
    `color-mix(in oklab, var(--foreground) ${pct(clamp(value * k, 0, 100))}, ${surfaceBase})`;
  const alphaFg = (value: number) =>
    `color-mix(in srgb, var(--foreground) ${pct(clamp(value * k, 0, 100))}, transparent)`;

  // 浅/深两套表面比例（对比度 50 时按旧 oklch 令牌反算）
  const mutedPct = light ? 3.5 : 14.8;
  const cardPct = light ? 0 : 7.1;
  const sidebarPct = light ? 1.75 : 7.1;
  const mutedFgPct = light ? 52 : 67;
  const ringPct = light ? 30 : 49;
  const borderPct = light ? 9 : 12;
  const inputPct = light ? 9 : 16;

  const fonts = resolveFonts(input);
  const preset = THEME_PRESETS[input.themePreset] ?? THEME_PRESETS.kova;
  const radiusPx = clamp(input.radius ?? preset.radius, 0, 24);

  const accent = resolveAccent(
    input,
    mode,
    foreground,
    background,
    mixFg,
    ringPct,
  );

  const hoverBase = light ? 4 : 6;
  const activeBase = light ? 7 : 10;
  const overlay = light ? "0 0 0" : "255 255 255";

  return {
    "--background": background,
    "--foreground": foreground,
    "--card": mixFg(cardPct),
    "--card-foreground": foreground,
    "--popover": mixFg(cardPct),
    "--popover-foreground": foreground,
    "--primary": accent.primary,
    "--primary-foreground": accent.primaryForeground,
    "--secondary": mixFg(mutedPct),
    "--secondary-foreground": foreground,
    "--muted": mixFg(mutedPct),
    "--muted-foreground": mixFg(mutedFgPct),
    "--accent": mixFg(mutedPct),
    "--accent-foreground": foreground,
    "--destructive": light
      ? "oklch(0.577 0.245 27.325)"
      : "oklch(0.704 0.191 22.216)",
    "--destructive-light": light ? "#fef2f2" : "#450a0a",
    "--border": alphaFg(borderPct),
    "--input": alphaFg(inputPct),
    "--ring": accent.ring,
    "--sidebar": mixFg(sidebarPct),
    "--sidebar-foreground": foreground,
    "--sidebar-primary": accent.primary,
    "--sidebar-primary-foreground": accent.primaryForeground,
    "--sidebar-accent": mixFg(mutedPct),
    "--sidebar-accent-foreground": foreground,
    "--sidebar-border": alphaFg(borderPct),
    "--sidebar-ring": accent.ring,
    "--chart-1": accent.primary,
    "--chart-2": mixFg(70),
    "--chart-3": mixFg(45),
    "--chart-4": mixFg(25),
    "--chart-5": mixFg(12),
    "--hover": `rgb(${overlay} / ${pct(clamp(hoverBase * k, 0, 100))})`,
    "--active": `rgb(${overlay} / ${pct(clamp(activeBase * k, 0, 100))})`,
    "--selected": "var(--muted)",
    "--code-surface": `color-mix(in oklab, var(--foreground) 4%, ${surfaceBase})`,
    "--drop-line": "color-mix(in oklab, var(--primary) 45%, transparent)",
    "--focus-ring": accent.primary,
    "--overlay": overlay,
    "--app-font-sans": fonts.uiStack,
    "--app-font-mono": fonts.codeStack,
    "--radius": `${Math.round(radiusPx * 100) / 100 / 16}rem`,
  };
}

/** 首帧缓存口径版本：字段语义变更时递增，预绘制脚本据此决定是否套用对应字段 */
export const BOOT_CACHE_VERSION = 3;

/** 首帧缓存：两套模式各一份令牌 + 非令牌字段，供 layout 预绘制脚本直接套用 */
export type BootThemeCache = {
  v: typeof BOOT_CACHE_VERSION;
  light: ThemeTokens;
  dark: ThemeTokens;
  /** 根字号（rem 基准）；null = 浏览器默认 16px */
  fontSize: string | null;
  /** Noto 系的 500 字重；null = 不覆盖（仅 Windows 使用） */
  fontWeight: string | null;
  /** 聊天正文字号（整数 px），跟随字号档位 */
  chatFontSize: string;
  /** 聊天正文行高（整数 px），跟随字号档位 */
  chatLineHeight: string;
  chatWidth: string;
  wallpaper: null | {
    mode: WallpaperConfig["mode"];
    vars: Record<string, string>;
  };
};

/** 对话宽度设置（rem 上限，40–100）→ CSS 值：100 表示始终平铺 */
export function formatChatWidth(rem: number): string {
  const cap = clamp(rem, 40, 100);
  return cap >= 100 ? "100%" : `${cap}rem`;
}

/** 壁纸强度 → 卡片染色层的底色比例：强度越高，压在图上的底色越薄 */
export function wallpaperVeil(opacity: number): string {
  return `${Math.round((88 - clamp(opacity, 0, 100) * 0.38) * 10) / 10}%`;
}

export function buildBootCache(
  input: ThemeInput & {
    fontSize: string | null;
    chatFontSize: string;
    chatLineHeight: string;
    chatWidth: number;
  },
): BootThemeCache {
  const fonts = resolveFonts(input);
  const wallpaper = input.wallpaper;
  const wallpaperVars: Record<string, string> | null = wallpaper?.enabled
    ? {
        "--wallpaper-opacity": String(clamp(wallpaper.opacity, 0, 100) / 100),
        "--wallpaper-blur": `${clamp(wallpaper.blur, 0, 40)}px`,
        "--wallpaper-dim": String(clamp(wallpaper.dim, 0, 80) / 100),
        "--wallpaper-veil": wallpaperVeil(wallpaper.opacity),
      }
    : null;
  return {
    v: BOOT_CACHE_VERSION,
    light: resolveTheme(input, "light"),
    dark: resolveTheme(input, "dark"),
    fontSize: input.fontSize,
    fontWeight: fonts.weight === null ? null : String(fonts.weight),
    chatFontSize: input.chatFontSize,
    chatLineHeight: input.chatLineHeight,
    chatWidth: formatChatWidth(input.chatWidth),
    wallpaper: wallpaper?.enabled
      ? { mode: wallpaper.mode, vars: wallpaperVars ?? {} }
      : null,
  };
}
