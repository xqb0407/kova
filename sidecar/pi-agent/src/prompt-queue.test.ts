import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { initStorage } from "./storage";
import {
  cancelAllEntries,
  cancelEntry,
  enqueueTurn,
  PROMPT_QUEUE_LIMIT,
  promoteEntry,
  queueSnapshot,
  resetQueueForTests,
  shouldQueue,
  takeFrontEntry,
  updateEntryText,
} from "./prompt-queue";
import { dispatch, dispatchPrompt } from "./protocol";
import { resolveSession } from "./sessions";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-queue-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
});

/** 捕获协议流（send 写 process.stdout） */
const lines: string[] = [];
let origWrite: typeof process.stdout.write;

beforeAll(() => {
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (
    c: unknown,
  ) => {
    lines.push(String(c));
    return true;
  };
});

afterAll(() => {
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
    origWrite as unknown as (c: unknown) => boolean;
});

/** 从捕获流里取某 reqId 的全部 chunk */
const chunksFor = (reqId: string) =>
  lines
    .map((l) => JSON.parse(l) as { id: string; chunk?: Record<string, unknown> })
    .filter((l) => l.id === reqId && l.chunk)
    .map((l) => l.chunk!);

/** 管理命令响应（非 chunk 行） */
const responses = (id: string) =>
  lines
    .map((l) => JSON.parse(l) as { id: string; type?: string })
    .filter((l) => l.id === id && l.type);

describe("prompt-queue state machine", () => {
  test("enqueue/take roundtrip with 1-based positions", () => {
    resetQueueForTests();
    expect(shouldQueue()).toBe(false);

    const a = enqueueTurn("qa", "t1", { text: "a" });
    const b = enqueueTurn("qb", "t1", { text: "b" });
    expect(a.ok && b.ok).toBe(true);
    expect(queueSnapshot()).toEqual([
      { reqId: "qa", threadId: "t1", text: "a", position: 1 },
      { reqId: "qb", threadId: "t1", text: "b", position: 2 },
    ]);

    // 链节取队首：qa 先出队，qb 位置重排为 1
    const front = takeFrontEntry();
    expect(front?.reqId).toBe("qa");
    expect(queueSnapshot().map((q) => q.reqId)).toEqual(["qb"]);
    expect(takeFrontEntry()?.reqId).toBe("qb");
    expect(takeFrontEntry()).toBeNull();
  });

  test("queue limit is enforced per thread", () => {
    resetQueueForTests();
    for (let i = 0; i < PROMPT_QUEUE_LIMIT; i++) {
      expect(enqueueTurn(`l${i}`, "t-limit", { text: `m${i}` }).ok).toBe(true);
    }
    expect(enqueueTurn("overflow", "t-limit", { text: "x" }).ok).toBe(false);
    // 其他线程不受该线程的限额影响
    expect(enqueueTurn("other", "t-other", { text: "y" }).ok).toBe(true);
    resetQueueForTests();
  });

  test("updateEntryText only mutates live queued entries", () => {
    resetQueueForTests();
    const r = enqueueTurn("qu", "t2", { text: "before" });
    expect(updateEntryText("qu", "after")).toBe(true);
    expect(r.ok && r.entry.msg.text).toBe("after");
    expect(updateEntryText("ghost", "nope")).toBe(false);
    // 取消后不可再改
    cancelEntry("qu");
    expect(updateEntryText("qu", "late")).toBe(false);
    resetQueueForTests();
  });

  test("cancelEntry finalizes the stream (abort + finish) and drops the entry", () => {
    resetQueueForTests();
    enqueueTurn("qc", "t3", { text: "bye" });
    lines.length = 0;
    expect(cancelEntry("qc")).toBe(true);
    expect(cancelEntry("qc")).toBe(false);
    expect(chunksFor("qc").map((c) => c.type)).toEqual(["abort", "finish"]);
    expect(queueSnapshot()).toEqual([]);
    resetQueueForTests();
  });

  test("promoteEntry moves the entry to the front", () => {
    resetQueueForTests();
    enqueueTurn("p1", "t4", { text: "1" });
    enqueueTurn("p2", "t4", { text: "2" });
    enqueueTurn("p3", "t4", { text: "3" });
    expect(promoteEntry("p3")).toBe(true);
    expect(promoteEntry("ghost")).toBe(false);
    expect(queueSnapshot().map((q) => q.reqId)).toEqual(["p3", "p1", "p2"]);
    resetQueueForTests();
  });

  test("cancelAllEntries finalizes every stream and empties the queue", () => {
    resetQueueForTests();
    enqueueTurn("ca", "t5", { text: "1" });
    enqueueTurn("cb", "t6", { text: "2" });
    lines.length = 0;
    expect(cancelAllEntries()).toBe(2);
    expect(queueSnapshot()).toEqual([]);
    expect(chunksFor("ca").map((c) => c.type)).toEqual(["abort", "finish"]);
    expect(chunksFor("cb").map((c) => c.type)).toEqual(["abort", "finish"]);
    resetQueueForTests();
  });
});

describe("dispatch: queue commands", () => {
  test("queue_update / queue_cancel / queue_promote reject unknown requestIds", async () => {
    await expect(
      dispatch("qx1", { type: "queue_update", requestId: "ghost", text: "x" }),
    ).rejects.toThrow("no queued prompt: ghost");
    await expect(
      dispatch("qx2", { type: "queue_cancel", requestId: "ghost" }),
    ).rejects.toThrow("no queued prompt: ghost");
    await expect(
      dispatch("qx3", { type: "queue_promote", requestId: "ghost" }),
    ).rejects.toThrow("no queued prompt: ghost");
  });

  test("queue_update / queue_cancel operate on live entries", async () => {
    resetQueueForTests();
    enqueueTurn("live-1", "t7", { text: "old" });

    await dispatch("qy1", { type: "queue_update", requestId: "live-1", text: "new" });
    expect(responses("qy1").at(-1)?.type).toBe("queue_updated");
    expect(queueSnapshot()[0]?.text).toBe("new");

    lines.length = 0;
    await dispatch("qy2", { type: "queue_cancel", requestId: "live-1" });
    expect(responses("qy2").at(-1)?.type).toBe("queue_cancelled");
    expect(chunksFor("live-1").map((c) => c.type)).toEqual(["abort", "finish"]);
    resetQueueForTests();
  });
});

describe("dispatchPrompt: queuing integration", () => {
  // 与 protocol.test.ts 相同理由：无凭据环境关闭 provider 重试，单次失败即 error chunk
  const prevRetryMax = process.env.PI_PROVIDER_RETRY_MAX;
  beforeAll(() => {
    process.env.PI_PROVIDER_RETRY_MAX = "0";
  });
  afterAll(() => {
    resetQueueForTests();
    if (prevRetryMax === undefined) delete process.env.PI_PROVIDER_RETRY_MAX;
    else process.env.PI_PROVIDER_RETRY_MAX = prevRetryMax;
  });

  // busy 窗口用 markTurnStart/End 手动控制，确定性覆盖排队 → 开跑的完整生命周期
  test("queued prompt emits queued → active → runs after the busy turn ends", async () => {
    resetQueueForTests();
    const { markTurnStart, markTurnEnd } = await import("./prompt-queue");
    markTurnStart();
    const p = dispatchPrompt("pq2", { type: "prompt", text: "two", threadId: "th-q1" });

    // 入队即发 data-queue queued
    const queuedChunk = chunksFor("pq2").find(
      (c) => c.type === "data-queue" && (c.data as { phase?: string })?.phase === "queued",
    );
    expect(queuedChunk).toBeDefined();
    expect((queuedChunk!.data as { position: number }).position).toBe(1);

    markTurnEnd(); // 活跃 turn 结束：链节放行
    await p;

    // 轮到时原地更新 active，然后执行（无模型 → error 收尾）
    const dqChunks = chunksFor("pq2").filter((c) => c.type === "data-queue");
    expect(dqChunks.map((c) => (c.data as { phase: string }).phase)).toEqual([
      "queued",
      "active",
    ]);
    const types = chunksFor("pq2").map((c) => c.type);
    expect(types).toContain("error");
    expect(types.indexOf("data-queue")).toBeLessThan(types.indexOf("error"));
    resetQueueForTests();
  });

  test("queue_cancel drops the entry: no active phase, no turn run", async () => {
    resetQueueForTests();
    const { markTurnStart, markTurnEnd } = await import("./prompt-queue");
    markTurnStart();
    const p = dispatchPrompt("pc2", { type: "prompt", text: "two", threadId: "th-q2" });

    await dispatch("pc-cmd", { type: "queue_cancel", requestId: "pc2" });
    markTurnEnd();
    await p;

    // 取消即收尾：abort + finish，绝无 active/error 执行痕迹
    expect(chunksFor("pc2").map((c) => c.type)).toEqual(["data-queue", "abort", "finish"]);
    resetQueueForTests();
  });

  test("queue_promote reorders: promoted entry runs before earlier entries", async () => {
    resetQueueForTests();
    const { markTurnStart, markTurnEnd } = await import("./prompt-queue");
    markTurnStart();
    const p2 = dispatchPrompt("pp2", { type: "prompt", text: "two", threadId: "th-q3" });
    const p3 = dispatchPrompt("pp3", { type: "prompt", text: "three", threadId: "th-q3" });

    await dispatch("pp-cmd", { type: "queue_promote", requestId: "pp3" });
    markTurnEnd(); // 链节按序放行：第一节取队首（= pp3），第二节取 pp2
    await Promise.all([p2, p3]);

    // 每个排队项都先后开跑（active），且 pp3 先于 pp2
    const activeLine = (id: string) =>
      lines.findIndex(
        (l) => l.includes(`"id":"${id}"`) && l.includes('"phase":"active"'),
      );
    expect(activeLine("pp3")).toBeGreaterThanOrEqual(0);
    expect(activeLine("pp2")).toBeGreaterThan(activeLine("pp3"));
    // 两条各自以 error 收尾（无模型），证明各自真正执行
    expect(chunksFor("pp2").some((c) => c.type === "error")).toBe(true);
    expect(chunksFor("pp3").some((c) => c.type === "error")).toBe(true);
    resetQueueForTests();
  });

  test("queue limit rejects with an error chunk while busy", async () => {
    resetQueueForTests();
    const { markTurnStart, markTurnEnd } = await import("./prompt-queue");
    markTurnStart();
    const queued = [];
    for (let i = 1; i <= PROMPT_QUEUE_LIMIT; i++) {
      queued.push(
        dispatchPrompt(`pl${i}`, { type: "prompt", text: `m${i}`, threadId: "th-q4" }),
      );
    }
    // 第 6 条超限：立即 error chunk，且不进队列
    await dispatchPrompt("pl6", { type: "prompt", text: "x", threadId: "th-q4" });
    expect(
      chunksFor("pl6").some(
        (c) => c.type === "error" && String(c.errorText).includes("排队消息过多"),
      ),
    ).toBe(true);

    markTurnEnd();
    await Promise.all(queued);
    // 前 5 条正常排队执行（active），第 6 条无执行痕迹
    for (let i = 1; i <= PROMPT_QUEUE_LIMIT; i++) {
      expect(
        chunksFor(`pl${i}`).some(
          (c) => c.type === "data-queue" && (c.data as { phase?: string })?.phase === "active",
        ),
      ).toBe(true);
    }
    expect(chunksFor("pl6").some((c) => c.type === "data-queue")).toBe(false);
    resetQueueForTests();
  });
});

/* --------------------------- Stop 收尾窗口（真实 turn） --------------------------- */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待某 reqId 收到指定类型 chunk（resolveSession 异步，固定延时不可靠） */
async function waitUntil(reqId: string, type: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chunksFor(reqId).some((c) => c.type === type)) return;
    await delay(5);
  }
  throw new Error(`timeout waiting for ${type} on ${reqId}`);
}

/** 可控假 Agent：首次 prompt 挂起，firstTurnMs 后自然完成（Stop 时以 unwindMs 提前收尾，
 *  模拟 provider 流拆除、persist 等收尾耗时）；后续 prompt 立即完成 */
function makeFakeAgent(firstTurnMs: number, unwindMs: number): Agent {
  let calls = 0;
  let resolveFirst: (() => void) | null = null;
  return {
    state: {
      model: { id: "fake", provider: "fake", contextWindow: 100000 },
      messages: [],
      tools: [],
      systemPrompt: "",
    },
    prompt: () => {
      calls += 1;
      if (calls === 1) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
          setTimeout(resolve, firstTurnMs); // 自然完成兜底（resolve 幂等）
        });
      }
      return Promise.resolve();
    },
    abort: () => {
      setTimeout(() => resolveFirst?.(), unwindMs);
    },
    waitForIdle: () => Promise.resolve(),
    subscribe: () => () => {},
  } as unknown as Agent;
}

describe("dispatchPrompt: Stop 收尾窗口内的新消息", () => {
  afterAll(() => resetQueueForTests());

  test("Stop 后收尾未完成时发送的新消息不进排队条，收尾后直接执行", async () => {
    resetQueueForTests();
    // 用户场景：回答一半点 Stop（收尾异步，turnBusy 仍为 true），
    // 紧接着发新消息——不应被误判为排队（且被下一次 Stop 连带取消）
    const run = await resolveSession("th-stop1");
    run.agent = makeFakeAgent(10_000, 80); // 只能靠 Stop 收尾

    const pa = dispatchPrompt("sa1", { type: "prompt", text: "A", threadId: "th-stop1" });
    await waitUntil("sa1", "start");
    await dispatch("sa1-abort", { type: "abort" }); // Stop：进入收尾窗口
    const pb = dispatchPrompt("sb1", { type: "prompt", text: "B", threadId: "th-stop1" });
    await Promise.all([pa, pb]);

    const bChunks = chunksFor("sb1").map((c) => c.type);
    expect(bChunks).not.toContain("data-queue"); // 不排队
    expect(bChunks).toContain("start"); // 沿链等收尾后确实执行
    expect(bChunks).toContain("finish");
    resetQueueForTests();
  });

  test("活跃 turn 未中止时发送仍正常排队（回归保护）", async () => {
    resetQueueForTests();
    const run = await resolveSession("th-stop2");
    run.agent = makeFakeAgent(150, 80); // A 自然跑完，B 排队等它结束

    const pa = dispatchPrompt("sa2", { type: "prompt", text: "A", threadId: "th-stop2" });
    await waitUntil("sa2", "start");
    const pb = dispatchPrompt("sb2", { type: "prompt", text: "B", threadId: "th-stop2" });
    // A 仍在跑：B 进队列（排队条可见），queued → active 生命周期完整
    await waitUntil("sb2", "data-queue");
    await Promise.all([pa, pb]);

    const phases = chunksFor("sb2")
      .filter((c) => c.type === "data-queue")
      .map((c) => (c.data as { phase: string }).phase);
    expect(phases).toEqual(["queued", "active"]);
    expect(chunksFor("sb2").map((c) => c.type)).toContain("finish");
    resetQueueForTests();
  });
});
