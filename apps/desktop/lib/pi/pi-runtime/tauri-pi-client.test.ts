import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

afterAll(restoreAllMocks);

/**
 * TauriPiClient 的事件路由核心语义测试（react-pi 迁移阶段 3b）：
 * mock Tauri invoke/listen，验证 thread_event 分流、delta→partial 重建
 * （文本累积 / toolcall 参数缓冲与权威替换 / done 终态替换）、快照基底
 * 对齐（运行中线程中途打开）与收尾帧观察兜底。
 */

type WireLine = { i: number | null; l: string };
type EventLike = { payload: WireLine[] };
type ListenFn = (event: EventLike) => void;

/** 每次测试重置的假 Tauri 状态。注意 listen 是多播：pi-channel 单例（首次
 *  piRequest 时构造）也会注册 pi-chunk-batch/pi-exit 监听，且每个用例都
 *  new 一个 client（各自注册一份监听）——不能像单回调那样互相覆盖，
 *  由 subscribeAndSettle 按注册下标精确喂给被测 client 的处理器 */
let chunkCbs: ListenFn[] = [];
let snapshotReply: unknown = null;
let snapshotCalls = 0;
let promptArgs: Record<string, unknown> | null = null;

mockModule("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "pi_request") {
      const payload = (args?.payload ?? {}) as { type?: string };
      if (payload.type === "thread_snapshot") {
        snapshotCalls += 1;
        return new Promise((resolve) =>
          setTimeout(() => resolve(JSON.stringify(snapshotReply)), 0),
        );
      }
      return Promise.resolve(JSON.stringify({ type: "sessions", sessions: [] }));
    }
    if (cmd === "pi_prompt") {
      promptArgs = args ?? null;
      return Promise.resolve();
    }
    if (cmd === "pi_abort") return Promise.resolve();
    return Promise.reject(new Error(`unexpected invoke ${cmd}`));
  },
}));

mockModule("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: ListenFn) => {
    if (event === "pi-chunk-batch") {
      return Promise.resolve().then(() => {
        chunkCbs.push(cb);
        return () => {
          chunkCbs = chunkCbs.filter((f) => f !== cb);
        };
      });
    }
    return Promise.resolve(() => {});
  },
}));

// pi-bridge 边界自锚（lib/testing/mock-module.ts 的纪律）：别名模块的 mock
// 跨文件恢复不可靠——全量跑 lib/pi/ 时 pi-history-window/app-mode 等文件的
// piRequest 桩会泄漏进本文件，thread_snapshot 路径被毒化（3 个快照依赖用例
// 失败）。这里显式接管，语义与真实 pi-bridge 一致：委托当前注册通道 +
// error 应答抛错。
mockModule("@/lib/pi/pi-bridge", () => {
  const { getPiChannel } = require("@/lib/pi/pi-channel") as typeof import("@/lib/pi/pi-channel");
  return {
    piRequest: async <T>(
      payload: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<T> => {
      const response = await getPiChannel().request(payload, timeoutMs);
      if ((response as { type?: string }).type === "error") {
        throw new Error((response as { errorText?: string }).errorText);
      }
      return response as T;
    },
  };
});

const { TauriPiClient } = await import("@/lib/pi/pi-runtime/tauri-pi-client");
const {
  pendingApprovalsForTest,
  pendingQuestionsForTest,
  resetInteractionsForTest,
} = await import("@/lib/pi/pi-interactions");
const { subscribeAgentEvents } = await import("@/lib/pi/agent-events");
const { sessionModeSnapshot } = await import("@/lib/pi/pi-session-mode");
type PiClientEvent = import("@/lib/pi/pi-runtime/types").PiClientEvent;

// ---------- 工具 ----------

const tick = () => new Promise((r) => setTimeout(r, 5));

/** 构造 thread_event 帧行 */
const threadEvent = (
  sessionId: string,
  seq: number,
  event: Record<string, unknown>,
): WireLine => ({
  i: null,
  l: JSON.stringify({ type: "thread_event", sessionId, eventSeq: seq, event }),
});

/** 运行中快照（末条 assistant = 在飞 partial） */
const runningSnapshot = (text: string) => ({
  metadata: { id: "s1", status: "running" },
  messages: [
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "x",
      provider: "p",
      model: "m",
      usage: {},
      stopReason: "stop",
      timestamp: 2,
    },
  ],
  seq: 5,
});

function subscribeAndSettle(): {
  events: PiClientEvent[];
  client: import("@/lib/pi/pi-runtime/tauri-pi-client").TauriPiClient;
  feed: (lines: WireLine[]) => void;
} {
  const events: PiClientEvent[] = [];
  // 被测 client 的监听在 subscribe 里同步注册（先于首个用例里 pi-channel
  // 单例的注册），push 顺序 FIFO，记录下标即可精确定位本用例的处理器
  const cbIndex = chunkCbs.length;
  const client = new TauriPiClient();
  client.subscribe("s1", (e) => events.push(e));
  const feed = (lines: WireLine[]) => chunkCbs[cbIndex]?.({ payload: lines });
  return { events, client, feed };
}

// ---------- 用例 ----------

describe("TauriPiClient 事件路由", () => {
  test("快照基底 + delta 重建：中途打开线程后续 delta 续上", async () => {
    snapshotCalls = 0;
    snapshotReply = { type: "thread_snapshot", snapshot: runningSnapshot("Hel") };
    const { events, feed } = subscribeAndSettle();
    await tick(); // 快照先行
    expect(snapshotCalls).toBe(1);
    expect(events[0]?.type).toBe("snapshot");

    feed([
      threadEvent("s1", 6, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
      }),
    ]);
    expect(events).toHaveLength(2);
    const update = events[1] as Extract<PiClientEvent, { type: "message_update" }>;
    expect(update.threadId).toBe("s1");
    expect(update.seq).toBe(6);
    const blocks = (update.message as { content: unknown[] }).content as {
      type: string;
      text: string;
    }[];
    expect(blocks[0]).toEqual({ type: "text", text: "Hello" });
  });

  test("message_start 起基 + text/thinking 累积 + message_end 清台账", async () => {
    snapshotCalls = 0;
    snapshotReply = { type: "thread_snapshot", snapshot: runningSnapshot("x") };
    const { events, feed } = subscribeAndSettle();
    await tick();
    events.length = 0;

    feed([
      threadEvent("s1", 7, {
        type: "message_start",
        message: { role: "assistant", content: [], timestamp: 3 },
      }),
      threadEvent("s1", 8, {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
      }),
      threadEvent("s1", 9, {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hm" },
      }),
      threadEvent("s1", 10, {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "hmm" },
      }),
      threadEvent("s1", 11, {
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 1 },
      }),
      threadEvent("s1", 12, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "a" },
      }),
      threadEvent("s1", 13, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "b" },
      }),
      threadEvent("s1", 14, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "ab" },
          ],
          timestamp: 4,
        },
      }),
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "message_start",
      "message_update",
      "message_update",
      "message_update",
      "message_update",
      "message_update",
      "message_update",
      "message_end",
    ]);
    const before = events[6] as Extract<PiClientEvent, { type: "message_update" }>;
    expect((before.message as { content: unknown[] }).content).toEqual([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "ab" },
    ]);
  });

  test("toolcall：参数缓冲累积，toolcall_end 权威整体替换", async () => {
    snapshotCalls = 0;
    snapshotReply = { type: "thread_snapshot", snapshot: runningSnapshot("x") };
    const { events, feed } = subscribeAndSettle();
    await tick();
    events.length = 0;

    feed([
      threadEvent("s1", 15, {
        type: "message_start",
        message: { role: "assistant", content: [], timestamp: 5 },
      }),
      threadEvent("s1", 16, {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          toolCall: { id: "t1", name: "bash" },
        },
      }),
      threadEvent("s1", 17, {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"command":"ls',
        },
      }),
      threadEvent("s1", 18, {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: ' -la"}',
        },
      }),
      threadEvent("s1", 19, {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: { id: "t1", name: "bash", arguments: { command: "ls -la" } },
        },
      }),
    ]);
    const last = events.at(-1) as Extract<PiClientEvent, { type: "message_update" }>;
    expect((last.message as { content: unknown[] }).content).toEqual([
      { id: "t1", name: "bash", arguments: { command: "ls -la" } },
    ]);
  });

  test("done 终态整体替换 accumulator 消息", async () => {
    snapshotCalls = 0;
    snapshotReply = { type: "thread_snapshot", snapshot: runningSnapshot("Hel") };
    const { events, feed } = subscribeAndSettle();
    await tick();
    events.length = 0;

    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
      timestamp: 6,
    };
    feed([
      threadEvent("s1", 20, {
        type: "message_update",
        assistantMessageEvent: { type: "done", reason: "stop", message: finalMessage },
      }),
    ]);
    const update = events[0] as Extract<PiClientEvent, { type: "message_update" }>;
    expect(update.message).toEqual(finalMessage);
  });

  test("无订阅者的 sessionId 事件静默丢弃；收尾帧触发快照兜底", async () => {
    snapshotCalls = 0;
    snapshotReply = { type: "thread_snapshot", snapshot: runningSnapshot("x") };
    const { events, client, feed } = subscribeAndSettle();
    await tick();
    events.length = 0;

    // 未知会话事件：不派发也不崩
    feed([threadEvent("other", 1, { type: "agent_start" })]);
    expect(events).toHaveLength(0);

    // sendMessage 登记在飞 → finish 行触发即时快照刷新
    await client.sendMessage("s1", { content: "hi" });
    expect(promptArgs).not.toBeNull();
    const requestId = String((promptArgs as { requestId: string }).requestId);
    feed([{ i: null, l: JSON.stringify({ id: requestId, chunk: { type: "finish" } }) }]);
    await tick();
    // 首帧快照(1) + 收尾帧兜底快照(2)
    expect(snapshotCalls).toBe(2);
  });
});

describe("TauriPiClient 交互卡旁路（4b）", () => {
  beforeEach(() => resetInteractionsForTest());

  /** 构造旁路 chunk 行（带 sessionId：拦截按会话喂 pi-interactions 台账） */
  const chunkLine = (sessionId: string, type: string, data: unknown): WireLine => ({
    i: null,
    l: JSON.stringify({ id: "req-x", chunk: { type, data }, sessionId }),
  });

  test("data-toolApproval / data-question 进卡且不进消息流", async () => {
    snapshotCalls = 0;
    snapshotReply = { type: "thread_snapshot", snapshot: runningSnapshot("x") };
    const { events, feed } = subscribeAndSettle();
    await tick();
    events.length = 0;

    feed([
      chunkLine("s1", "data-toolApproval", {
        approvalId: "ap1",
        toolCallId: "t1",
        toolName: "bash",
        input: { command: "ls" },
      }),
      chunkLine("s1", "data-question", {
        questionId: "q1",
        questions: [{ title: "用哪个方案?" }],
      }),
    ]);
    expect(pendingApprovalsForTest("s1")).toHaveLength(1);
    expect(pendingApprovalsForTest("s1")[0]?.toolName).toBe("bash");
    expect(pendingQuestionsForTest("s1")).toHaveLength(1);
    expect(pendingQuestionsForTest("s1")[0]?.questions[0]?.title).toBe("用哪个方案?");
    // 旁路 chunk 不产生 PiClientEvent（不进消息流）
    expect(events).toHaveLength(0);
  });

  test("data-interactionResolved 关单卡；agent_end 清空残留", async () => {
    snapshotCalls = 0;
    snapshotReply = { type: "thread_snapshot", snapshot: runningSnapshot("x") };
    const { events, feed } = subscribeAndSettle();
    await tick();
    events.length = 0;

    feed([
      chunkLine("s1", "data-toolApproval", { approvalId: "ap1", toolName: "bash" }),
      chunkLine("s1", "data-toolApproval", { approvalId: "ap2", toolName: "edit" }),
    ]);
    expect(pendingApprovalsForTest("s1")).toHaveLength(2);

    feed([chunkLine("s1", "data-interactionResolved", { interactionId: "ap1" })]);
    const rest = pendingApprovalsForTest("s1");
    expect(rest).toHaveLength(1);
    expect(rest[0]?.approvalId).toBe("ap2");

    // agent_end 兜底出口：残留（abort/异常未结算的）整线程清空
    feed([threadEvent("s1", 30, { type: "agent_end" })]);
    expect(pendingApprovalsForTest("s1")).toHaveLength(0);
    expect(pendingQuestionsForTest("s1")).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("agent_end");
  });

  test("data-planningState 进模式 store 且不进消息流（4d）", async () => {
    snapshotCalls = 0;
    snapshotReply = { type: "thread_snapshot", snapshot: runningSnapshot("x") };
    const { events, feed } = subscribeAndSettle();
    await tick();
    events.length = 0;

    feed([
      chunkLine("s1", "data-planningState", {
        mode: "plan",
        planning: "inactive",
        approvalLevel: "ask",
      }),
    ]);
    expect(sessionModeSnapshot("s1").mode).toBe("plan");
    expect(events).toHaveLength(0);
  });
});

describe("TauriPiClient 完成提醒（缺口3）", () => {
  test("agent_end 收尾定调：completed/error 提醒，aborted 与外来会话不提醒", async () => {
    snapshotCalls = 0;
    snapshotReply = { type: "thread_snapshot", snapshot: runningSnapshot("x") };
    const { client, feed } = subscribeAndSettle();
    await tick();

    const got: string[] = [];
    const un = subscribeAgentEvents((e) => {
      const d = (e.data ?? {}) as { prompt?: string; message?: string };
      got.push(`${e.name}:${d.prompt ?? d.message ?? ""}`);
    });

    // 本实例发起的会话：完成 → agent.turn.completed 带最近 prompt 正文
    await client.sendMessage("s1", { content: "帮我跑个构建" });
    feed([threadEvent("s1", 40, { type: "agent_end", stopReason: "stop" })]);
    expect(got).toEqual(["agent.turn.completed:帮我跑个构建"]);

    // 用户主动停止（stopReason aborted）：不提醒（旧链路 sawAborted 语义）
    feed([threadEvent("s1", 41, { type: "agent_end", stopReason: "aborted" })]);
    expect(got).toHaveLength(1);

    // 出错收尾：agent.turn.error 带错误正文
    feed([
      threadEvent("s1", 42, {
        type: "agent_end",
        stopReason: "error",
        errorMessage: "boom",
      }),
    ]);
    expect(got).toEqual(["agent.turn.completed:帮我跑个构建", "agent.turn.error:boom"]);

    // 外来会话（automation/他窗发起，本实例从未 sendMessage）：不提醒
    feed([threadEvent("sid-auto", 43, { type: "agent_end" })]);
    expect(got).toHaveLength(2);

    un();
  });
});
