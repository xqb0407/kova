// 症状3（编辑重发/重新生成）：reloadMessage/editMessage 走「服务端截断 +
// 重发」漏斗的行为测试。client 为纯内存 fake，只记录 truncate/send 调用；
// 事件时序类回归用例（重生成乐观镜像去重）用可控 fake：subscribe 捕获
// 监听器、快照按队列出队（可塞 deferred 挂起）、sendMessage 可挂起。

import { describe, expect, it } from "bun:test";
import { PiThreadController } from "./ThreadController";
import type { AppendMessage } from "@assistant-ui/react";
import type { PiClient, PiClientEvent, PiThreadSnapshot } from "../types";

type Recorded =
  | { kind: "truncate"; beforeSeq: number }
  | { kind: "send"; input: { content?: string; attachments?: unknown[] } };

const makeClient = (messages: unknown[], recorded: Recorded[]) =>
  ({
    getThread: async () =>
      ({
        metadata: { id: "thread-1", status: "idle" },
        messages,
        seq: 99,
      }) as unknown as PiThreadSnapshot,
    subscribe: () => () => {},
    sendMessage: async (_threadId: string, input: any) => {
      recorded.push({ kind: "send", input });
    },
    truncateToSeq: async (_threadId: string, beforeSeq: number) => {
      recorded.push({ kind: "truncate", beforeSeq });
    },
  }) as unknown as PiClient;

/** 测试用 AppendMessage 构造（core 真实载荷带 createdAt/metadata）。 */
const appendUser = (
  text: string,
  extra: Partial<Pick<AppendMessage, "sourceId">> = {},
): AppendMessage =>
  ({
    role: "user",
    content: [{ type: "text", text }],
    createdAt: new Date(0),
    metadata: {},
    ...extra,
  }) as unknown as AppendMessage;

const user = (seq: number, content: unknown) => ({
  role: "user",
  content,
  timestamp: seq * 1000,
  __seq: seq,
});
const assistant = (seq: number, text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: seq * 1000,
  __seq: seq,
});

const loadedController = async (messages: unknown[], recorded: Recorded[]) => {
  const controller = new PiThreadController(
    makeClient(messages, recorded),
    "thread-1",
  );
  await controller.load();
  return controller;
};

// —— 可控 fake：事件时序类回归（重生成乐观镜像去重）用 ——

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const makeControllableClient = (initialMessages: unknown[], recorded: Recorded[]) => {
  const listeners = new Set<(event: PiClientEvent) => void>();
  // getThread 逐个出队；塞入带 promise 的条目可挂起该次快照
  const snapshotQueue: (
    | PiThreadSnapshot
    | { promise: Promise<PiThreadSnapshot>; resolve: (s: PiThreadSnapshot) => void }
  )[] = [];
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((r) => (releaseSend = r));
  const client = {
    getThread: async () => {
      const next = snapshotQueue.shift();
      if (next && "promise" in next) return next.promise;
      if (next) return next;
      return {
        metadata: { id: "thread-1", status: "idle" },
        messages: initialMessages,
        seq: 99,
      } as unknown as PiThreadSnapshot;
    },
    subscribe: (_threadId: string, cb: (event: PiClientEvent) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    sendMessage: async (_threadId: string, input: any) => {
      recorded.push({ kind: "send", input });
      await sendGate;
    },
    truncateToSeq: async (_threadId: string, beforeSeq: number) => {
      recorded.push({ kind: "truncate", beforeSeq });
    },
  } as unknown as PiClient;
  return {
    client,
    /** 直发一帧 thread_event（真实链路里 routeThreadEvent 会补 threadId/seq） */
    emit: (event: Record<string, unknown>) => {
      for (const listener of listeners) {
        listener({ threadId: "thread-1", ...event } as PiClientEvent);
      }
    },
    holdSnapshot: () => {
      let resolve!: (s: PiThreadSnapshot) => void;
      const promise = new Promise<PiThreadSnapshot>((r) => (resolve = r));
      snapshotQueue.push({ promise, resolve });
      return resolve;
    },
    releaseSend,
  };
};

const transcripts = [
  user(0, "first"),
  assistant(1, "answer one"),
  user(2, "second"),
  assistant(3, "answer two"),
];

describe("reloadMessage（重新生成 = 截断 + 重发）", () => {
  it("parentId = null 从头截断并重发第一条 user 消息", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(transcripts, recorded);
    await controller.reloadMessage(null);
    expect(recorded).toEqual([
      { kind: "truncate", beforeSeq: 0 },
      { kind: "send", input: { content: "first" } },
    ]);
  });

  it("parentId = 前一条消息 id：截断并重发它本身（不是下一条 user）", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(transcripts, recorded);
    await controller.reloadMessage("pi-msg:2");
    expect(recorded).toEqual([
      { kind: "truncate", beforeSeq: 2 },
      { kind: "send", input: { content: "second" } },
    ]);
  });

  it("重生成第一轮时锚定第一条 user：不得跳过它去找后一轮", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(transcripts, recorded);
    await controller.reloadMessage("pi-msg:0");
    expect(recorded).toEqual([
      { kind: "truncate", beforeSeq: 0 },
      { kind: "send", input: { content: "first" } },
    ]);
  });

  it("锚点位不是 user（前驱为 assistant）时向上回溯最近的 user", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(transcripts, recorded);
    await controller.reloadMessage("pi-msg:1");
    expect(recorded).toEqual([
      { kind: "truncate", beforeSeq: 0 },
      { kind: "send", input: { content: "first" } },
    ]);
  });

  it("回归：单轮会话重生成唯一 assistant 不再报 no user message to reload", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(
      [user(0, "only"), assistant(1, "reply")],
      recorded,
    );
    await controller.reloadMessage("pi-msg:0");
    expect(recorded).toEqual([
      { kind: "truncate", beforeSeq: 0 },
      { kind: "send", input: { content: "only" } },
    ]);
  });

  it("重发保留图片附件（投影 data URL 还原为协议 attachments）", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(
      [user(0, [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }])],
      recorded,
    );
    await controller.reloadMessage(null);
    const send = recorded[1];
    expect(send.kind).toBe("send");
    expect(send.kind === "send" && send.input.attachments).toEqual([
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ]);
  });

  it("parentId 不存在时抛错且不截断", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(transcripts, recorded);
    await expect(controller.reloadMessage("pi-msg:404")).rejects.toThrow(
      "message not found",
    );
    expect(recorded).toEqual([]);
  });

  it("乐观镜像未落盘（pi-optimistic id）不可截断，抛错", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(transcripts, recorded);
    // 镜像只来自重发路径（普通发送不压镜像，回显是气泡唯一来源）：编辑重发
    // 产生 pi-optimistic 镜像——编辑后文本不在陈旧快照里，reconcile 摘不掉
    await controller.editMessage(
      appendUser("second, edited", { sourceId: "pi-msg:2" }),
    );
    const optimistic = controller
      .getProjectedMessages()
      .find((m) => m.id?.startsWith("pi-optimistic:"));
    expect(optimistic).toBeDefined();
    recorded.length = 0;
    // 镜像未落盘（无 pi-msg:<seq> id）：对它再编辑必须拒绝——无从截断
    await expect(
      controller.editMessage(appendUser("edited", { sourceId: optimistic!.id! })),
    ).rejects.toThrow("cannot resend");
    expect(recorded).toEqual([]);
  });
});

describe("editMessage（编辑重发 = 以 sourceId 截断 + 发送编辑内容）", () => {
  it("截断被编辑消息并发送编辑后的完整内容", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(transcripts, recorded);
    await controller.editMessage(
      appendUser("second, edited", { sourceId: "pi-msg:2" }),
    );
    expect(recorded[0]).toEqual({ kind: "truncate", beforeSeq: 2 });
    expect(recorded[1]).toEqual({
      kind: "send",
      input: { content: "second, edited" },
    });
  });

  it("缺少 sourceId / 非 user 角色 / 未知 id 都拒绝且不动服务端", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(transcripts, recorded);
    await expect(controller.editMessage(appendUser("x"))).rejects.toThrow(
      "no source id",
    );
    await expect(
      controller.editMessage({
        role: "assistant",
        content: [{ type: "text", text: "x" }],
        createdAt: new Date(0),
        metadata: {},
        sourceId: "pi-msg:0",
      } as unknown as AppendMessage),
    ).rejects.toThrow("only supports editing user messages");
    await expect(
      controller.editMessage(
        appendUser("x", { sourceId: "pi-msg:777" }),
      ),
    ).rejects.toThrow("message not found");
    expect(recorded).toEqual([]);
  });
});

// —— 重生成（截断 + 重发）乐观态的事件时序回归（2026-10-02）——
// 真实链路：truncate_session 确认 → truncateLocally 本地移除旧行（与重发压
// 入的新气泡同帧完成新旧互换）→ refreshInBackground 拉截断后快照 → sendMessage
// 压入乐观镜像（全文匹配下界 0）→ sidecar 对重发消息广播 message_start 回显。
// 快照与回显走两条传输通道无顺序保证，两种时序都必须收敛：回显先落（小帧
// 常态）或快照先落（带图大帧常态——曾致镜像按下界匹配永远确认不了，气泡
// 永久重复、仅切会话/刷新恢复）。
describe("reloadMessage 乐观镜像去重（截断后数组收缩的时序）", () => {
  const imageBlock = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const imageTranscript = [
    user(0, "first"),
    assistant(1, "answer one"),
    user(2, [{ type: "text", text: "second" }, imageBlock]),
    assistant(3, "answer two"),
  ];

  const optimisticResidue = (controller: PiThreadController) =>
    controller
      .getProjectedMessages()
      .some((m) => m.id?.startsWith("pi-optimistic:"));

  it("回归：截断后快照先收缩数组、回显 message_start 后到——镜像须被摘除", async () => {
    const recorded: Recorded[] = [];
    const h = makeControllableClient(imageTranscript, recorded);
    const controller = new PiThreadController(h.client, "thread-1");
    await controller.load();

    // 重生成第二（带图）轮：截断后快照（只余前两行）挂在途
    const resolveSnapshot = h.holdSnapshot();
    const reloading = controller.reloadMessage("pi-msg:2");
    await flush();

    // 乐观本地截断：旧轮行（含旧 assistant「answer two」）立即消失，不等
    // 快照回程；乐观镜像同帧上屏撑住气泡（新旧互换顺序修复点）
    expect(
      controller
        .getProjectedMessages()
        .some((m) => JSON.stringify(m.content).includes("answer two")),
    ).toBe(false);
    expect(optimisticResidue(controller)).toBe(true);

    // 截断后快照回程（内容与本地截断一致），回显仍未到：镜像继续在场
    resolveSnapshot({
      metadata: { id: "thread-1", status: "idle" },
      messages: [imageTranscript[0], imageTranscript[1]],
      seq: 100,
    } as unknown as PiThreadSnapshot);
    await flush();
    expect(optimisticResidue(controller)).toBe(true);

    // 服务端回显（带图 user 行，直播帧不带 __seq）
    h.emit({
      type: "message_start",
      seq: 101,
      message: {
        role: "user",
        content: [{ type: "text", text: "second" }, imageBlock],
        timestamp: Date.now(),
      },
    });

    // 修复点：全文匹配（下界 0）确认镜像摘除——投影只余回显这一条
    expect(optimisticResidue(controller)).toBe(false);
    const seconds = controller
      .getProjectedMessages()
      .filter((m) => m.role === "user" && JSON.stringify(m.content).includes("second"));
    expect(seconds).toHaveLength(1);

    h.releaseSend();
    await reloading;
    // 重发载荷仍带图（投影 attachments 还原为协议 attachments）
    const send = recorded.find((r) => r.kind === "send");
    expect(send?.kind).toBe("send");
    expect(send?.kind === "send" && send.input).toEqual({
      content: "second",
      attachments: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
    });
  });

  it("回显先落、随后陈旧快照被丢弃——镜像不残留也不崩", async () => {
    const recorded: Recorded[] = [];
    const h = makeControllableClient(imageTranscript, recorded);
    const controller = new PiThreadController(h.client, "thread-1");
    await controller.load();

    // 挂起截断后快照，让回显事件先落（Order B：回显落点 = 旧数组下界之后）
    const resolveStale = h.holdSnapshot();
    const reloading = controller.reloadMessage("pi-msg:2");
    await flush();

    h.emit({ type: "agent_start", seq: 100 });
    h.emit({
      type: "message_start",
      seq: 101,
      message: {
        role: "user",
        content: [{ type: "text", text: "second" }, imageBlock],
        timestamp: Date.now(),
      },
    });
    expect(optimisticResidue(controller)).toBe(false);

    // 快照此刻才回（seq 低于已消费的事件水位）→ responseWasOvertaken 丢弃
    //（内容与本地截断一致，丢弃无碍）——不得崩、不得残留镜像
    resolveStale({
      metadata: { id: "thread-1", status: "idle" },
      messages: imageTranscript,
      seq: 99,
    } as unknown as PiThreadSnapshot);
    await flush();
    h.releaseSend();
    await reloading;

    expect(optimisticResidue(controller)).toBe(false);
    // 旧轮行已随乐观本地截断移除：投影 = 前两行 + 回显
    expect(controller.getProjectedMessages()).toHaveLength(3);
  });
});
