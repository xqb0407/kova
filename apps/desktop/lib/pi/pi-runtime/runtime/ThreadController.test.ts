// 症状3（编辑重发/重新生成）：reloadMessage/editMessage 走「服务端截断 +
// 重发」漏斗的行为测试。client 为纯内存 fake，只记录 truncate/send 调用。

import { describe, expect, it } from "bun:test";
import { PiThreadController } from "./ThreadController";
import type { AppendMessage } from "@assistant-ui/react";
import type { PiClient, PiThreadSnapshot } from "../types";

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
    // 空闲发送产生乐观镜像（pi-optimistic id，未落盘无 seq）
    await controller.sendMessage(appendUser("pending"));
    recorded.length = 0;
    const optimistic = controller
      .getProjectedMessages()
      .find((m) => m.id?.startsWith("pi-optimistic:"));
    expect(optimistic).toBeDefined();
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
