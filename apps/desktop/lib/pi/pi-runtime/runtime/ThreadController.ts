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
// - 隐藏页面合并刷新改走定时器（2026-10-16 回焦首帧长任务修复，见
//   defaultScheduleNotify）：rAF 在隐藏页不跑，整段隐藏期的 message_update
//   原本会憋到回焦第一帧一次性渲染（流式期间跳过的代码高亮这时集中补上，
//   叠加布局与贴尾滚动就是一次秒级长任务，被卡顿看门狗记成界面冻结）。
//   defaultScheduleNotify 因此从模块私有变为具名导出，供单测覆盖。

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
import type {
  AppendMessage,
  ThreadMessage,
  ThreadMessageLike,
} from "@assistant-ui/react";
import {
  createPiThreadState,
  reducePiThreadState,
  removeHostUiRequest,
  type PiThreadState,
} from "./threadState";
import { errorText } from "pi-runtime";
import { isKnownPiClientEventType } from "../eventTypes";
import {
  createPiProjectionCache,
  projectPiThreadMessagesShared,
  quoteToMarkdownBlock,
} from "./messageProjection";
import { expandCodeDirectives } from "@/lib/composer/code-reference";
import { buildLibraryContext } from "@/lib/composer/library-reference";
import { prefetchLibraryNoteBodies } from "@/lib/composer/library-note-inline";
import { noteSpan } from "@/components/debug/perf-store";
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

/** 停止对账看门狗的节奏：abort→agent_end 正常一两秒内完成，4 秒已是余量；
 *  快照仍报 running（abort 在串行队列排队/收尾中）则按此节奏有限次重排。 */
const STOP_RECONCILE_DELAY_MS = 4_000;
/** 看门狗重排上限：5 轮 × 4s = 20s，覆盖串行队列被慢命令占满的最坏情形；
 *  超过即放弃（后续 agent_end 或 pi_restarted 广播仍会兜底归位），避免病态
 *  场景下无限轮询 getThread。 */
const STOP_RECONCILE_MAX_CYCLES = 5;

export const defaultScheduleNotify: PiNotificationScheduler = (flush) => {
  // 隐藏页面 rAF 不跑，继续挂在 rAF 上等于把整段隐藏期间的 message_update
  // 攒到回焦第一帧一次性渲染——隐藏期可能长达分钟级（流式期间跳过高亮的代码
  // 块也正好在这一帧集中补高亮），首帧因此被顶成秒级长任务。退回定时器给合并
  // 窗口一个上限：隐藏页的定时器本身会被降频到秒级/分钟级，总渲染量不变，
  // 只是不再全部堆在同一帧。
  if (typeof document !== "undefined" && document.hidden) {
    setTimeout(flush, 16);
    return;
  }
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

/** AppendMessage 携带的引用（SelectionToolbar「询问」）。库把引用放在
 *  metadata.custom.quote（QuoteInfo = { text, messageId }），不占 content——
 *  空文本引用直接忽略，其余原样透传。 */
export const appendMessageQuote = (
  message: AppendMessage,
): { text: string; messageId?: string } | undefined => {
  const custom = (
    message.metadata as { custom?: { quote?: unknown } } | undefined
  )?.custom;
  const quote = custom?.quote as
    | { text?: unknown; messageId?: unknown }
    | undefined;
  if (!quote || typeof quote.text !== "string" || quote.text.trim() === "") {
    return undefined;
  }
  return {
    text: quote.text,
    ...(typeof quote.messageId === "string"
      ? { messageId: quote.messageId }
      : {}),
  };
};

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

    // 引用（「询问」）：把引用文本以 Markdown 引用块前置进正文——模型因此看到
    // "针对哪段文字"的完整上下文；只要引用没有正文也照样发出（纯询问"这段是
    // 什么意思"）。投影侧按同一条约定还原成引用块渲染（splitLeadingQuoteBlock）
    const quote = appendMessageQuote(message);
    // 引用芯片发送处理：
    // - `:code[...]`（文件视图选区「引用到对话」）→ 展开成 `@path (lines N-M)`；
    // - `:library[...]`（资料库「引用到对话」）→ **芯片原样保留**（用户气泡渲染
    //   成芯片，而不是展开后的绝对路径）；路径/正文放进正文末尾的隐藏块：
    //   - `[[library-refs]]`：每条引用的 rel + 绝对路径（+ 行号），缺失的标
    //     「已删除」——模型按此用文件工具读取，绝不发死路径；
    //   - `[[library-notes]]`：小笔记（≤16KB）正文内联，模型无需再 read。
    //   两个隐藏块展示层剥离（splitPromptNotices / messageProjection），编辑
    //   重发拿到的仍是芯片。小笔记正文在发送汇聚点前已由
    //   prefetchLibraryNoteBodies 预取进缓存。
    const inlineNoteBlocks: string[] = [];
    const userText = textChunks
      .map((chunk) => expandCodeDirectives(chunk))
      .join("\n\n");
    const refsLines = buildLibraryContext(userText, (block) =>
      inlineNoteBlocks.push(block),
    );
    // 隐藏块用随机边界：笔记正文里写了 `[[/library-notes]]` 也不会提前截断
    const boundary = Math.random().toString(36).slice(2, 10);
    const contextBlocks: string[] = [];
    if (refsLines) {
      contextBlocks.push(
        `[[library-refs:${boundary}]]\n${refsLines}\n[[/library-refs:${boundary}]]`,
      );
    }
    if (inlineNoteBlocks.length > 0) {
      contextBlocks.push(
        `[[library-notes:${boundary}]]\n${inlineNoteBlocks.join("\n")}\n[[/library-notes:${boundary}]]`,
      );
    }
    const userTextWithNotes =
      contextBlocks.length > 0
        ? `${userText}\n\n${contextBlocks.join("\n\n")}`
        : userText;
    const content = quote
      ? userTextWithNotes
        ? `${quoteToMarkdownBlock(quote.text)}\n\n${userTextWithNotes}`
        : quoteToMarkdownBlock(quote.text)
      : userTextWithNotes;

  return {
    content,
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
  // 引用随 metadata 一起带回：投影把引用还原成 metadata.custom.quote（正文里
  // 已剥掉引用块），重发/编辑若丢掉它，重发的 prompt 就少了引用文本
  const carriedQuote = (
    message.metadata as { custom?: { quote?: unknown } } | undefined
  )?.custom?.quote;
  return {
    role: "user",
    content: parts,
    createdAt: new Date(),
    metadata: { custom: carriedQuote ? { quote: carriedQuote } : {} },
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

/** 当前状态里的 user 行数。起跑上屏的回显确认以「发送时的条数」为基线，
 *  而不是数组下标——快照应答可能先到并替换消息数组，下标会漂移。 */
const countUserMessages = (messages: readonly PiAgentMessage[]): number =>
  messages.reduce(
    (count, message) => count + (message.role === "user" ? 1 : 0),
    0,
  );

/** 基线之后新增的 user 行里是否有本条的落盘回显。前缀匹配保留：附件被拒收
 *  时落盘文本会多出说明行（与 reconcile 原口径一致）。纯图/纯文档消息的
 *  文本键为空：纯图回显无文本；纯文档（或被拒收的附件）回显是 sidecar 追加
 *  的「[用户附件：…]」说明行。`[[auto-continue]]` 等系统 user 行用双括号
 *  哨兵，必须排除——它们也占 user 行，但不是本条回显。 */
const hasNewUserEcho = (
  messages: readonly PiAgentMessage[],
  baseUserMessages: number,
  optimistic: PiAgentMessage,
): boolean => {
  const key = userContentKey(optimistic);
  if (key === null) return false;
  let seen = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    seen += 1;
    if (seen <= baseUserMessages) continue;
    if (key.length === 0) {
      const echoed = (userContentKey(message) ?? "").trimStart();
      if (
        echoed === "" ||
        (echoed.startsWith("[") && !echoed.startsWith("[["))
      ) {
        return true;
      }
      continue;
    }
    const echoed = userContentKey(message);
    if (echoed === key || echoed?.startsWith(key) === true) return true;
  }
  return false;
};

type OptimisticUserMessage = {
  message: PiAgentMessage;
  baseMessageCount: number;
  /** 起跑上屏的镜像：发送时状态里的 user 行数（回显确认基线，见 hasNewUserEcho） */
  baseUserMessages?: number;
  /** 起跑上屏的镜像对应的 prompt reqId（onPromptEnd 兜底清理用）；重发路径
   *  的即时镜像没有 reqId，仍只靠回显确认。 */
  requestId?: string;
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
  /** 增量投影的续算锚点（见 messageProjection 的 PiProjectionCache）：流式期间
   *  每帧只重投影真正变过的尾部，而不是整份转录。一线程一份，不跨线程共享。 */
  private readonly projectionCache = createPiProjectionCache();
  private messageRepository = ExportedMessageRepository.fromArray([]);
  /** 投影消息 → 已转换的运行时消息，按对象身份记忆。
   *
   *  为什么必须做：`ExportedMessageRepository.fromArray` 会对**每一条**消息重跑
   *  `fromThreadMessageLike`，而后者给每个 tool-call part 造新对象、给 content 造
   *  新数组——流式期间每帧全量跑一遍，代价是 O(全部消息 × 全部 part)，并且**摧毁
   *  对象身份**：上层所有按身份做的缓存（框架自己的 thread-message-client、面板的
   *  文件索引、getTurnParts…）统统失效。实测（真机日志）：消息 <10 时卡顿 0.09
   *  次/窗口，消息 ≥50 时 3.62 次/窗口、最差 2.7fps。
   *
   *  单条转换仍走框架自己的 fromArray（只喂一条），这样 status 的兜底口径与原来
   *  完全一致，不用重实现它内部未导出的 getRepositoryContentAutoStatus。 */
  private readonly runtimeMessageCache = new WeakMap<
    ThreadMessageLike,
    ThreadMessage
  >();
  private version = 0;
  private readonly allListeners = new Set<() => void>();
  private readonly metadataListeners = new Set<() => void>();
  private readonly messageListeners = new Set<() => void>();
  private connectionRetainers = 0;
  private readonly optimisticUserMessages: OptimisticUserMessage[] = [];
  /** 已发出、尚未起跑的 prompt：reqId → 该条的用户消息。起跑帧（start）到
   *  才推入 optimisticUserMessages 上屏——压缩/会话准备期间先把消息画出来，
   *  不用等 agent.prompt 的回显（轮前压缩可能几十秒）。同一 reqId 的终结帧
   *  （finish/error）负责把从未回显的镜像撤掉。 */
  private readonly pendingPromptMessages = new Map<
    string,
    {
      message: PiAgentMessage;
      revealed: boolean;
      /** 发送时状态里的 user 行数：起跑前快照若已带回回显，据此避免重复上屏 */
      baseUserMessages: number;
    }
  >();
  private unsubscribeFromEvents: (() => void) | null = null;
  /** prompt 起跑通知退订（见 ensureEventSubscription / dropLocalQueueEntry） */
  private unsubscribeFromPromptStart: (() => void) | null = null;
  /** prompt 终结通知退订（见 ensureEventSubscription / finishPendingPrompt） */
  private unsubscribeFromPromptEnd: (() => void) | null = null;
  private eventSubscriptionGeneration = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 停止对账看门狗（armStopReconcile）：abort 后 runStatus 迟迟不翻 idle 时
   *  拉快照对账——sidecar 换代后 agent_end 永远不会来，这是唯一归位出口 */
  private stopReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private stopReconcileCycles = 0;
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
    /** 停止对账看门狗的节奏/轮数（测试注入用；缺省走模块常量） */
    stopReconcileDelayMs?: number;
    stopReconcileMaxCycles?: number;
  };

  constructor(
    client: PiClient,
    threadId: string,
    options: {
      scheduleNotify?: PiNotificationScheduler;
      stopReconcileDelayMs?: number;
      stopReconcileMaxCycles?: number;
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
    if (this.stopReconcileTimer) {
      clearTimeout(this.stopReconcileTimer);
      this.stopReconcileTimer = null;
    }
    this.allListeners.clear();
    this.metadataListeners.clear();
    this.messageListeners.clear();
    this.pendingPromptMessages.clear();
    this.disconnectFromEvents();
  }

  /** 是否有消费者（挂载中的 runtime / 连接保留期）：控制器缓存 LRU 淘汰前
   *  判用——正在被看的会话永不淘汰；后台跑 turn 的会话被摘除后，回合结果
   *  仍由 sidecar 落库 + pi-running 全局事件提醒兜底，切回时新控制器从快照
   *  重建（含在飞 partial 基底），不丢内容。 */
  public isInUse(): boolean {
    return this.hasConsumers();
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
        // 起跑即上屏：轮前压缩发生在 agent.prompt 之前，回显要等压缩结束，
        // 期间消息流里既没有气泡也没有等待行（见 revealPendingUserMessage）
        this.revealPendingUserMessage(requestId);
      }) ?? null;
    // prompt 终结（finish/error）：撤掉起跑后始终没等到回显的镜像
    this.unsubscribeFromPromptEnd =
      this.client.onPromptEnd?.(this.threadId, (requestId) => {
        if (generation !== this.eventSubscriptionGeneration) return;
        this.finishPendingPrompt(requestId);
      }) ?? null;
  }

  private disconnectFromEvents() {
    if (
      !this.unsubscribeFromEvents &&
      !this.unsubscribeFromPromptStart &&
      !this.unsubscribeFromPromptEnd
    ) {
      return;
    }
    this.unsubscribeFromEvents = null;
    this.unsubscribeFromPromptStart?.();
    this.unsubscribeFromPromptStart = null;
    this.unsubscribeFromPromptEnd?.();
    this.unsubscribeFromPromptEnd = null;
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

    // 冷读已完成的会话（切回/重挂触发）不再回写 loadState：每次回写都会
    // 「发布 → 全量通知」，而 store 每次提交都会 notifySubscribers；在挂载抖动
    // （控制器重建等）下这会放大成 forceStoreRerender → commit → notify 的
    // 同步嵌套自环（Maximum update depth exceeded / 界面卡死）。后台刷新照旧
    // 取快照；首次加载（pending）与强制刷新（refresh()）保持原 loading 语义。
    if (force || this.state.loadState !== "loaded") {
      this.setState({ ...this.state, loadState: "loading" });
    }
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
    /** 重发/编辑：与乐观气泡同一提交丢掉 seq >= beforeSeq 的旧行（见调用点） */
    truncateBeforeSeq?: number,
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

    // 资料库小笔记正文预取（≤16KB，发送汇聚点覆盖普通/排队/重发全路径）：
    // 命中的笔记随 prompt 内联，模型免一次 read；读取失败/超限保持路径引用
    await prefetchLibraryNoteBodies(appendMessageParts(message));
    const built = buildPiSendInput(message, behavior);
    // 所有发送都带预生成 id：排队条目 id 与协议 reqId 同值（逐项操作按它命
    // 中服务端），起跑/终结通知也按它找回本条消息（见 pendingPromptMessages）
    const requestId = options?.requestId ?? this.newQueueRequestId();
    const input: PiSendMessageInput = { ...built, requestId };
    // 改动（发图能力提示）：当前模型目录元数据标为纯文本输入而本次发送含图时
    // toast 提醒——不拦截（sidecar 因元数据不可靠已移除硬门，见
    // lib/pi/pi-vision-warning.ts 头注）。排队/steer/重生重发同经此汇聚点。
    maybeWarnUnsupportedImages(this.threadId, (input.attachments?.length ?? 0) > 0);
    this.ensureEventSubscription({ includeSnapshot: false });

    // 起跑上屏的登记口径：steer 并入语义本就「无感」（有并入徽标/回显承担
    // 反馈），截断重发已有即时镜像——两者都不再压第二份。其余（普通直发、
    // followUp 排队、接力泵重发）登记，等 start 帧到再上屏。
    // 纯文档消息（无文本、无图片）不登记：文档不在乐观消息的投影里（附件卡
    // 只认 image part），压出来会是一个空气泡；等回显的「[用户附件：…]」
    // 说明行更合适。
    const hasVisibleDraft =
      input.content.trim().length > 0 || (input.attachments?.length ?? 0) > 0;
    if (behavior !== "steer" && !optimisticMirror && hasVisibleDraft) {
      this.rememberPendingPrompt(requestId, input);
    }

    if (isQueuedSend) {
      try {
        return await this.sendQueued(input, behavior ?? "followUp");
      } catch (error) {
        // 入队失败（上限/传输异常）：本条不会起跑，撤掉待上屏登记
        this.pendingPromptMessages.delete(requestId);
        throw error;
      }
    }

    // 普通发送不在发送瞬间压气泡（服务端可能仍排队，气泡与队列条会并存）；
    // 但也不能只等回显——轮前压缩发生在 agent.prompt 之前，回显可能被压缩
    // 推迟几十秒，期间消息流里什么都没有。起跑帧（start）是「这条真开跑了」
    // 的权威信号，由 revealPendingUserMessage 在该帧上屏；回显到达后由
    // reconcileOptimisticUserMessages 去重，终结帧再由 finishPendingPrompt 兜底。
    if (!optimisticMirror) {
      try {
        await this.client.sendMessage(this.threadId, input);
      } catch (error) {
        this.pendingPromptMessages.delete(requestId);
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
    // 截断与镜像必须同一提交：先截断再压镜像会有一帧内容高度塌陷（旧回复
    // 消失了、新气泡/锚点垫片还没上），浏览器把 scrollTop 夹到新 max，下一帧
    // 垫片补回高度再滚回去——重发时那一下「上下一跳」就是这两帧造成的。
    const messages =
      truncateBeforeSeq === undefined
        ? this.state.messages
        : this.state.messages.filter((m) => {
            const seq = (m as { __seq?: unknown }).__seq;
            return !(typeof seq === "number" && seq >= truncateBeforeSeq);
          });
    this.setState(markStateRunning({ ...this.state, messages }));
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
    // 下界传 0（全文匹配）：见 sendUserAppend 头注——截断快照收缩在飞数组后，
    // 回显落点低于按下标取的界，重生成/编辑重发的乐观镜像会永久滞留成重复气泡。
    // 本地截断交给 sendUserAppend 与镜像同一次提交（避免中间一帧高度塌陷）。
    try {
      await this.sendUserAppend(message, undefined, 0, true, false, Number(match[1]));
    } finally {
      // 快照在镜像落位之后才拉：避免它在截断与气泡之间插入一次高度塌陷
      this.refreshInBackground();
    }
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

  /** 登记「已发出、等起跑」的用户消息。上限兜底：start/end 通知若因传输
   *  异常丢失，台账也不会随发送次数无限增长。 */
  private rememberPendingPrompt(
    requestId: string,
    input: PiSendMessageInput,
  ) {
    this.pendingPromptMessages.set(requestId, {
      message: optimisticUserMessageFromInput(
        input,
        `pi-optimistic:${++this.optimisticUserSeq}`,
      ),
      revealed: false,
      baseUserMessages: countUserMessages(this.state.messages),
    });
    while (this.pendingPromptMessages.size > 20) {
      const oldest = this.pendingPromptMessages.keys().next().value;
      if (oldest === undefined) break;
      this.pendingPromptMessages.delete(oldest);
    }
  }

  /** 起跑即上屏：把该 reqId 的消息推入乐观镜像。轮前压缩发生在 agent.prompt
   *  之前，此时转录里还没有这条 user 行，靠它撑过压缩期间的空窗。同一 id 只
   *  上屏一次（start 每流一帧）；回显到达后由 reconcile 摘除。
   *
   *  起跑帧与快照应答没有顺序保证：快照可能已经把这条 user 行带进来了（真实
   *  气泡已在屏上）。此时不能再压镜像——镜像按投影规则恒排在消息列表末尾，
   *  会变成「助手回复下面又冒出一条用户消息」的重复。 */
  private revealPendingUserMessage(requestId: string) {
    const pending = this.pendingPromptMessages.get(requestId);
    if (!pending || pending.revealed) return;
    pending.revealed = true;
    if (
      hasNewUserEcho(
        this.state.messages,
        pending.baseUserMessages,
        pending.message,
      )
    ) {
      return;
    }
    this.optimisticUserMessages.push({
      message: pending.message,
      baseMessageCount: this.state.messages.length,
      baseUserMessages: pending.baseUserMessages,
      requestId,
    });
    this.recomputeProjectedMessagesAndNotify();
  }

  /** 终结兜底：该 reqId 的 finish/error 已到，若镜像还没被回显确认（起跑后
   *  失败/被停止，消息从未落到转录），撤掉它，避免幽灵气泡留到下次刷新。 */
  private finishPendingPrompt(requestId: string) {
    const pending = this.pendingPromptMessages.get(requestId);
    if (!pending) return;
    this.pendingPromptMessages.delete(requestId);
    if (!pending.revealed) return;
    const index = this.optimisticUserMessages.findIndex(
      (entry) => entry.requestId === requestId,
    );
    if (index === -1) return;
    this.optimisticUserMessages.splice(index, 1);
    this.recomputeProjectedMessagesAndNotify();
  }

  /** sidecar 换代（pi_restarted）：旧实例的在飞 prompt 不会再收到 finish，
   *  起跑时上屏、始终没等到回显的镜像因此没有清理出口，会一直挂到控制器被
   *  淘汰。这里撤掉这些已上屏的镜像；尚未起跑的登记保留（排队项可能随
   *  queue_state 恢复后重新派发，起跑帧还要用它上屏）。
   *  确实已落盘的消息由紧随的对账快照带回；重发路径的即时镜像没有
   *  requestId，同样保留——它同时承担截断后空位的占位。 */
  public discardLostPrompts(): void {
    for (const [requestId, pending] of this.pendingPromptMessages) {
      if (pending.revealed) this.pendingPromptMessages.delete(requestId);
    }
    const kept = this.optimisticUserMessages.filter((entry) => !entry.requestId);
    if (kept.length === this.optimisticUserMessages.length) return;
    this.optimisticUserMessages.length = 0;
    this.optimisticUserMessages.push(...kept);
    this.recomputeProjectedMessagesAndNotify();
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
    // 新一次停止从 0 计轮：上一轮看门狗走满放弃路径时计数停在 max，且那次
    // 运行之后多半由 agent_end 收尾（无回调可清零）——不清会让下一次停止
    // 带着满值计数，看门狗第一轮就不再重试
    this.stopReconcileCycles = 0;
    try {
      await this.client.cancelRun(this.threadId);
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) });
      // abort 没送达（传输层异常 = sidecar 已死/卡死）更要兜：run 大概率
      // 永远不会结算，看门狗快照对账是唯一归位出口
      this.armStopReconcile();
      throw error;
    }
    this.armStopReconcile();
  }

  /** 停止对账看门狗：正常情况下 abort 后 agent_end 一两秒内就到；但 sidecar
   *  换代（dev --watch 热重启/崩溃重启）后 running 表已空，agent_end 永远
   *  不会来——UI 卡在 running，再点停止也是对空表 abort。超时未结算就拉
   *  快照对账（快照权威）；快照仍报 running（abort 在串行队列里排队/收尾
   *  中）则有限次重排，超过即放弃——后续 agent_end 或 pi_restarted 广播
   *  仍会兜底归位。 */
  private armStopReconcile() {
    if (this.stopReconcileTimer) clearTimeout(this.stopReconcileTimer);
    const delayMs =
      this.options.stopReconcileDelayMs ?? STOP_RECONCILE_DELAY_MS;
    const maxCycles =
      this.options.stopReconcileMaxCycles ?? STOP_RECONCILE_MAX_CYCLES;
    this.stopReconcileTimer = setTimeout(() => {
      this.stopReconcileTimer = null;
      if (this.state.runStatus !== "running") {
        this.stopReconcileCycles = 0;
        return;
      }
      this.stopReconcileCycles += 1;
      void this.refresh()
        .catch(() => {
          // load() 已把错误记进 state.lastError
        })
        .finally(() => {
          if (this.state.runStatus !== "running") {
            this.stopReconcileCycles = 0;
            return;
          }
          if (this.stopReconcileCycles < maxCycles) {
            this.armStopReconcile();
          }
        });
    }, delayMs);
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
      // 起跑上屏的镜像按「发送时的 user 行数」确认（快照可替换数组，下标不可靠）；
      // 重发路径的即时镜像沿用原来的下标下界
      const confirmed =
        entry.baseUserMessages !== undefined
          ? hasNewUserEcho(
              this.state.messages,
              entry.baseUserMessages,
              entry.message,
            )
          : (() => {
              const key = userContentKey(entry.message);
              return this.state.messages
                .slice(entry.baseMessageCount)
                .some((message) => {
                  const echoed = userContentKey(message);
                  // 前缀匹配：附件被 sidecar 拒收时，落盘文本是 noticeAppendedText
                  // 原文 + 拒收/落盘说明行（prompt-attachments），全文相等会让镜像
                  // 永远摘不掉 → 气泡与回显行重复并存
                  return (
                    echoed === key ||
                    (key !== null &&
                      key.length > 0 &&
                      echoed?.startsWith(key) === true)
                  );
                });
            })();
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
      this.projectionCache,
    );
  }

  private recomputeProjectedMessagesAndNotify() {
    const t0 =
      process.env.NODE_ENV === "production" ? 0 : performance.now();
    const next = this.projectMessages();
    if (next === this.projectedMessages) {
      if (this.state !== this.stateSnapshot) this.publishState();
      if (t0) noteSpan("投影+通知", performance.now() - t0);
      return;
    }
    this.projectedMessages = next;
    // 增量重建仓库：未变的投影消息复用上次的转换结果（对象身份因此跨帧稳定），
    // 只有真正变过的那条走一遍转换。链式 parentId 与原 fromArray 口径一致。
    const converted = next.map((m) => {
      const hit = this.runtimeMessageCache.get(m);
      if (hit) return hit;
      const one = ExportedMessageRepository.fromArray([m]).messages[0]!.message;
      this.runtimeMessageCache.set(m, one);
      return one;
    });
    this.messageRepository = {
      messages: converted.map((m, idx) => ({
        parentId: idx > 0 ? converted[idx - 1]!.id : null,
        message: m,
      })),
    };
    // 通知扇出跑完才算完：store 每次更新都会把所有已挂载的 useAuiState 选择器
    // 同步跑一遍（见 @assistant-ui/store 的 notifySubscribers），这笔开销既不在
    // React 的 render 阶段里、也不在 paint 里——正是「最长帧远大于渲染+绘制」的
    // 缺口中最大的一块嫌疑。计时口径含投影 + 仓库重建 + 通知扇出。
    this.notifyMessageListeners();
    if (t0) noteSpan("投影+通知", performance.now() - t0);
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
