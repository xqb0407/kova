import { describe, expect, test } from "bun:test";

import {
  adaptAccent,
  hexToRgba,
  hexToRgb,
  normalizeHex,
  readableTextOn,
  rgbToHsl,
  hslToRgb,
} from "./color";

describe("normalizeHex", () => {
  test("三位展开、统一小写", () => {
    expect(normalizeHex("#F80")).toBe("#ff8800");
    expect(normalizeHex("7C5CFF")).toBe("#7c5cff");
  });

  test("非法值返回 null", () => {
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex("")).toBeNull();
  });
});

describe("hexToRgba", () => {
  test("转出带 alpha 的 rgb 语法", () => {
    expect(hexToRgba("#ffffff", 0.84)).toBe("rgb(255 255 255 / 0.84)");
    expect(hexToRgba("#000", 1)).toBe("rgb(0 0 0 / 1)");
  });

  test("非法 hex 原样返回（调用方已校验）", () => {
    expect(hexToRgba("nope", 0.5)).toBe("nope");
  });
});

describe("adaptAccent", () => {
  test("浅色模式把过亮/过暗的色夹到中等亮度", () => {
    const nearWhite = adaptAccent("#fefefe", "light")!;
    const nearBlack = adaptAccent("#050505", "light")!;
    const l1 = rgbToHsl(hexToRgb(nearWhite)!).l;
    const l2 = rgbToHsl(hexToRgb(nearBlack)!).l;
    expect(l1).toBeLessThanOrEqual(0.63);
    expect(l2).toBeGreaterThanOrEqual(0.33);
  });

  test("深色模式把颜色提到更亮的区间", () => {
    const dark = adaptAccent("#1e3a8a", "dark")!;
    const l = rgbToHsl(hexToRgb(dark)!).l;
    expect(l).toBeGreaterThanOrEqual(0.57);
  });

  test("色相基本保持", () => {
    const input = "#3b82f6";
    const out = adaptAccent(input, "light")!;
    const h1 = rgbToHsl(hexToRgb(input)!).h;
    const h2 = rgbToHsl(hexToRgb(out)!).h;
    expect(Math.abs(h1 - h2)).toBeLessThan(0.02);
  });

  test("非法输入返回 null", () => {
    expect(adaptAccent("blue", "light")).toBeNull();
  });
});

describe("readableTextOn", () => {
  test("阈值取黑白对比相等的交点（0.179）", () => {
    expect(readableTextOn("#efdf00")).toBe("#111");
    expect(readableTextOn("#000000")).toBe("#fff");
    // 中亮度紫：黑字对比更高
    expect(readableTextOn("#7c5cff")).toBe("#111");
    expect(readableTextOn("#ffffff")).toBe("#111");
    expect(readableTextOn("#111111")).toBe("#fff");
  });
});

describe("hsl 往返", () => {
  test("rgb → hsl → rgb 不漂移（取整误差内）", () => {
    const rgb = hexToRgb("#3b82f6")!;
    const back = hslToRgb(rgbToHsl(rgb));
    expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
  });
});
