// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/types.ts（runtime/ 子目录对应上游 src/runtime/）

/**
 * RPC-isomorphic, JSON-safe contract between assistant-ui and Pi.
 *
 * This module is **browser-safe**: it MUST NOT import `@earendil-works/pi-*`.
 * The Pi message/content/event shapes are mirrored here as plain serializable
 * types so they can travel over an arbitrary transport (HTTP/SSE, RPC
 * subprocess, Electron IPC). The shapes are kept structurally faithful to
 * Pi `0.78`–`0.80` so the node host (`./node`) can assign real Pi values into them
 * without conversion.
 *
 * Provenance (verified against `@earendil-works/pi-coding-agent` 0.78.0,
 * 0.79.0, 0.79.10, and 0.80.7):
 * - content/message shapes: `@earendil-works/pi-ai/dist/types.d.ts`
 * - custom message roles:    `pi-coding-agent/dist/core/messages.d.ts`
 * - agent/session events:    `pi-agent-core/dist/types.d.ts` (`AgentEvent`),
 *                            `pi-coding-agent/dist/core/agent-session.d.ts`
 *                            (`AgentSessionEvent`)
 * - host UI surface:         `pi-coding-agent/dist/core/extensions/types.d.ts`
 *                            (`ExtensionUIContext`, `ContextUsage`)
 */

// ---------------------------------------------------------------------------
// Content parts — mirror of `@earendil-works/pi-ai` content blocks.
// ---------------------------------------------------------------------------

import type { QueueAttachment } from "pi-protocol";

export interface PiTextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  /** When true, the thinking content was redacted by safety filters; the opaque
   * payload lives in `thinkingSignature`. Render a "redacted" affordance rather
   * than hiding silently. */
  redacted?: boolean;
}

export interface PiImageContent {
  type: "image";
  /** Base64-encoded image data (or data URL), per Pi `ImageContent`. */
  data: string;
  mimeType: string;
}

export interface PiToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export type PiAssistantContent = PiTextContent | PiThinkingContent | PiToolCall;
export type PiUserContent = PiTextContent | PiImageContent;
export type PiToolResultContent = PiTextContent | PiImageContent;

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type PiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// ---------------------------------------------------------------------------
// Messages — mirror of the base LLM `Message` union plus Pi's
// `CustomAgentMessages` augmentation (bashExecution/custom/branchSummary/
// compactionSummary). The union is intentionally *open*: Pi augments it via
// module augmentation, so the projection/reducer must tolerate unknown roles.
// ---------------------------------------------------------------------------

export interface PiUserMessage {
  role: "user";
  content: string | PiUserContent[];
  timestamp: number;
  /** 本地改动（稳定消息 id）：sidecar 快照透传的转录行 seq（per-session 单调
   *  水位）；在飞 partial 未落盘没有 seq。投影据此生成不漂移的消息 id。 */
  __seq?: number;
  /** 本地改动（稳定消息 id）：前端乐观用户消息的自生成 id（`pi-optimistic:${n}`），
   *  与转录投影的 `pi-msg:${seq}` 永不碰撞；真实行落盘后乐观消息即被确认清除。 */
  __optimisticId?: string;
}

export interface PiAssistantMessage {
  role: "assistant";
  content: PiAssistantContent[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  usage: PiUsage;
  stopReason: PiStopReason;
  errorMessage?: string;
  timestamp: number;
  /** 本地改动（稳定消息 id）：见 PiUserMessage.__seq */
  __seq?: number;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  /** Renderable output content (text/image). NOTE: this is the output, NOT
   * `details` — `details` is tool-specific metadata (see `PiToolResultDetails`). */
  content: PiToolResultContent[];
  details?: unknown;
  /** Usage from the tool execution itself (e.g. image generation tokens). */
  usage?: PiUsage;
  /** Milliseconds the tool's execute() took; absent for legacy results. */
  durationMs?: number;
  isError: boolean;
  timestamp: number;
  /** 本地改动（稳定消息 id）：见 PiUserMessage.__seq */
  __seq?: number;
}

/** Bash run via the `!` command — a Pi message role, not a tool call. */
export interface PiBashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  /** `!!` prefix — excluded from LLM context. */
  excludeFromContext?: boolean;
  /** 本地改动（稳定消息 id）：见 PiUserMessage.__seq */
  __seq?: number;
}

/** Extension-injected message via `sendMessage()`. */
export interface PiCustomMessage {
  role: "custom";
  customType: string;
  content: string | PiUserContent[];
  /** When false, participates in LLM context but is hidden in the UI. */
  display: boolean;
  details?: unknown;
  timestamp: number;
  /** 本地改动（稳定消息 id）：见 PiUserMessage.__seq */
  __seq?: number;
}

export interface PiBranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
  /** 本地改动（稳定消息 id）：见 PiUserMessage.__seq */
  __seq?: number;
}

export interface PiCompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  /** 本地改动（快照分隔线保真）：sidecar 从检查点行 details 推出后带上，
   *  与 get_history 的 data-compaction part 载荷同口径 */
  generation?: number;
  summarized?: boolean;
  /** 检查点来源（加性）：handoff = 从上一会话交接的初始上下文。前端据此把
   *  分隔线渲染成交接卡，而不是「上下文已压缩」 */
  strategy?: "summary" | "fresh_window" | "handoff";
  /** strategy=handoff 的来源会话（交接时刻的标题快照） */
  handoffFrom?: { sessionId: string; title: string };
  timestamp: number;
  /** 本地改动（稳定消息 id）：见 PiUserMessage.__seq */
  __seq?: number;
}

/** 本地改动（模型切换分隔线）：sidecar 把转录 model_change 设定行按 seq 锚点
 *  重建进快照消息流。设定行本身不占 seq，用文件序 `__stableId` 做稳定消息 id；
 *  provider/modelId 是切换后的模型，name 取目录（模型已删时缺省）。 */
export interface PiModelChangeMessage {
  role: "modelChange";
  provider: string;
  modelId: string;
  name?: string;
  timestamp: number;
  /** 本地改动（稳定消息 id）：转录中切换事件的文件序 */
  __stableId?: string;
}

export type PiKnownAgentMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiBashExecutionMessage
  | PiCustomMessage
  | PiBranchSummaryMessage
  | PiCompactionSummaryMessage
  | PiModelChangeMessage;

/** Forward-compat fallback for augmented/unknown roles. */
export interface PiUnknownAgentMessage {
  role: string;
  timestamp?: number;
  [key: string]: unknown;
}

export type PiAgentMessage = PiKnownAgentMessage | PiUnknownAgentMessage;

export type PiTranscriptMessage = PiAgentMessage;

// ---------------------------------------------------------------------------
// Session entries — mirror of Pi's persisted SessionEntry union.
// ---------------------------------------------------------------------------

type PiSessionEntryBase = {
  id: string;
  parentId: string | null;
  timestamp: string;
};

export type PiSessionEntry =
  | (PiSessionEntryBase & {
      type: "message";
      message: PiAgentMessage;
    })
  | (PiSessionEntryBase & {
      type: "thinking_level_change";
      thinkingLevel: string;
    })
  | (PiSessionEntryBase & {
      type: "model_change";
      provider: string;
      modelId: string;
    })
  | (PiSessionEntryBase & {
      type: "compaction";
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      details?: unknown;
      fromHook?: boolean;
    })
  | (PiSessionEntryBase & {
      type: "branch_summary";
      fromId: string;
      summary: string;
      details?: unknown;
      fromHook?: boolean;
    })
  | (PiSessionEntryBase & {
      type: "custom";
      customType: string;
      data?: unknown;
    })
  | (PiSessionEntryBase & {
      type: "custom_message";
      customType: string;
      content: string | (PiTextContent | PiImageContent)[];
      details?: unknown;
      display: boolean;
    })
  | (PiSessionEntryBase & {
      type: "label";
      targetId: string;
      label?: string | undefined;
    })
  | (PiSessionEntryBase & {
      type: "session_info";
      name?: string;
    });

export interface PiUnknownSessionEntry extends PiSessionEntryBase {
  type: string;
  [key: string]: unknown;
}

export type PiAnySessionEntry = PiSessionEntry | PiUnknownSessionEntry;

const KNOWN_PI_SESSION_ENTRY_TYPES = {
  message: true,
  thinking_level_change: true,
  model_change: true,
  compaction: true,
  branch_summary: true,
  custom: true,
  custom_message: true,
  label: true,
  session_info: true,
} satisfies Record<PiSessionEntry["type"], true>;

export const isKnownPiSessionEntry = (
  entry: PiAnySessionEntry,
): entry is PiSessionEntry =>
  Object.prototype.hasOwnProperty.call(
    KNOWN_PI_SESSION_ENTRY_TYPES,
    entry.type,
  );

// ---------------------------------------------------------------------------
// Streaming delta — mirror of `AssistantMessageEvent` (the `contentIndex`
// structural discriminator). Every variant carries `partial`, the current
// assistant message, so the projection can read `partial.content[contentIndex]`
// instead of re-accumulating text.
// ---------------------------------------------------------------------------

export type PiAssistantMessageDelta =
  | { type: "start"; partial: PiAssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: PiAssistantMessage }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: PiAssistantMessage;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content: string;
      partial: PiAssistantMessage;
    }
  | {
      type: "thinking_start";
      contentIndex: number;
      partial: PiAssistantMessage;
    }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      partial: PiAssistantMessage;
    }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: string;
      partial: PiAssistantMessage;
    }
  | {
      type: "toolcall_start";
      contentIndex: number;
      partial: PiAssistantMessage;
    }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: PiAssistantMessage;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: PiToolCall;
      partial: PiAssistantMessage;
    }
  | {
      type: "done";
      reason: "stop" | "length" | "toolUse";
      message: PiAssistantMessage;
    }
  | { type: "error"; reason: "aborted" | "error"; error: PiAssistantMessage };

// ---------------------------------------------------------------------------
// Context-window usage — mirror of `ContextUsage`. `tokens`/`percent` are
// nullable (e.g. right after compaction, before the next LLM response).
// ---------------------------------------------------------------------------

export interface PiContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

// ---------------------------------------------------------------------------
// Model / credential readiness.
// ---------------------------------------------------------------------------

export type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type PiModelInfo = {
  provider: string;
  modelId: string;
  name?: string;
  supportsThinking?: boolean;
  availableThinkingLevels?: readonly PiThinkingLevel[];
};

export type PiRuntimeReadiness =
  | {
      state: "ready";
      selection: { provider: string; modelId: string };
      source: "env" | "session" | "pi-default";
    }
  | { state: "missing-model"; message: string }
  | { state: "missing-credentials"; provider?: string; message: string }
  | {
      state: "unavailable-model";
      selection: { provider: string; modelId: string };
      message: string;
    };

// ---------------------------------------------------------------------------
// Thread metadata & input.
// ---------------------------------------------------------------------------

export type PiThreadStatus = "idle" | "running" | "failed";

export type PiQueuedMessage = {
  id: string;
  mode: "followUp" | "steer";
  content: string;
  /** 排队时随帧下发的图片附件（协议形状 { name, mimeType, data | path }）：
   *  快照恢复/队列条缩略图/接力泵重发都靠它——此前快照只带文本，刷新后图片丢 */
  attachments?: readonly QueueAttachment[];
};

/** 改动（4a）：队列条目带稳定 id + 文本。上游 queue_update/队列状态只携带
 *  内容字符串（逐项操作无从寻址），我们以真实 reqId 为 id 支撑逐项
 *  取消/并入/立即发送与「队列条目 id = 真实 reqId」约束。 */
export type PiQueueEntry = {
  id: string;
  content: string;
  /** 原载荷图片附件（协议形状，与 prompt 帧 attachments 同形：粘贴/网页端带
   *  data 裸 base64，dialog 路径直选带 path）——接力泵直发重发/队列条缩略图用，
   *  可选：旧 sidecar/快照行不带。文档类附件不入队（sidecar 落盘后折算说明行） */
  attachments?: readonly QueueAttachment[];
};

/** 整队清空回执：文本数组保留（旧调用面）+ 完整条目载荷（停止生成回填
 *  输入框：文本与图片都还原，见 ThreadController.drainQueueForStop）。 */
export type PiClearedQueue = {
  steering: string[];
  followUp: string[];
  items: PiQueueEntry[];
};

/** 每轮权威工时（sidecar 转录 turn_timing 行的快照投影）。
 *  anchorSeq = 本轮首条 user 消息行的转录 seq：前端投影 id 为 `pi-msg:${seq}`，
 *  与轮次键同值；endedAt 缺失 = 该轮仍在进行（当前实现只下发已收尾的轮）。 */
export type PiTurnTiming = {
  anchorSeq: number;
  startedAt: number;
  /** 首个 assistant 内容到达时刻：前端耗时起点；缺省/旧记录回落到 startedAt */
  firstResponseAt?: number;
  endedAt?: number;
  /** Stop / 「立即发送」中止的轮 */
  interrupted?: boolean;
};

export type PiThreadMetadata = {
  id: string;
  title?: string;
  workspacePath?: string;
  archived?: boolean;
  status: PiThreadStatus;
  compactionActive?: boolean;
  retryActive?: boolean;
  retryAttempt?: number;
  runningRunId?: string;
  queuedMessages?: readonly PiQueuedMessage[];
  /** 队列暂停位（v3.1）：快照权威携带，前端重建 state.queue.paused 用；
   *  缺省/部分窗口 = 未暂停 */
  queuePaused?: boolean;
  /** 每轮权威工时（按分页窗过滤）：前端据此覆盖本地推导，缺失时回落到时间戳 */
  turnTimings?: readonly PiTurnTiming[];
  config?: {
    provider?: string;
    modelId?: string;
    thinkingLevel?: PiThinkingLevel | string;
  };
  contextUsage?: PiContextUsage;
  /** Session .jsonl path — the durable handle (`SessionInfo.path`). */
  sessionFile?: string;
  /** Fork lineage across session files (`SessionInfo.parentSessionPath`). */
  parentSessionPath?: string;
  messageCount?: number;
  createdAt?: string;
  updatedAt?: string;
};

/** Image attachment passthrough — mirror of Pi `ImageContent`. */
export type PiInputAttachment = PiImageContent;

/** Composer file-part passthrough（迁移缺口：buildPiSendInput 原本丢弃 file
 *  parts，对话框直选的图片/文档全丢）。`data` 沿用 assistant-ui FileMessagePart
 *  语义：URL（file:///data:/http(s)/blob:）或裸 base64，由客户端转协议附件。 */
export type PiInputFilePart = {
  data: string;
  mimeType: string;
  filename?: string;
};

export type PiSendMessageInput = {
  content: string;
  attachments?: PiInputAttachment[];
  /** file parts（文档附件 + 对话框直选图片）：桌面客户端合成消息复用
   *  extractPromptAttachments 解析为协议附件（path/data 载荷）后再下发。 */
  files?: PiInputFilePart[];
  /** REQUIRED while the thread is running. Pi `prompt()` throws otherwise. */
  streamingBehavior?: "followUp" | "steer";
  /** 调用方预生成的请求 id（队列条目 id = 真实 reqId 的落点）：控制器为
   *  乐观队列条目先起 id 再随帧下发，客户端见值照用、缺省自造。 */
  requestId?: string;
};

// ---------------------------------------------------------------------------
// Host UI requests — Pi's entire human-in-the-loop / approval surface
// (`ExtensionUIContext.confirm/select/input/editor`). These carry NO
// `toolCallId` from Pi; the supervisor may set `toolCallId` only when exactly
// one tool is executing (single-tool causality). Never guess from titles.
// ---------------------------------------------------------------------------

export type PiHostUiRequestKind = "confirm" | "select" | "input" | "editor";

export type PiHostUiRequest =
  | {
      id: string;
      kind: "confirm";
      title: string;
      message: string;
      toolCallId?: string;
      timeoutMs?: number;
    }
  | {
      id: string;
      kind: "select";
      title: string;
      options: readonly string[];
      toolCallId?: string;
      timeoutMs?: number;
    }
  | {
      id: string;
      kind: "input";
      title: string;
      placeholder?: string;
      toolCallId?: string;
      timeoutMs?: number;
    }
  | {
      id: string;
      kind: "editor";
      title: string;
      prefill?: string;
      toolCallId?: string;
      timeoutMs?: number;
    };

// Verified Pi return-type semantics (extensions/types.d.ts):
//   confirm → Promise<boolean>                (cancel/timeout = false = deny;
//                                              there is NO "cancelled" channel)
//   select / input / editor → Promise<string | undefined>  (undefined = dismissed)
export type PiHostUiResponse =
  | { requestId: string; confirmed: boolean }
  | { requestId: string; value: string }
  | { requestId: string; dismissed: true };

// ---------------------------------------------------------------------------
// Event model — isomorphic to Pi's `AgentSessionEvent` (= base `AgentEvent`
// plus session additions), with a `snapshot` framing event and host-UI events.
//
// Corrections vs. an idealized model, verified against the real `.d.ts`:
// - Base `turn_start`/`turn_end` carry NO `turnIndex`; the supervisor derives
//   and stamps `turnIndex` by counting `turn_start`s (used for `pi-turn:N`
//   step ids in projection).
// - `agent_end` carries `willRetry`.
// - The union is open: unknown event types must be stored, not thrown.
//
// Every event is wrapped with a `{ threadId, seq }` envelope by the supervisor.
// ---------------------------------------------------------------------------

export type PiClientEventBody =
  | { type: "snapshot"; snapshot: PiThreadSnapshot }
  | { type: "agent_start" }
  // 本地改动（完成提醒缺口3）：sidecar agent_end 随帧带收尾定调字段
  | {
      type: "agent_end";
      willRetry?: boolean;
      stopReason?: string;
      errorMessage?: string;
    }
  | { type: "agent_settled" }
  | { type: "turn_start"; turnIndex: number }
  | { type: "turn_end"; turnIndex: number }
  | { type: "message_start"; message: PiAgentMessage }
  | {
      type: "message_update";
      message: PiAgentMessage;
      assistantMessageEvent: PiAssistantMessageDelta;
    }
  | { type: "message_end"; message: PiAgentMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName?: string;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      result: unknown;
      isError: boolean;
      /** Milliseconds the tool's execute() took (pi-agent-core 1.1+). */
      durationMs?: number;
    }
  | {
      // 改动（4a）：条目形状从内容字符串升级为 PiQueueEntry（id + 文本），
      // 与 sidecar queue_update 载荷、快照 queuedMessages 重建对齐
      // 改动（v3.1）：paused = 队列暂停位透传（缺省视为未暂停）
      type: "queue_update";
      steering: readonly PiQueueEntry[];
      followUp: readonly PiQueueEntry[];
      paused?: boolean;
    }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; aborted: boolean; willRetry: boolean }
  | { type: "entry_appended"; entry: PiAnySessionEntry }
  | { type: "auto_retry_start"; attempt: number; delayMs: number }
  | { type: "auto_retry_end"; success: boolean }
  | { type: "session_info_changed"; name?: string }
  | { type: "thinking_level_changed"; level: string }
  | { type: "context_usage"; contextUsage: PiContextUsage }
  | { type: "extension_ui_request"; request: PiHostUiRequest }
  | { type: "extension_ui_resolved"; requestId: string }
  | { type: "error"; error: string };

/**
 * Forward-compatible fallback for augmented/unknown event types. The transport
 * delivers these cast as `PiClientEvent`; the reducer's `default` branch stores
 * the seq and otherwise ignores them (the controller decides whether to
 * full-refresh). Kept out of `PiClientEventBody` so the known union still
 * narrows by `type` in the reducer switch.
 */
export type PiUnknownClientEventBody = {
  type: string;
  [key: string]: unknown;
};

export type PiClientEventEnvelope = {
  threadId: string;
  /** Monotonic per-thread sequence for ordering/dedup. */
  seq: number;
};

export type PiClientEvent = PiClientEventBody & PiClientEventEnvelope;

/** Open variant used at the transport boundary (subscribe/SSE decode). */
export type PiAnyClientEvent =
  | PiClientEvent
  | (PiUnknownClientEventBody & PiClientEventEnvelope);

// ---------------------------------------------------------------------------
// Snapshot & client contract.
// ---------------------------------------------------------------------------

export type PiThreadSnapshot = {
  metadata: PiThreadMetadata;
  messages: PiTranscriptMessage[];
  /** Pending blocking host-UI requests (survive reconnect — tracked on the
   * supervisor record, not the connection). */
  hostUiRequests?: readonly PiHostUiRequest[];
  readiness?: PiRuntimeReadiness;
  /** Per-thread seq this snapshot reflects. A response fetched over HTTP can
   * resolve after live events it predates, so the reducer needs it to tell a
   * superseded snapshot from a current one. Absent on cold reads. */
  seq?: number;
  /** Last surfaced runtime/session error, if any. */
  lastError?: string;
  /** 分页窗元数据（§6，移动端无限上翻）：本窗首/末行的转录 seq。
   *  全量请求（不带 tail/beforeSeq）也有值；hasMore 描述本窗之前是否还有更早行。 */
  firstSeq?: number;
  lastSeq?: number;
  hasMore?: boolean;
};

export interface PiClient {
  listThreads(input?: {
    workspacePath?: string;
    includeArchived?: boolean;
  }): Promise<PiThreadMetadata[]>;
  /** §6 会话列表分页：limit/offset 窗口 + nextOffset 游标（会话列表无限下滑）。
   *  可选——不实现时调用方退回全量 listThreads。单条摘要补齐走 pi-bridge 的
   *  session_summary（见 pi-thread-adapter.ensureSessionSummary），不进本契约。 */
  listThreadsPage?(input?: {
    workspacePath?: string;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ threads: PiThreadMetadata[]; nextOffset?: number }>;
  createThread(input?: {
    workspacePath?: string;
    title?: string;
    initialMessage?: PiSendMessageInput;
    /** 界面当前显示/选择的模型：建会话时随 new_session 带过去，sidecar 以它为
     *  会话初始模型（校验可用后钉进偏好列）。不传 = 由 sidecar 按自己的
     *  lastUsed → 默认链解析——缓存与界面不同步时首轮会用另一个模型应答
     *  （「发送前显示 A、发送后变 B」即此）。 */
    model?: { provider: string; modelId: string };
  }): Promise<PiThreadSnapshot>;
  /** input.tail = 尾窗行数（§6 分页；缺省全量，旧端不破）。移动端冷读传尾窗，
   *  更早的行由 getThreadPage 逐页上翻。桌面端忽略该参数（全量读）。 */
  getThread(
    threadId: string,
    input?: { tail?: number },
  ): Promise<PiThreadSnapshot>;
  /** 分页窗拉取（移动端无限上翻，§6）：beforeSeq = 当前已加载的最早行 seq，
   *  返回该游标之前的旧页（首末 seq/hasMore 随快照带）。可选——旧端不实现时
   *  调用方退回全量 getThread。 */
  getThreadPage?(
    threadId: string,
    input: { beforeSeq: number; tail?: number },
  ): Promise<PiThreadSnapshot>;

  sendMessage(threadId: string, input: PiSendMessageInput): Promise<void>;
  cancelRun(threadId: string): Promise<void>;

  /** 编辑/重新生成用：截断转录，丢弃 seq >= beforeSeq 的全部消息（服务端
   *  只在空闲回合边界允许，运行中抛 busy）。随后由调用方重发替换消息。 */
  truncateToSeq(threadId: string, beforeSeq: number): Promise<void>;

  /** Clear all queued (steering + follow-up) messages and return their text so
   * the UI can restore it to the composer. Pi exposes no per-item remove or
   * promote — clearing everything is the only queue mutation.
   * 改动（停止回填）：items 带完整条目载荷（文本 + 图片附件），供「停止生成」
   * 把排队内容原样退回输入框。 */
  clearQueue(threadId: string): Promise<PiClearedQueue>;

  // 改动（4a）：逐项队列操作。上游 Pi 无此面（契约只有整队清空，官方运行时
  // 对 per-item 操作 no-op）；我们经 sidecar queue_cancel/queue_promote/
  // queue_steer 实现真操作。id = 真实 reqId（队列条目 id 约束）。
  /** 删除单个排队项（不执行）。 */
  queueCancel?(threadId: string, id: string): Promise<void>;
  /** 立即发送：该项提到队首并中止该线程当前活跃轮，串行链随即执行它。
   *  队列暂停中调用会隐式恢复（用户要求马上执行）。 */
  queuePromote?(threadId: string, id: string): Promise<void>;
  /** 并入当前轮：排队项注入活跃轮（不中止不排队）。无活跃轮则报错、项原位保留。 */
  queueSteer?(threadId: string, id: string): Promise<void>;
  /** 改动（4a）：弹出队首交由前端重发（刷新接力泵用）。sidecar 守卫
   *  暂停位 + isTurnBusy + hasPromptChain 三保险——链节仍在/队列暂停时
   *  返回 null 绝不误弹。 */
  queuePop?(threadId: string): Promise<PiQueueEntry | null>;
  // 改动（v3.1）：暂停/恢复/排序。
  /** 暂停队列：冻结自动派发（当前轮跑完不再开下一轮；不挡 steer/promote）。 */
  queuePause?(threadId: string): Promise<void>;
  /** 恢复队列：清暂停位，sidecar 原生接力补槽派发（顺序与队列一致）。 */
  queueResume?(threadId: string): Promise<void>;
  /** 排序：把排队项移到 toIndex（移动后最终下标，sidecar clamp）。 */
  queueMove?(threadId: string, id: string, toIndex: number): Promise<void>;

  getAvailableModels(input?: {
    workspacePath?: string;
  }): Promise<PiModelInfo[]>;
  setModel(
    threadId: string,
    input: { provider: string; modelId: string },
  ): Promise<void>;
  setThinkingLevel(threadId: string, level: PiThinkingLevel): Promise<void>;

  renameThread(threadId: string, title: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<void>;
  /** Resolves once the thread no longer exists, also when it was already gone. */
  deleteThread(threadId: string): Promise<void>;

  /** Answer a blocking extension UI request (the approval/permission surface). */
  respondToHostUiRequest(
    threadId: string,
    response: PiHostUiResponse,
  ): Promise<void>;

  /** Snapshot-first by default. Callers that already loaded `getThread()` can
   * set `includeSnapshot: false` to skip the initial snapshot. The HTTP client
   * still receives a snapshot after each stream disconnect to recover missed
   * messages and thread status. */
  subscribe(
    threadId: string,
    listener: (event: PiClientEvent) => void,
    options?: { includeSnapshot?: boolean },
  ): () => void;

  /** prompt 真的开跑（该 reqId 的 start 帧）时回调：控制器用它摘掉本地乐观
   *  队列条目（服务端没排过队的消息永远不会广播 queue_update）。
   *  可选面——旧客户端缺失时控制器退回纯事件驱动。 */
  onPromptStart?(
    threadId: string,
    listener: (requestId: string) => void,
  ): () => void;

  /** prompt 终结（该 reqId 的 finish/error 帧）时回调：控制器用它撤掉
   *  「起跑时上屏、但始终没等到回显」的乐观用户消息（起跑后失败/被停止）。
   *  同一 id 只会通知一次。可选面——旧客户端缺失时跳过该清理。 */
  onPromptEnd?(
    threadId: string,
    listener: (requestId: string) => void,
  ): () => void;
}
