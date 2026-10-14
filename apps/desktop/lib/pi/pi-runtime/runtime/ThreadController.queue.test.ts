// 排队消息渲染与队列条目一致性回归（2026-10-05 修复）：
// - 乐观条目 id = 真实 reqId（撤销/并入/立即发送要能命中服务端条目）
// - prompt 起跑（start 帧）→ 本地残留条目摘除（服务端没排过队就没有 queue_update，
//   否则「气泡已渲染 + 队列条还挂着」的幽灵行永久留存）
// - ✕ 删除本地立即消失
// - queueResend 绕开排队车道（本地队列残留不得把直发重发误判成排队，压出幽灵）
// - drainQueueForStop 带条目载荷（文本 + 图片），供停止生成回填输入框

import { describe, expect, it } from "bun:test";
import { PiThreadController } from "./ThreadController";
import type { AppendMessage } from "@assistant-ui/react";
import type { PiClient, PiClientEvent, PiThreadSnapshot } from "../types";

type SentInput = {
  content?: string;
  requestId?: string;
  attachments?: { type?: string; mimeType?: string; data?: string }[];
  files?: unknown[];
  streamingBehavior?: string;
};

const IMAGE_DATA_URL = "data:image/png;base64,AAAA";

const appendUserWithImage = (text: string): AppendMessage =>
  ({
    role: "user",
    content: [
      { type: "text", text },
      { type: "image", image: IMAGE_DATA_URL },
    ],
    createdAt: new Date(0),
    metadata: {},
  }) as unknown as AppendMessage;

const makeQueueFixture = (options?: {
  clearedItems?: { id: string; content: string; attachments?: unknown[] }[];
}) => {
  const sent: SentInput[] = [];
  const cancelled: string[] = [];
  const promoted: string[] = [];
  const steered: string[] = [];
  const cleared: string[] = [];
  const listeners = new Set<(event: PiClientEvent) => void>();
  const startListeners = new Set<(requestId: string) => void>();

  const client = {
    getThread: async () =>
      ({
        metadata: { id: "thread-1", status: "idle" },
        messages: [],
        seq: 99,
      }) as unknown as PiThreadSnapshot,
    subscribe: (_threadId: string, cb: (event: PiClientEvent) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onPromptStart: (_threadId: string, cb: (requestId: string) => void) => {
      startListeners.add(cb);
      return () => startListeners.delete(cb);
    },
    sendMessage: async (_threadId: string, input: SentInput) => {
      sent.push(input);
    },
    queueCancel: async (_threadId: string, id: string) => {
      cancelled.push(id);
    },
    queuePromote: async (_threadId: string, id: string) => {
      promoted.push(id);
    },
    queueSteer: async (_threadId: string, id: string) => {
      steered.push(id);
    },
    queuePop: async () => null,
    clearQueue: async () => {
      cleared.push("clear");
      const items = options?.clearedItems ?? [];
      return { steering: [], followUp: items.map((i) => i.content), items };
    },
  } as unknown as PiClient;

  const controller = new PiThreadController(client, "thread-1");
  return {
    controller,
    sent,
    cancelled,
    promoted,
    steered,
    cleared,
    emit: (event: Record<string, unknown>) => {
      for (const listener of listeners) {
        listener({ threadId: "thread-1", ...event } as PiClientEvent);
      }
    },
    startPrompt: (requestId: string) => {
      for (const listener of startListeners) listener(requestId);
    },
  };
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("排队发送：条目 id = 真实 reqId（乐观镜像可被逐项操作命中）", () => {
  it("忙时发送带图消息：帧与乐观条目同 id，条目带上附件（队列条出缩略图）", async () => {
    const fixture = makeQueueFixture();
    fixture.controller.connect();
    // 线程在跑 → isQueuedSend 走排队车道
    fixture.emit({ type: "agent_start", seq: 1 });

    await fixture.controller.sendMessage(appendUserWithImage("带图消息"));
    await flush();

    const input = fixture.sent.at(-1) ?? {};
    const requestId = input.requestId ?? "";
    expect(input.content).toBe("带图消息");
    expect(requestId).toMatch(/^pi-/);
    expect(input.attachments).toEqual([
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ]);

    const queue = fixture.controller.getState().queue.followUp;
    expect(queue.length).toBe(1);
    expect(queue[0]?.id).toBe(requestId);
    expect(queue[0]?.content).toBe("带图消息");
    expect(queue[0]?.attachments).toEqual([
      { name: "image-1.png", mimeType: "image/png", data: "AAAA" },
    ]);
    // 排队中的消息不进消息列表（线程只由服务端回显填充）
    expect(
      fixture.controller.getProjectedMessages().filter((m) => m.role === "user"),
    ).toEqual([]);
  });

  it("prompt 起跑（start 帧）→ 本地条目摘除：气泡与队列行不再并存", async () => {
    const fixture = makeQueueFixture();
    fixture.controller.connect();
    fixture.emit({ type: "agent_start", seq: 1 });
    await fixture.controller.sendMessage(appendUserWithImage("带图消息"));
    await flush();

    const requestId = fixture.sent.at(-1)?.requestId!;
    expect(fixture.controller.getState().queue.followUp.length).toBe(1);

    // 服务端空闲直接执行了这条（本地曾经误判成排队）→ 只会来 start 帧，
    // 永远没有 queue_update 来清本地条目
    fixture.startPrompt(requestId);
    expect(fixture.controller.getState().queue.followUp).toEqual([]);
  });

  it("✕ 删除：本地条目立即消失，且按真实 reqId 通知服务端", async () => {
    const fixture = makeQueueFixture();
    fixture.controller.connect();
    fixture.emit({ type: "agent_start", seq: 1 });
    await fixture.controller.sendMessage(appendUserWithImage("带图消息"));

    const requestId = fixture.sent.at(-1)?.requestId!;
    await fixture.controller.queueCancel(requestId);
    expect(fixture.controller.getState().queue.followUp).toEqual([]);
    expect(fixture.cancelled).toEqual([requestId]);
  });

  it("服务端条目权威覆盖本地镜像（queue_update 整字段替换）", async () => {
    const fixture = makeQueueFixture();
    fixture.controller.connect();
    fixture.emit({ type: "agent_start", seq: 1 });
    await fixture.controller.sendMessage(appendUserWithImage("带图消息"));
    await flush();

    fixture.emit({
      type: "queue_update",
      seq: 2,
      steering: [],
      followUp: [{ id: "pi-real-1", content: "服务端条目" }],
    });
    expect(fixture.controller.getState().queue.followUp).toEqual([
      { id: "pi-real-1", content: "服务端条目" },
    ]);
  });

  it("willQueueSend 与排队判定同口径（runtime 新线程乐观气泡据此让位）", async () => {
    const fixture = makeQueueFixture();
    fixture.controller.connect();
    expect(fixture.controller.willQueueSend()).toBe(false); // 空闲且队列空

    // seq 用快照水位（99）之上的号：事件去重按 lastSeq 拦截，低号会被丢弃
    fixture.emit({ type: "agent_start", seq: 100 });
    expect(fixture.controller.willQueueSend()).toBe(true); // 运行中

    fixture.emit({ type: "agent_end", seq: 101 });
    expect(fixture.controller.willQueueSend()).toBe(false);

    // 队列非空（含乐观条目）：即使 runStatus 回 idle 也按排队算
    fixture.emit({
      type: "queue_update",
      seq: 102,
      steering: [],
      followUp: [{ id: "pi-q1", content: "排队中" }],
    });
    expect(fixture.controller.willQueueSend()).toBe(true);
  });
});

describe("接力泵直发重发：绕开排队车道（本地队列残留不再压幽灵）", () => {
  it("本地队列非空时重发：不新增本地条目，沿用原条目 id，图片原样带出", async () => {
    const fixture = makeQueueFixture();
    fixture.controller.connect();
    // 本地队列有残留（快照在途），线程已空闲
    fixture.emit({
      type: "queue_update",
      seq: 1,
      steering: [],
      followUp: [{ id: "pi-old", content: "重发内容" }],
    });

    await fixture.controller.queueResend({
      id: "pi-old",
      content: "重发内容",
      attachments: [{ name: "image-1.png", mimeType: "image/png", data: "BBBB" }],
    });

    const input = fixture.sent.at(-1);
    expect(input?.requestId).toBe("pi-old");
    // 直发不带车道提示（streamingBehavior 只用于把发送升级成 steer；排队与否
    // 由 sidecar 自己的 shouldQueue 决定，链路不带行为标记即为普通发送）
    expect(input?.streamingBehavior).toBeUndefined();
    expect(input?.content).toBe("重发内容");
    // data → data URL 还原（buildPiSendInput 的 image 分支原样收回）
    expect(input?.attachments).toEqual([
      { type: "image", mimeType: "image/png", data: "BBBB" },
    ]);
    // 直发不写本地队列镜像：残留条目由权威快照清，不额外长出一条 pending 幽灵
    expect(fixture.controller.getState().queue.followUp).toEqual([
      { id: "pi-old", content: "重发内容" },
    ]);
  });

  it("纯图条目（无文本 + 无附件）静默跳过，不发空帧", async () => {
    const fixture = makeQueueFixture();
    fixture.controller.connect();
    await fixture.controller.queueResend({ id: "pi-empty", content: "" });
    expect(fixture.sent).toEqual([]);
  });
});

describe("停止生成：取回排队条目载荷（文本 + 图片）", () => {
  it("drainQueueForStop 回填条目并清空本地队列", async () => {
    const fixture = makeQueueFixture({
      clearedItems: [
        {
          id: "pi-stop-1",
          content: "带图消息",
          attachments: [{ name: "image-1.png", mimeType: "image/png", data: "CCCC" }],
        },
        { id: "pi-stop-2", content: "纯文本" },
      ],
    });
    fixture.controller.connect();
    fixture.emit({
      type: "queue_update",
      seq: 1,
      steering: [],
      followUp: [{ id: "pi-stop-1", content: "带图消息" }],
    });

    const drained = await fixture.controller.drainQueueForStop();
    expect(drained).toEqual([
      {
        id: "pi-stop-1",
        content: "带图消息",
        attachments: [{ name: "image-1.png", mimeType: "image/png", data: "CCCC" }],
      },
      { id: "pi-stop-2", content: "纯文本" },
    ]);
    expect(fixture.cleared).toEqual(["clear"]);
    expect(fixture.controller.getState().queue).toEqual({ steering: [], followUp: [] });
  });
});
