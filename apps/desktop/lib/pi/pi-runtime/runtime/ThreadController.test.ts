// 症状3（编辑重发/重新生成）：reloadMessage/editMessage 走「服务端截断 +
// 重发」漏斗的行为测试。client 为纯内存 fake，只记录 truncate/send 调用；
// 事件时序类回归用例（重生成乐观镜像去重）用可控 fake：subscribe 捕获
// 监听器、快照按队列出队（可塞 deferred 挂起）、sendMessage 可挂起。

import { describe, expect, it } from "bun:test";
import { buildPiSendInput, PiThreadController } from "./ThreadController";
import type { AppendMessage } from "@assistant-ui/react";
import type { PiClient, PiClientEvent, PiThreadSnapshot } from "../types";
import {
  buildLibraryDirective,
  rememberLibraryNoteBody,
} from "@/lib/composer/library-reference";
import { buildCodeCommentChip } from "@/lib/composer/code-comment";
import {
  createCodeCommentEntry,
  putCodeComment,
  removeCodeComment,
} from "@/lib/composer/code-comment-store";

type Recorded =
  | { kind: "truncate"; beforeSeq: number }
  | {
      kind: "send";
      input: { content?: string; attachments?: unknown[]; requestId?: string };
    };

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
      { kind: "send", input: { content: "first", requestId: expect.any(String) } },
    ]);
  });

  it("parentId = 前一条消息 id：截断并重发它本身（不是下一条 user）", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(transcripts, recorded);
    await controller.reloadMessage("pi-msg:2");
    expect(recorded).toEqual([
      { kind: "truncate", beforeSeq: 2 },
      { kind: "send", input: { content: "second", requestId: expect.any(String) } },
    ]);
  });

  it("重生成第一轮时锚定第一条 user：不得跳过它去找后一轮", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(transcripts, recorded);
    await controller.reloadMessage("pi-msg:0");
    expect(recorded).toEqual([
      { kind: "truncate", beforeSeq: 0 },
      { kind: "send", input: { content: "first", requestId: expect.any(String) } },
    ]);
  });

  it("锚点位不是 user（前驱为 assistant）时向上回溯最近的 user", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController(transcripts, recorded);
    await controller.reloadMessage("pi-msg:1");
    expect(recorded).toEqual([
      { kind: "truncate", beforeSeq: 0 },
      { kind: "send", input: { content: "first", requestId: expect.any(String) } },
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
      { kind: "send", input: { content: "only", requestId: expect.any(String) } },
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
    // 重发路径在发送瞬间就压镜像（不必等 start 帧；普通发送则要等起跑帧
    // 才上屏）。编辑重发产生 pi-optimistic 镜像——编辑后文本不在陈旧快照里，
    // reconcile 摘不掉
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
      input: { content: "second, edited", requestId: expect.any(String) },
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
      requestId: expect.any(String),
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

// —— 卡死回归（2026-10-16）——
// 症状：侧边栏快速切换会话后界面完全卡死（Maximum update depth exceeded 风暴）。
// 归因：控制器缓存把「渲染期刚建、effect 尚未订阅」的实例当空闲淘汰 → 挂载
// effect [controller] 每趟重跑 → load() 无条件回写 loadState("loading") →
// 发布 + 全量通知 → store「每次提交都 notify」的泵把它放大成
// forceStoreRerender → commit → notify 的同步嵌套自环。
// 本组用例锁住 load() 侧的不变式：已加载的会话重复 load 不得再改写状态。
describe("load() 幂等（卡死回归）", () => {
  it("已加载的会话再次 load() 不再回写 loading 态（重挂触发的冷读只做后台刷新）", async () => {
    const recorded: Recorded[] = [];
    const controller = await loadedController([user(1, "hi")], recorded);

    const seen: string[] = [];
    const unsubscribe = controller.subscribe(() => {
      seen.push(controller.getStateSnapshot().loadState);
    });

    // 模拟挂载 effect 重跑（切回/重挂/控制器抖动）触发的冷读
    await controller.load();

    // 关键不变式：不得把已加载的界面打回 loading（每次回写都是一次全量
    // 发布；挂载抖动下就是卡死自环的燃料）。后台快照刷新本身允许。
    expect(seen).not.toContain("loading");
    expect(seen.every((state) => state === "loaded")).toBe(true);
    unsubscribe();
  });

  it("首次加载仍回写 loading 态（pending → loading），强制刷新保持原语义", async () => {
    const recorded: Recorded[] = [];
    const controller = new PiThreadController(
      makeClient([user(1, "hi")], recorded),
      "thread-1",
    );
    const states: string[] = [];
    const unsubscribe = controller.subscribe(() => {
      states.push(controller.getStateSnapshot().loadState);
    });

    const first = controller.load();
    expect(controller.getStateSnapshot().loadState).toBe("loading");
    await first;
    expect(controller.getStateSnapshot().loadState).toBe("loaded");
    expect(states).toContain("loading");
    unsubscribe();
  });
});


// —— 引用（SelectionToolbar「询问」）——
// 库把引用放在 AppendMessage.metadata.custom.quote（不占 content）。发送前
// 必须把引用文本以 Markdown 引用块前置进正文：模型才看得到"针对哪段文字"，
// 且引用随转录持久化（投影侧按同约定还原成引用块渲染，见 messageProjection）。
describe("buildPiSendInput 引用（「询问」）", () => {
  const withQuote = (text: string, quote: string | undefined): AppendMessage =>
    ({
      role: "user",
      content: text ? [{ type: "text", text }] : [],
      createdAt: new Date(0),
      metadata: quote !== undefined ? { custom: { quote: { text: quote, messageId: "m-1" } } } : {},
    }) as unknown as AppendMessage;

  it("引用以 Markdown 引用块前置进正文", () => {
    expect(buildPiSendInput(withQuote("问题是什么？", "引用的原文"), undefined).content).toBe(
      "> 引用的原文\n\n问题是什么？",
    );
  });

  it("多行引用逐行加前缀", () => {
    expect(buildPiSendInput(withQuote("", "第一行\n第二行"), undefined).content).toBe(
      "> 第一行\n> 第二行",
    );
  });

  it("只选引用不写正文也能发出（纯询问）", () => {
    expect(buildPiSendInput(withQuote("", "引用的原文"), undefined).content).toBe(
      "> 引用的原文",
    );
  });

  it("无引用不改动正文", () => {
    expect(buildPiSendInput(withQuote("你好", undefined), undefined).content).toBe("你好");
  });

  it("空/空白引用视作无引用", () => {
    expect(buildPiSendInput(withQuote("你好", "   "), undefined).content).toBe("你好");
  });
});


// —— 代码引用芯片（文件视图「引用到对话」）——
// 芯片以 :code[...] 序列化文本活在输入框里；发送时必须展开成
// `@path (lines N-M)` 引用形式（模型看到引用，内容由 agent 按行号自己读）。
describe("buildPiSendInput 代码引用芯片", () => {
  const withChip = (text: string): AppendMessage =>
    ({
      role: "user",
      content: [{ type: "text", text }],
      createdAt: new Date(0),
      metadata: {},
    }) as unknown as AppendMessage;
  const chip = (path: string, start: number, end: number) =>
    `:code[${path}:${start}${start === end ? "" : `-${end}`}]{name=code:${path}:${start}${start === end ? "" : `-${end}`}}`;

  it("芯片展开成 @path (lines N-M)，正文保留", () => {
    const built = buildPiSendInput(
      withChip(`看下 ${chip("src/foo.ts", 11, 16)} 这段`),
      undefined,
    );
    expect(built.content).toBe("看下 @src/foo.ts (lines 11-16) 这段");
  });

  it("整条消息只有芯片（纯引用直接发）", () => {
    const built = buildPiSendInput(withChip(chip("src/foo.ts", 12, 12)), undefined);
    expect(built.content).toBe("@src/foo.ts (line 12)");
  });

  it("无芯片的普通消息不改动", () => {
    expect(buildPiSendInput(withChip("你好"), undefined).content).toBe("你好");
  });
});

// —— 评论芯片（代码行悬浮评论）——
// 输入框里只有 :comment[label · preview]{name=comment:<id>}；完整评论在
// code-comment-store，发送时必须展开成 @path (lines N-M) + 评论正文。
describe("buildPiSendInput 评论芯片", () => {
  const withChip = (text: string): AppendMessage =>
    ({
      role: "user",
      content: [{ type: "text", text }],
      createdAt: new Date(0),
      metadata: {},
    }) as unknown as AppendMessage;

  it("芯片展开成引用 + 评论正文，不把内部 token 发给模型", () => {
    const entry = createCodeCommentEntry(
      { path: "src/foo.ts", startLine: 11, endLine: 16 },
      "这段为什么要这样写？",
    );
    putCodeComment(entry);
    try {
      const built = buildPiSendInput(
        withChip(`看下 ${buildCodeCommentChip(entry)}`),
        undefined,
      );
      expect(built.content).toBe(
        "看下 @src/foo.ts (lines 11-16)\n这段为什么要这样写？",
      );
    } finally {
      removeCodeComment(entry.id);
    }
  });

  it("删除侧芯片展开为 deleted 行号语义", () => {
    const entry = createCodeCommentEntry(
      { path: "src/foo.ts", startLine: 7, endLine: 7, deleted: true },
      "这行删得对吗？",
    );
    putCodeComment(entry);
    try {
      const built = buildPiSendInput(withChip(buildCodeCommentChip(entry)), undefined);
      expect(built.content).toBe("@src/foo.ts (deleted line 7)\n这行删得对吗？");
    } finally {
      removeCodeComment(entry.id);
    }
  });
});

// —— 资料库引用芯片（资料库页 / @ 资料库分组「引用到对话」）——
// 芯片以 :library[...] 序列化文本活在输入框里；发送时必须展开成
// `[资料库笔记/文件] rel → \`/abs\``（模型看到引用，内容由 agent 用文件工具
// 按行号自己读）。缺失安全网由 guard 维护的集合驱动，这里只测展开本身。
describe("buildPiSendInput 资料库引用芯片", () => {
  const withChip = (text: string): AppendMessage =>
    ({
      role: "user",
      content: [{ type: "text", text }],
      createdAt: new Date(0),
      metadata: {},
    }) as unknown as AppendMessage;

  it("纯芯片消息：芯片保留上屏，路径进隐藏 refs 块（随机边界）", () => {
    const chip = buildLibraryDirective({
      rel: "notes/周报.md",
      name: "周报",
      absPath: "/Users/me/library/notes/周报.md",
    });
    const built = buildPiSendInput(withChip(chip), undefined);
    expect(built.content.startsWith(`${chip}\n\n[[library-refs:`)).toBe(true);
    expect(built.content).toContain(
      "[资料库笔记] notes/周报.md → `/Users/me/library/notes/周报.md`",
    );
    expect(built.content).toMatch(/\[\[\/library-refs:[a-z0-9]+\]\]$/);
  });

  it("正文与芯片混排：芯片保留、正文保留、路径进隐藏块", () => {
    const chip = buildLibraryDirective({
      rel: "assets/spec.pdf",
      name: "spec",
      absPath: "/Users/me/library/assets/spec.pdf",
      startLine: 3,
      endLine: 4,
    });
    const built = buildPiSendInput(withChip(`看下 ${chip} 这段`), undefined);
    expect(built.content.startsWith(`看下 ${chip} 这段\n\n[[library-refs:`)).toBe(
      true,
    );
    expect(built.content).toContain(
      "[资料库文件] assets/spec.pdf → `/Users/me/library/assets/spec.pdf` (lines 3-4)",
    );
    expect(built.content).toMatch(/\[\[\/library-refs:[a-z0-9]+\]\]$/);
  });

  it("正文缓存命中：笔记正文内联进隐藏块，不再重复 refs 行", () => {
    const ref = {
      rel: "notes/inline-send.md",
      name: "Inline send",
      absPath: "/Users/me/library/notes/inline-send.md",
    };
    const chip = buildLibraryDirective(ref);
    rememberLibraryNoteBody(ref.absPath, "Inline send note", "这是笔记正文。");
    const built = buildPiSendInput(withChip(`${chip} 总结一下`), undefined);
    // 用户气泡：芯片仍在正文里
    expect(built.content).toContain(chip);
    // 模型上下文：只有 notes 块（来源路径已含在块内），没有 refs 块
    expect(built.content).not.toContain("[[library-refs");
    expect(built.content).toContain("[[library-notes:");
    expect(built.content).toContain('Referenced note "Inline send note"');
    expect(built.content).toContain("这是笔记正文。");
    expect(built.content).toMatch(/\[\[\/library-notes:[a-z0-9]+\]\]$/);
  });
});

describe("markInterruptedTurn（sidecar 换代腰斩的在跑轮）", () => {
  it("末尾是 user 行且空闲：补一条合成的 aborted 空回复", async () => {
    const controller = await loadedController([user(0, "123123")], []);
    expect(controller.getProjectedMessages().length).toBe(1);

    controller.markInterruptedTurn();
    const messages = controller.getProjectedMessages();
    expect(messages.length).toBe(2);
    expect(messages[1]!.status).toMatchObject({
      type: "incomplete",
      reason: "cancelled",
    });
    // 空内容：渲染层据此显示「回复已被你终止」占位
    expect(messages[1]!.content).toHaveLength(0);
  });

  it("末尾是 assistant 行：不补（快照里已有回复，标记交给 data-stopped）", async () => {
    const controller = await loadedController(
      [user(0, "123123"), assistant(1, "done")],
      [],
    );
    controller.markInterruptedTurn();
    expect(controller.getProjectedMessages().length).toBe(2);
  });

  it("重复置位不叠加", async () => {
    const controller = await loadedController([user(0, "123123")], []);
    controller.markInterruptedTurn();
    controller.markInterruptedTurn();
    expect(controller.getProjectedMessages().length).toBe(2);
  });
});
