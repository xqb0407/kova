import { afterAll, describe, expect, test } from "bun:test";
import type { PiChannel } from "@/lib/pi/pi-channel";
import type { PiResponse } from "@/lib/pi/pi-bridge";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * 定时任务实时投影 store 测试：
 * - fired → running 置位且不作废中（lastResult 清空）
 * - done（成功/失败）→ running 清除 + lastResult 记录 + agent-events 转发
 * - fired 帧不产生总线事件（通知卫生）
 * - 迟到旧轮 done 帧不得清除新一轮 running（runId 守卫）
 * - 通道缺 subscribeAutomationEvents 能力 ⇒ 静默降级不抛错
 */

type FrameHandler = (frame: unknown) => void;

mockModule("@tauri-apps/api/core", () => ({
  invoke: () => Promise.reject(new Error("unexpected invoke")),
}));
mockModule("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

// startAutomationLiveWatch 的 window 守卫（避免 SSR 触碰 Tauri API）在测试环境放行；
// 跑完连同 mock 注入一起回滚，别把桩留给同进程的后续测试文件
const hadWindow = "window" in globalThis;
(globalThis as { window?: unknown }).window ??= {};
afterAll(() => {
  restoreAllMocks();
  setPiChannel(null); // 通道单例不跨文件泄漏（同 pi-running.test.ts 收尾）
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

const { setPiChannel } = await import("@/lib/pi/pi-channel");
const {
  startAutomationLiveWatch,
  subscribeAutomationLive,
  getAutomationRunning,
  getAutomationLastResult,
  setAutomationFrameSync,
} = await import("@/lib/automation/automation-live");
const { subscribeAgentEvents } = await import("@/lib/pi/agent-events");

let feed: FrameHandler | null = null;

function fakeChannel(): PiChannel {
  return {
    kind: "tauri",
    request: async (): Promise<PiResponse> => ({ type: "sessions", sessions: [] }),
    promptStream: () => new ReadableStream(),
    abort: async () => {},
    subscribeAutomationEvents: (cb: FrameHandler) => {
      feed = cb;
      return () => {
        feed = null;
      };
    },
  } as unknown as PiChannel;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("automation-live store", () => {
  test("缺能力的通道 ⇒ 静默降级", async () => {
    const bare: PiChannel = {
      kind: "ws",
      request: async (): Promise<PiResponse> => ({ type: "sessions", sessions: [] }),
      promptStream: () => new ReadableStream(),
      abort: async () => {},
    } as unknown as PiChannel;
    setPiChannel(bare);
    startAutomationLiveWatch(); // 不得抛错
    await flush();
    expect(feed).toBeNull(); // 未订阅
  });

  test("fired/done 全周期与事件转发", async () => {
    setPiChannel(fakeChannel());
    // 上一测试因通道缺能力未置 watchStarted，此处真正装配订阅
    startAutomationLiveWatch();
    await flush();
    const f = feed;
    if (!f) throw new Error("subscription not established");

    const events: string[] = [];
    const un = subscribeAgentEvents((e) => {
      if (e.name.startsWith("automation.")) events.push(e.name);
    });
    let notifies = 0;
    const unsub2 = subscribeAutomationLive(() => notifies++);

    f({
      type: "automation_fired",
      taskId: "t1",
      taskName: "日报",
      taskType: "cron",
      runId: "r1",
      firedAt: "2026-09-15T01:00:00Z",
    });
    expect(getAutomationRunning("t1")?.runId).toBe("r1");
    expect(getAutomationLastResult("t1")).toBeUndefined();
    expect(events).toEqual([]); // fired 不推送

    f({
      type: "automation_run_done",
      taskId: "t1",
      taskName: "日报",
      runId: "r1",
      ok: true,
      sessionId: "sess-1",
      finishedAt: "2026-09-15T01:02:00Z",
    });
    expect(getAutomationRunning("t1")).toBeUndefined();
    expect(getAutomationLastResult("t1")).toMatchObject({ ok: true, sessionId: "sess-1" });
    expect(events).toEqual(["automation.task.completed"]);

    // 失败结算 + 无 sessionId（调度错误路径）
    f({
      type: "automation_run_done",
      taskId: "t2",
      taskName: "坏任务",
      runId: "r2",
      ok: false,
      error: "invalid cron expression",
      finishedAt: "2026-09-15T01:03:00Z",
    });
    expect(getAutomationLastResult("t2")).toMatchObject({ ok: false });
    expect(events).toEqual(["automation.task.completed", "automation.task.failed"]);
    expect(notifies).toBe(3); // fired/done/done 各一次投影变更

    un();
    unsub2();
  });

  test("runId 守卫：新一轮 fired 后迟到旧轮 done 不清除 running", async () => {
    const f = feed!;
    f({
      type: "automation_fired",
      taskId: "t3",
      taskName: "x",
      taskType: "interval",
      runId: "r3-new",
      firedAt: "2026-09-15T02:00:00Z",
    });
    f({
      type: "automation_run_done",
      taskId: "t3",
      taskName: "x",
      runId: "r3-old",
      ok: false,
      error: "late",
      finishedAt: "2026-09-15T02:00:01Z",
    });
    expect(getAutomationRunning("t3")?.runId).toBe("r3-new");
  });

  test("fired/done 帧驱动去抖的会话列表同步（一批帧只刷一次）", async () => {
    const f = feed!;
    let syncs = 0;
    setAutomationFrameSync(() => syncs++);

    f({
      type: "automation_fired",
      taskId: "t5",
      taskName: "y",
      taskType: "cron",
      runId: "r5",
      firedAt: "2026-09-15T03:00:00Z",
    });
    f({
      type: "automation_run_done",
      taskId: "t5",
      taskName: "y",
      runId: "r5",
      ok: true,
      sessionId: "sess-5",
      finishedAt: "2026-09-15T03:00:30Z",
    });
    expect(syncs).toBe(0); // 去抖窗口内尚未触发
    await new Promise((r) => setTimeout(r, 700));
    expect(syncs).toBe(1);

    // 注销后不再调度
    setAutomationFrameSync(null);
    f({
      type: "automation_fired",
      taskId: "t6",
      taskName: "z",
      taskType: "cron",
      runId: "r6",
      firedAt: "2026-09-15T03:01:00Z",
    });
    await new Promise((r) => setTimeout(r, 700));
    expect(syncs).toBe(1);
  });
});
