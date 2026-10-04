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

import {
  clearComposerChips,
  composerDirectiveText,
} from "@/lib/pi/composer-chips";
import { seqOf, shiftIndexPins, withIdPins } from "./messageIdPins";
import {
  canMaterializeImages,
  clearRowImageUri,
  collectFailedImageParts,
  collectInlineToolImages,
  isMaterializedImageFailed,
  materializeInlineImage,
  patchRowImage,
} from "@/lib/pi/image-materialize";
import { ExportedMessageRepository } from "@assistant-ui/react-native";
import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react-native";
import {
  createPiThreadState,
  prependOlderHistory,
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
  /** 分页窗（§6）：上翻一页更早历史（前置进投影；幂等，在途/无更多时短路）。 */
  loadMoreHistory(): Promise<void>;
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

/** 内联图片落盘开关：默认关（先走 base64）。隧道阶段打开即可复用整条链
 *  （行内 data → file:// 或远端 URL → 渲染；见 lib/pi/image-materialize）。 */
const IMAGE_MATERIALIZE_ENABLED = false;

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
  /** 冷读/刷新尾窗行数（§6 分页）：一页约 2–4 个回合。更早的行按需上翻，
   *  不与初始载荷一起搬（长会话冷开场的内存/渲染成本主要在这）。 */
  private readonly historyPageSize = 60;

  /** 图片落盘批大小：一次处理 2 张（解码/降采样在原生侧，别一口气排满队列） */
  private static readonly IMAGE_MATERIALIZE_BATCH = 2;
  /** 图片落盘排程标志（同一拍内只排一次；批间自续见 runImageMaterialization） */
  private imageMaterializeScheduled = false;

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

  /** 渲染层反馈入口：坏图 uri 摘除 + 后台刷新（见 revertFailedImages） */
  public handleImageMaterializationFailure(): void {
    this.revertFailedImages();
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
      .getThread(this.threadId, { tail: this.historyPageSize })
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

  /** 上翻一页更早的历史（§6 分页窗）：游标 = 已加载最早行的 seq，sidecar 返回
   *  该游标之前的尾窗旧页，前置进 olderMessages（seq 去重）。幂等：在途或无更多
   *  时短路；空转录/客户端不支持分页时关掉 hasMore，避免列表上沿反复触发。
   *  旧页行不带 partial/挂起交互/队列（sidecar 只在整窗上带），投影侧无重放风险。 */
  public async loadMoreHistory(): Promise<void> {
    if (this.state.historyLoading || !this.state.historyHasMore) return;
    const oldest = this.projectedInputMessages()[0];
    const beforeSeq = oldest ? seqOf(oldest) : undefined;
    const fetchPage = this.client.getThreadPage?.bind(this.client);
    if (beforeSeq === undefined || !fetchPage) {
      this.setState({ ...this.state, historyHasMore: false });
      return;
    }
    this.setState({ ...this.state, historyLoading: true });
    try {
      const page = await fetchPage(this.threadId, {
        beforeSeq,
        tail: this.historyPageSize,
      });
      const before = this.state.olderMessages.length;
      // 前置旧页会让本窗与在飞行的下标整体后移：先把下标型 id 钉扎右移
      //（messageIdPins 的前提），错位会让在飞行落盘时回查落空、id 换新
      shiftIndexPins(this.idPins, page.messages.length);
      const next = prependOlderHistory(
        { ...this.state, historyLoading: false },
        page.messages,
        page.hasMore ?? false,
      );
      // 去重吞掉了部分页行时，实际前置数少于页长——把多移的部分退回去
      const added = next.olderMessages.length - before;
      if (added >= 0 && added !== page.messages.length) {
        shiftIndexPins(this.idPins, added - page.messages.length);
      }
      this.setState(next);
      this.recomputeProjectedMessagesAndNotify();
    } catch (error) {
      this.setState({
        ...this.state,
        historyLoading: false,
        lastError: errorText(error),
      });
    }
  }

  private refreshInBackground() {
    if (this.loadPromise) return; // a load is already in flight; avoid storms
    void this.refresh().catch(() => {
      // load() already records the error on state.
    });
  }

  public async sendMessage(message: AppendMessage, options?: PiSendOptions) {
    // 乐观镜像保留独立前缀 id。**不要**把它对齐成"真实行将要得到的 id"：
    // 延迟 flush（scheduleProjectedMessageFlush）可能在没有先跑 reconcile 的
    // 情况下投影，镜像与真实行会短暂同帧并存，同 id 直接让
    // ExportedMessageRepository 抛 "A message with the same id already exists"。
    // 镜像被真实行替换时的那一次重挂，交给投影侧的 id 钉扎（i:<下标> → 复用）。
    return this.sendUserAppend(message, options, this.state.messages.length);
  }

  /** sendMessage 本体；baseMessageCount 是乐观镜像回显去重的匹配下界
   *  （reconcileOptimisticUserMessages 只扫 .slice(下界)）。普通发送取当前
   *  转录长度——回显只会追加在其后；重发路径（截断后）必须传 0 全文匹配：
   *  压入镜像时在飞数组还是截断前长度，随后截断快照把数组收缩，服务端
   *  回显落点低于旧下界，界匹配永远确认不了镜像 → 用户气泡永久重复
   * （带图重新生成必现：大帧让「快照先落、回显后到」占主导）。截断已把
   *  可能同文的旧尾部从服务端删掉，全文匹配安全——撞键只剩更早轮巧合
   *  同文，提前摘除镜像无碍，真回显随 agent_start 同批帧即刻落位。 */
  /**
   * 消息 id 钉扎台账（见 messageProjection.withIdPins）：同一行在整个会话生命周期
   * 里只发一个 id——直播行先拿下标形式、落盘后不再换成 seq 形式，避免 React 重挂；
   * 历史行按 seq 记账，往上翻页 prepend 时下标平移也不受影响。
   */
  private readonly idPins = new Map<string, string>();

  private async sendUserAppend(
    message: AppendMessage,
    options: PiSendOptions | undefined,
    baseMessageCount: number,
  ) {
    if (message.role !== "user") {
      throw new Error("Pi only supports sending user messages");
    }

    const isQueuedSend = this.state.runStatus === "running";
    const behavior =
      options?.streamingBehavior ??
      readSteeringIntent(message) ??
      (isQueuedSend ? "followUp" : undefined);

    const input = buildPiSendInput(message, behavior);
    // 移动端芯片（技能/子智能体）的序列化指令在**发送这一刻**拼进正文：输入框
    // 里只显示胶囊行（见 lib/pi/composer-chips），线上格式与桌面/web 完全一致。
    // 乐观镜像仍用未拼接的 input：用户气泡里不该出现 `:-skill[..]{..}` 这种原文。
    const chipDirectives = composerDirectiveText();
    const wireInput: PiSendMessageInput = chipDirectives
      ? {
          ...input,
          content: input.content ? `${input.content}\n\n${chipDirectives}` : chipDirectives,
        }
      : input;
    // 改动（发图能力提示）：当前模型目录元数据标为纯文本输入而本次发送含图时
    // toast 提醒——不拦截（sidecar 因元数据不可靠已移除硬门，见
    // lib/pi/pi-vision-warning.ts 头注）。排队/steer/重生重发同经此汇聚点。
    maybeWarnUnsupportedImages(this.threadId, (input.attachments?.length ?? 0) > 0);
    this.ensureEventSubscription({ includeSnapshot: false });

    if (isQueuedSend) {
      const queued = await this.sendQueued(
        wireInput,
        behavior ?? "followUp",
        input.content,
      );
      if (chipDirectives) clearComposerChips();
      return queued;
    }

    // 乐观镜像按 **wire 文本**建：回显去重是「内容全等」匹配（userContentKey），
    // 用未拼芯片的 input 建镜像时，服务端回显带 `:skill[...]` 就永远匹配不上，
    // 镜像永不摘除——用户会看到自己那条消息出现两次（有芯片的会话必现）。
    // 渲染侧不受影响：UserText 会把指令解析成胶囊，镜像与回显长得一样。
    const optimistic = optimisticUserMessageFromInput(
      wireInput,
      `pi-optimistic:${++this.optimisticUserSeq}`,
    );
    this.optimisticUserMessages.push({
      message: optimistic,
      baseMessageCount,
    });
    this.setState(markStateRunning(this.state));
    this.recomputeProjectedMessagesAndNotify();

    try {
      await this.client.sendMessage(this.threadId, wireInput);
      if (chipDirectives) clearComposerChips();
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

  /** 截断 + 重发的共用漏斗：id 是下标稳定形式 `pi-msg-idx:<下标>`，seq 从转录
   *  行回查（未落盘的行没有 __seq，无从截断）。截断成功后先后台刷一次快照收敛
   *  UI，再走 sendMessage 的正常发送语义（乐观镜像 + running 标记）。 */
  private async resendAfterTruncate(
    target: ThreadMessageLike,
    message: AppendMessage,
  ) {
    const match = /^pi-msg-idx:(\d+)$/.exec(target.id ?? "");
    const index = match ? Number(match[1]) : -1;
    // 下标基准 = 投影输入数组（olderMessages + 本窗 + 乐观镜像）——投影侧
    // messageId 的 index 就是这个数（§6 分页后本窗前还有旧页，不能再拿
    // state.messages 直取）
    const row =
      index >= 0
        ? (this.projectedInputMessages()[index] as { __seq?: number } | undefined)
        : undefined;
    const seq = typeof row?.__seq === "number" ? row.__seq : undefined;
    if (seq === undefined) {
      throw new Error("message is not persisted yet; cannot resend");
    }
    await this.client.truncateToSeq(this.threadId, seq);
    // 乐观本地截断先于重发压镜像：旧行与新气泡同一提交帧上新旧互换（旧的
    // 立即消失、新的立即出现）——等截断后快照回程才移除的话，带图会话快照
    // 是 MB 级大帧，新气泡会先上屏、旧行滞留到回程，视觉顺序颠倒
    this.truncateLocally(seq);
    this.refreshInBackground();
    // 下界传 0（全文匹配）：见 sendUserAppend 头注——截断快照收缩在飞数组后，
    // 回显落点低于按下标取的界，重生成/编辑重发的乐观镜像会永久滞留成重复气泡
    await this.sendUserAppend(message, undefined, 0);
  }

  /** 乐观本地截断：truncate_session 确认后立即在内存丢掉 seq >= beforeSeq 的
   *  转录行（消息与压缩检查点共用号段，一并移除），不等截断后快照回程。
   *  快照随后整体替换，内容与本截断一致，自愈；lastSeq 不动——降低它会放行
   *  已消费水位的陈旧事件重放。 */
  private truncateLocally(beforeSeq: number) {
    const below = (message: PiAgentMessage) => {
      const seq = (message as { __seq?: unknown }).__seq;
      return !(typeof seq === "number" && seq >= beforeSeq);
    };
    const kept = this.state.messages.filter(below);
    // 分页旧页（olderMessages）同号段：截断点落在旧页内时一并移除
    const keptOlder = this.state.olderMessages.filter(below);
    if (
      kept.length === this.state.messages.length &&
      keptOlder.length === this.state.olderMessages.length
    ) {
      return;
    }
    this.setState({
      ...this.state,
      messages: kept,
      olderMessages: keptOlder,
    });
    this.recomputeProjectedMessagesAndNotify();
  }

  /** Mid-run sends land in Pi's queue, not the transcript (Pi appends the user
   * message only when the queue flushes), so the optimistic mirror goes into
   * `state.queue` — the thread stays clean and the queue UI shows it instantly.
   * The next real `queue_update` replaces the arrays wholesale and self-heals.
   *  steer 模式除外（见下）：并入无队列条目可镜像。 */
  private async sendQueued(
    input: PiSendMessageInput,
    behavior: "followUp" | "steer",
    /** 排队条上显示的文本（芯片指令只在 wire 文本里；默认取入参） */
    displayContent?: string,
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
    // 乐观条目的 id 就用**真实 reqId**：控制器先起一个 id 塞进 input.requestId，
    // 客户端照用（不再自己生成）。这样队列条上的「撤销」在任何时刻点下去，
    // sidecar 的 queue_cancel 都认得这条（此前用 pending-<时间戳> 的临时 id，
    // 服务端查不到直接报错、被 void 吞掉——表现就是"点撤销没反应"）。下一条
    // queue_update 以服务端条目整体替换，id 同值、无感自愈。
    const queueRequestId =
      input.requestId ?? `pi-${Date.now().toString(36)}-${++this.optimisticQueueSeq}`;
    const optimisticEntry: PiQueueEntry = {
      id: queueRequestId,
      content: displayContent ?? input.content,
    };
    const optimisticQueue = {
      ...this.state.queue,
      [mode]: [...this.state.queue[mode], optimisticEntry],
    };
    this.setState({ ...this.state, queue: optimisticQueue });

    try {
      await this.client.sendMessage(this.threadId, { ...input, requestId: queueRequestId });
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
        : entries
            .map((entry) => entry.content)
            .lastIndexOf(displayContent ?? input.content);
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
    // 先本地摘掉（撤销要立刻可见），再尽力通知服务端：真删掉了服务端会随后
    // 发 queue_update；若这条其实早不在队列里（幽灵条目）或请求失败，也以
    // 本地移除为准——真相在服务端，下一条 queue_update 会把它带回来，不会撒谎。
    const before = this.state.queue;
    const next = {
      steering: before.steering.filter((entry) => entry.id !== id),
      followUp: before.followUp.filter((entry) => entry.id !== id),
    };
    if (next.steering.length !== before.steering.length || next.followUp.length !== before.followUp.length) {
      this.setState({ ...this.state, queue: next });
    }
    try {
      await this.client.queueCancel(this.threadId, id);
    } catch (error) {
      console.warn("[pi-runtime] queue_cancel 失败（本地已移除，等服务端队列回执校正）", id, error);
    }
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

    // 图片落盘默认关（先走 base64：display 直接用 data URL，行里的 base64 由
    // 「切会话即放控制器」回收）。代码保留、投影/渲染/守卫对 uri 的支持也在，
    // 等隧道阶段（sidecar 发引用 + 网关/对象存储出图）再把开关打开。
    if (IMAGE_MATERIALIZE_ENABLED && changed) this.scheduleImageMaterialization();

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

  /**
   * 内联工具图片落盘（内存优化，见 lib/pi/image-materialize）：转录行里的 base64
   * 是 JS 堆大户（实测单会话可达 20MB），投影还要再拼一份 data URL。这里逐张异步
   * 换成缓存目录里的 file://（顺带降采样），换完写回状态并重投影。
   *
   * 只在状态刚变（新行到达）时排一次；一批处理完继续排下一批，全失败/无目标即停，
   * 不会空转（失败留原 data，渲染照旧）。web 端整条跳过。
   */
  private scheduleImageMaterialization(): void {
    if (!canMaterializeImages() || this.imageMaterializeScheduled) return;
    this.imageMaterializeScheduled = true;
    const schedule = this.options.scheduleNotify ?? defaultScheduleNotify;
    schedule(() => {
      this.imageMaterializeScheduled = false;
      void this.runImageMaterialization();
    });
  }

  /**
   * 渲染层报过"这个 file:// 读不出来"后：把行上的 uri 摘掉（回到待落盘状态），
   * 再后台拉一次快照——快照把 base64 带回来，落盘任务随即生成新文件。摘掉 uri 的
   * 那一小会儿图是空占位（不是白屏），拿到 base64 就回来。
   */
  private revertFailedImages(): void {
    const failed = collectFailedImageParts(
      this.state.messages,
      this.state.olderMessages,
      isMaterializedImageFailed,
    );
    if (failed.length === 0) return;
    let next = this.state;
    for (const target of failed) {
      const rows = target.where === "messages" ? next.messages : next.olderMessages;
      const rowsNext = clearRowImageUri(rows, target.rowIndex, target.partIndex);
      if (!rowsNext) continue;
      next =
        target.where === "messages"
          ? { ...next, messages: rowsNext as typeof next.messages }
          : { ...next, olderMessages: rowsNext as typeof next.olderMessages };
    }
    if (next === this.state) return;
    this.setState(next);
    this.recomputeProjectedMessagesAndNotify();
    this.refreshInBackground();
  }

  private async runImageMaterialization(): Promise<void> {
    const targets = collectInlineToolImages(
      this.state.messages,
      this.state.olderMessages,
      PiThreadController.IMAGE_MATERIALIZE_BATCH,
    );
    if (targets.length === 0) return;
    const results = await Promise.all(
      targets.map(async (target) => ({
        target,
        materialized: await materializeInlineImage(target.data, target.mimeType),
      })),
    );
    let next = this.state;
    let patched = false;
    for (const { target, materialized } of results) {
      if (!materialized) continue;
      const rows = target.where === "messages" ? next.messages : next.olderMessages;
      const rowsNext = patchRowImage(rows, target.rowIndex, target.partIndex, materialized);
      if (!rowsNext) continue;
      next =
        target.where === "messages"
          ? { ...next, messages: rowsNext as typeof next.messages }
          : { ...next, olderMessages: rowsNext as typeof next.olderMessages };
      patched = true;
    }
    if (!patched) return;
    this.setState(next);
    this.recomputeProjectedMessagesAndNotify();
    // 这一批有进展：继续下一批（剩下的图；无目标时自然停）
    this.scheduleImageMaterialization();
  }

  private projectedInputMessages() {
    return [
      ...this.state.olderMessages,
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
    return withIdPins(this.idPins, () =>
      projectPiThreadMessagesShared(
        {
          messages: this.projectedInputMessages(),
          toolExecutions: this.state.toolExecutions,
          runStatus: this.state.runStatus,
          hostUiRequests: this.state.hostUiRequests,
        },
        this.projectedMessages,
      ),
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
