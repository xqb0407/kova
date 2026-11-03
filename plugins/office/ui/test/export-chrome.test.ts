/**
 * 导出页脚/页码测试：frameToSvg 的 chrome 与 SlideView 同视觉，svg 里应有
 * 左下页脚文本与右下 "N / M"（右对齐）。
 */
import { describe, expect, test } from "bun:test";
import { frameToSvg } from "../src/export-svg";
import type { Frame } from "../src/doc";

const frame: Frame = {
  id: "f1",
  type: "slide",
  x: 0,
  y: 0,
  w: 1280,
  h: 720,
  background: "#111318",
  elements: [],
};

describe("frameToSvg：页码/页脚", () => {
  test("深底页：页脚 + 右下页码同时输出", async () => {
    const svg = await frameToSvg(frame, { index: 2, total: 5, showNumber: true, footer: "内部分享 · 2026" });
    expect(svg).toContain("内部分享 · 2026");
    expect(svg).toContain("2 / 5");
    expect(svg).toContain('text-anchor="end"');
    expect(svg).toContain("rgba(255,255,255,.66)"); // 深底用浅色
  });

  test("浅底页用深色；无 chrome 时不输出", async () => {
    const light = await frameToSvg({ ...frame, background: "#ffffff" }, { index: 1, total: 1, showNumber: true });
    expect(light).toContain("rgba(17,24,39,.55)");
    const plain = await frameToSvg({ ...frame, background: "#ffffff" });
    expect(plain).not.toContain("text-anchor=\"end\"");
  });
});
