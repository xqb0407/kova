/**
 * 桌宠窗口位置钳制：单屏出界拉回、多屏跨屏放行、屏间空隙按最近屏拉回。
 * 纯函数，不 import electron。
 */
import { describe, expect, test } from "bun:test";
import { MIN_VISIBLE, clampWindowPosition, hasEnoughVisibleArea } from "./pet-bounds";

const primary = { x: 0, y: 0, width: 1920, height: 1040 }; // 1080p 减任务栏
const secondaryRight = { x: 1920, y: 0, width: 1920, height: 1040 };
const secondaryLeftScaled = { x: -1280, y: 0, width: 1280, height: 960 };
const secondaryDiagonal = { x: 2000, y: 1200, width: 1920, height: 1080 };

const size = { width: 200, height: 300 };

describe("hasEnoughVisibleArea", () => {
  test("完全落在单屏内", () => {
    expect(hasEnoughVisibleArea({ x: 100, y: 100, ...size }, [primary])).toBe(true);
  });

  test("完全出屏", () => {
    expect(hasEnoughVisibleArea({ x: 5000, y: 5000, ...size }, [primary])).toBe(false);
  });

  test("只露一条 80px 以上的边也算可见", () => {
    const rect = { x: primary.width - MIN_VISIBLE, y: 100, ...size };
    expect(hasEnoughVisibleArea(rect, [primary])).toBe(true);
  });

  test("横竖分别撞到两块屏、但实际没有相交 → 不可见", () => {
    const rect = { x: 100, y: 1100, ...size };
    expect(hasEnoughVisibleArea(rect, [primary, secondaryDiagonal])).toBe(false);
  });
});

describe("clampWindowPosition", () => {
  test("足够可见时原样放行（不缩进工作区）", () => {
    const point = { x: 500, y: 400 };
    expect(clampWindowPosition(point, size, [primary])).toEqual(point);
  });

  test("跨屏拖动过程放行：窗口一半在主屏、一半在右副屏", () => {
    const point = { x: 1820, y: 300 };
    expect(clampWindowPosition(point, size, [primary, secondaryRight])).toEqual(point);
  });

  test("跨屏接缝的窄窗每边只露一半也放行，不被吸回单屏", () => {
    const narrow = { width: 120, height: 300 };
    const point = { x: secondaryRight.x - narrow.width / 2, y: 200 };
    expect(clampWindowPosition(point, narrow, [primary, secondaryRight])).toEqual(point);
  });

  test("完全拖出右下角后拉回，至少留 MIN_VISIBLE 可见", () => {
    const point = { x: 4000, y: 3000 };
    const clamped = clampWindowPosition(point, size, [primary, secondaryRight]);
    expect(clamped.x).toBe(primary.width * 2 - MIN_VISIBLE);
    expect(clamped.y).toBe(primary.height - MIN_VISIBLE);
  });

  test("拖到负坐标但仍在左侧副屏内 → 放行", () => {
    const point = { x: -400, y: 100 };
    expect(clampWindowPosition(point, size, [primary, secondaryLeftScaled])).toEqual(point);
  });

  test("落进两屏之间的空隙 → 按最近屏拉回", () => {
    const gapPoint = { x: -1280 - 500, y: -800 };
    const pulled = clampWindowPosition(gapPoint, size, [primary, secondaryLeftScaled]);
    expect(pulled.x).toBe(-1280 - size.width + MIN_VISIBLE);
    expect(pulled.y).toBe(-size.height + MIN_VISIBLE);
  });

  test("没有显示器信息时不动窗口（异常环境兜底）", () => {
    const point = { x: 9000, y: -9000 };
    expect(clampWindowPosition(point, size, [])).toEqual(point);
  });
});
