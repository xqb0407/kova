import { describe, expect, test } from "bun:test";
import {
  capturePageContentPixels,
  clipScaleForDevicePixels,
  fallbackCaptureCssHeight,
  normalizeDevicePixelRatio,
} from "../main/share-metrics";

describe("分享截图 DPR 换算", () => {
  test("Retina 2x：clip.scale 减半后输出仍是目标倍率", () => {
    // 实测 CDP：clip 100×100 + scale=1 @DPR2 → PNG 200×200；
    // 想让输出为 2x（200×200）时必须传 scale=1；想要 4x 才传 2。
    expect(clipScaleForDevicePixels(2, 2)).toBe(1);
    expect(clipScaleForDevicePixels(1, 2)).toBe(0.5);
    expect(clipScaleForDevicePixels(2, 1)).toBe(2);
  });

  test("非法 DPR 回落到 1", () => {
    expect(normalizeDevicePixelRatio(undefined)).toBe(1);
    expect(normalizeDevicePixelRatio(0)).toBe(1);
    expect(normalizeDevicePixelRatio(-2)).toBe(1);
    expect(normalizeDevicePixelRatio(Number.NaN)).toBe(1);
    expect(normalizeDevicePixelRatio(3)).toBe(3);
  });

  test("capturePage 按设备像素计算内容尺寸", () => {
    // Electron 真机实测：400×800 CSS 的窗口在 Retina 上返回 800×1600。
    expect(capturePageContentPixels(1200, 2)).toBe(2400);
    expect(capturePageContentPixels(1200, 1)).toBe(1200);
  });

  test("兜底窗口高度按 dpr 折算，保证设备像素不超上限", () => {
    const MAX = 16_384;
    expect(fallbackCaptureCssHeight(20_000, 2, MAX)).toBe(8_192);
    expect(fallbackCaptureCssHeight(1_000, 2, MAX)).toBe(1_000);
    expect(fallbackCaptureCssHeight(20_000, 1, MAX)).toBe(16_384);
  });
});
