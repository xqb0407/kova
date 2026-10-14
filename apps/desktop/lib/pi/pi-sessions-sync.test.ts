import { afterEach, describe, expect, test } from "bun:test";

/**
 * 会话清单跨端同步（sessions_changed → 防抖 reload）：通道注册即装配、
 * 连续帧合并为一次刷新、事件源失效（cb(null)）同路、通道换代时旧订阅退订、
 * 无能力通道静默降级。通道走 setPiChannel 假实现（与 pi-context.test 同款）。
 */
import type { PiChannel, PiSessionsChangedFrame } from "@/lib/pi/pi-channel";

const { setPiChannel } = await import("@/lib/pi/pi-channel");
const sync = await import("@/lib/pi/pi-sessions-sync");

function makeFake() {
  const cbs = new Set<(frame: PiSessionsChangedFrame | null) => void>();
  let unsubbed = 0;
  const ch = {
    kind: "ws" as const,
    subscribeSessionsChanged(
      cb: (frame: PiSessionsChangedFrame | null) => void,
    ) {
      cbs.add(cb);
      return () => {
        cbs.delete(cb);
        unsubbed++;
      };
    },
  } as unknown as PiChannel;
  return {
    ch,
    fire: (frame: PiSessionsChangedFrame | null) => {
      for (const cb of [...cbs]) cb(frame);
    },
    unsubCount: () => unsubbed,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 去抖窗口 500ms，取余量
const SETTLE = 700;

afterEach(() => {
  sync.setSessionsChangedSync(null);
  setPiChannel(null);
});

describe("pi-sessions-sync", () => {
  test("变更帧防抖合并：连续两帧 → 一次 reload", async () => {
    const a = makeFake();
    setPiChannel(a.ch);
    let calls = 0;
    sync.setSessionsChangedSync(() => calls++);
    a.fire({ type: "sessions_changed", op: "created", sessionId: "s1" });
    a.fire({ type: "sessions_changed", op: "updated", sessionId: "s2" });
    expect(calls).toBe(0); // 去抖窗口未落
    await sleep(SETTLE);
    expect(calls).toBe(1);
  });

  test("cb(null)（事件源失效/重连）与变更帧同路触发 reload", async () => {
    const a = makeFake();
    setPiChannel(a.ch);
    let calls = 0;
    sync.setSessionsChangedSync(() => calls++);
    a.fire(null);
    await sleep(SETTLE);
    expect(calls).toBe(1);
  });

  test("通道换代：旧订阅退订，新通道继续收帧", async () => {
    const a = makeFake();
    setPiChannel(a.ch);
    let calls = 0;
    sync.setSessionsChangedSync(() => calls++);
    const b = makeFake();
    setPiChannel(b.ch);
    expect(a.unsubCount()).toBe(1);
    a.fire({ type: "sessions_changed", op: "updated", sessionId: "stale" });
    expect(calls).toBe(0); // 旧通道帧已无人接
    b.fire({ type: "sessions_changed", op: "created", sessionId: "fresh" });
    await sleep(SETTLE);
    expect(calls).toBe(1);
  });

  test("无能力通道静默降级：注册/发帧都不抛", async () => {
    const plain = { kind: "tauri" } as unknown as PiChannel;
    setPiChannel(plain);
    let calls = 0;
    expect(() => sync.setSessionsChangedSync(() => calls++)).not.toThrow();
    await sleep(SETTLE);
    expect(calls).toBe(0);
  });

  test("注销回调后帧不再触发 reload", async () => {
    const a = makeFake();
    setPiChannel(a.ch);
    let calls = 0;
    sync.setSessionsChangedSync(() => calls++);
    sync.setSessionsChangedSync(null);
    a.fire({ type: "sessions_changed", op: "deleted", sessionId: "s1" });
    await sleep(SETTLE);
    expect(calls).toBe(0);
  });
});
