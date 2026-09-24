import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { initStorage, sessionPath } from "../../src/storage/storage";
import {
  cancelAllEntries,
  cancelEntry,
  enqueueTurn,
  getQueueStateForThread,
  isTurnBusy,
  markTurnEnd,
  markTurnStart,
  popFrontForDispatch,
  PROMPT_QUEUE_LIMIT,
  promoteEntry,
  queueSnapshot,
  resetQueueForTests,
  shouldQueue,
  takeFrontEntry,
} from "../../src/sessions/prompt-queue";
import { dispatch, dispatchPrompt } from "../../src/protocol/protocol";
import { resolveSession } from "../../src/sessions/sessions";

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
    expect(shouldQueue("t1")).toBe(false);

    const a = enqueueTurn("qa", "t1", { text: "a" });
    const b = enqueueTurn("qb", "t1", { text: "b" });
    expect(a.ok && b.ok).toBe(true);
    expect(queueSnapshot("t1")).toEqual([
      { reqId: "qa", threadId: "t1", text: "a", position: 1 },
      { reqId: "qb", threadId: "t1", text: "b", position: 2 },
    ]);

    // 链节取队首：qa 先出队，qb 位置重排为 1
    const front = takeFrontEntry("t1");
    expect(front?.reqId).toBe("qa");
    expect(queueSnapshot("t1").map((q) => q.reqId)).toEqual(["qb"]);
    expect(takeFrontEntry("t1")?.reqId).toBe("qb");
    expect(takeFrontEntry("t1")).toBeNull();
  });

  test("per-thread isolation: one thread's busy/queue never gates another", () => {
    resetQueueForTests();
    // A 线程 turn 在跑：只有 A 排队，B 完全不受影响
    markTurnStart("tA");
    expect(isTurnBusy("tA")).toBe(true);
    expect(shouldQueue("tA")).toBe(true);
    expect(shouldQueue("tB")).toBe(false);
    enqueueTurn("ea", "tA", { text: "a" });
    expect(shouldQueue("tB")).toBe(false);
    expect(takeFrontEntry("tB")).toBeNull();

    // 线程级 cancelAll 只清该线程；promote 只在所属线程内重排
    enqueueTurn("eb", "tB", { text: "b" });
    enqueueTurn("ec", "tB", { text: "c" });
    expect(cancelAllEntries("tA")).toBe(1);
    expect(promoteEntry("ec")?.reqId).toBe("ec");
    expect(queueSnapshot().map((q) => q.reqId)).toEqual(["ec", "eb"]);
    expect(cancelAllEntries("tB")).toBe(2);
    expect(queueSnapshot()).toEqual([]);
    markTurnEnd("tA");
    expect(shouldQueue("tA")).toBe(false);
    resetQueueForTests();
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

  test("popFrontForDispatch 仅线程空闲时弹队首（busy 窗口不弹）", () => {
    resetQueueForTests();
    enqueueTurn("pf-a", "t-pop", { text: "a" });
    enqueueTurn("pf-b", "t-pop", { text: "b" });
    markTurnStart("t-pop");
    expect(popFrontForDispatch("t-pop")).toBeNull(); // turn 在跑：不弹
    expect(queueSnapshot("t-pop").map((q) => q.reqId)).toEqual(["pf-a", "pf-b"]);
    markTurnEnd("t-pop");
    expect(popFrontForDispatch("t-pop")?.reqId).toBe("pf-a");
    expect(popFrontForDispatch("t-pop")?.reqId).toBe("pf-b");
    expect(popFrontForDispatch("t-pop")).toBeNull(); // 空队列：null
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
    expect(promoteEntry("p3")?.reqId).toBe("p3");
    expect(promoteEntry("ghost")).toBeNull();
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
  test("queue_cancel / queue_promote / queue_steer reject unknown requestIds", async () => {
    await expect(
      dispatch("qx2", { type: "queue_cancel", requestId: "ghost" }),
    ).rejects.toThrow("no queued prompt: ghost");
    await expect(
      dispatch("qx3", { type: "queue_promote", requestId: "ghost" }),
    ).rejects.toThrow("no queued prompt: ghost");
    await expect(
      dispatch("qx4", { type: "queue_steer", requestId: "ghost" }),
    ).rejects.toThrow("no active turn to steer into: ghost");
  });

  test("queue_cancel removes a live entry; queue_pop pops head only when idle", async () => {
    resetQueueForTests();
    enqueueTurn("live-1", "t7", { text: "old" });

    lines.length = 0;
    await dispatch("qy2", { type: "queue_cancel", requestId: "live-1" });
    expect(responses("qy2").at(-1)?.type).toBe("queue_cancelled");
    expect(chunksFor("live-1").map((c) => c.type)).toEqual(["abort", "finish"]);
    expect(queueSnapshot("t7")).toEqual([]);

    // queue_pop：该线程 turn 在跑 → popped:null，项原位保留
    enqueueTurn("pop-1", "t-pop-cmd", { text: "p1", sessionId: "s-pop" });
    markTurnStart("t-pop-cmd");
    await dispatch("qy3", { type: "queue_pop", threadId: "t-pop-cmd" });
    expect(responses("qy3").at(-1)).toMatchObject({
      type: "queue_popped",
      popped: null,
    });
    expect(queueSnapshot("t-pop-cmd").map((q) => q.reqId)).toEqual(["pop-1"]);

    // 空闲后弹出：项离队，响应携带文本/sessionId 供前端接力泵重发
    markTurnEnd("t-pop-cmd");
    await dispatch("qy4", { type: "queue_pop", threadId: "t-pop-cmd" });
    expect(responses("qy4").at(-1)).toMatchObject({
      type: "queue_popped",
      popped: { reqId: "pop-1", text: "p1", sessionId: "s-pop" },
    });
    expect(queueSnapshot("t-pop-cmd")).toEqual([]);
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
  test("queued prompt dispatches after the busy turn ends (snapshot-driven)", async () => {
    resetQueueForTests();
    const { markTurnStart, markTurnEnd } = await import("../../src/sessions/prompt-queue");
    markTurnStart("th-q1")
    const p = dispatchPrompt("pq2", { type: "prompt", text: "two", threadId: "th-q1" });

    // 入队：快照可见（无 per-item chunk，状态由 data-queue-state 快照承载）
    expect(queueSnapshot("th-q1").map((q) => q.text)).toEqual(["two"]);

    markTurnEnd("th-q1") // 活跃 turn 结束：链节放行
    await p;

    // 派发执行（无模型 → error 收尾）；出队后快照清空
    const types = chunksFor("pq2").map((c) => c.type);
    expect(types).toContain("start");
    expect(types).toContain("error");
    expect(queueSnapshot("th-q1")).toEqual([]);
    resetQueueForTests();
  });

  test("queue_cancel drops the entry: no active phase, no turn run", async () => {
    resetQueueForTests();
    const { markTurnStart, markTurnEnd } = await import("../../src/sessions/prompt-queue");
    markTurnStart("th-q2")
    const p = dispatchPrompt("pc2", { type: "prompt", text: "two", threadId: "th-q2" });

    await dispatch("pc-cmd", { type: "queue_cancel", requestId: "pc2" });
    markTurnEnd("th-q2")
    await p;

    // 取消即收尾：abort + finish，绝无执行痕迹（无任何队列 chunk）
    expect(chunksFor("pc2").map((c) => c.type)).toEqual(["abort", "finish"]);
    resetQueueForTests();
  });

  test("queue_promote reorders: promoted entry runs before earlier entries", async () => {
    resetQueueForTests();
    const { markTurnStart, markTurnEnd } = await import("../../src/sessions/prompt-queue");
    markTurnStart("th-q3")
    const p2 = dispatchPrompt("pp2", { type: "prompt", text: "two", threadId: "th-q3" });
    const p3 = dispatchPrompt("pp3", { type: "prompt", text: "three", threadId: "th-q3" });

    await dispatch("pp-cmd", { type: "queue_promote", requestId: "pp3" });
    markTurnEnd("th-q3") // 链节按序放行：第一节取队首（= pp3），第二节取 pp2
    await Promise.all([p2, p3]);

    // 每个排队项都先后开跑，且 pp3 先于 pp2（按 start chunk 在捕获流中的顺序）
    const startLine = (id: string) =>
      lines.findIndex(
        (l) => l.includes(`"id":"${id}"`) && l.includes('"type":"start"'),
      );
    expect(startLine("pp3")).toBeGreaterThanOrEqual(0);
    expect(startLine("pp2")).toBeGreaterThan(startLine("pp3"));
    // 两条各自以 error 收尾（无模型），证明各自真正执行
    expect(chunksFor("pp2").some((c) => c.type === "error")).toBe(true);
    expect(chunksFor("pp3").some((c) => c.type === "error")).toBe(true);
    resetQueueForTests();
  });

  test("queue limit rejects with an error chunk while busy", async () => {
    resetQueueForTests();
    const { markTurnStart, markTurnEnd } = await import("../../src/sessions/prompt-queue");
    markTurnStart("th-q4")
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

    markTurnEnd("th-q4")
    await Promise.all(queued);
    // 前 5 条正常排队执行，第 6 条无执行痕迹
    for (let i = 1; i <= PROMPT_QUEUE_LIMIT; i++) {
      expect(chunksFor(`pl${i}`).map((c) => c.type)).toContain("start");
    }
    expect(chunksFor("pl6").map((c) => c.type)).not.toContain("start");
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
 *  模拟 provider 流拆除、persist 等收尾耗时）；后续 prompt 立即完成。
 *  steer(m) 记录注入（steered getter 供断言），不产生输出 */
function makeFakeAgent(firstTurnMs: number, unwindMs: number): Agent {
  let calls = 0;
  let resolveFirst: (() => void) | null = null;
  const steered: unknown[] = [];
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
    steer: (m: unknown) => {
      steered.push(m);
    },
    get steered() {
      return steered;
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
    expect(bChunks).not.toContain("data-steered"); // 不排队
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
    // A 仍在跑：B 进队列（排队条可见，状态由快照承载）
    expect(queueSnapshot("th-stop2").map((q) => q.reqId)).toEqual(["sb2"]);
    await Promise.all([pa, pb]);

    expect(chunksFor("sb2").map((c) => c.type)).not.toContain("data-steered");
    expect(chunksFor("sb2").map((c) => c.type)).toContain("finish");
    expect(queueSnapshot("th-stop2")).toEqual([]);
    resetQueueForTests();
  });
});

/* --------------------------- 线程隔离（并行 turn） --------------------------- */

describe("dispatchPrompt: 线程隔离并行执行", () => {
  afterAll(() => resetQueueForTests());

  test("其他线程忙不影响本线程：不排队立即执行；线程级 Stop 只中止对应线程", async () => {
    resetQueueForTests();
    const runA = await resolveSession("th-iso-a");
    runA.agent = makeFakeAgent(10_000, 60); // A 挂起，只能靠 Stop 收尾
    const runB = await resolveSession("th-iso-b");
    runB.agent = makeFakeAgent(50, 60); // B 自然完成

    const pa = dispatchPrompt("ia1", { type: "prompt", text: "A", threadId: "th-iso-a" });
    await waitUntil("ia1", "start");

    // A 仍在跑：B 必须不进排队条、立即执行完毕（旧全局队列下 B 会显示排队）
    const pb = dispatchPrompt("ib1", { type: "prompt", text: "B", threadId: "th-iso-b" });
    await pb;
    const bTypes = chunksFor("ib1").map((c) => c.type);
    expect(bTypes).not.toContain("data-steered");
    expect(bTypes).toContain("start");
    expect(bTypes).toContain("finish");

    // 线程级 Stop：只中止 A（收尾 finish），B 已结束不受影响
    await dispatch("ia-abort", { type: "abort", threadId: "th-iso-a" });
    await pa;
    const aTypes = chunksFor("ia1").map((c) => c.type);
    expect(aTypes).toContain("finish");
    resetQueueForTests();
  });
});

/* --------------------------- 并入当前轮（steer） --------------------------- */

describe("dispatchPrompt: steer 并入当前轮", () => {
  afterAll(() => resetQueueForTests());

  const steeredOf = (agent: Agent) =>
    (agent as unknown as { steered: unknown[] }).steered;

  test("忙线程带 steer 标记：注入活跃轮，本请求退化流收尾，不进队列不中止", async () => {
    resetQueueForTests();
    lines.length = 0; // 上一组用例复用了 sa1/sb1 reqId，先清捕获流
    const run = await resolveSession("th-st1");
    run.agent = makeFakeAgent(10_000, 80); // A 挂起，只能靠 Stop 收尾

    const pa = dispatchPrompt("sa1", { type: "prompt", text: "A", threadId: "th-st1" });
    await waitUntil("sa1", "start");

    const pb = dispatchPrompt("sb1", {
      type: "prompt",
      text: "B",
      steer: true,
      threadId: "th-st1",
    });
    await pb; // steer 立即完成（注入即返回），不等 A

    // 退化流生命周期：steered 标记 → start；finish 不立即发（提前结束会把
    // 框架共享 status 置回 ready，宿主轮被 UI 显示为已停止），挂起到宿主轮收尾
    expect(chunksFor("sb1").map((c) => c.type)).toEqual(["data-steered", "start"]);
    // 注入到活跃 agent（user 消息、纯文本 content）
    const steered = steeredOf(run.agent);
    expect(steered).toHaveLength(1);
    expect(steered[0]).toMatchObject({ role: "user", content: "B" });
    // 不占队列；活跃 turn 未被打断（A 尚未收尾）
    expect(queueSnapshot("th-st1")).toEqual([]);
    expect(chunksFor("sa1").some((c) => c.type === "finish")).toBe(false);

    // 宿主轮收尾（Stop）：A 的 finish 之后补发 sb1 的 finish
    await dispatch("sa1-abort", { type: "abort", threadId: "th-st1" });
    await pa;
    expect(chunksFor("sb1").map((c) => c.type)).toEqual([
      "data-steered",
      "start",
      "finish",
    ]);
    resetQueueForTests();
  });

  test("空闲线程带 steer 标记：按普通 prompt 执行（标记忽略）", async () => {
    resetQueueForTests();
    const run = await resolveSession("th-st2");
    run.agent = makeFakeAgent(30, 60);

    await dispatchPrompt("sc1", {
      type: "prompt",
      text: "C",
      steer: true,
      threadId: "th-st2",
    });

    const types = chunksFor("sc1").map((c) => c.type);
    expect(types).not.toContain("data-steered");
    expect(types).toContain("start");
    expect(types).toContain("finish");
    expect(steeredOf(run.agent)).toHaveLength(0);
    resetQueueForTests();
  });

  test("活跃轮收尾窗口（stopRequested）：steer 落回链上直接执行，不注入", async () => {
    resetQueueForTests();
    const run = await resolveSession("th-st3");
    run.agent = makeFakeAgent(10_000, 80);

    const pa = dispatchPrompt("sa3", { type: "prompt", text: "A", threadId: "th-st3" });
    await waitUntil("sa3", "start");
    await dispatch("sa3-abort", { type: "abort", threadId: "th-st3" }); // 进入收尾窗口
    const pb = dispatchPrompt("sb3", {
      type: "prompt",
      text: "B",
      steer: true,
      threadId: "th-st3",
    });
    await Promise.all([pa, pb]);

    // 收尾窗口的新消息不排队也不 steer：沿链等收尾后作为新 turn 执行
    expect(chunksFor("sb3").map((c) => c.type)).not.toContain("data-steered");
    expect(chunksFor("sb3").map((c) => c.type)).toContain("start");
    expect(chunksFor("sb3").map((c) => c.type)).toContain("finish");
    expect(steeredOf(run.agent)).toHaveLength(0);
    resetQueueForTests();
  });

  test("queue_steer：排队项注入活跃轮，项移除、退化流收尾、响应 queue_steered", async () => {
    resetQueueForTests();
    lines.length = 0;
    const run = await resolveSession("th-st4");
    run.agent = makeFakeAgent(10_000, 80);

    const pa = dispatchPrompt("sa4", { type: "prompt", text: "A", threadId: "th-st4" });
    await waitUntil("sa4", "start");
    const pb = dispatchPrompt("sb4", { type: "prompt", text: "B", threadId: "th-st4" });
    expect(queueSnapshot("th-st4").map((q) => q.reqId)).toEqual(["sb4"]);

    await dispatch("cmd-st", { type: "queue_steer", requestId: "sb4" });
    expect(responses("cmd-st").at(-1)?.type).toBe("queue_steered");

    // 项已移除；其流 steered 标记 → start（finish 挂到宿主轮收尾）；
    // 注入发生在活跃 agent
    expect(queueSnapshot("th-st4")).toEqual([]);
    expect(chunksFor("sb4").map((c) => c.type)).toEqual(["data-steered", "start"]);
    expect(chunksFor("sb4").filter((c) => c.type === "data-steered")).toHaveLength(1);
    expect(steeredOf(run.agent)).toHaveLength(1);
    expect(steeredOf(run.agent)[0]).toMatchObject({ role: "user", content: "B" });

    // A 收尾后 sb4 的链节轮到空队列，静默让位（不执行）；其退化流 finish
    // 随 A 的收尾补发
    await dispatch("sa4-abort", { type: "abort", threadId: "th-st4" });
    await Promise.all([pa, pb]);
    expect(chunksFor("sb4").map((c) => c.type)).toEqual(["data-steered", "start", "finish"]);
    expect(chunksFor("sb4").some((c) => c.type === "error")).toBe(false);
    resetQueueForTests();
  });

  test("queue_steer 无活跃轮/未知项：报错且项原位保留", async () => {
    resetQueueForTests();
    lines.length = 0;
    await expect(
      dispatch("cmd-st2", { type: "queue_steer", requestId: "ghost" }),
    ).rejects.toThrow("no active turn to steer into: ghost");

    enqueueTurn("sq1", "th-st5", { text: "S" });
    await expect(
      dispatch("cmd-st3", { type: "queue_steer", requestId: "sq1" }),
    ).rejects.toThrow("no active turn");
    expect(queueSnapshot("th-st5").map((q) => q.reqId)).toEqual(["sq1"]);

    expect(cancelAllEntries()).toBe(1);
    resetQueueForTests();
  });
});

/* ---------------------------- 队列持久化与回放采纳 ---------------------------- */

describe("队列持久化与回放采纳", () => {
  test("变更落盘 queue_state 行；内存清空后经回放采纳（不自动暂停）", () => {
    resetQueueForTests();
    enqueueTurn("pp1", "th-persist", {
      text: "persist me",
      threadId: "th-persist",
      sessionId: "s-qp",
    });
    enqueueTurn("pp2", "th-persist", {
      text: "second",
      threadId: "th-persist",
      sessionId: "s-qp",
    });

    // 快照行已落盘（items 全量）
    const raw = readFileSync(sessionPath("s-qp"), "utf8");
    expect(raw).toContain('"queue_state"');
    expect(raw).toContain("persist me");

    // 内存清空（模拟 sidecar 重启）→ get_queue_state 回放采纳，不再自动暂停
    resetQueueForTests();
    const snap = getQueueStateForThread("th-persist", "s-qp");
    expect(snap?.items.map((i) => i.text)).toEqual(["persist me", "second"]);
    expect("paused" in (snap ?? {})).toBe(false);

    // 采纳后的项可正常取消（按 reqId 寻址）
    expect(cancelEntry("pp1")).toBe(true);
    expect(getQueueStateForThread("th-persist", "s-qp")?.items.map((i) => i.text)).toEqual([
      "second",
    ]);
    resetQueueForTests();
  });

  test("线程内存队列非空时不覆盖活状态", () => {
    resetQueueForTests();
    enqueueTurn("pl1", "th-live", { text: "live", threadId: "th-live", sessionId: "s-ql" });
    // 手写一份不同的快照行到同 session，验证不覆盖
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(
      sessionPath("s-ql"),
      JSON.stringify({
        type: "queue_state",
        snapshot: {
          version: 2,
          threadId: "th-live",
          items: [{ id: 99, reqId: "stale", text: "stale", createdAt: "t" }],
          nextId: 100,
        },
      }) + "\n",
    );
    const snap = getQueueStateForThread("th-live", "s-ql");
    expect(snap?.items.map((i) => i.text)).toEqual(["live"]);
    resetQueueForTests();
  });
});

describe("data-queue-state 快照广播", () => {
  test("入队/promote 的变更广播到该线程活跃请求流上", async () => {
    resetQueueForTests();
    lines.length = 0;
    const run = await resolveSession("th-bc");
    run.agent = makeFakeAgent(10_000, 80);
    const pa = dispatchPrompt("pba", { type: "prompt", text: "A", threadId: "th-bc" });
    await waitUntil("pba", "start");

    const pb = dispatchPrompt("pbb", { type: "prompt", text: "B", threadId: "th-bc" });
    // 入队广播：data-queue-state 路由到活跃流（pba），携带全量快照
    const stateChunk = chunksFor("pba").find((c) => c.type === "data-queue-state");
    expect(stateChunk).toBeDefined();
    const data = stateChunk!.data as { threadId: string; items: { text: string }[] };
    expect(data.threadId).toBe("th-bc");
    expect(data.items.map((i) => i.text)).toEqual(["B"]);

    // promote：仍在快照（运行项锁定语义由快照消失表达）——至少再广播一次
    lines.length = 0;
    await dispatch("cmd-p", { type: "queue_promote", requestId: "pbb" });
    expect(
      chunksFor("pba").filter((c) => c.type === "data-queue-state").length,
    ).toBeGreaterThanOrEqual(1);

    // 宿主轮收尾：B 的退化…（B 经队列派发）——收尾后快照清空广播
    await dispatch("pba-abort", { type: "abort", threadId: "th-bc" });
    await Promise.all([pa, pb]);
    resetQueueForTests();
  });
});

describe("空队列快照必须落盘（复活 bug 回归）", () => {
  test("取消最后一个排队项：空快照落盘，回放不再复活已删项", () => {
    resetQueueForTests();
    enqueueTurn("pr1", "th-pr", { text: "dying", threadId: "th-pr", sessionId: "s-pr" });
    expect(readFileSync(sessionPath("s-pr"), "utf8")).toContain("dying");

    cancelEntry("pr1"); // 引擎清空前必须先落空快照
    const raw = readFileSync(sessionPath("s-pr"), "utf8");
    const queueLines = raw
      .split("\n")
      .filter((l) => l.includes('"queue_state"'))
      .map((l) => JSON.parse(l) as { snapshot: { items: unknown[] } });
    expect(queueLines.at(-1)!.snapshot.items).toEqual([]);

    // 重启语义：内存清空 → 回放采纳 → 不复活已删项
    resetQueueForTests();
    const snap = getQueueStateForThread("th-pr", "s-pr");
    expect(snap?.items).toEqual([]);
    resetQueueForTests();
  });
});
