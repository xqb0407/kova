import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

afterAll(restoreAllMocks);

/** 捕获 pi-chunk-batch 的唯一登记（bus 的传输层） */
type WireLine = { i: number | null; l: string };
let batchCb: ((event: { payload: WireLine[] }) => void) | null = null;
let unlistenCalls = 0;

mockModule("@/desktop-bridge/event", () => ({
  listen: (event: string, cb: (event: { payload: WireLine[] }) => void) => {
    if (event === "pi-chunk-batch") batchCb = cb;
    return Promise.resolve(() => {
      if (event === "pi-chunk-batch") {
        unlistenCalls += 1;
        batchCb = null;
      }
    });
  },
}));

const { subscribeWireFrames, resetWireBusForTests } = await import("@/lib/pi/wire-bus");

// 同进程跨文件共享模块：先清掉其它测试文件留下的常驻订阅/传输
resetWireBusForTests();
afterAll(resetWireBusForTests);

const line = (type: string, body: Record<string, unknown> = {}) =>
  ({ i: null, l: JSON.stringify({ type, ...body }) }) as WireLine;

describe("wire-bus", () => {
  test("同批行只解析一次，按类型投给全部订阅者；非订阅类型不解析", async () => {
    const a1: unknown[] = [];
    const a2: unknown[] = [];
    const b: unknown[] = [];
    const offA1 = await subscribeWireFrames<{ type: string }>(["turn_changed"], (f) => a1.push(f));
    const offA2 = await subscribeWireFrames<{ type: string }>(["turn_changed"], (f) => a2.push(f));
    const offB = await subscribeWireFrames<{ type: string }>(["sessions_changed"], (f) => b.push(f));

    const parse = spyOn(JSON, "parse");
    batchCb!({
      payload: [
        { i: 1, l: '{"id":"req","chunk":{"type":"delta"}}' }, // token 热路径行
        line("turn_changed", { sessionId: "s1", active: true }),
        line("turn_changed", { sessionId: "s2", active: false }),
        line("sessions_changed", { sessionId: "s1" }),
      ],
    });

    expect(parse).toHaveBeenCalledTimes(3); // 1 行热路径不解析 + 3 行命中各一次
    expect(a1.length).toBe(2);
    expect(a2.length).toBe(2);
    expect(b.length).toBe(1);
    parse.mockRestore();

    offA1();
    offA2();
    offB();
  });

  test("最后一个订阅退订后释放传输，再订阅重新登记", async () => {
    unlistenCalls = 0;
    const off = await subscribeWireFrames(["turn_changed"], () => {});
    expect(batchCb).not.toBeNull();
    off();
    expect(unlistenCalls).toBe(1);
    expect(batchCb).toBeNull();

    const again = await subscribeWireFrames(["turn_changed"], () => {});
    expect(batchCb).not.toBeNull();
    again();
    expect(unlistenCalls).toBe(2);
  });

  test("accept 在解析前挡行：同类型内的细分（thread_event 起止）不解析 delta", async () => {
    const got: unknown[] = [];
    let acceptCalls = 0;
    const off = await subscribeWireFrames(
      ["thread_event"],
      (frame) => got.push(frame),
      {
        accept: (raw) => {
          acceptCalls += 1;
          return raw.includes('"agent_start"');
        },
      },
    );

    const parse = spyOn(JSON, "parse");
    batchCb!({
      payload: [
        line("thread_event", {
          sessionId: "a",
          event: { type: "message_update" },
        }),
        line("thread_event", { sessionId: "a", event: { type: "agent_start" } }),
      ],
    });

    expect(parse).toHaveBeenCalledTimes(1); // delta 行被 accept 挡在解析前
    expect(acceptCalls).toBe(2); // 预筛与投递共用一次求值：每条行只调一次
    expect(got.length).toBe(1);
    parse.mockRestore();
    off();
  });

  test("accept 抛错只跳过该订阅者，不影响同帧其他订阅者", async () => {
    const got: string[] = [];
    const offBad = await subscribeWireFrames(["turn_changed"], () => {}, {
      accept: () => {
        throw new Error("accept boom");
      },
    });
    const offGood = await subscribeWireFrames<{ sessionId?: string }>(
      ["turn_changed"],
      (f) => got.push(String(f.sessionId)),
    );

    const error = spyOn(console, "error").mockImplementation(() => {});
    batchCb!({ payload: [line("turn_changed", { sessionId: "s1" })] });
    error.mockRestore();

    expect(got).toEqual(["s1"]);
    offBad();
    offGood();
  });

  test("单个订阅者抛错不影响同帧其他订阅者", async () => {
    const got: string[] = [];
    const offBad = await subscribeWireFrames(["turn_changed"], () => {
      throw new Error("boom");
    });
    const offGood = await subscribeWireFrames<{ sessionId?: string }>(
      ["turn_changed"],
      (f) => got.push(String(f.sessionId)),
    );

    const error = spyOn(console, "error").mockImplementation(() => {});
    batchCb!({ payload: [line("turn_changed", { sessionId: "s1" })] });
    error.mockRestore();

    expect(got).toEqual(["s1"]);
    offBad();
    offGood();
  });

  test("reset 撞上在飞的 listen：订阅完成后仍有传输，不留假活订阅", async () => {
    const got: unknown[] = [];
    const pending = subscribeWireFrames<{ sessionId?: string }>(
      ["turn_changed"],
      (f) => got.push(f),
    );
    // 此时 subscribe 已同步登记并启动了 listen，但尚未 await 完成
    resetWireBusForTests();
    const off = await pending;

    expect(batchCb).not.toBeNull();
    batchCb!({ payload: [line("turn_changed", { sessionId: "s1" })] });
    expect(got).toEqual([{ type: "turn_changed", sessionId: "s1" }]);
    off();
  });
});
