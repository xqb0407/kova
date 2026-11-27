/**
 * 文件预览右栏开合 store 的单测：默认展开、toggle 翻转、多订阅者同源。
 */
import { describe, expect, test } from "bun:test";
import {
  fileRailChangedOnlyForTest,
  fileRailOpenForTest,
  fileRailWidthForTest,
  setFileRailWidth,
  toggleFileRail,
  toggleFileRailChangedOnly,
} from "./file-rail";

describe("file-rail store", () => {
  test("默认展开，toggle 两次回到展开", () => {
    expect(fileRailOpenForTest()).toBe(true);
    toggleFileRail();
    expect(fileRailOpenForTest()).toBe(false);
    toggleFileRail();
    expect(fileRailOpenForTest()).toBe(true);
  });

  test("切换不依赖订阅者存在（模块级状态跨重挂载保持）", () => {
    toggleFileRail();
    // 模拟组件卸载后再挂载：状态仍在（无 hook 参与）
    expect(fileRailOpenForTest()).toBe(false);
    toggleFileRail();
    expect(fileRailOpenForTest()).toBe(true);
  });

  test("「只显示变更」默认关闭，toggle 翻转且跨重挂载保持", () => {
    expect(fileRailChangedOnlyForTest()).toBe(false);
    toggleFileRailChangedOnly();
    expect(fileRailChangedOnlyForTest()).toBe(true);
    toggleFileRailChangedOnly();
    expect(fileRailChangedOnlyForTest()).toBe(false);
  });

  test("宽度拖拽夹取在 160–480，正常值原样生效", () => {
    setFileRailWidth(100);
    expect(fileRailWidthForTest()).toBe(160);
    setFileRailWidth(9999);
    expect(fileRailWidthForTest()).toBe(480);
    setFileRailWidth(256);
    expect(fileRailWidthForTest()).toBe(256);
    setFileRailWidth(256.4); // 四舍五入，避免亚像素宽度
    expect(fileRailWidthForTest()).toBe(256);
  });
});
