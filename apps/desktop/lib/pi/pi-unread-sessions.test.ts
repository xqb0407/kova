/**
 * 未读集合 store 测试：纯快照逻辑（置未读/已读幂等、toggle 翻转、undefined
 * 键安全）。不装伪 window——load/persist 对缺 window 均安全（hydrate 路径与
 * pi-pinned-sessions 同款），避免同进程多测试文件模块求值顺序的脆弱性。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  getUnreadSessions,
  isSessionUnread,
  markSessionRead,
  markSessionUnread,
  toggleSessionUnread,
} from "./pi-unread-sessions";

beforeEach(() => {
  for (const id of getUnreadSessions()) markSessionRead(id);
});

describe("pi-unread-sessions", () => {
  test("置未读 → 已读：幂等", () => {
    markSessionUnread("s1");
    markSessionUnread("s1"); // 幂等：重复标记不产生重复键
    expect(getUnreadSessions()).toEqual(["s1"]);
    expect(isSessionUnread("s1")).toBe(true);

    markSessionRead("s1");
    markSessionRead("s1"); // 幂等：未在集合里时不动快照
    expect(getUnreadSessions()).toEqual([]);
    expect(isSessionUnread("s1")).toBe(false);
  });

  test("toggle 按当前状态翻转", () => {
    toggleSessionUnread("s2");
    expect(isSessionUnread("s2")).toBe(true);
    toggleSessionUnread("s2");
    expect(isSessionUnread("s2")).toBe(false);
  });

  test("undefined id 恒为已读（草稿无 remoteId）", () => {
    expect(isSessionUnread(undefined)).toBe(false);
  });
});
