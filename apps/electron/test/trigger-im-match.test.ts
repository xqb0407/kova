import { describe, expect, test } from "bun:test";
import { imTriggerSummary, matchImTriggers } from "../main/trigger-im-match";

const im = (overrides: Record<string, unknown> = {}) => ({
  id: "trg-im",
  type: "im",
  taskId: "task-1",
  enabled: true,
  config: { type: "im", platform: "feishu", pattern: "^/run" },
  ...overrides,
});

const msg = (overrides: Partial<{ platform: string; chatId: string; text: string }> = {}) => ({
  platform: "feishu",
  chatId: "chat-1",
  text: "/run 日报",
  ...overrides,
});

describe("IM 触发器匹配（L1c）", () => {
  test("平台 + 正则命中；不同平台/不匹配文本跳过", () => {
    const triggers = [im()];
    expect(matchImTriggers(triggers, msg())).toHaveLength(1);
    expect(matchImTriggers(triggers, msg({ platform: "wechat" }))).toHaveLength(0);
    expect(matchImTriggers(triggers, msg({ text: "随便聊聊" }))).toHaveLength(0);
  });

  test("chatId 限定：给了就只匹配该聊天", () => {
    const triggers = [im({ config: { type: "im", platform: "feishu", chatId: "chat-1" } })];
    expect(matchImTriggers(triggers, msg())).toHaveLength(1);
    expect(matchImTriggers(triggers, msg({ chatId: "chat-2" }))).toHaveLength(0);
  });

  test("缺省 pattern = 任意文本；非法正则跳过", () => {
    const anyText = im({ config: { type: "im", platform: "feishu" } });
    expect(matchImTriggers([anyText], msg({ text: "任何话" }))).toHaveLength(1);
    const bad = im({ config: { type: "im", platform: "feishu", pattern: "([" } });
    expect(matchImTriggers([bad], msg())).toHaveLength(0);
  });

  test("禁用/非 im/缺 platform 一律不匹配", () => {
    expect(matchImTriggers([im({ enabled: false })], msg())).toHaveLength(0);
    expect(matchImTriggers([im({ type: "webhook" })], msg())).toHaveLength(0);
    expect(
      matchImTriggers([im({ config: { type: "im", pattern: "^/run" } })], msg()),
    ).toHaveLength(0);
  });

  test("摘要：平台 + 发送者 + 消息（压空白、截 80 字）", () => {
    expect(imTriggerSummary({ platform: "feishu", chatId: "c", text: " /run  日报 ", senderId: "u1" })).toBe(
      "im feishu u1: /run 日报",
    );
    const long = "x".repeat(200);
    expect(imTriggerSummary({ platform: "wechat", chatId: "c", text: long }).length).toBeLessThan(120);
  });
});
