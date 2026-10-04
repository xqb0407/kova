import { afterAll, describe, expect, test } from "bun:test";
import type { PiChannel } from "@/lib/pi/pi-channel";
import type { PiResponse } from "@/lib/pi/pi-bridge";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

afterAll(restoreAllMocks);

/**
 * 侧边栏"运行中"信号链路测试（迁移 4c 后架构）：
 * - 启动时序：chunk-batch/pi-exit 监听登记（await listen）完成后才发起
 *   listRunning 种子——登记窗口里广播的起止事件种子补不回
 * - 增量源：pi-chunk-batch 行里的 thread_event（agent_start/agent_end）
 * - 合并语义：种子快照 + 增量双向修正 / 幂等 / 事件源失效清空重水合
 * - resync 纠偏：end 事件丢失留下的陈旧 true 增量在种子回来时清除，
 *   种子发起之后才 start 的会话不受误伤
 * - TauriPiChannel.subscribeTurns：turn_changed 行解析与 pi-exit 失效信号（旧 transport）
 * mock Tauri invoke/listen（沿用 pi-channel-attach.test.ts 的桩风格）。
 */

type WireLine = { i: number | null; l: string };
type EventLike = { payload: WireLine[] | string };
type ListenFn = (event: EventLike) => void;

/** 按事件名捕获的监听回调（listen 桩登记于此） */
const listenersByEvent = new Map<string, ListenFn>();
let listRunningSeed: string[] = [];

mockModule("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "pi_request") {
      return Promise.resolve(
        JSON.stringify({ type: "running", sessionIds: listRunningSeed }),
      );
    }
    return Promise.reject(new Error(`unexpected invoke ${cmd}`));
  },
}));

mockModule("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: ListenFn) => {
    listenersByEvent.set(event, cb);
    return Promise.resolve(() => {
      listenersByEvent.delete(event);
    });
  },
}));

const { TauriPiChannel, setPiChannel } = await import("@/lib/pi/pi-channel");
const {
  startPiRunningWatch,
  resyncPiRunning,
  subscribeRunningSessions,
  isSessionRunning,
  hydrateRunningRegistrations,
} = await import("@/lib/pi/pi-running");
const { piResumableStorage } = await import("@/lib/pi/pi-resume-storage");

// 通道单例收尾：setPiChannel 写的是共享模块的模块级 current，bun 同进程跑
// 整个 lib/pi/ 时会把本文件的 fake 泄漏给后跑文件（tauri-pi-client.test.ts
// 的 thread_snapshot 路径被毒化，3 个用例失败）——跑完清空注册表
afterAll(() => setPiChannel(null));

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 记录 store 快照变化的探针 */
function snapshotLog(ids: string[] = ["a", "b"]) {
  const seen: boolean[][] = [];
  const stop = subscribeRunningSessions(() => {
    seen.push(ids.map((id) => isSessionRunning(id)));
  });
  return { seen, stop };
}

describe("pi-running store", () => {
  test("通道无种子能力 ⇒ 降级静默（watch 不启动，种子也不会拉）", () => {
    // 旧通道无 listRunning：guard 在 watchStarted 置位前短路——此前用例给了
    // listRunning 导致置位后毒化下一个用例的 startPiRunningWatch（早退），
    // resolveListen 恒空而挂。这也与生产降级形态一致（旧 sidecar 无种子能力）。
    const bare: PiChannel = {
      kind: "tauri",
      request: async (): Promise<PiResponse> => ({ type: "sessions", sessions: [] }),
      abort: async () => {},
    };
    setPiChannel(bare);
    startPiRunningWatch();
    expect(isSessionRunning("a")).toBe(false);
    expect(isSessionRunning(undefined)).toBe(false);
  });

  test("监听就绪→种子→实时增量→失效重水合→resync 纠偏", async () => {
    let seedCalls = 0;
    let seedMode: "auto" | "manual" = "auto";
    let manualSeedResolve: ((ids: string[]) => void) | null = null;
    const fake: PiChannel = {
      kind: "tauri",
      request: async (): Promise<PiResponse> => ({ type: "sessions", sessions: [] }),
      abort: async () => {},
      listRunning: () => {
        seedCalls += 1;
        if (seedMode === "manual") {
          return new Promise<string[]>((r) => {
            manualSeedResolve = r;
          });
        }
        return Promise.resolve(listRunningSeed);
      },
    };
    setPiChannel(fake);
    listRunningSeed = ["a"];
    startPiRunningWatch();
    await flush();
    // 监听桩即刻 resolve ⇒ 登记完成后即发起种子（时序契约由 startPiRunningWatch
    // 的 await listen 结构保证：先登记后种子，登记窗口丢的 end 事件种子补不回）
    expect(seedCalls).toBe(1);
    expect(isSessionRunning("a")).toBe(true);
    expect(isSessionRunning("b")).toBe(false);

    // 实时增量（pi-chunk-batch 的 thread_event 行）：b 开跑 → a 收尾
    const emitTurn = (
      sessionId: string,
      kind: "agent_start" | "agent_end",
    ) => {
      listenersByEvent.get("pi-chunk-batch")!({
        payload: [
          {
            i: null,
            l: JSON.stringify({
              type: "thread_event",
              sessionId,
              event: { type: kind },
            }),
          },
        ],
      });
    };
    emitTurn("b", "agent_start");
    expect(isSessionRunning("b")).toBe(true);
    emitTurn("a", "agent_end");
    expect(isSessionRunning("a")).toBe(false);
    // 幂等：重复 end 投影不变 ⇒ 不触发通知
    const probe = snapshotLog();
    const beforeDup = probe.seen.length;
    emitTurn("a", "agent_end");
    expect(probe.seen.length).toBe(beforeDup);
    probe.stop();

    // 事件源失效（sidecar 重启，pi-exit）：清空即时生效 + 按新种子重新水合
    listRunningSeed = ["b", "a"];
    listenersByEvent.get("pi-exit")!({ payload: "0" });
    expect(isSessionRunning("b")).toBe(false);
    await flush();
    expect(seedCalls).toBe(2);
    expect(isSessionRunning("b")).toBe(true);
    expect(isSessionRunning("a")).toBe(true);

    // resync 纠偏：d 的 end 事件丢失 ⇒ 增量陈旧 true 而种子事实里没有它 → 清除；
    // 种子发起之后才 start 的 c 不在"发起时刻 true 名单"，不得误伤
    emitTurn("d", "agent_start");
    seedMode = "manual";
    resyncPiRunning(); // seedCalls=3，在飞
    emitTurn("c", "agent_start"); // 发起后才到达的新 start
    manualSeedResolve!([]); // 快照事实：b、a、d 都没在跑
    await flush();
    expect(seedCalls).toBe(3);
    expect(isSessionRunning("a")).toBe(false);
    expect(isSessionRunning("b")).toBe(false);
    expect(isSessionRunning("d")).toBe(false); // 陈旧增量被纠偏
    expect(isSessionRunning("c")).toBe(true); // 种子后新 start 保留
  });
});

describe("TauriPiChannel.subscribeTurns", () => {
  test("登记就绪后 resolve 退订；只解析 turn_changed 通知行；pi-exit 转失效信号", async () => {
    listRunningSeed = ["s9"];
    const channel = new TauriPiChannel();
    const got: [string | null, boolean][] = [];
    const teardown = channel.subscribeTurns!((sessionId, active) => {
      got.push([sessionId, active]);
    });
    expect(teardown).toBeInstanceOf(Promise); // 异步登记契约
    const unsubscribe = await teardown;
    expect(await channel.listRunning!()).toEqual(["s9"]);

    listenersByEvent.get("pi-chunk-batch")!({
      payload: [
        { i: null, l: '{"type":"turn_changed","sessionId":"a","active":true}' },
        // 热路径杂行：chunk 行与非 turn_changed 通知都不回调
        { i: 1, l: '{"id":"pi-x","chunk":{"type":"start"}}' },
        { i: null, l: '{"type":"pong","id":"mgr-1"}' },
        { i: null, l: "not-json" },
      ],
    });
    listenersByEvent.get("pi-exit")!({ payload: "0" });
    expect(got).toEqual([
      ["a", true],
      [null, false],
    ]);
    unsubscribe();
    listenersByEvent.get("pi-chunk-batch")?.({
      payload: [{ i: null, l: '{"type":"turn_changed","sessionId":"b","active":true}' }],
    });
    expect(got.length).toBe(2); // 退订后不再投递
  });
});

describe("hydrateRunningRegistrations（启动水合）", () => {
  test("存量残留先清空：陈旧条目不劫持回切，在跑轮次按 sidecar 真相重建", async () => {
    // 上一 webview 生命周期的残留（react-pi 新链路不写登记，轮次收尾清理
    // 也只覆盖本生命周期）：刷新回切曾被它劫持到无关会话（2026-10-01）
    piResumableStorage.setStreamId("req-stale", "pi-draft-old", "sid-stale");
    expect(piResumableStorage.getStreamId("sid-stale")).toBe("req-stale");

    const fake: PiChannel = {
      kind: "tauri",
      request: async (): Promise<PiResponse> => ({ type: "sessions", sessions: [] }),
      abort: async () => {},
      listRunningTurns: async () => [{ requestId: "req-run", sessionId: "sid-run" }],
    };
    setPiChannel(fake);
    const turns = await hydrateRunningRegistrations();
    expect(turns).toEqual([{ requestId: "req-run", sessionId: "sid-run" }]);
    expect(piResumableStorage.getStreamId("sid-stale")).toBeNull(); // 残留被清
    expect(piResumableStorage.getStreamId("sid-run")).toBe("req-run"); // 在跑重建
  });

  test("通道缺 listRunningTurns 能力：仍清空残留（降级路径同样不劫持回切）", async () => {
    piResumableStorage.setStreamId("req-stale2", "pi-draft-old2", "sid-stale2");
    const bare: PiChannel = {
      kind: "tauri",
      request: async (): Promise<PiResponse> => ({ type: "sessions", sessions: [] }),
      abort: async () => {},
    };
    setPiChannel(bare);
    expect(await hydrateRunningRegistrations()).toEqual([]);
    expect(piResumableStorage.getStreamId("sid-stale2")).toBeNull();
  });
});
