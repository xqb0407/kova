import { describe, expect, test } from "bun:test";

import { DEFAULT_PREFS, type UiPrefs } from "../settings/ui-prefs";
import {
  buildThemeFile,
  parseThemeFile,
  serializeThemeFile,
  themeFileToPatch,
} from "./serialize";

const prefs: UiPrefs = {
  ...DEFAULT_PREFS,
  themePreset: "mist",
  themeOverrides: {
    light: { background: "#101820", foreground: "#eef3f8" },
    dark: {},
  },
  accent: "violet",
  accentCustom: "#7c5cff",
  contrast: 64,
  radius: 12,
  chatWidth: 60,
  fontFamily: "inter",
  codeFontFamily: "jetbrains",
  wallpaper: { enabled: true, opacity: 88, blur: 10, dim: 24, mode: "dark" },
};

const IMAGE =
  "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=";

describe("buildThemeFile / serializeThemeFile", () => {
  test("只导出外观相关字段并带上壁纸图", () => {
    const file = buildThemeFile(prefs, IMAGE);
    expect(file.format).toBe("kova-theme");
    expect(file.version).toBe(1);
    expect(file.theme.preset).toBe("mist");
    expect(file.theme.accentCustom).toBe("#7c5cff");
    expect(file.wallpaper?.image).toBe(IMAGE);
    // 声音设置不外带
    expect(JSON.stringify(file)).not.toContain("soundVolume");
  });

  test("includeWallpaper=false 时省略图片但保留配置", () => {
    const file = buildThemeFile(prefs, IMAGE, { includeWallpaper: false });
    expect(file.wallpaper?.image).toBeUndefined();
    expect(file.wallpaper?.blur).toBe(10);
  });

  test("序列化 → 解析往返一致", () => {
    const raw = serializeThemeFile(prefs, IMAGE);
    const parsed = parseThemeFile(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.theme.contrast).toBe(64);
    expect(parsed.file.wallpaper?.mode).toBe("dark");
  });
});

describe("parseThemeFile", () => {
  test("拒绝非 JSON", () => {
    const result = parseThemeFile("{nope");
    expect(result).toEqual({ ok: false, error: "不是合法的 JSON" });
  });

  test("拒绝非法颜色（防止任意 CSS 注入）", () => {
    const raw = JSON.stringify({
      format: "kova-theme",
      version: 1,
      theme: {
        preset: "kova",
        overrides: { light: { background: "red; background: url(x)" } },
        accent: "default",
      },
    });
    const result = parseThemeFile(raw);
    expect(result.ok).toBe(false);
  });

  test("拒绝非图片 dataURL", () => {
    const raw = JSON.stringify({
      format: "kova-theme",
      version: 1,
      theme: { preset: "kova", accent: "default" },
      wallpaper: {
        enabled: true,
        opacity: 100,
        blur: 0,
        dim: 20,
        mode: "both",
        image: "javascript:alert(1)",
      },
    });
    expect(parseThemeFile(raw).ok).toBe(false);
  });

  test("未知预设/强调色被拒绝", () => {
    const raw = JSON.stringify({
      format: "kova-theme",
      version: 1,
      theme: { preset: "nope", accent: "default" },
    });
    expect(parseThemeFile(raw).ok).toBe(false);
  });
});

describe("themeFileToPatch", () => {
  test("导入后映射为 prefs 补丁与壁纸动作", () => {
    const file = buildThemeFile(prefs, IMAGE);
    const { patch, wallpaper } = themeFileToPatch(file);
    expect(patch.themePreset).toBe("mist");
    expect(patch.themeOverrides?.light.background).toBe("#101820");
    expect(patch.chatWidth).toBe(60);
    expect(patch.fontFamily).toBe("inter");
    expect(patch.codeFontFamily).toBe("jetbrains");
    expect(wallpaper).toEqual({
      type: "replace",
      image: IMAGE,
      config: { enabled: true, opacity: 88, blur: 10, dim: 24, mode: "dark" },
    });
  });

  test("wallpaper=null 表示移除", () => {
    const file = { ...buildThemeFile(prefs, null), wallpaper: null };
    expect(themeFileToPatch(file).wallpaper).toEqual({ type: "remove" });
  });

  test("未携带 wallpaper 字段时保持现状", () => {
    const { wallpaper: _omit, ...rest } = buildThemeFile(prefs, null);
    expect(themeFileToPatch(rest).wallpaper).toEqual({ type: "keep" });
  });
});
