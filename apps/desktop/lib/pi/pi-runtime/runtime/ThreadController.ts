// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/ThreadController.ts（runtime/ 子目录对应上游 src/runtime/）

/**
 * Per-thread controller: bridges Pi client events into a snapshot-authoritative
 * `PiThreadState` and exposes the imperative actions the runtime hook wires into
 * a `useExternalStoreRuntime`.
 *
 * The `PiClient` is the transport boundary (HTTP/SSE, RPC subprocess, IPC), so
 * there is no separate event-source class here. React store subscriptions stay
 * local; the controller opens live Pi events only for an explicit `connect()`
 * or operations that need a live runtime. `load()` is the cold read path and
 * seeds from `getThread`.
 *
 * Browser-safe; imports no `@earendil-works/pi-*` packages.
 */

import { ExportedMessageRepository } from "@assistant-ui/react";
import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import {
  createPiThreadState,
  reducePiThreadState,
  removeHostUiRequest,
  type PiThreadState,
} from "./threadState";
import { errorText } from "../utils";
import { isKnownPiClientEventType } from "../eventTypes";
import { projectPiThreadMessagesShared } from "./messageProjection";
import {
  responseForApproval,
  responseForInterrupt,
  responseForToolApproval,
  type PiInterruptAnswer,
} from "./hostUi";
import type {
  PiClient,
  PiClientEvent,
  PiAgentMessage,
  PiHostUiResponse,
  PiImageContent,
  PiInputFilePart,
  PiQueueEntry,
  PiSendMessageInput,
  PiThinkingLevel,
  PiThreadSnapshot,
} from "../types";

export type PiSendOptions = {
  /** Overrides the derived behavior. While the thread is running this is
   * REQUIRED by Pi (`prompt()` throws otherwise); the controller derives a
   * `"followUp"` default from run status when omitted. */
  streamingBehavior?: "followUp" | "steer";
};

export type PiNotificationScheduler = (flush: () => void) => void;

/** `getStateSnapshot` (or `getState` where it is absent) and
 * `getMessageRepository` are read as `useSyncExternalStore` snapshots, so an
 * implementation must return a reference that changes only when a subscribed
 * channel notifies; a freshly built value per call loops React. */
export interface PiThreadControllerLike {
  getState(): PiThreadState;
  /** The state as of the last listener notification. `getState()` can run
   * ahead of it while a coalesced message frame is pending, so only this is a
   * valid `useSyncExternalStore` snapshot. Optional for backwards
   * compatibility; callers fall back to `getState()`. */
  getStateSnapshot?(): PiThreadState;
  getProjectedMessages(): readonly ThreadMessageLike[];
  getMessageRepository(): ExportedMessageRepository;
  getVersion(): number;
  connect(): () => void;
  subscribe(listener: () => void): () => void;
  subscribeMetadata(listener: () => void): () => void;
  subscribeMessages(listener: () => void): () => void;
  load(force?: boolean): Promise<void>;
  refresh(): Promise<void>;
  sendMessage(message: AppendMessage, options?: PiSendOptions): Promise<void>;
  /** 重新生成（症状3）：服务端截断 parentId 之后（含下一条 user 消息）的
   *  转录，重发那条 user 消息。运行中由 sidecar busy 守卫拒绝。 */
  reloadMessage(parentId: string | null): Promise<void>;
  /** 编辑重发（症状3）：截断被编辑消息（message.sourceId）及其后全部转录，
   *  发送编辑后的新内容。投影不保留文档附件，file parts 无法随重发还原。 */
  editMessage(message: AppendMessage): Promise<void>;
  cancel(): Promise<void>;
  /** Clear Pi's server-side queue; resolves with the cleared text so the UI
   * can restore it to the composer. */
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  // 改动（4a）：逐项队列操作（id = 真实 reqId）。客户端不支持时抛错——
  // 官方契约只有整队清空，no-op 会静默吞掉用户的操作意图。
  queueCancel(id: string): Promise<void>;
  queuePromote(id: string): Promise<void>;
  queueSteer(id: string): Promise<void>;
  /** 改动（4a）：弹出队首交由前端重发（刷新接力泵用）；无孤儿队列时为 null。 */
  queuePop(): Promise<PiQueueEntry | null>;
  setModel(input: { provider: string; modelId: string }): Promise<void>;
  setThinkingLevel(level: PiThinkingLevel): Promise<void>;
  /** Answer a request by its id with a decision alone: a `confirm` takes it as
   * is, a refusal dismisses any other kind, and accepting one without its
   * option or text rejects. */
  respondToToolApproval(approvalId: string, approved: boolean): Promise<void>;
  /** Answer the host-UI request raised during a tool call, by `toolCallId`. */
  resumeToolCall(toolCallId: string, payload: unknown): Promise<void>;
  /** Answer a side-channel (free-standing) host-UI request directly. */
  respondToHostUiRequest(response: PiHostUiResponse): Promise<void>;
  dispose(): void;
}

const defaultScheduleNotify: PiNotificationScheduler = (flush) => {
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(() => flush());
    return;
  }
  setTimeout(flush, 16);
};

const notifyListeners = (listeners: Iterable<() => void>) => {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("[react-pi] Listener threw an error", error);
    }
  }
};

/** Event types the reducer acts on. Anything else triggers a snapshot refresh
 * (forward-compat for Pi's open, module-augmented event union). */
const MESSAGE_DIRTY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "snapshot",
  "agent_start",
  "agent_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_update",
  "tool_execution_end",
  "extension_ui_request",
  "extension_ui_resolved",
]);

const MESSAGE_FRAME_COALESCED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message_update",
  "tool_execution_update",
]);

const METADATA_DIRTY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "snapshot",
  "agent_start",
  "agent_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "session_info_changed",
  "thinking_level_changed",
  "context_usage",
  "extension_ui_request",
  "extension_ui_resolved",
  "error",
]);

/** Parse a `data:<mime>;base64,<data>` URL into Pi `ImageContent`. Non-data-URL
 * strings pass through as opaque base64 with a generic image mime. */
const toImageContent = (image: string): PiImageContent => {
  const match = /^data:([^;,]+)(?:;base64)?,(.*)$/is.exec(image);
  if (match) {
    return {
      type: "image",
      mimeType: match[1]!.toLowerCase(),
      data: match[2]!,
    };
  }
  return { type: "image", mimeType: "image/png", data: image };
};

/** All content parts of an append message, with attachment parts flattened in. */
export const appendMessageParts = (message: AppendMessage) => [
  ...message.content,
  ...(message.attachments?.flatMap((a) => a.content ?? []) ?? []),
];

export const buildPiSendInput = (
  message: AppendMessage,
  streamingBehavior: "followUp" | "steer" | undefined,
): PiSendMessageInput => {
  const parts = appendMessageParts(message);

  const textChunks: string[] = [];
  const attachments: PiImageContent[] = [];
  const files: PiInputFilePart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      textChunks.push(part.text);
    } else if (part.type === "image") {
      attachments.push(toImageContent(part.image));
    } else if (part.type === "file") {
      // Composer 附件（对话框直选的图片/文档等）：透传给客户端解析为
      // 协议附件（path/data 载荷），不再静默丢弃
      files.push({
        data: part.data,
        mimeType: part.mimeType,
        ...(part.filename ? { filename: part.filename } : {}),
      });
    }
  }

  return {
    content: textChunks.join("\n\n"),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(streamingBehavior ? { streamingBehavior } : {}),
  };
};

const readSteeringIntent = (
  message: AppendMessage,
): "followUp" | "steer" | undefined => {
  const intent = message.runConfig?.custom?.["streamingBehavior"];
  return intent === "followUp" || intent === "steer" ? intent : undefined;
};

// 改动（稳定消息 id）：乐观消息自带自生成 __optimisticId——此前按下标拿 id，
// 与快照尾部真实 user 行撞号会被外部 store"重复 id 保留最后"吞掉一条
//（发送时"闪一下消失"）；自生成号段与转录 seq 永不碰撞。
const optimisticUserMessageFromInput = (
  input: PiSendMessageInput,
  optimisticId: string,
): PiAgentMessage => ({
  role: "user",
  content:
    input.attachments && input.attachments.length > 0
      ? [{ type: "text", text: input.content }, ...input.attachments]
      : input.content,
  timestamp: Date.now(),
  __optimisticId: optimisticId,
});

/** 重发用：把投影出的 user 消息还原为 AppendMessage。投影只保留 text 与
 * image（data URL）parts——文档附件在投影里本就不存在，无法随重发还原
 * （truncate/edit 的已知保真度限制，编辑路径不受影响：core 给 onEdit 的
 * 是 composer 的完整 AppendMessage）。 */
const appendMessageFromUserProjection = (
  message: ThreadMessageLike,
): AppendMessage => {
  // AppendMessage["content"] 是 readonly 联合，不能直接 push——先收集到
  // 显式可写的 part 联合，再整体赋值（结构上可赋给 readonly 成员）。
  type ResendPart =
    | { type: "text"; text: string }
    | { type: "image"; image: string };
  const parts: ResendPart[] = [];
  if (typeof message.content === "string") {
    parts.push({ type: "text", text: message.content });
  } else {
    for (const part of message.content) {
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
      } else if (part.type === "image") {
        parts.push({ type: "image", image: part.image });
      }
    }
  }
  // 本版本 AppendMessage 必填 createdAt/metadata（含 custom）与
  // parentId/sourceId/runConfig；重发链路只消费 role/content
  // （buildPiSendInput），其余补占位值即可。
  return {
    role: "user",
    content: parts,
    createdAt: new Date(),
    metadata: { custom: {} },
    parentId: null,
    sourceId: null,
    runConfig: undefined,
  };
};

/** Text-only reconcile key: the echoed transcript message may carry extra
 * fields (e.g. enriched image content), so structural equality is too strict —
 * the prompt text is the stable part. */
const userContentKey = (message: PiAgentMessage): string | null => {
  if (message.role !== "user") return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return (content as readonly { type: string; text?: string }[])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
};

type OptimisticUserMessage = {
  message: PiAgentMessage;
  baseMessageCount: number;
};

const markStateRunning = (state: PiThreadState): PiThreadState => {
  if (state.runStatus === "running" && state.metadata.status === "running") {
    return state;
  }
  return {
    ...state,
    runStatus: "running",
    lastError: undefined,
    metadata:
      state.metadata.status === "running"
        ? state.metadata
        : { ...state.metadata, status: "running" },
  };
};

export class PiThreadController implements PiThreadControllerLike {
  private state: PiThreadState;
  private stateSnapshot: PiThreadState;
  private projectedMessages: readonly ThreadMessageLike[] = [];
  private messageRepository = ExportedMessageRepository.fromArray([]);
  private version = 0;
  private readonly allListeners = new Set<() => void>();
  private readonly metadataListeners = new Set<() => void>();
  private readonly messageListeners = new Set<() => void>();
  private connectionRetainers = 0;
  private readonly optimisticUserMessages: OptimisticUserMessage[] = [];
  private unsubscribeFromEvents: (() => void) | null = null;
  private eventSubscriptionGeneration = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private loadPromise: Promise<void> | null = null;
  private messageFlushScheduled = false;
  /** 乐观队列条目的临时 id 序号（真实 reqId 由客户端生成，见 sendQueued）。 */
  private optimisticQueueSeq = 0;
  /** 改动（稳定消息 id）：乐观用户消息的自生成 id 序号（`pi-optimistic:${n}`）。 */
  private optimisticUserSeq = 0;
  /** Fallback sequence for snapshots without a supervisor-provided sequence. */
  private readonly localSnapshotSeq = 0;

  private readonly client: PiClient;
  private readonly threadId: string;
  private readonly options: {
    scheduleNotify?: PiNotificationScheduler;
  };

  constructor(
    client: PiClient,
    threadId: string,
    options: {
      scheduleNotify?: PiNotificationScheduler;
    } = {},
  ) {
    this.client = client;
    this.threadId = threadId;
    this.options = options;
    this.state = createPiThreadState(threadId);
    this.stateSnapshot = this.state;
  }

  public getState() {
    return this.state;
  }

  public getStateSnapshot() {
    return this.stateSnapshot;
  }

  public getProjectedMessages() {
    return this.projectedMessages;
  }

  public getMessageRepository() {
    return this.messageRepository;
  }

  public getVersion() {
    return this.version;
  }

  public connect() {
    this.connectionRetainers += 1;
    this.ensureEventSubscription({
      includeSnapshot: this.state.loadState !== "loaded",
    });
    return () => {
      this.connectionRetainers = Math.max(0, this.connectionRetainers - 1);
      this.maybeDisconnectFromEvents();
    };
  }

  public subscribe(listener: () => void) {
    this.allListeners.add(listener);
    return () => {
      this.allListeners.delete(listener);
      this.maybeDisconnectFromEvents();
    };
  }

  public subscribeMetadata(listener: () => void) {
    this.metadataListeners.add(listener);
    return () => {
      this.metadataListeners.delete(listener);
      this.maybeDisconnectFromEvents();
    };
  }

  public subscribeMessages(listener: () => void) {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
      this.maybeDisconnectFromEvents();
    };
  }

  public dispose() {
    // React StrictMode can detach then resubscribe the same controller.
    this.clearDisconnectTimer();
    this.allListeners.clear();
    this.metadataListeners.clear();
    this.messageListeners.clear();
    this.disconnectFromEvents();
  }

  private ensureEventSubscription(options?: { includeSnapshot?: boolean }) {
    this.clearDisconnectTimer();
    if (this.unsubscribeFromEvents) return;
    const generation = ++this.eventSubscriptionGeneration;
    this.unsubscribeFromEvents = this.client.subscribe(
      this.threadId,
      (event: PiClientEvent) => {
        if (generation !== this.eventSubscriptionGeneration) return;
        if (event.threadId !== this.threadId) return;
        this.dispatch(event);
      },
      options,
    );
  }

  private disconnectFromEvents() {
    const unsubscribe = this.unsubscribeFromEvents;
    if (!unsubscribe) return;
    this.unsubscribeFromEvents = null;
    this.eventSubscriptionGeneration += 1;
    unsubscribe();
  }

  private hasConsumers(): boolean {
    return (
      this.connectionRetainers > 0 ||
      this.allListeners.size > 0 ||
      this.metadataListeners.size > 0 ||
      this.messageListeners.size > 0
    );
  }

  private maybeDisconnectFromEvents() {
    if (this.hasConsumers()) return;
    if (this.disconnectTimer) return;
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      if (this.hasConsumers()) return;
      this.disconnectFromEvents();
    }, 30_000);
  }

  private clearDisconnectTimer() {
    if (!this.disconnectTimer) return;
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  public async load(force = false) {
    if (this.loadPromise && !force) return this.loadPromise;

    this.setState({ ...this.state, loadState: "loading" });
    const sequenceAtStart = this.state.lastSeq;

    const request = this.client
      .getThread(this.threadId)
      .then((snapshot: PiThreadSnapshot) => {
        if (this.loadPromise !== request) return;
        this.applySnapshot(snapshot, sequenceAtStart);
      })
      .catch((error: unknown) => {
        if (this.loadPromise !== request) throw error;
        this.setState({
          ...this.state,
          loadState: "loaded",
          lastError: errorText(error),
        });
        throw error;
      })
      .finally(() => {
        if (this.loadPromise === request) this.loadPromise = null;
      });

    this.loadPromise = request;
    return request;
  }

  public refresh() {
    return this.load(true);
  }

  private refreshInBackground() {
    if (this.loadPromise) return; // a load is already in flight; avoid storms
    void this.refresh().catch(() => {
      // load() already records the error on state.
    });
  }

  public async sendMessage(message: AppendMessage, options?: PiSendOptions) {
    if (message.role !== "user") {
      throw new Error("Pi only supports sending user messages");
    }

    const isQueuedSend = this.state.runStatus === "running";
    const behavior =
      options?.streamingBehavior ??
      readSteeringIntent(message) ??
      (isQueuedSend ? "followUp" : undefined);

    const input = buildPiSendInput(message, behavior);
    this.ensureEventSubscription({ includeSnapshot: false });

    if (isQueuedSend) return this.sendQueued(input, behavior ?? "followUp");

    const optimistic = optimisticUserMessageFromInput(
      input,
      `pi-optimistic:${++this.optimisticUserSeq}`,
    );
    this.optimisticUserMessages.push({
      message: optimistic,
      baseMessageCount: this.state.messages.length,
    });
    this.setState(markStateRunning(this.state));
    this.recomputeProjectedMessagesAndNotify();

    try {
      await this.client.sendMessage(this.threadId, input);
    } catch (error) {
      const index = this.optimisticUserMessages.findIndex(
        (entry) => entry.message === optimistic,
      );
      if (index !== -1) this.optimisticUserMessages.splice(index, 1);
      this.recomputeProjectedMessagesAndNotify();
      // The optimistic `running` mark must not outlive the failed send; any
      // events from a run that did start will self-heal the status.
      this.setState({
        ...this.state,
        lastError: errorText(error),
        runStatus: "failed",
        metadata: { ...this.state.metadata, status: "failed" },
      });
      throw error;
    }
  }

  /** 重新生成：core 传的 parentId 是「被重生成 assistant 的前一条消息 id」，
   *  即那条 user 消息本身；null = 首条消息无前驱锚点，从头重发。锚点位不是
   *  user（如连续 assistant、中间夹系统行）时向上回溯最近的 user 作截断重发点。 */
  public async reloadMessage(parentId: string | null) {
    const messages = this.projectedMessages;
    let target: (typeof messages)[number] | undefined;
    if (parentId != null) {
      const anchorIndex = messages.findIndex((m) => m.id === parentId);
      if (anchorIndex === -1)
        throw new Error(`message not found: ${parentId}`);
      for (let i = anchorIndex; i >= 0; i--) {
        if (messages[i].role === "user") {
          target = messages[i];
          break;
        }
      }
    } else {
      target = messages.find((m) => m.role === "user");
    }
    if (!target) throw new Error("no user message to reload");
    await this.resendAfterTruncate(
      target,
      appendMessageFromUserProjection(target),
    );
  }

  /** 编辑重发：core 在 onEdit 载荷里带被编辑消息的投影 id（sourceId），
   *  以它为截断点发送编辑后的完整 AppendMessage。 */
  public async editMessage(message: AppendMessage) {
    if (message.role !== "user") {
      throw new Error("Pi only supports editing user messages");
    }
    const sourceId = message.sourceId;
    if (typeof sourceId !== "string") {
      throw new Error("edited message has no source id");
    }
    const target = this.projectedMessages.find((m) => m.id === sourceId);
    if (!target) throw new Error(`message not found: ${sourceId}`);
    await this.resendAfterTruncate(target, message);
  }

  /** 截断 + 重发的共用漏斗：只认 `pi-msg:<seq>` 稳定 id（乐观镜像与
   *  下标回退 id 未落盘，无从截断）。截断成功后先后台刷一次快照收敛
   *  UI，再走 sendMessage 的正常发送语义（乐观镜像 + running 标记）。 */
  private async resendAfterTruncate(
    target: ThreadMessageLike,
    message: AppendMessage,
  ) {
    const match = /^pi-msg:(\d+)$/.exec(target.id ?? "");
    if (!match) {
      throw new Error("message is not persisted yet; cannot resend");
    }
    await this.client.truncateToSeq(this.threadId, Number(match[1]));
    this.refreshInBackground();
    await this.sendMessage(message);
  }

  /** Mid-run sends land in Pi's queue, not the transcript (Pi appends the user
   * message only when the queue flushes), so the optimistic mirror goes into
   * `state.queue` — the thread stays clean and the queue UI shows it instantly.
   * The next real `queue_update` replaces the arrays wholesale and self-heals. */
  private async sendQueued(
    input: PiSendMessageInput,
    behavior: "followUp" | "steer",
  ) {
    const mode = behavior === "steer" ? "steering" : "followUp";
    // 改动（4a）：乐观条目带临时 id——真实 reqId 由客户端在 sendMessage 内
    // 生成，控制器无从得知；下一条 queue_update 以服务端条目整体替换自愈。
    const optimisticEntry: PiQueueEntry = {
      id: `pending-${Date.now()}-${++this.optimisticQueueSeq}`,
      content: input.content,
    };
    const optimisticQueue = {
      ...this.state.queue,
      [mode]: [...this.state.queue[mode], optimisticEntry],
    };
    this.setState({ ...this.state, queue: optimisticQueue });

    try {
      await this.client.sendMessage(this.threadId, input);
    } catch (error) {
      // Roll back only while our optimistic mirror is still exactly what we
      // set. Any queue write since — a `queue_update`, a snapshot on
      // (re)connect/refresh, a clear, or a sibling send — replaces the queue
      // object, and the entry is then no longer ours to match by content:
      // removing by `lastIndexOf` could delete a surviving identical message.
      // A later `queue_update` self-heals the stale entry instead.
      const reconciled = this.state.queue !== optimisticQueue;
      const entries = this.state.queue[mode];
      const index = reconciled
        ? -1
        : entries.map((entry) => entry.content).lastIndexOf(input.content);
      this.setState({
        ...this.state,
        lastError: errorText(error),
        ...(index !== -1
          ? {
              queue: {
                ...this.state.queue,
                [mode]: entries.filter((_, i) => i !== index),
              },
            }
          : {}),
      });
      throw error;
    }
  }

  public async clearQueue() {
    // Snapshot the queue we are clearing. Every queue write allocates a fresh
    // object — sendQueued, the `queue_update` reducer, and a reconnect/refresh
    // snapshot (applySnapshot, even when the contents are unchanged) — so a
    // changed reference means some write landed while the request was in
    // flight, which may be a refresh rather than a newer message. Bias toward
    // skipping the local empty when it changed: leaving a stale entry is
    // self-healed by the next `queue_update`, whereas emptying could drop a
    // message the server still holds.
    const queueBefore = this.state.queue;
    const cleared = await this.client.clearQueue(this.threadId);
    // Optimistically empty the local mirror; Pi's own `queue_update` (emitted
    // by `session.clearQueue`) confirms it.
    if (
      this.state.queue === queueBefore &&
      (queueBefore.steering.length > 0 || queueBefore.followUp.length > 0)
    ) {
      this.setState({
        ...this.state,
        queue: { steering: [], followUp: [] },
      });
    }
    return cleared;
  }

  /** 改动（4a）：逐项队列操作，直通客户端（id = 真实 reqId）。状态更新由
   *  sidecar 的 queue_update 事件驱动，控制器不做乐观改写——逐项操作的
   *  失败（如并入时活跃轮恰好收尾）需要条目原位保留，乐观删除会闪动。 */
  public async queueCancel(id: string) {
    if (!this.client.queueCancel) {
      throw new Error("Pi client does not support per-item queue ops");
    }
    await this.client.queueCancel(this.threadId, id);
  }

  public async queuePromote(id: string) {
    if (!this.client.queuePromote) {
      throw new Error("Pi client does not support per-item queue ops");
    }
    await this.client.queuePromote(this.threadId, id);
  }

  public async queueSteer(id: string) {
    if (!this.client.queueSteer) {
      throw new Error("Pi client does not support per-item queue ops");
    }
    await this.client.queueSteer(this.threadId, id);
  }

  /** 改动（4a）：弹出队首（接力泵）。客户端不支持时返回 null（视为无孤儿）。 */
  public async queuePop(): Promise<PiQueueEntry | null> {
    if (!this.client.queuePop) return null;
    return this.client.queuePop(this.threadId);
  }

  public async cancel() {
    try {
      await this.client.cancelRun(this.threadId);
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) });
      throw error;
    }
  }

  public async setModel(input: { provider: string; modelId: string }) {
    try {
      await this.client.setModel(this.threadId, input);
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) });
      throw error;
    }
    await this.refresh();
  }

  public async setThinkingLevel(level: PiThinkingLevel) {
    try {
      await this.client.setThinkingLevel(this.threadId, level);
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) });
      throw error;
    }
    await this.refresh();
  }

  public async respondToToolApproval(approvalId: string, approved: boolean) {
    const request = this.state.hostUiRequests.find((r) => r.id === approvalId);
    await this.respond(
      request
        ? responseForToolApproval(request, { approvalId, approved })
        : responseForApproval(approvalId, approved),
    );
  }

  public async resumeToolCall(toolCallId: string, payload: unknown) {
    const request = this.state.hostUiRequests.find(
      (r) => r.toolCallId === toolCallId,
    );
    if (!request) {
      throw new Error(
        `No pending host-UI request for tool call "${toolCallId}"`,
      );
    }
    if (request.kind === "confirm") {
      await this.respond(responseForApproval(request.id, payload === true));
    } else {
      await this.respond(
        responseForInterrupt(request.id, payload as PiInterruptAnswer),
      );
    }
  }

  public async respondToHostUiRequest(response: PiHostUiResponse) {
    await this.respond(response);
  }

  private async respond(response: PiHostUiResponse) {
    try {
      await this.client.respondToHostUiRequest(this.threadId, response);
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) });
      throw error;
    }
    // Optimistically clear the resolved request so the gate closes immediately.
    // Done directly (not via the reducer) because a synthetic event at the
    // current seq would be dropped by the dedup guard; the supervisor's real
    // `extension_ui_resolved` is idempotent over this removal.
    const next = removeHostUiRequest(this.state, response.requestId);
    if (next !== this.state) {
      this.setState(next);
      this.recomputeProjectedMessagesAndNotify();
    }
  }

  private applySnapshot(snapshot: PiThreadSnapshot, sequenceAtStart: number) {
    const currentSequence = this.state.lastSeq;
    // Live records stamp snapshots at handle time, so an uncontested snapshot
    // behind the request-start watermark belongs to a rebuilt record.
    const sequenceResetWhileLoading = currentSequence < sequenceAtStart;
    const responseWasOvertaken =
      snapshot.seq !== undefined &&
      currentSequence > sequenceAtStart &&
      snapshot.seq < currentSequence;

    if (sequenceResetWhileLoading || responseWasOvertaken) {
      if (this.state.loadState !== "loaded") {
        this.setState({ ...this.state, loadState: "loaded" });
      }
      return;
    }

    this.dispatch({
      type: "snapshot",
      snapshot,
      threadId: this.threadId,
      seq: snapshot.seq ?? this.localSnapshotSeq,
    });
  }

  private dispatch(event: PiClientEvent) {
    const next = reducePiThreadState(this.state, event);
    const changed = next !== this.state;
    if (changed) this.state = next;

    this.reconcileOptimisticUserMessages();

    if (changed && METADATA_DIRTY_EVENT_TYPES.has(event.type)) {
      this.notifyMetadataListeners();
    }

    if (changed && MESSAGE_DIRTY_EVENT_TYPES.has(event.type)) {
      if (MESSAGE_FRAME_COALESCED_EVENT_TYPES.has(event.type)) {
        this.scheduleProjectedMessageFlush();
      } else {
        this.recomputeProjectedMessagesAndNotify();
      }
    }

    // Pi 0.80.7 emits entry_appended only for custom extension entries. Keep
    // snapshot reconciliation for other variants if Pi broadens that event.
    const needsSnapshotRefresh =
      !isKnownPiClientEventType(event.type) ||
      (event.type === "entry_appended" && event.entry?.type !== "custom");
    if (needsSnapshotRefresh) this.refreshInBackground();
  }

  private setState(next: PiThreadState) {
    if (next === this.state) return;
    this.state = next;
    this.notifyMetadataListeners();
  }

  private projectedInputMessages() {
    return [
      ...this.state.messages,
      ...this.optimisticUserMessages.map((entry) => entry.message),
    ];
  }

  private reconcileOptimisticUserMessages() {
    if (this.optimisticUserMessages.length === 0) return;

    const remaining: OptimisticUserMessage[] = [];
    for (const entry of this.optimisticUserMessages) {
      const key = userContentKey(entry.message);
      const confirmed = this.state.messages
        .slice(entry.baseMessageCount)
        .some((message) => userContentKey(message) === key);
      if (!confirmed) remaining.push(entry);
    }

    if (remaining.length === this.optimisticUserMessages.length) return;
    this.optimisticUserMessages.length = 0;
    this.optimisticUserMessages.push(...remaining);
  }

  private projectMessages() {
    return projectPiThreadMessagesShared(
      {
        messages: this.projectedInputMessages(),
        toolExecutions: this.state.toolExecutions,
        runStatus: this.state.runStatus,
        hostUiRequests: this.state.hostUiRequests,
      },
      this.projectedMessages,
    );
  }

  private recomputeProjectedMessagesAndNotify() {
    const next = this.projectMessages();
    if (next === this.projectedMessages) {
      if (this.state !== this.stateSnapshot) this.publishState();
      return;
    }
    this.projectedMessages = next;
    // `fromArray` chains messages linearly and keeps their stable `pi-msg:N`
    // ids (its generated id is only a fallback for id-less messages).
    this.messageRepository = ExportedMessageRepository.fromArray(next);
    this.notifyMessageListeners();
  }

  private scheduleProjectedMessageFlush() {
    if (this.messageFlushScheduled) return;
    this.messageFlushScheduled = true;
    const scheduleNotify = this.options.scheduleNotify ?? defaultScheduleNotify;
    scheduleNotify(() => {
      this.messageFlushScheduled = false;
      this.recomputeProjectedMessagesAndNotify();
    });
  }

  private bumpVersion() {
    this.version += 1;
  }

  /** `message_end` advances state without moving the projection, so neither
   * the metadata nor the message channel describes what changed. Publishing on
   * `all` alone reaches every state subscriber without redefining what
   * `subscribeMetadata` fires for. */
  private publishState() {
    this.stateSnapshot = this.state;
    this.bumpVersion();
    notifyListeners(this.allListeners);
  }

  private notifyMetadataListeners() {
    this.stateSnapshot = this.state;
    this.bumpVersion();
    notifyListeners(this.metadataListeners);
    notifyListeners(this.allListeners);
  }

  private notifyMessageListeners() {
    this.stateSnapshot = this.state;
    this.bumpVersion();
    notifyListeners(this.messageListeners);
    notifyListeners(this.allListeners);
  }
}
