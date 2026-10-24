import { describe, expect, test } from "bun:test";
import { PiThreadController } from "./ThreadController";
import type { PiClient, PiClientEvent, PiThreadSnapshot } from "../types";

/**
 * 停止对账看门狗（ThreadController.armStopReconcile）的行为钉桩：
 * - abort 后 agent_end 照常到达 → 看门狗不产生额外快照；
 * - agent_end 永远不来（sidecar 换代）→ 超时拉快照对账归位；
 * - 快照仍报 running（abort 在串行队列排队）→ 有限次重排后放弃；
 * - 放弃路径不污染下一次停止的重试预算。
 *
 * 计时一律「轮询到条件 + 静默窗口」，不用固定 sleep 推算节拍：CI 负载下
 * setTimeout 可能被延迟几十到几百 ms，固定 sleep 断言会随机失败。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 predicate 成立（默认 5s 截止） */
const waitUntil = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timeout: ${label}`);
    await sleep(5);
  }
};

let seqCounter = 10;
const snapshotOf = (status: "running" | "idle"): PiThreadSnapshot =>
  ({
    metadata: { id: "t1", status },
    messages: [],
    seq: ++seqCounter,
  }) as unknown as PiThreadSnapshot;

type StubClient = {
  client: PiClient;
  emit: (event: PiClientEvent) => void;
  getThreadCalls: () => number;
  setNextSnapshots: (snapshots: PiThreadSnapshot[]) => void;
};

const stubClient = (): StubClient => {
  let cb: ((event: PiClientEvent) => void) | null = null;
  let calls = 0;
  let snapshots = [snapshotOf("idle")];
  const client = {
    subscribe: (
      _threadId: string,
      listener: (event: PiClientEvent) => void,
    ) => {
      cb = listener;
      return () => {};
    },
    getThread: async (): Promise<PiThreadSnapshot> => {
      calls += 1;
      return snapshots[Math.min(calls - 1, snapshots.length - 1)]!;
    },
    cancelRun: async () => {},
  };
  return {
    client: client as unknown as PiClient,
    emit: (event) => cb?.(event),
    getThreadCalls: () => calls,
    setNextSnapshots: (next) => {
      snapshots = next;
      calls = 0;
    },
  };
};

const DELAY_MS = 15;
const MAX_CYCLES = 3;

const makeController = (client: PiClient) =>
  new PiThreadController(client, "t1", {
    stopReconcileDelayMs: DELAY_MS,
    stopReconcileMaxCycles: MAX_CYCLES,
  });

/** 静默窗口：确认没有「额外」轮询发生（有的话会在一个节拍内出现） */
const QUIET_WINDOW_MS = DELAY_MS * 4;

describe("停止对账看门狗", () => {
  test("agent_end 正常到达：看门狗不产生额外快照", async () => {
    const stub = stubClient();
    const controller = makeController(stub.client);
    const detach = controller.connect();
    stub.emit({ type: "agent_start", threadId: "t1", seq: 1 });
    expect(controller.getState().runStatus).toBe("running");

    await controller.cancel(); // cancelRun 即刻成功
    // agent_end 正常到达（比看门狗快）
    stub.emit({ type: "agent_end", threadId: "t1", seq: 2 });
    await sleep(QUIET_WINDOW_MS);

    expect(controller.getState().runStatus).toBe("idle");
    expect(stub.getThreadCalls()).toBe(0);
    detach();
  });

  test("agent_end 永远不来（sidecar 换代）：超时拉快照对账归位", async () => {
    const stub = stubClient();
    const controller = makeController(stub.client);
    const detach = controller.connect();
    stub.emit({ type: "agent_start", threadId: "t1", seq: 1 });
    // 换代后的 sidecar：快照权威报 idle
    stub.setNextSnapshots([snapshotOf("idle")]);

    await controller.cancel();
    await waitUntil(
      () => controller.getState().runStatus === "idle",
      "watchdog reconcile settles runStatus",
    );

    expect(stub.getThreadCalls()).toBe(1);
    detach();
  });

  test("快照仍报 running：有限次重排后放弃，不再轮询", async () => {
    const stub = stubClient();
    const controller = makeController(stub.client);
    const detach = controller.connect();
    stub.emit({ type: "agent_start", threadId: "t1", seq: 1 });
    // abort 在串行队列里排队：快照持续报 running
    stub.setNextSnapshots([snapshotOf("running")]);

    await controller.cancel();
    await waitUntil(
      () => stub.getThreadCalls() >= MAX_CYCLES,
      "watchdog exhausts retry budget",
    );
    await sleep(QUIET_WINDOW_MS); // 放弃后不得再排下一轮

    expect(controller.getState().runStatus).toBe("running");
    expect(stub.getThreadCalls()).toBe(MAX_CYCLES);
    detach();
  }, 20_000);

  test("放弃路径不污染下一次停止的看门狗预算（计轮随 cancel 归零）", async () => {
    const stub = stubClient();
    const controller = makeController(stub.client);
    const detach = controller.connect();

    // 第一轮：走满放弃路径（快照持续 running）
    stub.emit({ type: "agent_start", threadId: "t1", seq: 1 });
    stub.setNextSnapshots([snapshotOf("running")]);
    await controller.cancel();
    await waitUntil(
      () => stub.getThreadCalls() >= MAX_CYCLES,
      "first stop exhausts retry budget",
    );
    expect(controller.getState().runStatus).toBe("running");

    // 该轮最终由 agent_end 收尾（无看门狗回调可清零计数的场景）。
    // seq 必须高于快照水位（snapshot 事件推进 lastSeq，低 seq 会被去重丢弃）
    stub.emit({ type: "agent_end", threadId: "t1", seq: 1_000 });
    expect(controller.getState().runStatus).toBe("idle");

    // 第二轮：需要两轮对账才归位——修复前带着满值计轮，第一轮就放弃
    stub.emit({ type: "agent_start", threadId: "t1", seq: 1_001 });
    stub.setNextSnapshots([snapshotOf("running"), snapshotOf("idle")]);
    await controller.cancel();
    await waitUntil(
      () => controller.getState().runStatus === "idle",
      "second stop reconciles with a fresh budget",
    );

    expect(stub.getThreadCalls()).toBe(2);
    detach();
  }, 20_000);

  test("cancelRun 抛错（abort 未送达）同样布置看门狗兜底", async () => {
    const stub = stubClient();
    // 覆写 cancelRun：传输层异常（sidecar 已死/卡死）
    (stub.client as unknown as { cancelRun: () => Promise<void> }).cancelRun =
      async () => {
        throw new Error("pi-agent is not running");
      };
    const controller = makeController(stub.client);
    const detach = controller.connect();
    stub.emit({ type: "agent_start", threadId: "t1", seq: 1 });
    stub.setNextSnapshots([snapshotOf("idle")]);

    await expect(controller.cancel()).rejects.toThrow("pi-agent is not running");
    await waitUntil(
      () => controller.getState().runStatus === "idle",
      "watchdog reconciles after cancelRun rejection",
    );

    expect(stub.getThreadCalls()).toBe(1);
    detach();
  });
});
