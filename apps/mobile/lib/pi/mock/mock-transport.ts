/**
 * MockPiTransport：PiClientTransport 的演示实现——不动 sidecar / 网关，
 * 让手机在没有桌面端的情况下也能进聊天、看流式、点工具行、玩队列。
 *
 * 复用 PiClientBase 全部重建逻辑（快照权威 + delta 重建 + 收尾帧兜底），
 * 所以 mock 只需伪造两种东西：
 * - 管理类 request：list_sessions / thread_snapshot / new_session / models …；
 * - 原始 NDJSON 行：thread_event（agent_start / message_* / agent_end）+
 *   finish chunk 帧（触发基座的强制快照刷新）。
 *
 * 流式脚本走真实时序（thinking → toolcall → toolResult → 正文），每一拍之间
 * 有延迟，肉眼看到的就是打字机效果而不是一次性贴出全文。abort 中途打断，
 * stopReason 落 aborted；运行中再发送按 followUp 排队（queue_update 事件 +
 * 快照 queuedMessages），轮次结束后自动接力。
 */
import type { PiPromptAttachment } from "@/lib/pi/pi-channel";
import type {
  PiAssistantMessage,
  PiThreadSnapshot,
  PiTranscriptMessage,
} from "@/lib/pi/pi-runtime/types";
import { PiClientBase, type PiClientTransport } from "@/lib/pi/pi-runtime/pi-client-base";

/** 每条 delta 之间的间隔（ms）：再小就失去"流式"感，再大显得卡 */
const TICK_MS = 55;
/** 工具执行的假耗时（ms） */
const TOOL_MS = 900;
/** 轮次结束后接续队列的间隔（ms） */
const NEXT_TURN_MS = 400;

type MockSession = {
  sessionId: string;
  title: string;
  cwd: string;
  createdAt: string;
  modified: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
  messages: PiTranscriptMessage[];
  /** 转录行水位（__seq 与快照 seq 同源递增） */
  seq: number;
  /** thread_event 水位（per-session 单调，routeThreadEvent 靠它去重） */
  eventSeq: number;
  running: boolean;
  /** 当前轮的 prompt requestId（abort 收尾要按它补 finish 帧） */
  currentRequestId: string | null;
  /** 排队项（运行中再发送）；steer/followUp 同仓，顺序执行 */
  queue: { id: string; mode: "steer" | "followUp"; content: string }[];
};

const CWD = "/Users/you/pi-kova";
/** 演示用的第二个目录。首页「项目」视图按 cwd 分组，两个种子会话都挂同一个
 *  目录的话那一段只有一个标题，看不出分组到底生效没有 */
const CWD_ALT = "/Users/you/pi-kova-mobile/my-app";

function iso(msOffset = 0): string {
  return new Date(Date.now() - msOffset).toISOString();
}

function usage(output: number) {
  const input = 8400;
  return {
    input,
    output,
    cacheRead: 3200,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0.0026,
      output: 0.004,
      cacheRead: 0.0004,
      cacheWrite: 0,
      total: 0.007,
    },
  };
}

function assistantMessage(
  content: PiAssistantMessage["content"],
  stopReason: PiAssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): PiAssistantMessage {
  return {
    role: "assistant",
    content,
    api: "mock.openai/v1",
    provider: "mock",
    model: "kova-demo-1",
    usage: usage(96),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

/** 预置回复：带表格/代码块/列表，正好当 markdown 渲染的验收样本 */
const REPLY_RICH = `好的，已核对完这轮改动。整体结构没问题，有三处建议收敛一下：

## 结论

- **队列语义正确**：运行中发送走 followUp，steer 才并轮，和你桌面端的行为一致
- \`turn-checkpoints\` 的 \`anchorIndex\` 允许为空，快照回放时记得兜底
- 深色模式下边框对比度略高，可以压到 8%

## 建议的最小改法

| 位置 | 现状 | 建议 |
| --- | --- | --- |
| composer | 停止键覆盖发送键 | 两键并存 |
| 队列条目 | 只有文本 | 带 reqId |
| 快照指纹 | 5 项 | 加 queuedMessages 首项 id |

代码上大概是这样：

\`\`\`ts
const composerSendDisabled =
  !canSend || (isRunning && !capabilities.queue && voice === undefined);
\`\`\`

需要的话我下一轮直接把这三处改掉。`;

const REPLY_SHORT = `收到。这个点我先记下了，下一轮一起处理——优先级排在队列语义后面。`;

const REPLY_IMAGE = `图片我看到了：构图是居中的，文字部分清晰可读。如果要做成启动页素材，建议把四周裁掉 8% 再压一档对比度，玻璃层叠上去会更透。`;

/** 读文件工具的假输出 */
const TOOL_OUTPUT = `import { useAuiState } from "@assistant-ui/react";

export function useCanSend() {
  return useAuiState(({ composer }) => !composer.isRunning);
}
// 12 行，截断展示`;

export class MockPiTransport implements PiClientTransport {
  private readonly sessions = new Map<string, MockSession>();
  private lineSink: ((raw: string) => void) | null = null;
  private generationCb: (() => void) | null = null;
  /** 当前在跑的轮：abort 置位后脚本在下一拍退出 */
  private abortedFor: string | null = null;
  private disposed = false;

  constructor() {
    this.seed();
  }

  /** 预置两个会话：一个有历史，一个空的（对应"新对话"的冷启动观感） */
  private seed() {
    const earlier: MockSession = {
      sessionId: "mock-sess-earlier",
      title: "远程网关轮询间隔",
      cwd: CWD,
      createdAt: iso(1000 * 60 * 60 * 26),
      modified: iso(1000 * 60 * 42),
      provider: "mock",
      modelId: "kova-demo-1",
      thinkingLevel: "medium",
      seq: 0,
      eventSeq: 0,
      running: false,
      currentRequestId: null,
      queue: [],
      messages: [
        {
          role: "user",
          content: "网关断线重连现在是多久一次？",
          timestamp: Date.now() - 1000 * 60 * 45,
          __seq: 1,
        },
        assistantMessage(
          [
            {
              type: "text",
              text: "指数退避：1s 起步，每次 ×1.6，封顶 15s。连上 authed 之后立刻拉一轮快照自愈，所以断线期间桌面端跑完的轮次不会丢。\n\n重连参数在 `pi-ws-channel.ts` 的 `backoff()` 里，要改宽隆窗口改那一个常量就行。",
            },
          ],
          "stop",
        ),
      ],
    };
    earlier.messages[1] = { ...earlier.messages[1], __seq: 2 } as PiAssistantMessage;
    earlier.seq = 2;
    this.sessions.set(earlier.sessionId, earlier);

    const fresh: MockSession = {
      sessionId: "mock-sess-fresh",
      title: "新对话",
      cwd: CWD_ALT,
      createdAt: iso(1000 * 60 * 5),
      modified: iso(1000 * 60 * 5),
      provider: "mock",
      modelId: "kova-demo-1",
      thinkingLevel: "off",
      seq: 0,
      eventSeq: 0,
      running: false,
      currentRequestId: null,
      queue: [],
      messages: [],
    };
    this.sessions.set(fresh.sessionId, fresh);
  }

  dispose(): void {
    this.disposed = true;
    this.lineSink = null;
    this.generationCb = null;
  }

  // ---------- 原始行 ----------

  private emit(session: MockSession, event: Record<string, unknown>): void {
    session.eventSeq += 1;
    this.lineSink?.(
      JSON.stringify({
        type: "thread_event",
        sessionId: session.sessionId,
        eventSeq: session.eventSeq,
        event,
      }),
    );
  }

  private emitFinish(sessionId: string, requestId: string): void {
    this.lineSink?.(JSON.stringify({ id: requestId, chunk: { type: "finish" } }));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------- 流式脚本 ----------

  private async runTurn(
    session: MockSession,
    prompt: string,
    hasImage: boolean,
    requestId: string,
  ): Promise<void> {
    const userSeq = ++session.seq;
    session.messages.push({
      role: "user",
      content: prompt,
      timestamp: Date.now(),
      __seq: userSeq,
    });
    session.running = true;
    session.currentRequestId = requestId;
    this.abortedFor = null;
    if (session.messages.length <= 1) {
      // 首条消息派生标题（sidecar 同款行为），thread_event 透传让顶栏跟变
      session.title = prompt.slice(0, 24) || "新对话";
      this.emit(session, { type: "session_info_changed", name: session.title });
    }

    this.emit(session, { type: "agent_start" });

    // ---- 思考块 ----
    const thinkPartial = () => assistantMessage([{ type: "thinking", thinking: "" }]);
    this.emit(session, {
      type: "message_start",
      message: thinkPartial(),
    });
    this.emit(session, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    const thought =
      "先判断意图：这条更像是要我核对上一轮的改动结论，不是要动代码。" +
      "组织一个带结论、建议、代码示例的回答。";
    for (const piece of thought.match(/[\s\S]{1,14}/g) ?? []) {
      if (this.stopped(session)) return this.finishAborted(session);
      this.emit(session, {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: piece },
      });
      await this.sleep(TICK_MS);
    }
    this.emit(session, {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: thought,
      },
    });

    // ---- 工具调用（只有首条消息带，模拟"先看一眼文件再答"） ----
    if (session.messages.length <= 2) {
      const toolCall = {
        type: "toolCall" as const,
        id: `tool-${session.eventSeq}`,
        name: "read",
        arguments: { path: "apps/desktop/lib/pi/pi-channel.ts" },
      };
      this.emit(session, {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, toolCall },
      });
      const argsJson = JSON.stringify(toolCall.arguments);
      for (const piece of argsJson.match(/[\s\S]{1,10}/g) ?? []) {
        if (this.stopped(session)) return this.finishAborted(session);
        this.emit(session, {
          type: "message_update",
          assistantMessageEvent: {
            type: "toolcall_delta",
            contentIndex: 1,
            delta: piece,
          },
        });
        await this.sleep(TICK_MS);
      }
      this.emit(session, {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall },
      });
      await this.sleep(TOOL_MS / 2);
      if (this.stopped(session)) return this.finishAborted(session);

      const toolMsg: PiTranscriptMessage = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: TOOL_OUTPUT }],
        isError: false,
        timestamp: Date.now(),
      };
      // 落盘与收尾对齐真链路：带工具调用的 assistant 行（thinking + toolCall）先落并
      // 收尾，toolResult 行随后落并收尾。此前只发一条**空内容**的 assistant message_end，
      // 直播投影因此看不到工具 part——轮次折叠判不出「本轮有过程」，脚本跑完摘要行不出现；
      // 转录里也缺这条调用行，冷读与直播两副面孔（2026-10-04 实测发现）。
      const callRow = {
        ...assistantMessage([{ type: "thinking", thinking: thought }, toolCall]),
        __seq: ++session.seq,
      };
      session.messages.push(callRow);
      this.emit(session, { type: "message_end", message: callRow });
      const toolRow = { ...toolMsg, __seq: ++session.seq };
      session.messages.push(toolRow);
      this.emit(session, { type: "message_end", message: toolRow });

      this.emit(session, {
        type: "tool_execution_start",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: toolCall.arguments,
      });
      await this.sleep(TOOL_MS / 2);
      if (this.stopped(session)) return this.finishAborted(session);
      this.emit(session, {
        type: "tool_execution_end",
        toolCallId: toolCall.id,
        result: { output: TOOL_OUTPUT },
        isError: false,
      });
    }

    // ---- 正文：独立的一条 assistant 消息（基座的流式台账在 message_end 已清，
    // 不重发 message_start 的话 text_delta 会被当孤儿丢掉）----
    const text = hasImage ? REPLY_IMAGE : this.pickReply(session);
    this.emit(session, {
      type: "message_start",
      message: assistantMessage([{ type: "text", text: "" }]),
    });
    this.emit(session, {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    // [\s\S] 而不是 .{1,6}：. 不匹配换行（缺 s 旗标），用它会把手稿里所有
    // \n 吞掉——流式期间整篇没有换行，marked 只能 lex 成一个大段落，
    // 标题/表格/代码围栏全是字面文本，message_end 才恢复正常。
    for (const piece of text.match(/[\s\S]{1,6}/g) ?? []) {
      if (this.stopped(session)) return this.finishAborted(session);
      this.emit(session, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: piece },
      });
      await this.sleep(TICK_MS);
    }
    const final = assistantMessage([{ type: "text", text }]);
    const finalSeq = ++session.seq;
    session.messages.push({ ...final, __seq: finalSeq });
    this.emit(session, { type: "message_end", message: final });
    this.emit(session, { type: "agent_end", stopReason: "stop" });
    session.running = false;
    session.currentRequestId = null;
    session.modified = iso(0);
  }

  private stopped(session: MockSession): boolean {
    return this.disposed || this.abortedFor === session.sessionId;
  }

  private finishAborted(session: MockSession): void {
    session.running = false;
    session.currentRequestId = null;
    const seq = ++session.seq;
    session.messages.push({
      ...assistantMessage([], "aborted"),
      __seq: seq,
    } as PiTranscriptMessage);
    this.emit(session, { type: "agent_end", stopReason: "aborted" });
  }

  /** 轮次接力：队列里还有就走下一轮 */
  private pump(session: MockSession): void {
    const next = session.queue.shift();
    if (!next || this.disposed) return;
    setTimeout(() => {
      if (this.disposed) return;
      void this.runTurn(session, next.content, false, next.id).then(() => {
        this.emitFinish(session.sessionId, next.id);
        if (session.queue.length) this.pump(session);
      });
    }, NEXT_TURN_MS);
  }

  private pickReply(session: MockSession): string {
    const turns = session.messages.filter((m) => m.role === "user").length;
    return turns % 2 === 1 ? REPLY_RICH : REPLY_SHORT;
  }

  // ---------- 快照 ----------

  private snapshot(session: MockSession): PiThreadSnapshot {
    return {
      metadata: {
        id: session.sessionId,
        title: session.title,
        workspacePath: session.cwd,
        status: session.running ? "running" : "idle",
        config: {
          provider: session.provider,
          modelId: session.modelId,
          thinkingLevel: session.thinkingLevel,
        },
        queuedMessages: session.queue.map((q) => ({
          id: q.id,
          mode: q.mode,
          content: q.content,
        })),
        contextUsage: {
          tokens: 11_600,
          contextWindow: 200_000,
          percent: 5.8,
        },
        messageCount: session.messages.length,
        createdAt: session.createdAt,
        updatedAt: session.modified,
      },
      messages: session.messages,
      seq: session.seq,
    };
  }

  // ---------- PiClientTransport ----------

  async request<T>(payload: Record<string, unknown>): Promise<T> {
    const type = String(payload.type ?? "");
    const byId = (id: unknown) =>
      typeof id === "string" ? this.sessions.get(id) : undefined;
    switch (type) {
      case "list_sessions":
        return {
          type: "sessions",
          sessions: [...this.sessions.values()].map((s) => ({
            sessionId: s.sessionId,
            name: s.title,
            firstMessage:
              (s.messages[0] as { content?: string } | undefined)?.content ?? "",
            messageCount: s.messages.length,
            modified: s.modified,
            cwd: s.cwd,
            modelProvider: s.provider,
            modelId: s.modelId,
            thinkingLevel: s.thinkingLevel,
          })),
        } as T;
      case "list_running":
        return {
          type: "running",
          sessionIds: [...this.sessions.values()]
            .filter((s) => s.running)
            .map((s) => s.sessionId),
        } as T;
      case "new_session": {
        const session: MockSession = {
          sessionId: `mock-sess-${Date.now().toString(36)}`,
          title: "新对话",
          cwd: typeof payload.cwd === "string" && payload.cwd ? payload.cwd : CWD,
          createdAt: iso(0),
          modified: iso(0),
          provider: "mock",
          modelId: "kova-demo-1",
          thinkingLevel: "off",
          seq: 0,
          eventSeq: 0,
          running: false,
          currentRequestId: null,
          queue: [],
          messages: [],
        };
        this.sessions.set(session.sessionId, session);
        return { type: "session", sessionId: session.sessionId, threadId: session.sessionId } as T;
      }
      case "thread_snapshot": {
        const session = byId(payload.sessionId);
        if (!session) throw new Error("mock: session not found");
        return { type: "thread_snapshot", snapshot: this.snapshot(session) } as T;
      }
      case "list_pending":
        return { type: "pending", items: [] } as T;
      case "list_models":
        return {
          type: "models",
          models: [
            {
              provider: "mock",
              providerName: "Mock",
              id: "kova-demo-1",
              name: "Kova Demo（演示模型）",
              reasoning: true,
              supportedThinkingLevels: ["low", "medium", "high"],
              contextWindow: 200_000,
              input: ["text", "image"],
              authed: true,
            },
          ],
          providers: [{ id: "mock", name: "Mock", authed: true }],
        } as T;
      case "set_model": {
        const session = byId(payload.sessionId);
        if (session && typeof payload.modelId === "string") {
          session.modelId = payload.modelId;
          session.provider = String(payload.provider ?? session.provider);
        }
        return { type: "model", provider: String(payload.provider ?? ""), modelId: String(payload.modelId ?? "") } as T;
      }
      case "set_thinking": {
        const session = byId(payload.sessionId);
        if (session) session.thinkingLevel = String(payload.level ?? "off");
        return { type: "thinking", level: String(payload.level ?? "off") } as T;
      }
      case "rename_session": {
        const session = byId(payload.sessionId);
        if (session && typeof payload.name === "string") session.title = payload.name;
        return { type: "renamed" } as T;
      }
      case "delete_session":
        this.sessions.delete(String(payload.sessionId ?? ""));
        return { type: "deleted" } as T;
      case "archive_session":
        return { type: "archived" } as T;
      case "truncate_session": {
        const session = byId(payload.sessionId);
        if (session) {
          const beforeSeq = Number(payload.beforeSeq ?? 0);
          session.messages = session.messages.filter((m) => {
            const lineSeq = (m as { __seq?: number }).__seq;
            return lineSeq === undefined || lineSeq < beforeSeq;
          });
          session.seq = Math.min(session.seq, Math.max(0, beforeSeq - 1));
        }
        return { removed: 1 } as T;
      }
      // 逐项撤销（队列条上的「撤销」）：真链路由 sidecar queue_cancel(按 requestId
      // 删项)实现，mock 这里同语义——此前落到 default 的 {type:"ok"} 假成功，
      // 演示里点撤销看着没反应、轮末还会把条目泵回来（2026-10-04 实测对齐）。
      case "queue_cancel": {
        const requestId = String(payload.requestId ?? "");
        for (const session of this.sessions.values()) {
          const index = session.queue.findIndex((q) => q.id === requestId);
          if (index < 0) continue;
          session.queue.splice(index, 1);
          this.emit(session, {
            type: "queue_update",
            steering: session.queue.filter((q) => q.mode === "steer"),
            followUp: session.queue.filter((q) => q.mode === "followUp"),
          });
          return { type: "queue_cancelled", requestId } as T;
        }
        throw new Error(`no queued prompt: ${requestId}`);
      }
      case "queue_clear": {
        const session = byId(payload.threadId);
        const cleared = session?.queue.map((q) => q.content) ?? [];
        if (session) {
          session.queue = [];
          this.emit(session, { type: "queue_update", steering: [], followUp: [] });
        }
        return { type: "ok", cleared } as T;
      }
      case "tool_confirm":
        return { type: "ok" } as T;
      default:
        // 未覆盖的管理命令在 mock 里一律成功：字段对不上时基座侧也只是忽略
        return { type: "ok" } as T;
    }
  }

  async sendPrompt(args: {
    requestId: string;
    text: string;
    threadId: string;
    cwd: string | null;
    attachments: PiPromptAttachment[] | null;
    steer: boolean;
  }): Promise<void> {
    const session = this.sessions.get(args.threadId);
    if (!session) return;
    const hasImage = !!args.attachments?.length;

    if (session.running) {
      // 运行中再发送：排队（followUp / steer 都先入列，轮末自动接力）。
      // queue_update 事件让侧栏/输入框上方的队列条立即出现。
      session.queue.push({
        id: args.requestId,
        mode: args.steer ? "steer" : "followUp",
        content: args.text,
      });
      this.emit(session, {
        type: "queue_update",
        steering: session.queue.filter((q) => q.mode === "steer"),
        followUp: session.queue.filter((q) => q.mode === "followUp"),
      });
      return;
    }

    void this.runTurn(session, args.text, hasImage, args.requestId).then(() => {
      // finish chunk 帧：基座靠它把 inflight 台账收掉并强制刷快照——
      // agent_end 事件只改运行态，不触发这条权威刷新
      this.emitFinish(session.sessionId, args.requestId);
      if (session.queue.length) this.pump(session);
    });
  }

  async abort(threadId: string): Promise<void> {
    this.abortedFor = threadId;
  }

  async watchLines(cb: (raw: string) => void): Promise<() => void> {
    this.lineSink = cb;
    return () => {
      if (this.lineSink === cb) this.lineSink = null;
    };
  }

  async watchGeneration(cb: () => void): Promise<() => void> {
    // mock 没有事件源换代；保留退订形状与真实通道一致
    this.generationCb = cb;
    return () => {
      if (this.generationCb === cb) this.generationCb = null;
    };
  }
}

/**
 * Mock 通道适配：会话偏好/模型选择等管理模块走的是模块级通道表
 * （setPiChannel/getPiChannel，PiChannel 接口），与 PiClientBase 的传输是两条
 * 并行的入口。mock 模式下两者指向同一个 MockPiTransport，偏好切换才有响应。
 */
export function createMockPiChannel(transport: MockPiTransport): import("@/lib/pi/pi-channel").PiChannel {
  return {
    kind: "ws",
    request: (payload) => transport.request(payload),
    abort: (threadId) => transport.abort(threadId ?? ""),
    close: () => transport.dispose(),
    onStatusChange: () => () => {},
  };
}

/** Mock 客户端：与 WsPiClient 同一基座，换传输实现 */
export class MockPiClient extends PiClientBase {
  private readonly mock: MockPiTransport;
  private channelAdapter: import("@/lib/pi/pi-channel").PiChannel | null = null;

  constructor() {
    const t = new MockPiTransport();
    super(t);
    this.mock = t;
  }

  /** 模块级通道表（piRequest 型模块）用的入口；缓存保证身份稳定 */
  get channel(): import("@/lib/pi/pi-channel").PiChannel {
    this.channelAdapter ??= createMockPiChannel(this.mock);
    return this.channelAdapter;
  }

  dispose(): void {
    this.mock.dispose();
  }
}
