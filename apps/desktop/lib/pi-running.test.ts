import { describe, expect, mock, test } from "bun:test";
import type { PiChannel } from "@/lib/pi-channel";
import type { PiResponse } from "@/lib/pi-bridge";

/**
 * 侧边栏"运行中"信号链路测试：
 * - 启动时序：subscribeTurns 登记（异步）完成后才允许发起 listRunning 种子
 * - 合并语义：种子快照 + 增量双向修正 / 幂等 / 事件源失效清空重水合
 * - resync 纠偏：end 事件丢失留下的陈旧 true 增量在种子回来时清除，
 *   种子发起之后才 start 的会话不受误伤
 * - TauriPiChannel.subscribeTurns：turn_changed 行解析与 pi-exit 失效信号
 * mock Tauri invoke/listen（沿用 pi-channel-attach.test.ts 的桩风格）。
 */

type WireLine = { i: number | null; l: string };
type EventLike = { payload: WireLine[] | string };
type ListenFn = (event: EventLike) => void;

/** 按事件名捕获的监听回调（listen 桩登记于此） */
const listenersByEvent = new Map<string, ListenFn>();
let listRunningSeed: string[] = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "pi_request") {
      return Promise.resolve(
        JSON.stringify({ type: "running", sessionIds: listRunningSeed }),
      );
    }
    return Promise.reject(new Error(`unexpected invoke ${cmd}`));
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: ListenFn) => {
    listenersByEvent.set(event, cb);
    return Promise.resolve(() => {
      listenersByEvent.delete(event);
    });
  },
}));

const { TauriPiChannel, setPiChannel } = await import("@/lib/pi-channel");
const {
  startPiRunningWatch,
  resyncPiRunning,
  subscribeRunningSessions,
  isSessionRunning,
} = await import("@/lib/pi-running");

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
  test("通道无订阅能力 ⇒ 降级静默（种子也不会拉）", () => {
    let seedCalls = 0;
    const bare: PiChannel = {
      kind: "tauri",
      request: async (): Promise<PiResponse> => ({ type: "sessions", sessions: [] }),
      promptStream: () => new ReadableStream(),
      abort: async () => {},
      listRunning: async () => {
        seedCalls += 1;
        return [];
      },
    };
    setPiChannel(bare);
    startPiRunningWatch(); // 不应抛错，也不会启动（缺 subscribeTurns）
    expect(seedCalls).toBe(0);
    expect(isSessionRunning("a")).toBe(false);
    expect(isSessionRunning(undefined)).toBe(false);
  });

  test("先订阅就绪→种子→实时增量→失效重水合→resync 纠偏", async () => {
    let emit: ((sessionId: string | null, active: boolean) => void) | null = null;
    let resolveListen: (() => void) | null = null;
    let seedCalls = 0;
    let seedMode: "auto" | "manual" = "auto";
    let manualSeedResolve: ((ids: string[]) => void) | null = null;
    const fake: PiChannel = {
      kind: "tauri",
      request: async (): Promise<PiResponse> => ({ type: "sessions", sessions: [] }),
      promptStream: () => new ReadableStream(),
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
      // 登记完成前不 resolve（贴近 Tauri listen 的真实异步性）
      subscribeTurns: (cb) =>
        new Promise<() => void>((r) => {
          emit = cb;
          resolveListen = () =>
            r(() => {
              emit = null;
            });
        }),
    };
    setPiChannel(fake);
    listRunningSeed = ["a"];
    startPiRunningWatch();
    await flush();
    // 时序契约：订阅登记未完成前不得发起种子——登记窗口丢的 end 事件种子补不回
    expect(seedCalls).toBe(0);
    expect(isSessionRunning("a")).toBe(false);

    resolveListen!();
    await flush();
    expect(seedCalls).toBe(1);
    expect(isSessionRunning("a")).toBe(true);
    expect(isSessionRunning("b")).toBe(false);

    // 实时增量：b 开跑 → a 收尾（增量双向修正快照滞后）
    emit!("b", true);
    expect(isSessionRunning("b")).toBe(true);
    emit!("a", false);
    expect(isSessionRunning("a")).toBe(false);
    // 幂等：重复 end 投影不变 ⇒ 不触发通知
    const probe = snapshotLog();
    const beforeDup = probe.seen.length;
    emit!("a", false);
    expect(probe.seen.length).toBe(beforeDup);
    probe.stop();

    // 事件源失效（重启）：清空即时生效 + 按新种子重新水合
    listRunningSeed = ["b", "a"];
    emit!(null, false);
    expect(isSessionRunning("b")).toBe(false);
    await flush();
    expect(seedCalls).toBe(2);
    expect(isSessionRunning("b")).toBe(true);
    expect(isSessionRunning("a")).toBe(true);

    // resync 纠偏：d 的 end 事件丢失 ⇒ 增量陈旧 true 而种子事实里没有它 → 清除；
    // 种子发起之后才 start 的 c 不在"发起时刻 true 名单"，不得误伤
    emit!("d", true);
    seedMode = "manual";
    resyncPiRunning(); // seedCalls=3，在飞
    emit!("c", true); // 发起后才到达的新 start
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
