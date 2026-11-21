/**
 * 主题 JSON 的导出 / 导入。
 *
 * 安全边界：导入内容来自用户粘贴或文件，字段一律走 zod 白名单 ——
 * 颜色只接受 hex、数值 clamp 到合法区间、壁纸只接受 png/jpeg/webp 的
 * dataURL，避免把任意字符串塞进 CSS 变量造成注入。
 */
import { z } from "zod";
import type { UiPrefs } from "../settings/ui-prefs";
import {
  CODE_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  type CodeFontFamilyName,
  type FontFamilyName,
} from "./fonts";
import { ACCENT_VALUES, THEME_PRESET_IDS } from "./presets";
import type {
  AccentName,
  PaletteOverride,
  ThemePresetName,
  WallpaperConfig,
} from "./types";

export const THEME_FILE_FORMAT = "kova-theme";
export const THEME_FILE_VERSION = 1;
/**
 * 格式 Schema（随包在 public/schemas/，源码即文档）。导出文件像
 * components.json 一样带 $schema 指过去；用 GitHub raw 地址，外部编辑器
 * （VS Code 等）能自动拉取做字段校验。应用侧导入不依赖它（zod 白名单）。
 */
export const THEME_SCHEMA_URL =
  "https://raw.githubusercontent.com/xqb0407/kova/main/apps/desktop/public/schemas/kova-theme-1.json";

const UI_FONT_VALUES = UI_FONT_OPTIONS.map((o) => o.value) as [
  FontFamilyName,
  ...FontFamilyName[],
];
const CODE_FONT_VALUES = CODE_FONT_OPTIONS.map((o) => o.value) as [
  CodeFontFamilyName,
  ...CodeFontFamilyName[],
];

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "颜色必须是 #RRGGBB 格式");
const overrideSchema = z
  .object({ background: hex.optional(), foreground: hex.optional() })
  .default({});
const dataImage = z
  .string()
  .max(8_000_000, "壁纸图片过大")
  .regex(
    /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i,
    "壁纸必须是 png/jpeg/webp 的 dataURL",
  );

const wallpaperSchema = z.object({
  enabled: z.boolean().default(true),
  opacity: z.number().min(0).max(100).default(100),
  blur: z.number().min(0).max(40).default(0),
  dim: z.number().min(0).max(80).default(20),
  mode: z.enum(["both", "light", "dark"]).default("both"),
  image: dataImage.nullable().optional(),
});

const themeFileSchema = z.object({
  // 导入端只认白名单字段：$schema 指路用，解析时直接丢弃
  "$schema": z.string().max(200).optional(),
  format: z.literal(THEME_FILE_FORMAT),
  version: z.literal(THEME_FILE_VERSION),
  name: z.string().max(80).optional(),
  theme: z.object({
    preset: z.enum(THEME_PRESET_IDS as [ThemePresetName, ...ThemePresetName[]]),
    overrides: z
      .object({ light: overrideSchema, dark: overrideSchema })
      .optional(),
    accent: z.enum(ACCENT_VALUES as [AccentName, ...AccentName[]]).default("default"),
    accentCustom: hex.nullable().optional().default(null),
    contrast: z.number().min(0).max(100).optional().default(50),
    radius: z.number().min(0).max(24).nullable().optional().default(null),
  }),
  typography: z
    .object({
      uiFont: z.enum(UI_FONT_VALUES).optional(),
      uiFontSize: z.enum(["sm", "md", "lg"]).optional(),
      codeFont: z.enum(CODE_FONT_VALUES).optional(),
      // 导入保持宽松：旧导出可能带 10px 历史值；应用侧统一夹到 11–24
      codeFontSize: z.number().min(8).max(32).optional(),
    })
    .optional(),
  layout: z
    .object({ chatWidth: z.number().min(40).max(100) })
    .optional(),
  code: z
    .object({
      themeLight: z.enum(["default", "vscode", "idea"]).optional(),
      themeDark: z.enum(["default", "vscode", "idea"]).optional(),
      lineNumbers: z.boolean().optional(),
      wrap: z.boolean().optional(),
    })
    .optional(),
  wallpaper: wallpaperSchema.nullable().optional(),
});

export type ThemeFile = z.infer<typeof themeFileSchema>;

/** 导出：只包含外观相关字段（提示音/通知等留在本机） */
export function buildThemeFile(
  prefs: UiPrefs,
  wallpaperImage: string | null,
  options: { includeWallpaper?: boolean; name?: string } = {},
): ThemeFile {
  const includeWallpaper = options.includeWallpaper !== false;
  const wallpaper = prefs.wallpaper
    ? {
        ...prefs.wallpaper,
        image: includeWallpaper ? (wallpaperImage ?? undefined) : undefined,
      }
    : null;
  return {
    "$schema": THEME_SCHEMA_URL,
    format: THEME_FILE_FORMAT,
    version: THEME_FILE_VERSION,
    ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    theme: {
      preset: prefs.themePreset,
      overrides: prefs.themeOverrides,
      accent: prefs.accent,
      accentCustom: prefs.accentCustom,
      contrast: prefs.contrast,
      radius: prefs.radius,
    },
    typography: {
      uiFont: prefs.fontFamily,
      uiFontSize: prefs.fontSize,
      codeFont: prefs.codeFontFamily,
      codeFontSize: prefs.codeFontSize,
    },
    layout: { chatWidth: prefs.chatWidth },
    code: {
      themeLight: prefs.codeThemeLight,
      themeDark: prefs.codeThemeDark,
      lineNumbers: prefs.codeLineNumbers,
      wrap: prefs.codeWrap,
    },
    wallpaper,
  };
}

export function serializeThemeFile(
  prefs: UiPrefs,
  wallpaperImage: string | null,
  options?: { includeWallpaper?: boolean; name?: string },
): string {
  return JSON.stringify(buildThemeFile(prefs, wallpaperImage, options), null, 2);
}

export type ParseThemeResult =
  | { ok: true; file: ThemeFile }
  | { ok: false; error: string };

export function parseThemeFile(raw: string): ParseThemeResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "不是合法的 JSON" };
  }
  // 「贴错文件」单独解释：components.json 之类别的项目的 JSON 也会走到这，
  // zod 的英文 literal 报错让人摸不着头脑，先用一句人话指路
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { format?: unknown }).format !== THEME_FILE_FORMAT
  ) {
    const keys = Object.keys(value as Record<string, unknown>)
      .slice(0, 5)
      .join("、");
    return {
      ok: false,
      error: `不是扣瓦主题文件：缺少 format: "${THEME_FILE_FORMAT}"${keys ? `（顶层键：${keys}）` : ""}。请先用「导出主题」复制内容，再粘贴导入。`,
    };
  }
  const parsed = themeFileSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    return {
      ok: false,
      error: path ? `${path}：${issue.message}` : (issue?.message ?? "主题格式不正确"),
    };
  }
  return { ok: true, file: parsed.data };
}

export type WallpaperAction =
  | { type: "keep" }
  | { type: "remove" }
  | { type: "replace"; image: string | null; config: WallpaperConfig };

/** 导入结果 → 可直接交给 ui-prefs 的补丁 + 壁纸动作 */
export function themeFileToPatch(file: ThemeFile): {
  patch: Partial<UiPrefs>;
  wallpaper: WallpaperAction;
} {
  const overrides = file.theme.overrides ?? { light: {}, dark: {} };
  const patch: Partial<UiPrefs> = {
    themePreset: file.theme.preset,
    themeOverrides: {
      light: overrides.light as PaletteOverride,
      dark: overrides.dark as PaletteOverride,
    },
    accent: file.theme.accent,
    accentCustom: file.theme.accentCustom ?? null,
    contrast: file.theme.contrast ?? 50,
    radius: file.theme.radius ?? null,
  };
  if (file.typography) {
    if (file.typography.uiFont) patch.fontFamily = file.typography.uiFont;
    if (file.typography.uiFontSize) patch.fontSize = file.typography.uiFontSize;
    if (file.typography.codeFont) patch.codeFontFamily = file.typography.codeFont;
    if (typeof file.typography.codeFontSize === "number") {
      patch.codeFontSize = Math.min(24, Math.max(11, file.typography.codeFontSize));
    }
  }
  if (file.layout) patch.chatWidth = file.layout.chatWidth;
  if (file.code) {
    if (file.code.themeLight) patch.codeThemeLight = file.code.themeLight;
    if (file.code.themeDark) patch.codeThemeDark = file.code.themeDark;
    if (typeof file.code.lineNumbers === "boolean") {
      patch.codeLineNumbers = file.code.lineNumbers;
    }
    if (typeof file.code.wrap === "boolean") patch.codeWrap = file.code.wrap;
  }

  let wallpaper: WallpaperAction = { type: "keep" };
  if (file.wallpaper === null) {
    wallpaper = { type: "remove" };
  } else if (file.wallpaper) {
    wallpaper = {
      type: "replace",
      image: file.wallpaper.image ?? null,
      config: {
        enabled: file.wallpaper.enabled,
        opacity: file.wallpaper.opacity,
        blur: file.wallpaper.blur,
        dim: file.wallpaper.dim,
        mode: file.wallpaper.mode,
      },
    };
  }
  return { patch, wallpaper };
}

/** 主题文件的可读名称（toast / 导入确认用） */
export function themeFileName(file: ThemeFile): string {
  return file.name?.trim() || `${file.theme.preset} 主题`;
}
