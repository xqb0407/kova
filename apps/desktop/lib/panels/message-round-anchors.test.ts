import { describe, expect, test } from "bun:test";

import { pickRoundAnchors } from "./message-round-anchors";

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
