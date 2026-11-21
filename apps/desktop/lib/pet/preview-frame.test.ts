import { describe, expect, test } from "bun:test";
import { previewFramePlan, previewMiniGrid } from "./preview-frame";

/** 库宠物常见几何：4608×5616、8 列 × 9 行、单格 576×624。 */
const BIG_GEOMETRY = { columns: 8, rows: 9, frameWidth: 576, frameHeight: 624 };

describe("previewFramePlan（图集路径缩放/裁剪计划）", () => {
  test("降采样：格宽取目标、格高按宽比取整、缩放目标网格整数对齐", () => {
    // 624 × 184 / 576 = 199.33… → 199（格高取整允许 ≤0.5px 失真，行界仍整数）
    const plan = previewFramePlan(BIG_GEOMETRY, 0, 184);
    expect(plan.frameWidth).toBe(184);
    expect(plan.frameHeight).toBe(199);
    // 整图缩放目标 = 列行 × 缩后格尺寸：行/列边界在缩放后位图上仍是整数像素
    expect(plan.resizeWidth).toBe(8 * 184);
    expect(plan.resizeHeight).toBe(9 * 199);
    expect(plan.cropY).toBe(0);
  });

  test("不放大：目标超过原格宽时钳在原值（1:1 缩放）", () => {
    const plan = previewFramePlan(BIG_GEOMETRY, 0, 1024);
    expect(plan.frameWidth).toBe(576);
    expect(plan.frameHeight).toBe(624);
    expect(plan.resizeWidth).toBe(4608);
    expect(plan.resizeHeight).toBe(5616);
  });

  test("行偏移裁剪：自定义 idle 行号时裁剪起点随行走", () => {
    const plan = previewFramePlan(BIG_GEOMETRY, 3, 184);
    expect(plan.cropY).toBe(3 * plan.frameHeight);
  });

  test("极端目标钳到 1px，不产生 0 尺寸", () => {
    const plan = previewFramePlan(BIG_GEOMETRY, 0, 0);
    expect(plan.frameWidth).toBe(1);
    expect(plan.frameHeight).toBe(1);
    expect(plan.resizeWidth).toBe(8);
    expect(plan.resizeHeight).toBe(9);
    expect(plan.cropY).toBe(0);
  });
});

describe("previewMiniGrid（preview.webp 网格校验）", () => {
  test("缩微版：1/3 比例的 1536×1872 → 单格 192×208", () => {
    // 库宠物实测：preview.webp = 图集整比缩小，格正好落在契约基准 192×208
    const grid = previewMiniGrid(1536, 1872, BIG_GEOMETRY);
    expect(grid).toEqual({ cellWidth: 192, cellHeight: 208 });
  });

  test("整尺寸图（s=1）也是合法缩微版", () => {
    const grid = previewMiniGrid(4608, 5616, BIG_GEOMETRY);
    expect(grid).toEqual({ cellWidth: 576, cellHeight: 624 });
  });

  test("高度对不上网格 → null（宁可回落大图也不裁出废帧）", () => {
    // 宽度定比例 s=1/3，高度应为 1872；给 1000 直接拒绝
    expect(previewMiniGrid(1536, 1000, BIG_GEOMETRY)).toBeNull();
    // ±2% + 2px 容差内的轻微偏差仍接受（1872 的 2% ≈ 37px）
    expect(previewMiniGrid(1536, 1872 + 30, BIG_GEOMETRY)).toEqual({ cellWidth: 192, cellHeight: 208 });
    expect(previewMiniGrid(1536, 1872 + 40, BIG_GEOMETRY)).toBeNull();
  });

  test("比例 >1（比图集还大）→ null", () => {
    expect(previewMiniGrid(9216, 11232, BIG_GEOMETRY)).toBeNull();
  });

  test("零尺寸 → null", () => {
    expect(previewMiniGrid(0, 0, BIG_GEOMETRY)).toBeNull();
    expect(previewMiniGrid(1536, 0, BIG_GEOMETRY)).toBeNull();
  });
});
