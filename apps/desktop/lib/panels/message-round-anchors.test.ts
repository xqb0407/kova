import { describe, expect, test } from "bun:test";

import {
  nearestRoundAnchorIndex,
  pickRoundAnchors,
} from "./message-round-anchors";

/** 造锚点桩：只带 data-slot，足够 pickRoundAnchors 判定 */
const el = (slot: string) => ({ dataset: { slot } });
const USER = "aui_user-message-root";
const ASSISTANT = "aui_assistant-message-content";

describe("pickRoundAnchors", () => {
  test("多轮对话：每轮只保留 user 消息，assistant 全部丢弃", () => {
    const anchors = [
      el(USER),
      el(ASSISTANT),
      el(ASSISTANT),
      el(USER),
      el(ASSISTANT),
    ];
    const kept = pickRoundAnchors(anchors);
    expect(kept).toEqual([anchors[0], anchors[3]]);
  });

  test("开场 assistant 预置段：保留末条兜底", () => {
    const anchors = [el(ASSISTANT), el(ASSISTANT), el(USER), el(ASSISTANT)];
    const kept = pickRoundAnchors(anchors);
    expect(kept).toEqual([anchors[1], anchors[2]]);
  });

  test("纯 assistant 内容（无 user 消息）：保留末条", () => {
    const anchors = [el(ASSISTANT), el(ASSISTANT)];
    expect(pickRoundAnchors(anchors)).toEqual([anchors[1]]);
  });

  test("单轮对话：恰好一个刻度", () => {
    const anchors = [el(USER), el(ASSISTANT), el(ASSISTANT)];
    expect(pickRoundAnchors(anchors)).toEqual([anchors[0]]);
  });

  test("空列表返回空", () => {
    expect(pickRoundAnchors([])).toEqual([]);
  });
});

describe("nearestRoundAnchorIndex", () => {
  test("空数组：-1（调用方据此跳过更新）", () => {
    expect(nearestRoundAnchorIndex([], 100)).toBe(-1);
  });

  test("落在两项之间取更近者", () => {
    const centers = [0, 100, 200];
    expect(nearestRoundAnchorIndex(centers, 49)).toBe(0);
    expect(nearestRoundAnchorIndex(centers, 51)).toBe(1);
    // 等距取前一项（与"滚动到下一轮才切换"的稳定预期一致）
    expect(nearestRoundAnchorIndex(centers, 150)).toBe(1);
  });

  test("越界夹取首/尾项", () => {
    const centers = [40, 100, 200];
    expect(nearestRoundAnchorIndex(centers, -1_000)).toBe(0);
    expect(nearestRoundAnchorIndex(centers, 9_999)).toBe(2);
  });

  test("单项与重复坐标不崩", () => {
    expect(nearestRoundAnchorIndex([50], 0)).toBe(0);
    // 重复坐标（同高锚点）等距时取最后一项：结果稳定，不随二分细节抖动
    expect(nearestRoundAnchorIndex([0, 0, 0], 0)).toBe(2);
    expect(nearestRoundAnchorIndex([0, 0, 0], 10)).toBe(2);
  });
});
