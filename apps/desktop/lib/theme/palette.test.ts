import { describe, expect, test } from "bun:test";

import {
  buildBootCache,
  resolveBaseColors,
  resolveFonts,
  resolveTheme,
  wallpaperVeil,
  type ThemeInput,
} from "./palette";

const base: ThemeInput = {
  themePreset: "kova",
  themeOverrides: { light: {}, dark: {} },
  accent: "default",
  accentCustom: null,
  contrast: 50,
  radius: null,
  fontFamily: "default",
  codeFontFamily: "theme",
  wallpaper: null,
};

const theme = (patch: Partial<ThemeInput> = {}) =>
  resolveTheme({ ...base, ...patch }, "light");

describe("resolveBaseColors", () => {
  test("默认预设：白底黑字", () => {
    expect(resolveBaseColors(base, "light")).toEqual({
      background: "#ffffff",
      foreground: "#171717",
    });
  });

  test("自定义覆盖优先，非法值忽略", () => {
    const input = {
      ...base,
      themeOverrides: {
        light: { background: "#101010", foreground: "nope" },
        dark: {},
      },
    };
    expect(resolveBaseColors(input, "light")).toEqual({
      background: "#101010",
      foreground: "#171717",
    });
  });
});

describe("resolveTheme", () => {
  test("默认主题保持单色强调：primary = 前景、primary-foreground = 背景", () => {
    const tokens = theme();
    expect(tokens["--background"]).toBe("#ffffff");
    expect(tokens["--foreground"]).toBe("#171717");
    expect(tokens["--primary"]).toBe("#171717");
    expect(tokens["--primary-foreground"]).toBe("#ffffff");
  });

  test("派生表面色用 foreground/background 的 color-mix", () => {
    const light = resolveTheme(base, "light");
    expect(light["--muted"]).toBe(
      "color-mix(in oklab, var(--foreground) 3.5%, #ffffff)",
    );
    expect(light["--card"]).toBe(
      "color-mix(in oklab, var(--foreground) 0%, #ffffff)",
    );
    const dark = resolveTheme(base, "dark");
    expect(dark["--muted"]).toBe(
      "color-mix(in oklab, var(--foreground) 14.8%, #0a0a0a)",
    );
    expect(dark["--card"]).toBe(
      "color-mix(in oklab, var(--foreground) 7.1%, #0a0a0a)",
    );
  });

  test("对比度缩放表面比例（50 = 1.0，100 = 1.6，0 = 0.4）", () => {
    const high = resolveTheme({ ...base, contrast: 100 }, "light");
    expect(high["--muted"]).toContain("5.6%");
    const low = resolveTheme({ ...base, contrast: 0 }, "light");
    expect(low["--muted"]).toContain("1.4%");
  });

  test("自定义强调色：primary 用自定义色，文字色按亮度取", () => {
    const tokens = resolveTheme({ ...base, accentCustom: "#ff0000" }, "light");
    expect(tokens["--primary"]).toBe("#ff0000");
    // 纯红亮度 ≈0.213 > 0.179：黑字对比更高（旧阈值会错给白字）
    expect(tokens["--primary-foreground"]).toBe("#111");
    expect(tokens["--ring"]).toBe("#ff0000");
  });

  test("命名强调色沿用浅深两档", () => {
    const light = resolveTheme({ ...base, accent: "blue" }, "light");
    const dark = resolveTheme({ ...base, accent: "blue" }, "dark");
    expect(light["--primary"]).toBe("oklch(0.55 0.22 257)");
    expect(dark["--primary"]).toBe("oklch(0.65 0.19 257)");
    expect(light["--ring"]).toBe("oklch(0.62 0.19 257)");
  });

  test("壁纸只作用于聊天卡片，不改变全局底色", () => {
    const tokens = resolveTheme(base, "light");
    expect(tokens["--background"]).toBe("#ffffff");
    expect(tokens["--card"]).toBe(
      "color-mix(in oklab, var(--foreground) 0%, #ffffff)",
    );
  });

  test("圆角：显式值优先，否则跟随预设", () => {
    expect(resolveTheme({ ...base, radius: 16 }, "light")["--radius"]).toBe(
      "1rem",
    );
    expect(resolveTheme({ ...base }, "light")["--radius"]).toBe("0.625rem");
    expect(
      resolveTheme({ ...base, themePreset: "paper" }, "light")["--radius"],
    ).toBe("0.375rem");
  });

  test("主题字体配对通过 --app-font-* 输出", () => {
    const tokens = resolveTheme({ ...base, themePreset: "paper" }, "light");
    expect(tokens["--app-font-sans"]).toContain("Noto Serif SC");
    expect(tokens["--app-font-mono"]).toContain("Cascadia Mono");
    const midnight = resolveTheme(
      { ...base, themePreset: "midnight" },
      "light",
    );
    expect(midnight["--app-font-mono"]).toContain("JetBrains Mono");
  });
});

describe("resolveFonts", () => {
  test("跟随主题时取预设字体，自定义后以其为准", () => {
    expect(resolveFonts({ ...base, themePreset: "mist" }).ui).toBe("inter");
    expect(
      resolveFonts({ ...base, themePreset: "mist", fontFamily: "serif" }).ui,
    ).toBe("serif");
    expect(resolveFonts({ ...base, themePreset: "paper" }).weight).toBe(500);
    expect(resolveFonts(base).weight).toBeNull();
  });
});

describe("wallpaperVeil", () => {
  test("强度越高，卡片底色越薄", () => {
    expect(wallpaperVeil(100)).toBe("50%");
    expect(wallpaperVeil(20)).toBe("80.4%");
    expect(wallpaperVeil(120)).toBe("50%");
    expect(wallpaperVeil(-10)).toBe("88%");
  });
});

describe("buildBootCache", () => {
  test("同时缓存两套模式与非令牌字段", () => {
    const cache = buildBootCache({
      ...base,
      contrast: 60,
      fontSize: "17px",
      chatWidth: 64,
      wallpaper: {
        enabled: true,
        opacity: 80,
        blur: 12,
        dim: 30,
        mode: "light",
      },
    });
    expect(cache.v).toBe(1);
    expect(cache.light["--background"]).toBe("#ffffff");
    expect(cache.dark["--background"]).toBe("#0a0a0a");
    expect(cache.fontSize).toBe("17px");
    expect(cache.chatWidth).toBe("64%");
    expect(cache.wallpaper?.mode).toBe("light");
    expect(cache.wallpaper?.vars["--wallpaper-blur"]).toBe("12px");
    expect(cache.wallpaper?.vars["--wallpaper-dim"]).toBe("0.3");
    expect(cache.wallpaper?.vars["--wallpaper-veil"]).toBe("57.6%");
  });
});
