/**
 * 内置模板库测试：主题×版式全组合可构造、元素几何合法、颜色全部来自主题 token、
 * id 框内唯一、整套起步页数与命名、序列化往返不丢元素、非法入参返回 null。
 */
import { describe, expect, test } from "bun:test";
import { parseDoc, serializeDoc } from "../src/doc";
import { buildStarterDeck, buildTemplateFrame, LAYOUT_META, STARTER_DECK_LAYOUTS, TEMPLATE_THEMES, themeById } from "../src/templates";

describe("templates", () => {
  test("每个主题×每个版式都能构造出非空页", () => {
    for (const theme of TEMPLATE_THEMES) {
      for (const layout of LAYOUT_META) {
        const f = buildTemplateFrame(theme.id, layout.id);
        expect(f).not.toBeNull();
        expect(f!.elements.length).toBeGreaterThan(3);
        expect(f!.background).toBe(theme.tokens.bg);
      }
    }
  });

  test("元素几何合法：坐标有限、尺寸为正、数量不随调用次数漂移（纯函数）", () => {
    const f1 = buildTemplateFrame("qingchuan", "cards3")!;
    const f2 = buildTemplateFrame("qingchuan", "cards3")!;
    expect(f1.elements.length).toBe(f2.elements.length);
    for (const el of f1.elements) {
      expect(Number.isFinite(el.x)).toBe(true);
      expect(Number.isFinite(el.y)).toBe(true);
      expect(el.w).toBeGreaterThan(0);
      expect(el.h).toBeGreaterThan(0);
    }
  });

  test("所有颜色都来自该主题的 token 集合（防硬编码走色）", () => {
    for (const theme of TEMPLATE_THEMES) {
      const allowed = new Set(Object.values(theme.tokens).filter((v): v is string => typeof v === "string"));
      for (const layout of LAYOUT_META) {
        const f = buildTemplateFrame(theme.id, layout.id)!;
        for (const el of f.elements) {
          const colors: string[] = [];
          if (el.kind === "text") colors.push(...el.runs.map((r) => r.color).filter((c): c is string => !!c));
          if (el.kind === "shape") {
            if (el.fill && el.fill !== "none") colors.push(el.fill);
            if (el.stroke && el.stroke !== "none") colors.push(el.stroke);
          }
          for (const c of colors) expect(allowed.has(c)).toBe(true);
        }
      }
    }
  });

  test("页内元素 id 唯一", () => {
    for (const theme of TEMPLATE_THEMES) {
      for (const layout of LAYOUT_META) {
        const f = buildTemplateFrame(theme.id, layout.id)!;
        const ids = new Set(f.elements.map((e) => e.id));
        expect(ids.size).toBe(f.elements.length);
      }
    }
  });

  test("整套起步：页数与 STARTER_DECK_LAYOUTS 一致，命名带主题标签，页横排不重叠", () => {
    const deck = buildStarterDeck("yehang");
    expect(deck.length).toBe(STARTER_DECK_LAYOUTS.length);
    deck.forEach((f, i) => {
      expect(f.name).toContain("夜航");
      if (i > 0) expect(f.x).toBeGreaterThan(deck[i - 1]!.x);
    });
  });

  test("构造的页可通过 parseDoc 容错解析且元素不丢（序列化往返）", () => {
    const f = buildTemplateFrame("nuanyang", "timeline")!;
    const parsed = parseDoc(JSON.parse(serializeDoc({ version: 2, meta: { name: "t", pagePreset: "16:9" }, objects: [], frames: [f] })));
    expect(parsed).not.toBeNull();
    expect(parsed!.frames[0]!.elements.length).toBe(f.elements.length);
  });

  test("非法主题/版式 id 返回 null；themeById 兜底第一套", () => {
    expect(buildTemplateFrame("nope", "cover")).toBeNull();
    expect(buildTemplateFrame("qingchuan", "nope")).toBeNull();
    expect(themeById("nope").id).toBe(TEMPLATE_THEMES[0]!.id);
  });

  test("4:3 / A4L 页幅下版式同样可构造", () => {
    for (const preset of ["4:3", "A4L"] as const) {
      for (const layout of LAYOUT_META) {
        const f = buildTemplateFrame("qingtai", layout.id, preset);
        expect(f).not.toBeNull();
        expect(f!.w).toBe(preset === "4:3" ? 1024 : 1123);
      }
    }
  });
});
