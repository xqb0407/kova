// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/ThreadController.ts（runtime/ 子目录对应上游 src/runtime/）
// - 重新生成/编辑重发的乐观镜像去重下界（2026-10-02 带图重生重复气泡修复）：
//   截断后重发走 sendUserAppend(message, undefined, 0) 全文匹配——截断快照会把
//   在飞数组收缩，回显落点低于按下标取的界，界匹配永远确认不了乐观镜像
//  （气泡永久重复、顺序错乱，仅切会话/刷新恢复）；普通发送仍按下界匹配。
// - 截断确认后的乐观本地截断 truncateLocally（2026-10-02 新旧互换顺序修复）：
//   旧行不等截断后快照回程、确认服务端截断后立即在内存移除，与重发压入的
//   新气泡同一提交帧上新旧互换——否则带图会话快照回程慢，新气泡先上屏、
//   旧行滞留，视觉顺序颠倒。

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
import { maybeWarnUnsupportedImages } from "@/lib/pi/pi-vision-warning";
import type {
  PiClearedQueue,
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
  /** 预生成的请求 id（队列条目 id = 真实 reqId）：接力泵重发沿用原条目 id，
   *  控制器排队发送时自行生成——客户端见值照用。 */
  requestId?: string;
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
  /** Clear Pi's server-side queue; resolves with the cleared items (text +
   * image attachments) so the UI can restore them to the composer. */
  clearQueue(): Promise<PiClearedQueue>;
  /** 停止生成前的排队取回：先清队拿载荷（文本+图片）再中止。见 drainQueueForStop。 */
  drainQueueForStop(): Promise<PiQueueEntry[]>;
  /** 此刻发送是否会进队列（与 sendUserAppend 的 isQueuedSend 同口径）：
   *  runtime 层的新线程乐观气泡据此决定压不压（排队消息不进消息列表）。 */
  willQueueSend(): boolean;
  // 改动（4a）：逐项队列操作（id = 真实 reqId）。客户端不支持时抛错——
  // 官方契约只有整队清空，no-op 会静默吞掉用户的操作意图。
  queueCancel(id: string): Promise<void>;
  queuePromote(id: string): Promise<void>;
  queueSteer(id: string): Promise<void>;
  /** 改动（4a）：弹出队首交由前端重发（刷新接力泵用）；无孤儿队列时为 null。 */
  queuePop(): Promise<PiQueueEntry | null>;
  /** 接力泵直发重发：按原载荷（文本+附件）走 sendMessage 汇聚点，绕开
   *  composer 共用车道（泵弹出后前后端队列短暂分歧时 composer 车道会把
   *  重发误判进排队，压出 pending 幽灵条目）。 */
  queueResend(entry: PiQueueEntry): Promise<void>;
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

/** 重发用：把投影出的 user 消息还原为 AppendMessage。图片现在投在
 * message.attachments（气泡外附件卡），重发时从 attachments 的 content 里
 * 还原回 image（data URL）parts——文档附件在投影里本就不存在，无法随重发
 * 还原（truncate/edit 的已知保真度限制，编辑路径不受影响：core 给 onEdit
 * 的是 composer 的完整 AppendMessage）。 */
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
  for (const attachment of message.attachments ?? []) {
    for (const part of attachment.content) {
      if (part.type === "image") {
        parts.push({ type: "image", image: part.image });
      } else if (
        part.type === "file" &&
        part.mimeType.startsWith("image/")
      ) {
        parts.push({ type: "image", image: part.data });
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
  /** prompt 起跑通知退订（见 ensureEventSubscription / dropLocalQueueEntry） */
  private unsubscribeFromPromptStart: (() => void) | null = null;
  private eventSubscriptionGeneration = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private loadPromise: Promise<void> | null = null;
  private messageFlushScheduled = false;
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
    // prompt 起跑对账（见 dropLocalQueueEntry）：客户端无此面（旧实现）时跳过
    this.unsubscribeFromPromptStart =
      this.client.onPromptStart?.(this.threadId, (requestId) => {
        if (generation !== this.eventSubscriptionGeneration) return;
        this.dropLocalQueueEntry(requestId);
      }) ?? null;
  }

  private disconnectFromEvents() {
    if (!this.unsubscribeFromEvents && !this.unsubscribeFromPromptStart) return;
    this.unsubscribeFromEvents = null;
    this.unsubscribeFromPromptStart?.();
    this.unsubscribeFromPromptStart = null;
    this.eventSubscriptionGeneration += 1;
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
    return this.sendUserAppend(message, options, this.state.messages.length);
  }

  /** sendMessage 本体；baseMessageCount 是乐观镜像回显去重的匹配下界
   *  （reconcileOptimisticUserMessages 只扫 .slice(下界)）。普通发送取当前
   *  转录长度——回显只会追加在其后；重发路径（截断后）必须传 0 全文匹配：
   *  压入镜像时在飞数组还是截断前长度，随后截断快照把数组收缩，服务端
   *  回显落点低于旧下界，界匹配永远确认不了镜像 → 用户气泡永久重复
   * （带图重新生成必现：大帧让「快照先落、回显后到」占主导）。截断已把
   *  可能同文的旧尾部从服务端删掉，全文匹配安全——撞键只剩更早轮巧合
   *  同文，提前摘除镜像无碍，真回显随 agent_start 同批帧即刻落位。
   *
   *  bypassQueueLane：接力泵直发重发（queueResend）走这里——弹出项的排队
   *  归属已由 sidecar 定论，控制器不能再按本地残留队列把它误判进排队分支
   *  （旧实现只绕开 composer 车道，isQueuedSend 仍会压出 pending 幽灵）。 */
  private async sendUserAppend(
    message: AppendMessage,
    options: PiSendOptions | undefined,
    baseMessageCount: number,
    optimisticMirror = false,
    bypassQueueLane = false,
  ) {
    if (message.role !== "user") {
      throw new Error("Pi only supports sending user messages");
    }

    // 排队判定必须与 sidecar shouldQueue（busyThreads || 队列非空）同口径：
    // agent_end 之后 turn 仍占线的窗口（委派收敛、轮间压缩、收尾 finally）里
    // runStatus 已翻 idle，但 sidecar 会照常入队。此时若走普通发送分支会压入
    // 乐观气泡，回显又排在队列里 → 气泡与队列条并存（"排队消息提前渲染"）
    const isQueuedSend = !bypassQueueLane && this.willQueueSend();
    const behavior =
      options?.streamingBehavior ??
      readSteeringIntent(message) ??
      (isQueuedSend ? "followUp" : undefined);

    const built = buildPiSendInput(message, behavior);
    // 预生成 id（队列/重发路径）：乐观队列条目 id 与协议 reqId 必须同值，
    // 逐项操作才能在任意时刻按 id 命中服务端条目（见 sendQueued）
    const input: PiSendMessageInput = options?.requestId
      ? { ...built, requestId: options.requestId }
      : built;
    // 改动（发图能力提示）：当前模型目录元数据标为纯文本输入而本次发送含图时
    // toast 提醒——不拦截（sidecar 因元数据不可靠已移除硬门，见
    // lib/pi/pi-vision-warning.ts 头注）。排队/steer/重生重发同经此汇聚点。
    maybeWarnUnsupportedImages(this.threadId, (input.attachments?.length ?? 0) > 0);
    this.ensureEventSubscription({ includeSnapshot: false });

    if (isQueuedSend) return this.sendQueued(input, behavior ?? "followUp");

    // 普通发送不压乐观气泡：回显（sidecar message_start 的 user 行）是用户
    // 气泡唯一来源。盲区竞态里压出的镜像永远等不到回显去重（消息在 sidecar
    // 排队未派发，转录里没有这条），气泡与队列条并存。仅截断重发
    // （reloadMessage/editMessage → resendAfterTruncate）沿用本地镜像——
    // 它先截断转录再发，等待回显期间旧气泡已被截掉，需要镜像占位。
    if (!optimisticMirror) {
      try {
        await this.client.sendMessage(this.threadId, input);
      } catch (error) {
        this.setState({ ...this.state, lastError: errorText(error) });
        throw error;
      }
      return;
    }

    const optimistic = optimisticUserMessageFromInput(
      input,
      `pi-optimistic:${++this.optimisticUserSeq}`,
    );
    this.optimisticUserMessages.push({
      message: optimistic,
      baseMessageCount,
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
    // 乐观本地截断先于重发压镜像：旧行与新气泡同一提交帧上新旧互换（旧的
    // 立即消失、新的立即出现）——等截断后快照回程才移除的话，带图会话快照
    // 是 MB 级大帧，新气泡会先上屏、旧行滞留到回程，视觉顺序颠倒
    this.truncateLocally(Number(match[1]));
    this.refreshInBackground();
    // 下界传 0（全文匹配）：见 sendUserAppend 头注——截断快照收缩在飞数组后，
    // 回显落点低于按下标取的界，重生成/编辑重发的乐观镜像会永久滞留成重复气泡
    await this.sendUserAppend(message, undefined, 0, true);
  }

  /** 乐观本地截断：truncate_session 确认后立即在内存丢掉 seq >= beforeSeq 的
   *  转录行（消息与压缩检查点共用号段，一并移除），不等截断后快照回程。
   *  快照随后整体替换，内容与本截断一致，自愈；lastSeq 不动——降低它会放行
   *  已消费水位的陈旧事件重放。 */
  private truncateLocally(beforeSeq: number) {
    const kept = this.state.messages.filter((message) => {
      const seq = (message as { __seq?: unknown }).__seq;
      return !(typeof seq === "number" && seq >= beforeSeq);
    });
    if (kept.length === this.state.messages.length) return;
    this.setState({ ...this.state, messages: kept });
    this.recomputeProjectedMessagesAndNotify();
  }

  /** Mid-run sends land in Pi's queue, not the transcript (Pi appends the user
   * message only when the queue flushes), so the optimistic mirror goes into
   * `state.queue` — the thread stays clean and the queue UI shows it instantly.
   * The next real `queue_update` replaces the arrays wholesale and self-heals.
   *  steer 模式除外（见下）：并入无队列条目可镜像。
   *
   *  乐观条目的 id 用**真实 reqId**（控制器先生成、随 `input.requestId` 下发，
   *  客户端照用）：这样队列条的 ✕/并入/立即发送在任何时刻点下去 sidecar 都认得
   *  这条。此前用 `pending-<时间戳>` 临时 id，服务端查不到 → 撤销无效果，且当
   *  服务端其实没排队（空闲直接执行）时没有任何 queue_update 来清它，条目永远
   *  挂着（幽灵行 + 气泡并存）。附件随条目带上（协议形状）：队列条出缩略图，
   *  纯图消息不再是空行。 */
  private async sendQueued(
    input: PiSendMessageInput,
    behavior: "followUp" | "steer",
  ) {
    const mode = behavior === "steer" ? "steering" : "followUp";
    // steer（并入当前轮）跳过乐观写入：注入成功的队列快照从未变过，sidecar
    // 不会为它发 queue_update，写进 state.queue.steering 的条目没有事件来清
    // （悬挂条目还连带把 queueBusy 订阅保活拖住）；并入语义本就无感、不显示
    // 排队条。注入失败时 sidecar 落回真队列，条目以 followUp 形态随
    // queue_update 出现，无需本地镜像。
    if (mode === "steering") {
      try {
        await this.client.sendMessage(this.threadId, input);
      } catch (error) {
        this.setState({ ...this.state, lastError: errorText(error) });
        throw error;
      }
      return;
    }
    const requestId = input.requestId ?? this.newQueueRequestId();
    const wireInput: PiSendMessageInput = { ...input, requestId };
    const optimisticEntry: PiQueueEntry = {
      id: requestId,
      content: input.content,
      ...(input.attachments && input.attachments.length > 0
        ? {
            attachments: input.attachments.map((a, index) => ({
              name: `image-${index + 1}.${a.mimeType.split("/")[1] ?? "png"}`,
              mimeType: a.mimeType,
              data: a.data,
            })),
          }
        : {}),
    };
    const optimisticQueue = {
      ...this.state.queue,
      [mode]: [...this.state.queue[mode], optimisticEntry],
    };
    this.setState({ ...this.state, queue: optimisticQueue });

    try {
      await this.client.sendMessage(this.threadId, wireInput);
    } catch (error) {
      // Roll back only while our optimistic mirror is still exactly what we
      // set. Any queue write since — a `queue_update`, a snapshot on
      // (re)connect/refresh, a clear, or a sibling send — replaces the queue
      // object, and the entry is then no longer ours to match: removing the
      // stale entry is left to the authoritative writes instead.
      const reconciled = this.state.queue !== optimisticQueue;
      const entries = this.state.queue[mode];
      const index = reconciled
        ? -1
        : entries.findIndex((entry) => entry.id === requestId);
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

  /** 此刻发送是否会进队列（与 sendUserAppend 的 isQueuedSend 同口径）：
   *  运行中/压缩中/重试中，或本地队列非空（含乐观条目）。runtime 层的新线程
   *  乐观气泡据此决定压不压——排队消息不进消息列表（设计文档 §3.3 R1）。 */
  public willQueueSend(): boolean {
    return (
      this.state.runStatus === "running" ||
      this.state.metadata.compactionActive === true ||
      this.state.metadata.retryActive === true ||
      this.state.queue.steering.length > 0 ||
      this.state.queue.followUp.length > 0
    );
  }

  /** 队列条目 id = 真实 reqId：控制器先生成（复用给乐观条目与协议帧），
   *  客户端 sendMessage 见 requestId 直接照用、不再自造。 */
  private newQueueRequestId(): string {
    const uuid =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `pi-${uuid}`;
  }

  /** 「这条消息真的开跑了」对账（客户端 start chunk 观察）：服务端没排过队的
   *  消息永远不会广播 queue_update，本地乐观条目只能靠这个信号摘除——否则
   *  就是「气泡已渲染 + 队列条还挂着一条」的幽灵。派发中的条目本就在
   *  出队快照里消失（wholesale 替换），这里只兜本地残留。 */
  private dropLocalQueueEntry(requestId: string) {
    const queue = this.state.queue;
    const steering = queue.steering.filter((entry) => entry.id !== requestId);
    const followUp = queue.followUp.filter((entry) => entry.id !== requestId);
    if (
      steering.length === queue.steering.length &&
      followUp.length === queue.followUp.length
    ) {
      return;
    }
    this.setState({ ...this.state, queue: { steering, followUp } });
  }

  public async clearQueue(): Promise<PiClearedQueue> {
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

  /** 停止生成前的排队取回（产品语义：停止 = 未派发的排队项回到输入框）。
   *  先 queue_clear 拿完整条目载荷（文本 + 图片附件）再 abort——abort 本身
   *  会取消整队，先清后停才拿得到载荷。失败不阻断停止：调用方仍继续 abort，
   *  只是没有可回填的内容。 */
  public async drainQueueForStop(): Promise<PiQueueEntry[]> {
    try {
      const drained = await this.clearQueue();
      return drained.items;
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) });
      return [];
    }
  }

  /** 改动（4a）：逐项队列操作，id = 真实 reqId，直通 sidecar 队列引擎。
   *  先本地摘掉（撤销要立刻可见——服务端若真的没这条/已被派发，下一条
   *  queue_update 或快照会把它带回来，真相在服务端、不撒谎），再尽力通知
   *  服务端；失败（传输层异常）时条目已被权威快照恢复路径兜住。 */
  public async queueCancel(id: string) {
    if (!this.client.queueCancel) {
      throw new Error("Pi client does not support per-item queue ops");
    }
    this.dropLocalQueueEntry(id);
    await this.client.queueCancel(this.threadId, id);
  }

  /** 接力泵直发重发：弹出项按原载荷（文本 + 图片附件）直接走 sendMessage
   *  汇聚点。必须绕开 composer 共用车道（aui.composer.send）——泵弹出后前端
   *  队列条与 sidecar 引擎可能短暂分歧（空快照事件在途），composer 车道的
   *  isQueuedSend 会按「队列非空」误判进排队分支，压出 pending 幽灵条目
   *  （sidecar 空闲直接执行，永远没有 queue_update 来清它）。直发把判定收敛
   *  到与 sidecar 同口径的单点：撞竞态轮（线程又忙了）时 isQueuedSend 照常
   *  接管续排队，语义不变；空闲则回显直接落气泡（回显是气泡唯一来源）。 */
  public async queueResend(entry: PiQueueEntry): Promise<void> {
    type ResendPart =
      | { type: "text"; text: string }
      | { type: "image"; image: string };
    const parts: ResendPart[] = [];
    if (entry.content.length > 0) parts.push({ type: "text", text: entry.content });
    for (const attachment of entry.attachments ?? []) {
      if (!attachment.data) continue;
      // 协议附件 data 是无前缀 base64，还原成 data URL 让 buildPiSendInput 的
      // image 分支原样收回（sidecar 出队时已把 path-only 项读盘内联）
      parts.push({
        type: "image",
        image: `data:${attachment.mimeType};base64,${attachment.data}`,
      });
    }
    if (parts.length === 0) return;
    const message: AppendMessage = {
      role: "user",
      content: parts,
      createdAt: new Date(),
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    };
    // bypassQueueLane：不做本地排队镜像（该条已不在服务端队列里，是泵弹出来
    // 直发的）；requestId 沿用原条目 id——重发若又进队列（撞竞态轮），队列条
    // 的 ✕/并入仍按同一 id 命中
    await this.sendUserAppend(
      message,
      { requestId: entry.id },
      this.state.messages.length,
      false,
      true,
    );
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
        .some((message) => {
          const echoed = userContentKey(message);
          // 前缀匹配：附件被 sidecar 拒收时，落盘文本是 noticeAppendedText
          // 原文 + 拒收/落盘说明行（prompt-attachments），全文相等会让镜像
          // 永远摘不掉 → 气泡与回显行重复并存
          return (
            echoed === key ||
            (key !== null && key.length > 0 && echoed?.startsWith(key) === true)
          );
        });
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
