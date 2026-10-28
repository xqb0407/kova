/**
 * DesktopPiChannel 宿主门回归测试：
 * - desktopChannelAvailable 三态：无 window（bun/SSR）放行、有 window 无
 *   Electron 标记空转、有标记放行；
 * - 桌面宿主（__KOVA_DESKTOP__）下订阅必须真正落到 wire 传输、帧回调可达，
 *   守住「desktopSubscribe 误把自身当传输导致桌面端爆栈」这类回归。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/** pi-chunk-batch 的 listen 桩：捕获唯一传输登记 */
type WireLine = { i: number | null; l: string };
let batchCb: ((event: { payload: WireLine[] }) => void) | null = null;

mockModule("@/desktop-bridge/event", () => ({
  listen: (event: string, cb: (event: { payload: WireLine[] }) => void) => {
    if (event === "pi-chunk-batch") batchCb = cb;
    return Promise.resolve(() => {
      if (event === "pi-chunk-batch") batchCb = null;
    });
  },
}));

const { DesktopPiChannel, desktopChannelAvailable } = await import(
  "@/lib/pi/pi-channel"
);
const { resetWireBusForTests } = await import("@/lib/pi/wire-bus");

const realWindow = globalThis.window;
const setWindow = (value: unknown) => {
  Object.defineProperty(globalThis, "window", {
    value,
    configurable: true,
    writable: true,
  });
};
const clearWindow = () => {
  delete (globalThis as { window?: unknown }).window;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetWireBusForTests();
  batchCb = null;
  clearWindow();
});

afterAll(() => {
  resetWireBusForTests();
  if (realWindow === undefined) clearWindow();
  else setWindow(realWindow);
  restoreAllMocks();
});

describe("desktopChannelAvailable", () => {
  test("无 window（bun 测试 / SSR）：放行，交给传输层自行降级", () => {
    expect(desktopChannelAvailable()).toBe(true);
  });

  test("有 window 无 Electron 标记（纯浏览器）：空转", () => {
    setWindow({ location: { search: "" } });
    expect(desktopChannelAvailable()).toBe(false);
  });

  test("有 Electron 标记（桌面壳）：放行", () => {
    setWindow({ __KOVA_DESKTOP__: {}, location: { search: "" } });
    expect(desktopChannelAvailable()).toBe(true);
  });
});

describe("DesktopPiChannel 桌面路径", () => {
  test("桌面宿主：订阅落到 wire 传输，帧回调可达（防自递归回归）", async () => {
    setWindow({ __KOVA_DESKTOP__: {}, location: { search: "" } });
    const channel = new DesktopPiChannel();
    const received: unknown[] = [];
    const off = await channel.subscribeDesignThemes((frame) =>
      received.push(frame),
    );
    await flush();
    expect(typeof off).toBe("function");
    expect(batchCb).not.toBeNull();
    batchCb!({
      payload: [
        { i: null, l: JSON.stringify({ type: "design_themes", entries: [] }) },
      ],
    });
    expect(received).toHaveLength(1);
    off();
  });
});
