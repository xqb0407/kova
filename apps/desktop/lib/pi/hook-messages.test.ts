import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * hook_message 自发帧 → 全局 toast：接线、去重/限流、会话上下文与展示截断。
 * 通道实现由 pi-channel 的既有测试覆盖。
 */

type ToastInput = { title?: unknown; description?: unknown; duration?: number };
const toasts: ToastInput[] = [];

mockModule("@/components/ui/toast", () => ({
  toast: {
    warning: (input: ToastInput) => {
      toasts.push(input);
      return "toast-id";
    },
  },
}));
afterAll(() => restoreAllMocks());

const { setPiChannel } = await import("@/lib/pi/pi-channel");
const { installHookMessageToasts, resetHookMessageToastStateForTest } = await import(
  "@/lib/pi/hook-messages"
);
import type { PiChannel, PiHookMessageFrame } from "@/lib/pi/pi-channel";

let handler: ((frame: PiHookMessageFrame) => void) | undefined;

const fakeChannel = {
  kind: "desktop",
  request: async () => ({ type: "ok" }),
  subscribeHookMessages: (cb: (frame: PiHookMessageFrame) => void) => {
    handler = cb;
    return () => {
      handler = undefined;
    };
  },
} as unknown as PiChannel;

const frame = (over: Partial<PiHookMessageFrame> = {}): PiHookMessageFrame => ({
  type: "hook_message",
  hookName: "warn",
  text: "heads up",
  ...over,
});

beforeEach(() => {
  resetHookMessageToastStateForTest();
  toasts.length = 0;
  setPiChannel(fakeChannel);
  installHookMessageToasts();
  expect(handler).toBeDefined();
});

afterEach(() => {
  setPiChannel(null);
  toasts.length = 0;
});

describe("hook_message toast", () => {
  test("systemMessage 帧转成 warning toast", () => {
    handler!(frame());
    expect(toasts).toHaveLength(1);
    expect(String(toasts[0]!.title)).toContain("warn");
    expect(toasts[0]!.description).toBe("heads up");
    expect(toasts[0]!.duration).toBe(6000);
  });

  test("同内容短窗去重", () => {
    handler!(frame());
    handler!(frame());
    expect(toasts).toHaveLength(1);
  });

  test("全局限流：10s 内最多 5 条", () => {
    for (let i = 0; i < 6; i += 1) handler!(frame({ text: `msg-${i}` }));
    expect(toasts).toHaveLength(5);
  });

  test("带事件与会话上下文", () => {
    handler!(
      frame({
        event: "PreToolUse",
        sessionId: "sess-123456789",
        text: "heads up",
      }),
    );
    const description = String(toasts[0]!.description);
    expect(description).toContain("heads up");
    expect(description).toContain("PreToolUse");
    expect(description).toContain("sess-123");
  });

  test("长文本展示截断", () => {
    handler!(frame({ text: "x".repeat(700) }));
    const description = String(toasts[0]!.description);
    expect(description.endsWith("…")).toBe(true);
    expect(description.length).toBeLessThan(700);
  });

  test("空文本忽略", () => {
    handler!(frame({ text: "   " }));
    expect(toasts).toHaveLength(0);
  });
});
