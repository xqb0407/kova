/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { parseDingTalkRobotMessage } from "../main/im/adapters/dingtalk/dingtalk-parse";

/**
 * 钉钉机器人消息归一的回归保护：群聊/非文本/机器人回环必须过滤，
 * 前导空格要清理，sessionWebhook 必须作为回复凭据透出。
 */

function robotMessage(overrides?: Record<string, unknown>) {
  return {
    msgtype: "text",
    text: { content: " 你好" },
    conversationType: "1",
    conversationId: "cid_1",
    senderStaffId: "staff_1",
    senderId: "sender_1",
    chatbotUserId: "bot_1",
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=x",
    msgId: "msg_1",
    ...overrides,
  };
}

describe("parseDingTalkRobotMessage", () => {
  test("单聊文本解析（清理前导空格）", () => {
    const draft = parseDingTalkRobotMessage(robotMessage());
    expect(draft?.text).toBe("你好");
    expect(draft?.chatId).toBe("cid_1");
    expect(draft?.senderId).toBe("staff_1");
    expect(draft?.eventId).toBe("msg_1");
    expect(draft?.replyContext).toBe(
      "https://oapi.dingtalk.com/robot/sendBySession?session=x",
    );
  });

  test("群聊消息丢弃", () => {
    expect(
      parseDingTalkRobotMessage(robotMessage({ conversationType: "2" })),
    ).toBeNull();
  });

  test("非文本消息丢弃", () => {
    expect(
      parseDingTalkRobotMessage(robotMessage({ msgtype: "picture" })),
    ).toBeNull();
  });

  test("空文本丢弃", () => {
    expect(
      parseDingTalkRobotMessage(robotMessage({ text: { content: "   " } })),
    ).toBeNull();
  });

  test("机器人自身回环丢弃", () => {
    expect(
      parseDingTalkRobotMessage(robotMessage({ senderStaffId: "bot_1" })),
    ).toBeNull();
  });

  test("senderStaffId 缺失时回落到 senderId", () => {
    const draft = parseDingTalkRobotMessage(
      robotMessage({ senderStaffId: undefined }),
    );
    expect(draft?.senderId).toBe("sender_1");
  });
});
