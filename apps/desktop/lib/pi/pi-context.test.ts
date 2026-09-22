import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * 上下文占用镜像测试（设计文档 §7）：context_changed 推送帧直更（绑定反查、
 * 陈旧水印丢弃、畸形形状丢弃）、拉取写入的字段映射、缺口回拉
 * refreshContextMirror、以及惰性订阅的一次性/可重订阅语义。
 * piRequest 打桩换响应；通道走 setPiChannel 假实现（不走 mock.module，
 * 每例干净换线）。
 */

const seenRequests: Record<string, unknown>[] = [];
let contextInfoReply: Record<string, unknown> = {};
let contextInfoReject = false;

// 只换 piRequest，其余运行时导出透传（mock.module 进程级，别拆后载文件的符号）
const realPiBridge = await import("@/lib/pi/pi-bridge");
mock.module("@/lib/pi/pi-bridge", () => ({
  ...realPiBridge,
  piRequest: (req: Record<string, unknown>) => {
    seenRequests.push(req);
    if (req.type === "context_info") {
      return contextInfoReject
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(contextInfoReply);
    }
    return Promise.resolve({ type: "ok" });
  },
}));

const ctx = await import("@/lib/pi/pi-context");
const { piSessionRegistry } = await import("@/lib/pi/pi-thread-adapter");
const { setPiChannel } = await import("@/lib/pi/pi-channel");
import type { PiChannel, PiContextChangedFrame } from "@/lib/pi/pi-channel";

const frame = (
  over: Partial<PiContextChangedFrame> & { sessionId: string },
): PiContextChangedFrame => ({
  type: "context_changed",
  usedTokens: 100,
  threshold: 8000,
  contextWindow: 16000,
  cacheHitRatio: null,
  ...over,
});

/** 等一轮微任务/定时器结算（refreshContextMirror 与订阅都是异步落账） */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  seenRequests.length = 0;
  contextInfoReply = {};
  contextInfoReject = false;
  ctx.teardownContextSubscription();
  setPiChannel(null);
});

afterEach(() => {
  ctx.teardownContextSubscription();
  setPiChannel(null);
});

describe("context 占用镜像（§7）", () => {
  test("推送帧直更：按会话反查线程；未绑定/畸形帧丢弃", () => {
    piSessionRegistry.set("thread-a", "sess-a");
    ctx.applyContextChanged(
      frame({
        sessionId: "sess-a",
        usedTokens: 1234,
        threshold: 8000,
        contextWindow: 16000,
        cacheHitRatio: 0.5,
        eventSeq: 3,
      }),
    );
    expect(ctx.readContextMirror("thread-a")).toEqual({
      usedTokens: 1234,
      threshold: 8000,
      contextWindow: 16000,
      cacheHitRatio: 0.5,
      eventSeq: 3,
    });

    // 没登记的会话：帧无处安放，不建条目也不串台
    ctx.applyContextChanged(frame({ sessionId: "sess-orphan", usedTokens: 999 }));
    expect(ctx.readContextMirror("thread-orphan")).toBeNull();
    expect(ctx.readContextMirror("thread-a")?.usedTokens).toBe(1234);

    // 数值形状残缺：整帧弃
    ctx.applyContextChanged(
      { ...frame({ sessionId: "sess-a" }), usedTokens: undefined } as unknown as PiContextChangedFrame,
    );
    expect(ctx.readContextMirror("thread-a")?.usedTokens).toBe(1234);
  });

  test("陈旧水印丢弃；拉取写入（eventSeq null）不受推送回退保护", () => {
    piSessionRegistry.set("thread-b", "sess-b");
    ctx.applyContextChanged(frame({ sessionId: "sess-b", usedTokens: 1, eventSeq: 5 }));
    ctx.applyContextChanged(frame({ sessionId: "sess-b", usedTokens: 2, eventSeq: 3 })); // 重放旧号：弃
    expect(ctx.readContextMirror("thread-b")).toMatchObject({ usedTokens: 1, eventSeq: 5 });
    ctx.applyContextChanged(frame({ sessionId: "sess-b", usedTokens: 3, eventSeq: 8 })); // 新号：更新
    expect(ctx.readContextMirror("thread-b")).toMatchObject({ usedTokens: 3, eventSeq: 8 });

    // 拉取写入总是生效（口径同源、时间更新），并清掉水印门槛
    ctx.setContextMirrorFromPull("thread-b", {
      messageTokens: 10,
      systemPromptTokens: 5,
      toolTokens: 3,
      hardLimit: 7777,
      contextWindow: 9999,
      cacheHitRate: 0.25,
    } as never);
    expect(ctx.readContextMirror("thread-b")).toEqual({
      usedTokens: 18, // 三项之和（与推送口径一致）
      threshold: 7777,
      contextWindow: 9999,
      cacheHitRatio: 0.25,
      eventSeq: null,
    });
    // 拉取后旧推送号（6 < 8 但 prev 已是 null）照常更新
    ctx.applyContextChanged(frame({ sessionId: "sess-b", usedTokens: 4, eventSeq: 6 }));
    expect(ctx.readContextMirror("thread-b")).toMatchObject({ usedTokens: 4, eventSeq: 6 });
  });

  test("refreshContextMirror：发 context_info 拉取回填；失败静默", async () => {
    contextInfoReply = {
      messageTokens: 7,
      systemPromptTokens: 2,
      toolTokens: 1,
      hardLimit: 100,
      contextWindow: 200,
      cacheHitRate: null,
    };
    ctx.refreshContextMirror("thread-c");
    await settle();
    expect(seenRequests.some((r) => r.type === "context_info" && r.threadId === "thread-c")).toBe(true);
    expect(ctx.readContextMirror("thread-c")).toMatchObject({ usedTokens: 10, threshold: 100 });

    contextInfoReject = true;
    ctx.refreshContextMirror("thread-d");
    await settle(); // 不抛、不建条目——守卫路径上零噪音
    expect(ctx.readContextMirror("thread-d")).toBeNull();
  });

  test("惰性订阅：一次注册、帧经通道回调进镜像；teardown 后可重订", async () => {
    piSessionRegistry.set("thread-e", "sess-e");
    let push: ((f: PiContextChangedFrame) => void) | null = null;
    let subscribed = 0;
    let unlistened = 0;
    setPiChannel({
      subscribeContextChanges: (cb: (f: PiContextChangedFrame) => void) => {
        subscribed += 1;
        push = cb;
        return Promise.resolve(() => {
          unlistened += 1;
          push = null;
        });
      },
    } as unknown as PiChannel);

    ctx.ensureContextSubscription();
    ctx.ensureContextSubscription(); // 重复触发只订一次
    await settle();
    expect(subscribed).toBe(1);

    push!(frame({ sessionId: "sess-e", usedTokens: 42, eventSeq: 7 }));
    expect(ctx.readContextMirror("thread-e")).toMatchObject({ usedTokens: 42 });

    ctx.teardownContextSubscription();
    expect(unlistened).toBe(1);
    ctx.ensureContextSubscription();
    await settle();
    expect(subscribed).toBe(2);
  });

  test("通道不支持订阅：镜像退化纯拉取，ensure 不抛", async () => {
    setPiChannel({} as unknown as PiChannel); // 无 subscribeContextChanges 的老通道
    ctx.ensureContextSubscription();
    await settle();
    expect(() => ctx.teardownContextSubscription()).not.toThrow();
  });
});
