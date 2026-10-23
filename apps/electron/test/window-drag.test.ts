import { describe, expect, test } from "bun:test";
import {
  restoreDragPosition,
  restoreMaximizedWindowAt,
  type DragWindow,
  type Rect,
} from "../main/window-drag";

const MAXIMIZED = { x: 0, y: 0, width: 1920, height: 1080 };
const NORMAL = { x: 200, y: 100, width: 1000, height: 800 };

/** 假窗口：只需要 window-drag 用到的能力，避免测试依赖 Electron 运行时 */
function fakeWindow(opts: {
  bounds: Rect;
  normal?: Rect;
  maximized?: boolean;
  fullscreen?: boolean;
  /** false = 模拟 unmaximize 没生效（窗口仍最大化） */
  unmaximizeWorks?: boolean;
}) {
  let bounds = { ...opts.bounds };
  let maximized = opts.maximized ?? false;
  const calls = { unmaximize: 0, setBounds: [] as Rect[] };
  const win: DragWindow = {
    isFullScreen: () => opts.fullscreen ?? false,
    isMaximized: () => maximized,
    getBounds: () => ({ ...bounds }),
    getNormalBounds: () => ({ ...(opts.normal ?? bounds) }),
    unmaximize: () => {
      calls.unmaximize += 1;
      if (opts.unmaximizeWorks !== false) maximized = false;
    },
    setBounds: (b) => {
      calls.setBounds.push({ ...b });
      bounds = { ...b };
    },
  };
  return { win, calls };
}

describe("restoreDragPosition", () => {
  test("光标在最大化窗口中央：还原后仍在窗口中央", () => {
    expect(
      restoreDragPosition({
        cursorX: 960,
        cursorY: 24,
        grabOffsetY: 24,
        maximized: MAXIMIZED,
        normalWidth: 1000,
      }),
    ).toEqual({ x: 460, y: 0 });
  });

  test("抓着标题栏右侧：还原后光标仍落在窗口对应比例处", () => {
    expect(
      restoreDragPosition({
        cursorX: 1900,
        cursorY: 24,
        grabOffsetY: 24,
        maximized: MAXIMIZED,
        normalWidth: 1000,
      }),
    ).toEqual({ x: 910, y: 0 });
  });

  test("副屏坐标偏移：按窗口自身区间计算比例", () => {
    expect(
      restoreDragPosition({
        cursorX: 2880,
        cursorY: 40,
        grabOffsetY: 24,
        maximized: { x: 1920, y: 0, width: 1920, height: 1080 },
        normalWidth: 1000,
      }),
    ).toEqual({ x: 2380, y: 16 });
  });

  test("宽度为 0（异常快照）：退化为居中，不除零", () => {
    expect(
      restoreDragPosition({
        cursorX: 500,
        cursorY: 30,
        grabOffsetY: 10,
        maximized: { x: 0, y: 0, width: 0, height: 0 },
        normalWidth: 800,
      }),
    ).toEqual({ x: 100, y: 20 });
  });
});

describe("restoreMaximizedWindowAt", () => {
  test("全屏：不还原、不落位", () => {
    const { win, calls } = fakeWindow({
      bounds: MAXIMIZED,
      maximized: true,
      fullscreen: true,
    });
    expect(
      restoreMaximizedWindowAt(win, {
        cursorX: 960,
        cursorY: 24,
        grabOffsetY: 24,
      }),
    ).toBeNull();
    expect(calls.unmaximize).toBe(0);
    expect(calls.setBounds).toHaveLength(0);
  });

  test("已经不是最大化：回当前位置继续拖，不调用还原", () => {
    const { win, calls } = fakeWindow({ bounds: NORMAL });
    expect(
      restoreMaximizedWindowAt(win, {
        cursorX: 960,
        cursorY: 24,
        grabOffsetY: 24,
      }),
    ).toEqual({ x: 200, y: 100 });
    expect(calls.unmaximize).toBe(0);
    expect(calls.setBounds).toHaveLength(0);
  });

  test("最大化：按光标比例还原并返回落位后的实际位置", () => {
    const { win, calls } = fakeWindow({
      bounds: MAXIMIZED,
      normal: NORMAL,
      maximized: true,
    });
    expect(
      restoreMaximizedWindowAt(win, {
        cursorX: 960,
        cursorY: 24,
        grabOffsetY: 24,
      }),
    ).toEqual({ x: 460, y: 0 });
    expect(calls.unmaximize).toBe(1);
    expect(calls.setBounds).toEqual([
      { x: 460, y: 0, width: 1000, height: 800 },
    ]);
  });

  test("还原没生效（窗口仍最大化）：返回 null，让前端停手", () => {
    const { win, calls } = fakeWindow({
      bounds: MAXIMIZED,
      normal: NORMAL,
      maximized: true,
      unmaximizeWorks: false,
    });
    expect(
      restoreMaximizedWindowAt(win, {
        cursorX: 960,
        cursorY: 24,
        grabOffsetY: 24,
      }),
    ).toBeNull();
    expect(calls.unmaximize).toBe(1);
    expect(calls.setBounds).toHaveLength(0);
  });
});
