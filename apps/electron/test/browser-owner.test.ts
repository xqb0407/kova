import { describe, expect, test } from "bun:test";
import { resolveGuestOwner } from "../main/browser-owner";

describe("resolveGuestOwner", () => {
  test("首次绑定：把空属主设置为请求会话", () => {
    expect(resolveGuestOwner(null, "thread-a")).toBe("thread-a");
  });

  test("同一会话重复绑定（StrictMode / 双事件）保持幂等", () => {
    expect(resolveGuestOwner("thread-a", "thread-a")).toBe("thread-a");
  });

  test("不带属主的 UI 绑定不覆盖已有属主", () => {
    expect(resolveGuestOwner("thread-a", null)).toBe("thread-a");
  });

  test("拒绝把同一个 guest 转给另一个会话", () => {
    expect(() => resolveGuestOwner("thread-a", "thread-b")).toThrow(
      /already belongs to another conversation/,
    );
  });
});
