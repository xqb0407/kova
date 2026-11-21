import { describe, expect, test } from "bun:test";

import { DEFAULT_PREFS, migratePrefs, resolveEffectiveWallpaper } from "./ui-prefs";

describe("migratePrefs", () => {
  test("空值回落到默认", () => {
    expect(migratePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(migratePrefs({})).toEqual(DEFAULT_PREFS);
  });

  test("旧版三档对话宽度迁移为 rem 上限", () => {
    expect(migratePrefs({ chatWidth: "narrow" }).chatWidth).toBe(50);
    expect(migratePrefs({ chatWidth: "md" }).chatWidth).toBe(60);
    expect(migratePrefs({ chatWidth: "wide" }).chatWidth).toBe(70);
    expect(migratePrefs({ chatWidth: "nope" }).chatWidth).toBe(60);
    expect(migratePrefs({ chatWidth: 999 }).chatWidth).toBe(100);
    expect(migratePrefs({ chatWidth: 10 }).chatWidth).toBe(40);
  });

  test("非法枚举回落到默认", () => {
    const p = migratePrefs({
      theme: "purple",
      themePreset: "unknown",
      accent: "cyan",
      fontFamily: "comic-sans",
      codeFontFamily: "papyrus",
      fontSize: "huge",
      codeThemeLight: "solarized",
    });
    expect(p.theme).toBe("system");
    expect(p.themePreset).toBe("kova");
    expect(p.accent).toBe("default");
    expect(p.fontFamily).toBe("default");
    expect(p.codeFontFamily).toBe("theme");
    expect(p.fontSize).toBe("md");
    expect(p.codeThemeLight).toBe("default");
  });

  test("自定义配色只保留合法 hex", () => {
    const p = migratePrefs({
      themeOverrides: {
        light: { background: "#FFF", foreground: "rgb(0,0,0)" },
        dark: { foreground: "#101010", background: "#12345" },
      },
    });
    expect(p.themeOverrides.light).toEqual({ background: "#ffffff" });
    expect(p.themeOverrides.dark).toEqual({ foreground: "#101010" });
  });

  test("强调色自定义值非法则丢弃", () => {
    expect(migratePrefs({ accentCustom: "#7C5CFF" }).accentCustom).toBe("#7c5cff");
    expect(migratePrefs({ accentCustom: "javascript:1" }).accentCustom).toBeNull();
  });

  test("对比度/圆角/代码字号 clamp 到合法区间", () => {
    expect(migratePrefs({ contrast: 999 }).contrast).toBe(100);
    expect(migratePrefs({ contrast: -5 }).contrast).toBe(0);
    expect(migratePrefs({ radius: 99 }).radius).toBe(24);
    expect(migratePrefs({ radius: -3 }).radius).toBe(0);
    expect(migratePrefs({ codeFontSize: 99 }).codeFontSize).toBe(24);
    expect(migratePrefs({ codeFontSize: 1 }).codeFontSize).toBe(11);
  });

  test("壁纸配置与生效模式校验", () => {
    const p = migratePrefs({
      wallpaper: {
        enabled: true,
        opacity: 150,
        blur: -5,
        dim: 200,
        mode: "sideways",
      },
    });
    expect(p.wallpaper).toEqual({
      enabled: true,
      opacity: 100,
      blur: 0,
      dim: 80,
      mode: "both",
    });
    expect(migratePrefs({ wallpaper: "yes" }).wallpaper).toBeNull();
  });

  test("提示音/通知字段不受主题迁移影响", () => {
    const p = migratePrefs({
      soundEnabled: false,
      soundPack: "calm",
      soundVolume: 0.2,
      popupEnabled: true,
    });
    expect(p.soundEnabled).toBe(false);
    expect(p.soundPack).toBe("calm");
    expect(p.soundVolume).toBe(0.2);
    expect(p.popupEnabled).toBe(true);
  });
});

describe("resolveEffectiveWallpaper（测试环境无 localStorage，用户图恒为空）", () => {
  test("主题内置壁纸兜底：china 未设置时用内置图与默认观感", () => {
    const eff = resolveEffectiveWallpaper(migratePrefs({ themePreset: "china" }));
    expect(eff?.fromTheme).toBe(true);
    expect(eff?.image).toBe("/wallpapers/china-ink.svg");
    expect(eff?.config).toEqual({
      enabled: true,
      opacity: 100,
      blur: 0,
      dim: 0,
      mode: "both",
    });
  });

  test("显式关闭（enabled:false）不算未设置，内置壁纸不兜底", () => {
    const off = migratePrefs({
      themePreset: "china",
      wallpaper: { enabled: false },
    });
    expect(resolveEffectiveWallpaper(off)).toBeNull();
  });

  test("无内置壁纸的预设不兜底", () => {
    expect(resolveEffectiveWallpaper(migratePrefs({ themePreset: "kova" }))).toBeNull();
    expect(resolveEffectiveWallpaper(migratePrefs({}))).toBeNull();
  });

  test("用户只调过参数没传图：内置图占位 + 用户观感覆盖", () => {
    const tuned = migratePrefs({
      themePreset: "china",
      wallpaper: { enabled: true, dim: 30, mode: "dark" },
    });
    const eff = resolveEffectiveWallpaper(tuned);
    expect(eff?.fromTheme).toBe(true);
    expect(eff?.image).toBe("/wallpapers/china-ink.svg");
    expect(eff?.config).toEqual({
      enabled: true,
      opacity: 100,
      blur: 0,
      dim: 30,
      mode: "dark",
    });
  });
});
