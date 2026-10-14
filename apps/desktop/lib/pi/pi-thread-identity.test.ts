import { describe, expect, test } from "bun:test";

import {
  claimKnownSession,
  isLocalDraftThreadId,
  type ClaimDeps,
} from "./pi-thread-identity";

const SESSION = "a3f7e87c-ec5f-44f7-8b6b-3e70679c9307";
const DRAFT = "__LOCALID_ETtIPuw";

const deps = (entries: { ownerChatId: string; sessionId?: string }[]): ClaimDeps => ({
  peekEntries: () => entries,
});

describe("isLocalDraftThreadId", () => {
  test("__LOCALID_ 前缀 = 运行时新草稿", () => {
    expect(isLocalDraftThreadId(DRAFT)).toBe(true);
  });

  test("sessionId（UUID）不是草稿 id", () => {
    expect(isLocalDraftThreadId(SESSION)).toBe(false);
  });
});

describe("claimKnownSession（绑定认领阶梯）", () => {
  test("恢复/列表线程：threadId 本身就是 sessionId，直接认领自己（不依赖列表水合）", () => {
    expect(claimKnownSession(SESSION, deps([]))).toBe(SESSION);
    expect(claimKnownSession(SESSION, deps([{ ownerChatId: DRAFT, sessionId: "x" }]))).toBe(
      SESSION,
    );
  });

  test("在飞登记按 ownerChatId 命中：认领登记里的 sessionId", () => {
    expect(
      claimKnownSession(DRAFT, deps([{ ownerChatId: DRAFT, sessionId: SESSION }])),
    ).toBe(SESSION);
  });

  test("真草稿且无登记：返回 null（调用方才允许 new_session 物化新会话）", () => {
    expect(claimKnownSession(DRAFT, deps([]))).toBeNull();
    expect(
      claimKnownSession(DRAFT, deps([{ ownerChatId: "other-thread", sessionId: SESSION }])),
    ).toBeNull();
  });

  test("非 UUID 非草稿的异形 id 不走「id 即 sessionId」捷径", () => {
    expect(claimKnownSession("custom-thread-id", deps([]))).toBeNull();
  });
});
