/**
 * 整份换肤测试：页底统一、文字明度角色映射、强调色频次映射、形状填充/描边语义、
 * 非 hex 原样保留、入参不被修改。
 */
import { describe, expect, test } from "bun:test";
import { hexToRgb, luminance, rethemeDoc, saturation } from "../src/editor/retheme";
import type { CanvasDoc } from "../src/doc";
import { TEMPLATE_THEMES } from "../src/templates";

const qingchuan = TEMPLATE_THEMES.find((t) => t.id === "qingchuan")!.tokens;
const yehang = TEMPLATE_THEMES.find((t) => t.id === "yehang")!.tokens;

function lightDeck(): CanvasDoc {
  return {
    version: 2,
    meta: { name: "t", pagePreset: "16:9", kind: "deck" },
    objects: [],
    frames: [
      {
        id: "f1",
        type: "slide",
        x: 0,
        y: 0,
        w: 1280,
        h: 720,
        background: "#ffffff",
        elements: [
          {
            kind: "text",
            id: "t1",
            x: 0,
            y: 0,
            w: 100,
            h: 40,
            runs: [
              { text: "标题", color: "#111111" },
              { text: "说明", color: "#6b7280" },
              { text: "强调", color: "#2563eb" },
              { text: "次要强调", color: "#dc2626" },
              { text: "隐藏", color: "#ffffff" },
            ],
          },
          {
            kind: "shape",
            id: "s1",
            shape: "rect",
            x: 0,
            y: 0,
            w: 100,
            h: 50,
            fill: "#f5f5f7",
            stroke: "#1d1d1f",
            strokeWidth: 2,
          },
          {
            kind: "shape",
            id: "s2",
            shape: "rect",
            x: 0,
            y: 0,
            w: 100,
            h: 50,
            fill: "#2563eb",
            stroke: "none",
            strokeWidth: 1,
          },
        ],
      },
      { id: "f2", type: "slide", x: 0, y: 720, w: 1280, h: 720, background: "#ffffff", elements: [] },
    ],
  };
}

describe("retheme：浅色旧档 → 深色主题", () => {
  const doc = lightDeck();
  const before = JSON.stringify(doc);
  const next = rethemeDoc(doc, yehang);

  test("入参不被修改（深拷贝语义）", () => {
    expect(JSON.stringify(doc)).toBe(before);
    expect(next).not.toBe(doc);
  });

  test("所有页底换成主题 bg", () => {
    for (const f of next.frames) expect(f.background).toBe(yehang.bg);
  });

  test("文字按明度角色映射到 ink/sub/faint；强调色按频次 → accent/accent2", () => {
    const runs = (next.frames[0]!.elements[0] as Extract<CanvasDoc["frames"][number]["elements"][number], { kind: "text" }>).runs;
    expect(runs[0]!.color).toBe(yehang.ink);
    expect(runs[1]!.color).toBe(yehang.sub);
    expect(runs[2]!.color).toBe(yehang.accent); // 蓝用得最多 → 主强调
    expect(runs[3]!.color).toBe(yehang.accent2); // 红第二 → 副强调
    expect(runs[4]!.color).toBe(yehang.bg); // 与旧底色同色（隐藏文字）保持隐藏意图
  });

  test("形状：浅填充 → panel、深描边 → ink、饱和填充走强调映射、none 保留", () => {
    const s1 = next.frames[0]!.elements[1] as Extract<CanvasDoc["frames"][number]["elements"][number], { kind: "shape" }>;
    const s2 = next.frames[0]!.elements[2] as Extract<CanvasDoc["frames"][number]["elements"][number], { kind: "shape" }>;
    expect(s1.fill).toBe(yehang.panel);
    expect(s1.stroke).toBe(yehang.ink);
    expect(s2.fill).toBe(yehang.accent);
    expect(s2.stroke).toBe("none");
  });
});

describe("retheme：深色旧档 → 浅色主题", () => {
  test("浅色文字映射回深色 ink（明暗极性翻转正确）", () => {
    const doc: CanvasDoc = {
      version: 2,
      meta: { name: "d", pagePreset: "16:9", kind: "deck" },
      objects: [],
      frames: [
        {
          id: "f1",
          type: "slide",
          x: 0,
          y: 0,
          w: 1280,
          h: 720,
          background: "#0b1526",
          elements: [
            {
              kind: "text",
              id: "t1",
              x: 0,
              y: 0,
              w: 100,
              h: 40,
              runs: [
                { text: "亮标题", color: "#e6edf7" },
                { text: "灰说明", color: "#94a3b8" },
                { text: "暗字", color: "#1e293b" },
              ],
            },
          ],
        },
      ],
    };
    const next = rethemeDoc(doc, qingchuan);
    const runs = (next.frames[0]!.elements[0] as Extract<CanvasDoc["frames"][number]["elements"][number], { kind: "text" }>).runs;
    expect(runs[0]!.color).toBe(qingchuan.ink);
    expect(runs[1]!.color).toBe(qingchuan.sub);
    expect(runs[2]!.color).toBe(qingchuan.faint);
  });
});

describe("retheme：颜色工具与边界", () => {
  test("luminance/saturation/hexToRgb", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1, 5);
    expect(saturation("#808080")).toBe(0);
    expect(saturation("#ff0000")).toBe(1);
    expect(hexToRgb("#abc")).toEqual([170, 187, 204]);
    expect(hexToRgb("gradient(x)")).toBeNull();
  });

  test("中文/未识别色与渐变串原样保留", () => {
    const doc = lightDeck();
    const el = doc.frames[0]!.elements[1] as Extract<CanvasDoc["frames"][number]["elements"][number], { kind: "shape" }>;
    el.fill = "linear-gradient(#fff, #000)";
    const next = rethemeDoc(doc, yehang);
    const s1 = next.frames[0]!.elements[1] as Extract<CanvasDoc["frames"][number]["elements"][number], { kind: "shape" }>;
    expect(s1.fill).toBe("linear-gradient(#fff, #000)");
  });
});
