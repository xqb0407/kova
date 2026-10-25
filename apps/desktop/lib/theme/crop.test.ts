import { describe, expect, test } from "bun:test";

import {
  clampOffsets,
  clampZoom,
  coverScale,
  cropViewSize,
  sourceRect,
} from "./crop";

describe("coverScale", () => {
  test("取较大的缩放比，保证铺满预览框", () => {
    expect(coverScale(2000, 1000, 500, 500)).toBe(0.5);
    expect(coverScale(1000, 2000, 500, 500)).toBe(0.5);
  });

  test("非法尺寸回落到 1", () => {
    expect(coverScale(0, 100, 500, 500)).toBe(1);
  });
});

describe("clampZoom", () => {
  test("限制在 1–3", () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(5)).toBe(3);
    expect(clampZoom(1.5)).toBe(1.5);
  });
});

describe("clampOffsets", () => {
  test("水平方向留出可移动范围，垂直方向不越界", () => {
    expect(
      clampOffsets(2000, 1000, 500, 500, {
        zoom: 1,
        offsetX: 1000,
        offsetY: 300,
      }),
    ).toEqual({ offsetX: 250, offsetY: 0 });
  });

  test("放大后两个方向都有可移动范围", () => {
    const clamped = clampOffsets(2000, 1000, 500, 500, {
      zoom: 2,
      offsetX: -9999,
      offsetY: 9999,
    });
    expect(clamped).toEqual({ offsetX: -750, offsetY: 250 });
  });
});

describe("sourceRect", () => {
  test("zoom=1 时裁掉超出的水平部分", () => {
    const rect = sourceRect(2000, 1000, 500, 500, {
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
    });
    expect(rect.sx).toBe(500);
    expect(rect.sy).toBe(0);
    expect(rect.sw).toBe(1000);
    expect(rect.sh).toBe(1000);
  });

  test("zoom=2 时是居中的 500×500 源区域", () => {
    const rect = sourceRect(2000, 1000, 500, 500, {
      zoom: 2,
      offsetX: 0,
      offsetY: 0,
    });
    expect(rect).toEqual({ sx: 750, sy: 250, sw: 500, sh: 500 });
  });

  test("偏移后裁剪窗口跟着移动且不越界", () => {
    // 向左拖图片 = 看到更靠右的区域
    const rect = sourceRect(2000, 1000, 500, 500, {
      zoom: 2,
      offsetX: -99999,
      offsetY: 0,
    });
    expect(rect.sx).toBe(1500);
    expect(rect.sx + rect.sw).toBeLessThanOrEqual(2000);
  });
});

describe("cropViewSize", () => {
  test("按窗口比例并限制在 1.2–2.4", () => {
    expect(cropViewSize(1440, 900, 600)).toEqual({ width: 600, height: 375 });
    expect(cropViewSize(1000, 1000, 600)).toEqual({ width: 600, height: 500 });
    expect(cropViewSize(500, 900, 600)).toEqual({ width: 340, height: 283 });
  });

  test("短窗口按高度上限反推宽度，保证 footer 可见", () => {
    expect(cropViewSize(1440, 900, 600, 300)).toEqual({
      width: 480,
      height: 300,
    });
    expect(cropViewSize(980, 700, 600, 340)).toEqual({
      width: 476,
      height: 340,
    });
  });
});
