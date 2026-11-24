import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * hook_message 自发帧 → 全局 toast。
 * 只验证帧到 toast 的接线；通道实现由 pi-channel 的既有测试覆盖。
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
const { installHookMessageToasts } = await import("@/lib/pi/hook-messages");
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

describe("hook_message toast", () => {
  afterEach(() => {
    setPiChannel(null);
    toasts.length = 0;
  });

  test("systemMessage 帧转成 warning toast", () => {
    setPiChannel(fakeChannel);
    installHookMessageToasts();
    expect(handler).toBeDefined();

    handler!({ type: "hook_message", hookName: "warn", text: "heads up" });

    expect(toasts).toHaveLength(1);
    expect(String(toasts[0]!.title)).toContain("warn");
    expect(toasts[0]!.description).toBe("heads up");
    expect(toasts[0]!.duration).toBe(6000);
  });

  test("空文本忽略", () => {
    setPiChannel(fakeChannel);
    installHookMessageToasts();

    handler!({ type: "hook_message", text: "   " });
    expect(toasts).toHaveLength(0);
  });
});
