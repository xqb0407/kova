import { describe, expect, test } from "bun:test";
import {
  ATLAS_ROWS,
  lookCellRowCol,
  lookIndexFor,
  lookSupported,
  toPercent,
} from "./atlas";

describe("toPercent（background-position 百分比切格）", () => {
  test("首尾格落在 0% / 100%", () => {
    expect(toPercent(0, 8)).toBe(0);
    expect(toPercent(7, 8)).toBe(100);
  });

  test("中间格线性分布，与图集真实像素无关", () => {
    expect(toPercent(3, 8)).toBeCloseTo((3 * 100) / 7, 10);
    expect(toPercent(2, 9)).toBeCloseTo(25, 10);
  });

  test("单列图集恒为 0（除零保护）", () => {
    expect(toPercent(0, 1)).toBe(0);
    expect(toPercent(5, 1)).toBe(0);
  });
});

describe("ATLAS_ROWS（Codex 契约行序）", () => {
  test("行号固定：idle=0、右跑=1、左跑=2、失败=5、等待=6、工作=7、审查=8", () => {
    expect(ATLAS_ROWS.idle.row).toBe(0);
    expect(ATLAS_ROWS["moving-right"].row).toBe(1);
    expect(ATLAS_ROWS["moving-left"].row).toBe(2);
    expect(ATLAS_ROWS.failed.row).toBe(5);
    expect(ATLAS_ROWS.waiting.row).toBe(6);
    expect(ATLAS_ROWS.working.row).toBe(7);
    expect(ATLAS_ROWS.review.row).toBe(8);
  });

  test("循环集与一次性集的语义", () => {
    for (const m of ["idle", "working", "waiting", "moving-left", "moving-right"] as const) {
      expect(ATLAS_ROWS[m].loop).toBe(true);
    }
    for (const m of ["waving", "jumping", "failed", "review"] as const) {
      expect(ATLAS_ROWS[m].loop).toBe(false);
    }
  });

  test("idle 是慢速呼吸档：逐帧时长长度 = 帧数，首末帧长停留", () => {
    const idle = ATLAS_ROWS.idle;
    expect(idle.durations).toHaveLength(idle.frames);
    expect(idle.durations![0]).toBeGreaterThan(idle.interval);
    expect(idle.durations!.at(-1)!).toBeGreaterThan(idle.interval);
  });
});

describe("lookIndexFor（v2 视线格）", () => {
  test("四个正方向：上=0、右=4、下=8、左=12（顺时针 22.5° 一格）", () => {
    expect(lookIndexFor({ x: 0, y: -1 })).toBe(0);
    expect(lookIndexFor({ x: 1, y: 0 })).toBe(4);
    expect(lookIndexFor({ x: 0, y: 1 })).toBe(8);
    expect(lookIndexFor({ x: -1, y: 0 })).toBe(12);
  });

  test("中间方向落在 22.5° 刻度上", () => {
    expect(lookIndexFor({ x: 1, y: -1 })).toBe(2); // 右上 45°
    expect(lookIndexFor({ x: -1, y: 1 })).toBe(10); // 左下 225°
  });

  test("四舍五入到最近刻度：354° 离 0° 更近归 0，337.5° 精确落 15", () => {
    expect(lookIndexFor({ x: 0.1, y: -1 })).toBe(0); // ≈354°，离 360°(=0) 更近
    expect(lookIndexFor({ x: -Math.sin(Math.PI / 8), y: -Math.cos(Math.PI / 8) })).toBe(15); // 337.5°
  });

  test("死区（含零向量）与非有限值返回 undefined", () => {
    expect(lookIndexFor({ x: 0, y: 0 }, 24)).toBeUndefined();
    expect(lookIndexFor({ x: 10, y: 10 }, 24)).toBeUndefined();
    expect(lookIndexFor({ x: 25, y: 0 }, 24)).toBe(4);
    expect(lookIndexFor({ x: Number.NaN, y: 0 })).toBeUndefined();
  });
});

describe("lookCellRowCol（视线格 → 行/列）", () => {
  test("行 9 放 0-7，行 10 放 8-15", () => {
    expect(lookCellRowCol(0)).toEqual({ row: 9, column: 0 });
    expect(lookCellRowCol(7)).toEqual({ row: 9, column: 7 });
    expect(lookCellRowCol(8)).toEqual({ row: 10, column: 0 });
    expect(lookCellRowCol(15)).toEqual({ row: 10, column: 7 });
  });

  test("越界序号环回", () => {
    expect(lookCellRowCol(16)).toEqual({ row: 9, column: 0 });
    expect(lookCellRowCol(-1)).toEqual({ row: 10, column: 7 });
  });
});

describe("lookSupported", () => {
  test("v1（9 行）不支持，v2（11 行）支持", () => {
    expect(lookSupported({ columns: 8, rows: 9, frameWidth: 192, frameHeight: 208 })).toBe(false);
    expect(lookSupported({ columns: 8, rows: 11, frameWidth: 192, frameHeight: 208 })).toBe(true);
  });
});
