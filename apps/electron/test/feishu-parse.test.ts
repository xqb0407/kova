/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { parseFeishuInbound, stripFeishuMentions } from "../main/im/adapters/feishu/feishu-parse";

/**
 * 飞书入站归一的回归保护：漏过滤会把机器人自己的消息/群聊消息灌进会话，
 * 误解析会让私聊看起来"发了消息没反应"。
 */

function textEvent(overrides?: {
  text?: string;
  chatType?: string;
  senderType?: string;
  messageType?: string;
  content?: unknown;
  messageId?: string;
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
        chat_id: "oc_chat_1",
        chat_type: overrides?.chatType ?? "p2p",
        message_type: overrides?.messageType ?? "text",
        content: JSON.stringify(overrides?.content ?? { text }),
      },
    },
  };
}

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

  test("群聊消息本期不处理", () => {
    expect(parseFeishuInbound(textEvent({ chatType: "group" }))).toBeNull();
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
