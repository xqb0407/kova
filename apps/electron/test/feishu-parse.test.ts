/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { parseFeishuInbound, stripFeishuMentions } from "../main/im/adapters/feishu/feishu-parse";

/**
 * 飞书入站归一的回归保护：漏过滤会把机器人自己的消息灌进会话；
 * 群聊要正确识别 @ 本机器人，否则要么群里没反应、要么回复其它 bot 的 @。
 */

function textEvent(overrides?: {
  text?: string;
  chatType?: string;
  chatId?: string;
  senderType?: string;
  messageType?: string;
  content?: unknown;
  messageId?: string;
  mentions?: unknown[];
}) {
  const text = overrides?.text ?? "你好";
  return {
    event: {
      sender: {
        sender_type: overrides?.senderType ?? "user",
        sender_id: { open_id: "ou_123" },
      },
      message: {
        message_id: overrides?.messageId ?? "om_1",
        chat_id: overrides?.chatId ?? "oc_chat_1",
        chat_type: overrides?.chatType ?? "p2p",
        message_type: overrides?.messageType ?? "text",
        content: JSON.stringify(overrides?.content ?? { text }),
        ...(overrides?.mentions ? { mentions: overrides.mentions } : {}),
      },
    },
  };
}

const botMention = (openId = "ou_bot") => ({
  key: "@_user_1",
  id: { open_id: openId },
  name: "Kova",
  mentioned_type: "bot",
});

describe("parseFeishuInbound", () => {
  test("私聊文本解析", () => {
    const draft = parseFeishuInbound(textEvent({ text: "帮我写个周报" }));
    expect(draft?.text).toBe("帮我写个周报");
    expect(draft?.chatId).toBe("oc_chat_1");
    expect(draft?.senderId).toBe("ou_123");
    expect(draft?.eventId).toBe("om_1");
    expect(draft?.replyContext).toBe("om_1");
  });

  test("机器人自身消息丢弃", () => {
    expect(parseFeishuInbound(textEvent({ senderType: "app" }))).toBeNull();
  });

  test("缺/未知 chat_type 丢弃：不能默认成 p2p 绕过群开关", () => {
    expect(parseFeishuInbound(textEvent({ chatType: "" }))).toBeNull();
    expect(parseFeishuInbound(textEvent({ chatType: "topic" }))).toBeNull();
  });

  test("群聊 @ 本机器人：解析为 group 并剥离 mention", () => {
    const draft = parseFeishuInbound(
      textEvent({
        chatType: "group",
        chatId: "oc_group_1",
        text: "@_user_1 帮我写个周报",
        mentions: [botMention()],
      }),
      { botOpenId: "ou_bot" },
    );
    expect(draft?.chatType).toBe("group");
    expect(draft?.chatId).toBe("oc_group_1");
    expect(draft?.mentioned).toBe(true);
    expect(draft?.text).toBe("帮我写个周报");
  });

  test("拿不到 bot open_id 时 fail-closed：群聊不认 @", () => {
    const draft = parseFeishuInbound(
      textEvent({
        chatType: "group",
        text: "@_user_1 你好",
        mentions: [botMention()],
      }),
    );
    expect(draft?.chatType).toBe("group");
    expect(draft?.mentioned).toBe(false);
  });

  test("群聊未 @ 本机器人：保留 mentioned=false，由 access 层拒绝", () => {
    const draft = parseFeishuInbound(
      textEvent({ chatType: "group", text: "大家好" }),
    );
    expect(draft?.chatType).toBe("group");
    expect(draft?.mentioned).toBe(false);
  });

  test("群聊 mention 精确匹配 bot open_id：不响应其它 bot 的 @", () => {
    const otherBot = botMention("ou_other_bot");
    expect(
      parseFeishuInbound(
        textEvent({
          chatType: "group",
          text: "@_user_1 你好",
          mentions: [otherBot],
        }),
        { botOpenId: "ou_our_bot" },
      )?.mentioned,
    ).toBe(false);
    expect(
      parseFeishuInbound(
        textEvent({
          chatType: "group",
          text: "@_user_1 你好",
          mentions: [botMention("ou_our_bot")],
        }),
        { botOpenId: "ou_our_bot" },
      )?.mentioned,
    ).toBe(true);
  });

  test("兼容 SDK 摊平（event 字段在顶层）", () => {
    const flat = textEvent();
    const draft = parseFeishuInbound(flat.event);
    expect(draft?.text).toBe("你好");
  });

  test("富文本 post 提取正文并剥离 mention", () => {
    const post = {
      zh_cn: {
        title: "标题",
        content: [
          [
            { tag: "at", user_id: "@_user_1" },
            { tag: "text", text: " 看下 @_user_1 这个" },
          ],
          [{ tag: "text", text: "第二行" }],
        ],
      },
    };
    const draft = parseFeishuInbound(
      textEvent({ messageType: "post", content: post }),
    );
    expect(draft?.text).toBe("标题\n 看下 这个\n第二行");
  });

  test("空文本/非文本消息丢弃", () => {
    expect(parseFeishuInbound(textEvent({ messageType: "image" }))).toBeNull();
    expect(parseFeishuInbound(textEvent({ text: "   " }))).toBeNull();
  });

  test("stripFeishuMentions 清理占位与多余空白", () => {
    expect(stripFeishuMentions("@_user_1  你好 @_all ")).toBe("你好");
  });
});
