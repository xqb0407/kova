import { describe, expect, test, beforeEach } from "bun:test";
import {
  getOverlayCountForTest,
  registerOverlay,
  resetOverlayRegistryForTest,
} from "./overlay-occlusion";

/**
 * 浮层登记表：浏览器子 webview 靠它知道自己被浮层盖住了。
 * 过去这里是人工白名单（几十个调用点各广播一次，漏一个就复现一次 bug），
 * 所以"计数必须能准确归零、注销必须幂等"是这个模块唯一重要的性质。
 */
describe("registerOverlay", () => {
  beforeEach(() => resetOverlayRegistryForTest());

  test("登记使计数增加，注销使计数归零", () => {
    expect(getOverlayCountForTest()).toBe(0);
    const off = registerOverlay();
    expect(getOverlayCountForTest()).toBe(1);
    off();
    expect(getOverlayCountForTest()).toBe(0);
  });

  // StrictMode 下 effect 挂载→卸载→再挂载。注销不幂等的话计数会净少，
  // 多次开关弹窗后必然漂移——面板 webview 就再也回不来了
  test("注销幂等：重复注销不会把计数扣穿", () => {
    const off = registerOverlay();
    off();
    off();
    off();
    expect(getOverlayCountForTest()).toBe(0);
    // 归零后再登记仍是 1，不是 0 或别的漂移值
    const off2 = registerOverlay();
    expect(getOverlayCountForTest()).toBe(1);
    off2();
    expect(getOverlayCountForTest()).toBe(0);
  });

  test("多个浮层并存，各自独立注销", () => {
    const offA = registerOverlay();
    const offB = registerOverlay();
    const offC = registerOverlay();
    expect(getOverlayCountForTest()).toBe(3);
    offB();
    expect(getOverlayCountForTest()).toBe(2);
    offA();
    offC();
    expect(getOverlayCountForTest()).toBe(0);
  });

  // 注册表是模块级单例，HMR / 测试之间若残留计数，浏览器面板会一直隐身
  test("reset 清零", () => {
    registerOverlay();
    registerOverlay();
    resetOverlayRegistryForTest();
    expect(getOverlayCountForTest()).toBe(0);
  });
});
