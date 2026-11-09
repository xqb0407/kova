import { describe, expect, test } from "bun:test";
import {
  THINKING_DEPTH_LABELS,
  thinkingCometLevel,
  thinkingDepthZone,
} from "./thinking-depth";

describe("thinkingDepthZone", () => {
  test("off 不落档，低档→简单，中档→中度，高档→深度", () => {
    expect(thinkingDepthZone("off")).toBeUndefined();
    expect(thinkingDepthZone("minimal")).toBe(0);
    expect(thinkingDepthZone("low")).toBe(0);
    expect(thinkingDepthZone("medium")).toBe(1);
    expect(thinkingDepthZone("high")).toBe(2);
    expect(thinkingDepthZone("xhigh")).toBe(2);
    expect(thinkingDepthZone("max")).toBe(2);
    expect(THINKING_DEPTH_LABELS).toEqual(["简单", "中度", "深度"]);
  });
});

describe("thinkingCometLevel", () => {
  test("关闭/单档无彗星，第二档起出现并递增到满强度", () => {
    expect(thinkingCometLevel(0, 7)).toBe(0);
    expect(thinkingCometLevel(0, 1)).toBe(0);
    expect(thinkingCometLevel(1, 7)).toBe(0.25);
    expect(thinkingCometLevel(2, 7)).toBeCloseTo(1 / 3, 5);
    expect(thinkingCometLevel(3, 7)).toBe(0.5);
    expect(thinkingCometLevel(6, 7)).toBe(1);
    // 两档模型（off + 一个推理档）：第二档直接满强度
    expect(thinkingCometLevel(1, 2)).toBe(1);
  });
});
