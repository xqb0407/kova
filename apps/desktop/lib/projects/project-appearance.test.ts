import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  PROJECT_IMAGE_MAX_CHARS,
  PROJECT_MASCOT_COLORS,
  PROJECT_MASCOT_GLYPHS,
  PROJECT_PIXEL_MASCOTS,
  isProjectColor,
  isProjectGlyphId,
  isProjectImageDataUrl,
  hasProjectAppearance,
  isProjectPixelId,
  normalizeProjectAppearance,
  pixelMascotRows,
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
      expect(isProjectColor("#123456")).toBe(false);
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
      ).toBe(null);
      expect(normalizeProjectAppearance({ glyph: "cat", color: "乱写" })).toEqual({
        glyph: "cat",
      });
      expect(
        normalizeProjectAppearance({ glyph: "cat", color: "#ef4444", image: PNG_1PX }),
      ).toEqual({ glyph: "cat", color: "#ef4444", image: PNG_1PX });
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

describe("像素吉祥物（8×8）", () => {
  beforeEach(() => {
    resetProjectAppearancesForTest();
  });

  it("网格规整：8×8、只含 #/.（眼睛与缝隙靠挖洞表达）", () => {
    // 两组像素（技术主题 + 形态主题）并列，至少 16 个
    expect(PROJECT_PIXEL_MASCOTS.length).toBeGreaterThanOrEqual(16);
    // 形态主题那 8 个（补进来的经典造型）必须在列
    const ids = new Set(PROJECT_PIXEL_MASCOTS.map((m) => m.id));
    for (const id of ["tile", "bolt", "cactus", "cloud", "penguin", "cup", "fox", "moon"]) {
      expect(ids.has(id), id).toBe(true);
    }
    for (const mascot of PROJECT_PIXEL_MASCOTS) {
      expect(mascot.rows, mascot.id).toBeDefined();
      expect(mascot.rows!).toHaveLength(8);
      for (const row of mascot.rows!) {
        expect(row, mascot.id).toHaveLength(8);
        expect(/^[#.]+$/u.test(row)).toBe(true);
      }
    }
  });

  it("像素组与矢量组：id 不重叠、各自唯一，label 不重复", () => {
    const pixelIds = PROJECT_PIXEL_MASCOTS.map((m) => m.id);
    const glyphIds = PROJECT_MASCOT_GLYPHS.map((g) => g.id);
    expect(new Set(pixelIds).size).toBe(pixelIds.length);
    for (const id of pixelIds) {
      expect(glyphIds.includes(id)).toBe(false);
    }
    const labels = [
      ...PROJECT_PIXEL_MASCOTS.map((m) => m.label),
      ...PROJECT_MASCOT_GLYPHS.map((g) => g.label),
    ];
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("isProjectPixelId / pixelMascotRows：未知 id 回退", () => {
    expect(isProjectPixelId("fox")).toBe(true);
    expect(isProjectPixelId("cat")).toBe(false); // 矢量 id 不算像素
    expect(pixelMascotRows("moon")).toHaveLength(8);
    expect(pixelMascotRows("cat")).toBe(null);
  });

  it("normalize：像素字段收下；与矢量互斥时像素优先", () => {
    expect(normalizeProjectAppearance({ pixel: "fox" })).toEqual({
      pixel: "fox",
    });
    expect(
      normalizeProjectAppearance({ pixel: "fox", glyph: "cat", color: "#3b82f6" }),
    ).toEqual({ pixel: "fox", color: "#3b82f6" });
    expect(normalizeProjectAppearance({ pixel: "不存在" })).toBe(null);
  });

  it("存储：设置像素吉祥物后可读、可清；水合时冲突取像素", () => {
    setProjectAppearance("/w/a", { pixel: "penguin", color: "#22c55e" });
    expect(projectAppearanceFor("/w/a")).toEqual({
      pixel: "penguin",
      color: "#22c55e",
    });
    setProjectAppearance("/w/a", { color: "#22c55e" });
    expect(projectAppearanceFor("/w/a")).toEqual({ color: "#22c55e" });

    resetProjectAppearancesForTest();
    installStorageStub({
      "project-appearance-v1": JSON.stringify({
        "/w/a": { pixel: "moon", glyph: "cat" },
        "/w/b": { pixel: "乱写" },
      }),
    });
    expect(projectAppearanceFor("/w/a")).toEqual({ pixel: "moon" });
    expect(projectAppearanceFor("/w/b")).toBe(null);
  });
});

describe("hasProjectAppearance（UI 判条件统一口径）", () => {
  it("图片 / 矢量 / 像素任一都算有标记", () => {
    expect(hasProjectAppearance({ image: "data:image/png;base64,AA" })).toBe(true);
    expect(hasProjectAppearance({ glyph: "cat" })).toBe(true);
    expect(hasProjectAppearance({ pixel: "fox" })).toBe(true);
  });

  it("只选颜色不算（颜色是给图标上色用的）；空值不算", () => {
    expect(hasProjectAppearance({ color: "#3b82f6" })).toBe(false);
    expect(hasProjectAppearance({})).toBe(false);
    expect(hasProjectAppearance(null)).toBe(false);
  });
});
