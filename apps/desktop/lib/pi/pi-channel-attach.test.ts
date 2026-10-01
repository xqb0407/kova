import { afterAll, describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

afterAll(restoreAllMocks);

/**
 * TauriPiChannel.attachStream 的"快照+直播按 seq 合并"核心语义测试：
 * mock Tauri invoke/listen，验证重放幂等去重、乱序暂存、收尾关流与
 * 降级返回 null 的各分支。
 */

const REQ = "pi-test-req";

type WireLine = { i: number | null; l: string };
type EventLike = { payload: WireLine[] };
type ListenFn = (event: EventLike) => void;

/** 每次测试重置的假 Tauri 状态 */
let batchCb: ListenFn | null = null;
let attachReply: unknown = null;

mockModule("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "pi_attach") {
      // setTimeout(0) 让出窗口：监听注册先于快照返回，贴近真实 IPC 顺序
      return new Promise((resolve) => setTimeout(() => resolve(attachReply), 0));
    }
    if (cmd === "pi_abort") return Promise.resolve();
    return Promise.reject(new Error(`unexpected invoke ${cmd}`));
  },
}));

mockModule("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: ListenFn) => {
    if (event !== "pi-chunk-batch") return Promise.resolve(() => {});
    return Promise.resolve().then(() => {
      batchCb = cb;
      return () => {
        batchCb = null;
      };
    });
  },
}));

const { TauriPiChannel, compactReplayChunks } = await import("@/lib/pi/pi-channel");

// ---------- 工具 ----------

const wire = (seq: number, chunk: UIMessageChunk): WireLine => ({
  i: seq,
  l: JSON.stringify({ id: REQ, chunk }),
});
const foreign = (seq: number): WireLine => ({
  i: seq,
  l: JSON.stringify({ id: "pi-other", chunk: { type: "text-delta", delta: "x", id: "d0" } }),
});

async function readAll(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const out: UIMessageChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const start: UIMessageChunk = { type: "start", message_id: "m1" } as UIMessageChunk;
const delta = (t: string): UIMessageChunk =>
  ({ type: "text-delta", delta: t, id: "d1" }) as UIMessageChunk;
const finish: UIMessageChunk = { type: "finish" } as UIMessageChunk;
const errorChunk: UIMessageChunk = { type: "error", errorText: "boom" } as UIMessageChunk;

function attach() {
  return new TauriPiChannel().attachStream!({ requestId: REQ, threadId: "t1" });
}

// ---------- 用例 ----------

describe("attachStream", () => {
  test("tombstone 快照：完整重放含收尾行后立即关流", async () => {
    batchCb = null;
    attachReply = {
      active: false,
      truncated: false,
      lines: [wire(1, start), wire(2, delta("he")), wire(3, finish)],
    };
    const stream = await attach();
    expect(stream).not.toBeNull();
    const chunks = await readAll(stream!);
    expect(chunks.map((c) => c.type)).toEqual(["start", "text-delta", "finish"]);
  });

  test("快照与直播重叠区按 seq 幂等去重", async () => {
    batchCb = null;
    attachReply = {
      active: true,
      truncated: false,
      lines: [wire(1, start), wire(2, delta("a")), wire(3, delta("b"))],
    };
    const stream = await attach();
    expect(stream).not.toBeNull();
    // 直播重放快照内 2、3 两行 + 新行 4、5；穿插别的 run 的行（必须被忽略）。
    // 快照重放走快速前进：同 id 的 2、3 两个 delta 合并为一段 "ab"
    batchCb!({
      payload: [
        wire(2, delta("a")),
        foreign(1),
        wire(3, delta("b")),
        wire(4, delta("c")),
        wire(5, finish),
      ],
    });
    const chunks = await readAll(stream!);
    expect(chunks.map((c) => c.type)).toEqual(["start", "text-delta", "text-delta", "finish"]);
    expect(chunks.map((c) => (c as { delta?: string }).delta)).toEqual([
      undefined,
      "ab",
      "c",
      undefined,
    ]);
  });

  test("直播行先于快照处理到达：乱序暂存，快照补齐后按序放出", async () => {
    batchCb = null;
    attachReply = { active: true, truncated: false, lines: [wire(1, start)] };
    const promise = attach();
    // 微任务窗口：监听已挂上、attach 尚未返回时投递"超前"的直播行
    await new Promise((r) => setTimeout(r, 0));
    batchCb!({ payload: [wire(2, delta("live")), wire(3, finish)] });
    const stream = await promise;
    expect(stream).not.toBeNull();
    const chunks = await readAll(stream!);
    expect(chunks.map((c) => c.type)).toEqual(["start", "text-delta", "finish"]);
  });

  test("run 刚起步无快照：纯直播续传", async () => {
    batchCb = null;
    attachReply = { active: true, truncated: false, lines: [] };
    const stream = await attach();
    expect(stream).not.toBeNull();
    batchCb!({ payload: [wire(1, start), wire(2, errorChunk)] });
    const chunks = await readAll(stream!);
    expect(chunks.map((c) => c.type)).toEqual(["start", "error"]);
  });

  test("truncated / 无缓冲 → 返回 null 走历史回退", async () => {
    batchCb = null;
    attachReply = { active: true, truncated: true, lines: [] };
    expect(await attach()).toBeNull();
    attachReply = { active: false, truncated: false, lines: [] };
    expect(await attach()).toBeNull();
  });

  test("tombstone 无收尾行（异常竞态）：关流落定不挂死", async () => {
    batchCb = null;
    attachReply = {
      active: false,
      truncated: false,
      lines: [wire(1, start), wire(2, delta("x"))],
    };
    const stream = await attach();
    expect(stream).not.toBeNull();
    const chunks = await readAll(stream!);
    expect(chunks.map((c) => c.type)).toEqual(["start", "text-delta"]);
  });
});

describe("compactReplayChunks（快速前进重放合并）", () => {
  test("同 id delta 串合并为一段；kind/id 变化断开；非 delta chunk 前先冲刷", () => {
    const reasoning = { type: "reasoning-delta", delta: "r", id: "rr" } as UIMessageChunk;
    const other = { type: "text-delta", delta: "c", id: "d2" } as UIMessageChunk;
    const tool = {
      type: "tool-input-available",
      toolCallId: "t1",
      toolName: "read",
      input: {},
    } as UIMessageChunk;
    const { chunks } = compactReplayChunks(
      [start, delta("a"), delta("b"), reasoning, other, tool].map((chunk, i) =>
        wire(i + 1, chunk),
      ),
      REQ,
    );
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "text-delta",
      "reasoning-delta",
      "text-delta",
      "tool-input-available",
    ]);
    expect(chunks[1]).toMatchObject({ id: "d1", delta: "ab" });
    expect(chunks[3]).toMatchObject({ id: "d2", delta: "c" });
  });

  test("超过 32KB 的 delta 串切多段，文本总量守恒", () => {
    const piece = "x".repeat(1024);
    const lines = Array.from({ length: 100 }, (_, i) => wire(i + 1, delta(piece)));
    const { chunks } = compactReplayChunks(lines, REQ);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.type === "text-delta")).toBe(true);
    const total = chunks.reduce((n, c) => n + ((c as { delta: string }).delta?.length ?? 0), 0);
    expect(total).toBe(100 * 1024);
    for (const c of chunks) {
      expect((c as { delta: string }).delta.length).toBeLessThanOrEqual(32 * 1024 + 1024);
    }
  });

  test("畸形行 / 他 run 行跳过，maxSeq 仍按快照计入", () => {
    const { chunks, maxSeq } = compactReplayChunks(
      [foreign(1), { i: 2, l: "{not json" }, wire(3, delta("ok"))],
      REQ,
    );
    expect(maxSeq).toBe(3);
    expect(chunks).toEqual([{ type: "text-delta", delta: "ok", id: "d1" }]);
  });

  test("空快照", () => {
    expect(compactReplayChunks([], REQ)).toEqual({ chunks: [], maxSeq: 0 });
  });
});
