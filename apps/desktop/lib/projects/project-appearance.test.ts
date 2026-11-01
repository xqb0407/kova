import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  PROJECT_IMAGE_MAX_CHARS,
  PROJECT_MASCOT_COLORS,
  PROJECT_MASCOT_GLYPHS,
  isProjectColor,
  isProjectGlyphId,
  isProjectImageDataUrl,
  hasProjectAppearance,
  normalizeProjectAppearance,
  projectAppearanceFor,
  resetProjectAppearancesForTest,
  setProjectAppearance,
} from "./project-appearance";

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 最小 localStorage 替身：测 hydration（预置）与落盘 */
function installStorageStub(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  const writes: string[] = [];
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
        writes.push(value);
      },
    },
  };
  return { store, writes };
}

describe("项目外观", () => {
  beforeEach(() => {
    resetProjectAppearancesForTest();
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    resetProjectAppearancesForTest();
  });

  describe("素材清单", () => {
    it("吉祥物 id/label 唯一且非空", () => {
      const ids = PROJECT_MASCOT_GLYPHS.map((g) => g.id);
      const labels = PROJECT_MASCOT_GLYPHS.map((g) => g.label);
      expect(ids.length).toBeGreaterThanOrEqual(8);
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(labels).size).toBe(labels.length);
    });

    it("预设色都是 6 位 hex（徽章底色要拼透明度后缀）", () => {
      expect(PROJECT_MASCOT_COLORS.length).toBeGreaterThanOrEqual(6);
      for (const color of PROJECT_MASCOT_COLORS) {
        expect(/^#[0-9a-f]{6}$/iu.test(color)).toBe(true);
      }
    });
  });

  describe("校验", () => {
    it("isProjectGlyphId / isProjectColor", () => {
      expect(isProjectGlyphId("cat")).toBe(true);
      expect(isProjectGlyphId("不存在")).toBe(false);
      expect(isProjectColor("#3b82f6")).toBe(true);
      // 自定义取色器给的是任意 6 位 hex，不再只认预设色
      expect(isProjectColor("#123456")).toBe(true);
      expect(isProjectColor("#12345")).toBe(false);
      expect(isProjectColor("red")).toBe(false);
      expect(isProjectColor("#12345g")).toBe(false);
    });

    it("图片 dataURL：只收 png/jpeg/webp、有长度上限", () => {
      expect(isProjectImageDataUrl(PNG_1PX)).toBe(true);
      expect(isProjectImageDataUrl("https://example.com/a.png")).toBe(false);
      expect(isProjectImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
      expect(
        isProjectImageDataUrl(`data:image/png;base64,${"A".repeat(PROJECT_IMAGE_MAX_CHARS)}`),
      ).toBe(false);
    });

    it("normalizeProjectAppearance：坏字段逐项丢弃，全空回 null", () => {
      expect(normalizeProjectAppearance(null)).toBe(null);
      expect(normalizeProjectAppearance({})).toBe(null);
      expect(
        normalizeProjectAppearance({ glyph: "猫不存在", color: "#000000", image: 42 }),
      ).toEqual({ color: "#000000" });
      expect(normalizeProjectAppearance({ glyph: "cat", color: "乱写" })).toEqual({
        glyph: "cat",
      });
      expect(
        normalizeProjectAppearance({ glyph: "cat", color: "#ef4444", image: PNG_1PX }),
      ).toEqual({ glyph: "cat", color: "#ef4444", image: PNG_1PX });
      // 自定义颜色：任意 6 位 hex 合法；大写统一归一成小写
      expect(normalizeProjectAppearance({ color: "#0f0f0f" })).toEqual({
        color: "#0f0f0f",
      });
      expect(normalizeProjectAppearance({ color: "#AABBCC" })).toEqual({
        color: "#aabbcc",
      });
    });
  });

  describe("存储", () => {
    it("默认无外观；设置后可读、按项目隔离、整对象替换", () => {
      expect(projectAppearanceFor("/w/a")).toBe(null);
      setProjectAppearance("/w/a", { glyph: "cat" });
      expect(projectAppearanceFor("/w/a")).toEqual({ glyph: "cat" });
      setProjectAppearance("/w/a", { glyph: "cat", color: "#3b82f6" });
      expect(projectAppearanceFor("/w/a")).toEqual({
        glyph: "cat",
        color: "#3b82f6",
      });
      expect(projectAppearanceFor("/w/b")).toBe(null);
    });

    it("传 null 或归一化后为空 → 清除", () => {
      setProjectAppearance("/w/a", { glyph: "不存在" as string });
      setProjectAppearance("/w/a", null);
      expect(projectAppearanceFor("/w/a")).toBe(null);
      setProjectAppearance("/w/a", { glyph: "cat" });
      setProjectAppearance("/w/a", { glyph: "乱写" });
      expect(projectAppearanceFor("/w/a")).toBe(null);
    });

    it("相同值不重复落盘", () => {
      const { writes } = installStorageStub();
      setProjectAppearance("/w/a", { glyph: "cat" });
      const count = writes.length;
      setProjectAppearance("/w/a", { glyph: "cat" });
      expect(writes.length).toBe(count);
    });

    it("水合：合法条目收下，非法条目丢弃", () => {
      installStorageStub({
        "project-appearance-v1": JSON.stringify({
          "/w/a": { glyph: "cat" },
          "/w/b": { glyph: "不存在" },
          "/w/c": { color: "#22c55e", extra: 1 },
          "/w/d": "乱写",
        }),
      });
      expect(projectAppearanceFor("/w/a")).toEqual({ glyph: "cat" });
      expect(projectAppearanceFor("/w/b")).toBe(null);
      expect(projectAppearanceFor("/w/c")).toEqual({ color: "#22c55e" });
      expect(projectAppearanceFor("/w/d")).toBe(null);
    });

    it("超出上限按写入顺序淘汰最早的（LRU）", () => {
      installStorageStub();
      for (let i = 0; i < 201; i++) {
        setProjectAppearance(`/w/p${i}`, { glyph: "cat" });
      }
      expect(projectAppearanceFor("/w/p0")).toBe(null);
      expect(projectAppearanceFor("/w/p200")).toEqual({ glyph: "cat" });
    });

    it("存储不可用时内存态照常工作", () => {
      setProjectAppearance("/w/a", { glyph: "bot", color: "#f97316" });
      expect(projectAppearanceFor("/w/a")).toEqual({
        glyph: "bot",
        color: "#f97316",
      });
    });
  });
});

describe("内置头像", () => {
  beforeEach(() => {
    resetProjectAppearancesForTest();
  });

  it("normalize：头像字段收下；与矢量互斥时头像优先", () => {
    expect(normalizeProjectAppearance({ avatar: "gaze-01" })).toEqual({
      avatar: "gaze-01",
    });
    expect(
      normalizeProjectAppearance({ avatar: "gaze-01", glyph: "cat", color: "#3b82f6" }),
    ).toEqual({ avatar: "gaze-01", color: "#3b82f6" });
    expect(normalizeProjectAppearance({ avatar: "不存在" })).toBe(null);
  });

  it("存储：内置头像可读、可清", () => {
    setProjectAppearance("/w/a", { avatar: "gaze-03", color: "#22c55e" });
    expect(projectAppearanceFor("/w/a")).toEqual({
      avatar: "gaze-03",
      color: "#22c55e",
    });
    setProjectAppearance("/w/a", { color: "#22c55e" });
    expect(projectAppearanceFor("/w/a")).toEqual({ color: "#22c55e" });
  });
});

describe("hasProjectAppearance（UI 判条件统一口径）", () => {
  it("图片 / 内置头像 / 矢量吉祥物任一都算有标记", () => {
    expect(hasProjectAppearance({ image: "data:image/png;base64,AA" })).toBe(true);
    expect(hasProjectAppearance({ avatar: "gaze-01" })).toBe(true);
    expect(hasProjectAppearance({ glyph: "cat" })).toBe(true);
  });

  it("只选颜色不算（颜色是给图标上色用的）；空值不算", () => {
    expect(hasProjectAppearance({ color: "#3b82f6" })).toBe(false);
    expect(hasProjectAppearance({})).toBe(false);
    expect(hasProjectAppearance(null)).toBe(false);
  });
});
