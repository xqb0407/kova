/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import {
  canSettleGroupApproval,
  formatGroupPrompt,
  groupAccessAllowed,
  groupDenyReason,
  stripLeadingGroupMention,
} from "../main/im/group";
import type { ImInboundMessage } from "../main/im/types";

/**
 * 群聊门控：通道开关 + @ 本机器人。access.ts 对 chatType=group 只调用
 * groupAccessAllowed 并直接返回，不进入 owner 门——这里只测纯判定，
 * 避免把 Electron store 依赖拖进单测进程。
 */

let seq = 0;
function groupMsg(overrides?: Partial<ImInboundMessage>): ImInboundMessage {
  seq += 1;
  return {
    platform: "wecom",
    channelId: "ch-group",
    chatType: "group",
    chatId: "group_1",
    senderId: "user_1",
    text: "你好",
    eventId: `evt-${seq}`,
    mentioned: true,
    ...overrides,
  };
}

describe("群聊准入", () => {
  test("通道未开启群聊：拒绝", () => {
    expect(
      groupAccessAllowed(groupMsg(), { groupEnabled: false, ownerId: "user_1" }),
    ).toBe(false);
  });

  test("owner 模式：只有私聊 owner 放行", () => {
    expect(
      groupAccessAllowed(groupMsg(), {
        groupEnabled: true,
        groupAccess: "owner",
        ownerId: "user_1",
      }),
    ).toBe(true);
    expect(
      groupAccessAllowed(groupMsg(), {
        groupEnabled: true,
        groupAccess: "owner",
        ownerId: "user_2",
      }),
    ).toBe(false);
    expect(
      groupAccessAllowed(groupMsg(), {
        groupEnabled: true,
        groupAccess: "owner",
        ownerId: null,
      }),
    ).toBe(false);
  });

  test("all 模式：其他群成员 @ 也放行", () => {
    expect(
      groupAccessAllowed(groupMsg({ senderId: "user_2" }), {
        groupEnabled: true,
        groupAccess: "all",
        ownerId: "user_1",
      }),
    ).toBe(true);
  });

  test("通道开启但未 @：任何模式都拒绝", () => {
    for (const groupAccess of ["owner", "all"] as const) {
      expect(
        groupAccessAllowed(groupMsg({ mentioned: false }), {
          groupEnabled: true,
          groupAccess,
          ownerId: "user_1",
        }),
      ).toBe(false);
      expect(
        groupAccessAllowed(groupMsg({ mentioned: undefined }), {
          groupEnabled: true,
          groupAccess,
          ownerId: "user_1",
        }),
      ).toBe(false);
    }
  });

  test("groupAccessAllowed 只认 group 类型", () => {
    expect(
      groupAccessAllowed(groupMsg(), {
        groupEnabled: true,
        groupAccess: "all",
      }),
    ).toBe(true);
    expect(
      groupAccessAllowed(groupMsg({ chatType: "p2p" }), {
        groupEnabled: true,
        groupAccess: "all",
      }),
    ).toBe(false);
  });
});

describe("群聊被拒原因（决定是否回提示）", () => {
  test("未 @ 不提示（避免飞书全量群消息刷屏）", () => {
    expect(
      groupDenyReason(groupMsg({ mentioned: false }), {
        groupEnabled: false,
      }),
    ).toBeNull();
  });

  test("群开关未开 / 无 owner / 非 owner 分别给出原因", () => {
    expect(
      groupDenyReason(groupMsg(), { groupEnabled: false }),
    ).toBe("group-disabled");
    expect(
      groupDenyReason(groupMsg(), {
        groupEnabled: true,
        groupAccess: "owner",
        ownerId: null,
      }),
    ).toBe("no-owner");
    expect(
      groupDenyReason(groupMsg({ senderId: "other" }), {
        groupEnabled: true,
        groupAccess: "owner",
        ownerId: "owner_1",
      }),
    ).toBe("not-owner");
  });

  test("owner 本人 / all 模式不提示", () => {
    expect(
      groupDenyReason(groupMsg(), {
        groupEnabled: true,
        groupAccess: "owner",
        ownerId: "user_1",
      }),
    ).toBeNull();
    expect(
      groupDenyReason(groupMsg({ senderId: "other" }), {
        groupEnabled: true,
        groupAccess: "all",
        ownerId: "user_1",
      }),
    ).toBeNull();
  });
});

describe("群聊提示词与 @ 剥离", () => {
  test("发言人优先昵称，缺失时脱敏 id", () => {
    expect(
      formatGroupPrompt(groupMsg({ senderId: "user_1234567890", text: "你好", senderName: "张三" })),
    ).toBe("[[im-group:张三]] 你好");
    expect(
      formatGroupPrompt(groupMsg({ senderId: "user_1234567890", text: "你好" })),
    ).toBe("[[im-group:user_1…7890]] 你好");
  });

  test("只剥离开头一个 @机器人，保留正文其它 @", () => {
    expect(stripLeadingGroupMention("@Kova 你好 @李四")).toBe("你好 @李四");
    expect(stripLeadingGroupMention("@Kova，你好")).toBe("你好");
    expect(stripLeadingGroupMention("你好")).toBe("你好");
  });
});

describe("群内审批结算权", () => {
  test("群聊只允许发起人；私聊不额外限制", () => {
    expect(
      canSettleGroupApproval({
        chatType: "group",
        requesterId: "u1",
        senderId: "u1",
      }),
    ).toBe(true);
    expect(
      canSettleGroupApproval({
        chatType: "group",
        requesterId: "u1",
        senderId: "u2",
      }),
    ).toBe(false);
    expect(
      canSettleGroupApproval({
        chatType: "p2p",
        requesterId: "u1",
        senderId: "u2",
      }),
    ).toBe(true);
  });
});
