import { describe, expect, test } from "bun:test";

import fontAssets from "./font-assets.json";
import {
  CODE_FONT_STACKS,
  FONT_WEIGHT_BOOST,
  UI_FONT_STACKS,
} from "./fonts";

describe("字体栈", () => {
  test("默认栈：中文回退顺序是苹方 → 思源黑体 → 雅黑", () => {
    const stack = UI_FONT_STACKS.default;
    const pingFang = stack.indexOf('"PingFang SC"');
    const noto = stack.indexOf('"Noto Sans SC"');
    const yahei = stack.indexOf('"Microsoft YaHei UI"');
    expect(pingFang).toBeGreaterThanOrEqual(0);
    expect(noto).toBeGreaterThan(pingFang);
    expect(yahei).toBeGreaterThan(noto);
  });

  test("Segoe UI 档在 Windows 也用思源黑体兜底中文", () => {
    const stack = UI_FONT_STACKS.segoe;
    const noto = stack.indexOf('"Noto Sans SC"');
    expect(noto).toBeGreaterThan(-1);
    expect(noto).toBeLessThan(stack.indexOf('"Microsoft YaHei UI"'));
  });

  test("代码字体栈只用系统 CJK，不额外拉思源黑体", () => {
    expect(CODE_FONT_STACKS.theme).not.toContain('"Noto Sans SC"');
    expect(CODE_FONT_STACKS.theme).toContain('"PingFang SC"');
    expect(CODE_FONT_STACKS.theme).toContain('"Microsoft YaHei UI"');
    expect(CODE_FONT_STACKS.mono).not.toContain('"Noto Sans SC"');
  });

  test("思源系字重补偿依赖随包 500/600", () => {
    expect(FONT_WEIGHT_BOOST["noto-sans-sc"]).toBe(500);
    expect(fontAssets["noto-sans-sc"].weights).toContain("500");
    expect(fontAssets["noto-sans-sc"].weights).toContain("600");
    expect(fontAssets["noto-serif-sc"].weights).toContain("600");
  });
});
