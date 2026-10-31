import { describe, expect, test } from "bun:test";
import {
  isLocalThreadId,
  isSessionNotFoundError,
  markSilentRuntimeAction,
} from "./thread-missing";

describe("isSessionNotFoundError", () => {
  test("识别 sidecar 的缺行文案（大小写不敏感）", () => {
    expect(isSessionNotFoundError(new Error("session not found: abc"))).toBe(true);
    expect(isSessionNotFoundError(new Error("Session Not Found: abc"))).toBe(true);
    expect(isSessionNotFoundError("session not found: abc")).toBe(true);
  });

  test("其它错误不误判", () => {
    expect(isSessionNotFoundError(new Error("sidecar not ready"))).toBe(false);
    expect(isSessionNotFoundError(new Error("thread_snapshot timeout"))).toBe(false);
    expect(isSessionNotFoundError(null)).toBe(false);
  });
});

describe("isLocalThreadId", () => {
  test("草稿 id 与 sessionId 区分开", () => {
    expect(isLocalThreadId("__LOCALID_draft-a")).toBe(true);
    expect(isLocalThreadId("__LOCALID_")).toBe(true);
    expect(isLocalThreadId("d5abc9ac-5419-4f7e-9907-04749f11e2a5")).toBe(false);
    expect(isLocalThreadId("")).toBe(false);
  });
});

describe("markSilentRuntimeAction", () => {
  test("打上 assistant-ui 的 silent 标记且保留原错误信息", () => {
    const error = new Error("session not found: abc");
    expect(markSilentRuntimeAction(error)).toBe(error);
    expect(
      (error as unknown as Record<symbol, unknown>)[
        Symbol.for("assistant-ui.silent-runtime-action")
      ],
    ).toBe(true);
    expect(error.message).toBe("session not found: abc");
  });

  test("重复标记幂等", () => {
    const error = new Error("session not found: abc");
    const first = markSilentRuntimeAction(error);
    const second = markSilentRuntimeAction(error);
    expect(second).toBe(first);
    expect(
      (error as unknown as Record<symbol, unknown>)[
        Symbol.for("assistant-ui.silent-runtime-action")
      ],
    ).toBe(true);
  });
});
