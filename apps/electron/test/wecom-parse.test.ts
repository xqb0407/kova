/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { parseWeComFrame } from "../main/im/adapters/wecom/wecom-parse";

/**
 * 企业微信智能机器人帧归一的回归保护：仅单聊文本；chatid 缺失时用 userid
 * 作会话锚点；原始帧必须作为 replyContext 透出（回复要透传 req_id）。
 */

function frame(overrides?: {
  body?: Record<string, unknown>;
  msgtype?: string;
  chattype?: string;
  content?: string;
  chatid?: string;
  userid?: string;
}) {
  return {
    headers: { req_id: "req_1" },
    body: {
      msgid: "msg_1",
      msgtype: overrides?.msgtype ?? "text",
      chattype: overrides?.chattype ?? "single",
      from: { userid: overrides?.userid ?? "user_1" },
      ...(overrides?.chatid ? { chatid: overrides.chatid } : {}),
      text: { content: overrides?.content ?? "你好" },
      ...(overrides?.body ?? {}),
    },
  };
}

describe("parseWeComFrame", () => {
  test("单聊文本解析（chatid 缺失回落 userid）", () => {
    const input = frame();
    const draft = parseWeComFrame(input);
    expect(draft?.text).toBe("你好");
    expect(draft?.chatId).toBe("user_1");
    expect(draft?.senderId).toBe("user_1");
    expect(draft?.eventId).toBe("msg_1");
    expect(draft?.replyContext).toBe(input);
  });

  test("群聊 @ 本机器人：解析为 group、用 chatid 作锚点并剥离 @", () => {
    const draft = parseWeComFrame(
      frame({ chattype: "group", chatid: "chat_1", content: "@Kova 你好" }),
    );
    expect(draft?.chatType).toBe("group");
    expect(draft?.chatId).toBe("chat_1");
    expect(draft?.mentioned).toBe(true);
    expect(draft?.text).toBe("你好");
  });

  test("缺 chattype 但有 chatid：按群聊处理，不能回落单聊绕过群开关", () => {
    const draft = parseWeComFrame({
      headers: { req_id: "req_x" },
      body: {
        msgid: "msg_x",
        msgtype: "text",
        from: { userid: "user_x" },
        chatid: "chat_x",
        text: { content: "@Kova 你好" },
      },
    });
    expect(draft?.chatType).toBe("group");
    expect(draft?.chatId).toBe("chat_x");
    expect(draft?.mentioned).toBe(true);
  });

  test("机器人自身消息丢弃", () => {
    expect(
      parseWeComFrame(frame({ body: { aibotid: "bot_1" }, userid: "bot_1" })),
    ).toBeNull();
  });

  test("非文本消息丢弃", () => {
    expect(parseWeComFrame(frame({ msgtype: "image" }))).toBeNull();
  });

  test("空文本丢弃", () => {
    expect(parseWeComFrame(frame({ content: "  " }))).toBeNull();
  });

  test("兼容帧体摊平（无 body 包装）", () => {
    const flat = frame();
    const draft = parseWeComFrame(flat.body);
    expect(draft?.text).toBe("你好");
  });
});
