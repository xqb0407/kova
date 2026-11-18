/// <reference path="./bun-test.d.ts" />
import { afterAll, describe, expect, mock, test } from "bun:test";

/**
 * 群聊准入的直接门控测试：access.ts 的 group 分支必须只走
 * groupAccessAllowed，绝不能调用 passesOwnerGate（会摸 im_owner 表）。
 * 这里把 store 换成“一用就抛”的桩：任何 DB 访问都会让用例失败。
 */
mock.module("../main/store", () => ({
  getDb: () => {
    throw new Error("group access must not touch DB");
  },
}));

const { checkInboundAccess } = await import("../main/im/access");
import type { ImInboundMessage } from "../main/im/types";

let seq = 0;
function groupMsg(overrides?: Partial<ImInboundMessage>): ImInboundMessage {
  seq += 1;
  return {
    platform: "feishu",
    channelId: "ch-access",
    chatType: "group",
    chatId: "group_1",
    senderId: "owner_1",
    text: "你好",
    eventId: `access-${seq}`,
    mentioned: true,
    ...overrides,
  };
}

afterAll(() => {
  // bun 的 mock 类型未声明 restore（运行时存在）；兼容不同版本
  (mock as unknown as { restore?: () => void }).restore?.();
});

describe("checkInboundAccess：群聊分支", () => {
  test("owner 模式：owner 放行、他人拒绝、无 owner 拒绝，且不碰 DB", () => {
    expect(
      checkInboundAccess(groupMsg(), {
        groupEnabled: true,
        groupAccess: "owner",
        ownerId: "owner_1",
      }),
    ).toBe("allow");
    expect(
      checkInboundAccess(groupMsg({ senderId: "other_1" }), {
        groupEnabled: true,
        groupAccess: "owner",
        ownerId: "owner_1",
      }),
    ).toBe("deny");
    expect(
      checkInboundAccess(groupMsg(), {
        groupEnabled: true,
        groupAccess: "owner",
        ownerId: null,
      }),
    ).toBe("deny");
  });

  test("all 模式：其他成员放行（仍要求 @ 和群开关）", () => {
    expect(
      checkInboundAccess(groupMsg({ senderId: "other_1" }), {
        groupEnabled: true,
        groupAccess: "all",
        ownerId: "owner_1",
      }),
    ).toBe("allow");
    expect(
      checkInboundAccess(groupMsg({ mentioned: false }), {
        groupEnabled: true,
        groupAccess: "all",
      }),
    ).toBe("deny");
    expect(
      checkInboundAccess(groupMsg(), {
        groupEnabled: false,
        groupAccess: "all",
      }),
    ).toBe("deny");
  });
});
