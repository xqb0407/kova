// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/threadState.ts（runtime/ 子目录对应上游 src/runtime/）

/**
 * Pure, incremental per-thread reducer.
 *
 * Design:
 * - The canonical transcript is `PiAgentMessage[]`. A `snapshot` event replaces
 *   it wholesale and is **authoritative** — so the reducer never depends on
 *   fragile event ordering; any divergence self-heals on the next snapshot.
 * - Between snapshots, streaming events patch only the changed tail:
 *   `message_start` appends, `message_update` replaces the streaming assistant
 *   message in place (Pi guarantees `start` before partial updates), and
 *   `tool_execution_update` buffers live partial output by `toolCallId`.
 * - Unknown event types are tolerated: they bump `lastSeq` and are otherwise
 *   ignored (the controller layers a full-refresh fallback on top).
 *
 * This module is browser-safe and imports no `@earendil-works/*` packages.
 */

import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiClientEvent,
  PiContextUsage,
  PiHostUiRequest,
  PiQueueEntry,
  PiRuntimeReadiness,
  PiThreadMetadata,
  PiThreadSnapshot,
} from "../types";
import { seqOf } from "./messageIdPins";
export type PiRunStatus = "idle" | "running" | "failed";

export type PiLoadState = "pending" | "loading" | "loaded";

export interface PiToolExecutionState {
  toolCallId: string;
  toolName?: string;
  args?: unknown;
  /** Latest streaming partial result (same shape as the final tool result:
   * `{ content: [{ type: "text", text }], details? }`). Superseded by the
   * `toolResult` message once it lands in the transcript. */
  partialResult?: unknown;
  status: "running" | "complete" | "error";
}

export interface PiThreadState {
  threadId: string;
  metadata: PiThreadMetadata;
  /** Canonical transcript — source of truth for projection. */
  messages: readonly PiAgentMessage[];
  /** 分页窗（§6）：本窗之前的更早转录行（loadMoreHistory 逐页前置；seq 升序，
   *  与本窗衔接）。投影输入 = olderMessages + messages；快照替换只动 messages，
   *  旧页因此不会被后台刷新冲掉。 */
  olderMessages: readonly PiAgentMessage[];
  /** 本窗/已加载页之前还有更早行（列表上沿「加载更多」的开关）。 */
  historyHasMore: boolean;
  /** 上一页拉取在途（列表上沿 loading 态；防重复触发）。 */
  historyLoading: boolean;
  /** Index into `messages` of the assistant message currently streaming, or
   * `undefined` when not streaming. */
  streamingMessageIndex: number | undefined;
  /** Live streaming tool output, keyed by `toolCallId`. */
  toolExecutions: Readonly<Record<string, PiToolExecutionState>>;
  runStatus: PiRunStatus;
  // 改动（4a）：条目化队列（id = 真实 reqId），支撑逐项操作；上游为内容字符串
  queue: { steering: readonly PiQueueEntry[]; followUp: readonly PiQueueEntry[] };
  contextUsage: PiContextUsage | undefined;
  compaction: { active: boolean; reason?: "manual" | "threshold" | "overflow" };
  retry: { active: boolean; attempt: number };
  /** Pending blocking host-UI requests (Pi's approval surface). */
  hostUiRequests: readonly PiHostUiRequest[];
  readiness: PiRuntimeReadiness | undefined;
  lastError: string | undefined;
  loadState: PiLoadState;
  /** Sequence watermark for ordering/dedup. An authoritative snapshot can
   * lower it when the supervisor starts a new sequence. */
  lastSeq: number;
}

const EMPTY_METADATA = (threadId: string): PiThreadMetadata => ({
  id: threadId,
  status: "idle",
});

export const createPiThreadState = (threadId: string): PiThreadState => ({
  threadId,
  metadata: EMPTY_METADATA(threadId),
  messages: [],
  olderMessages: [],
  historyHasMore: false,
  historyLoading: false,
  streamingMessageIndex: undefined,
  toolExecutions: {},
  runStatus: "idle",
  queue: { steering: [], followUp: [] },
  contextUsage: undefined,
  compaction: { active: false },
  retry: { active: false, attempt: 0 },
  hostUiRequests: [],
  readiness: undefined,
  lastError: undefined,
  loadState: "pending",
  lastSeq: 0,
});

const isAssistantMessage = (
  message: PiAgentMessage | undefined,
): message is PiAssistantMessage => message?.role === "assistant";

const withMetadataStatus = (
  metadata: PiThreadMetadata,
  status: PiThreadState["metadata"]["status"],
): PiThreadMetadata =>
  metadata.status === status ? metadata : { ...metadata, status };

const withMetadataActivity = (
  metadata: PiThreadMetadata,
  compaction: PiThreadState["compaction"],
  retry: PiThreadState["retry"],
): PiThreadMetadata =>
  metadata.compactionActive === compaction.active &&
  metadata.retryActive === retry.active &&
  metadata.retryAttempt === retry.attempt
    ? metadata
    : {
        ...metadata,
        compactionActive: compaction.active,
        retryActive: retry.active,
        retryAttempt: retry.attempt,
      };

/** 按 seq 归并「旧于 windowFirst」的行（olderMessages + 上一窗的行），seq 升序去重。
 *  分页窗上任一快照替换 messages 时用它捡回本窗之前的已加载行：
 *  ① 此前逐页前置的旧页；② 上一窗里落在新窗首之前的部分——转录增长后新窗首
 *  右移，两窗之间的行只能从旧窗捡，否则上翻出现空档。
 *  只有带分页元数据（firstSeq）的窗口才捡：全量快照本身已含全部行，捡了重复。
 *  无 seq 的行（在飞 partial）恒属尾部，不捡。 */
const carryOlderRows = (
  older: readonly PiAgentMessage[],
  previous: readonly PiAgentMessage[],
  windowFirst: number | undefined,
): readonly PiAgentMessage[] => {
  if (windowFirst === undefined) return older.length ? [] : older;
  const bySeq = new Map<number, PiAgentMessage>();
  for (const message of [...older, ...previous]) {
    const seq = seqOf(message);
    if (seq === undefined || seq >= windowFirst) continue;
    // 先见者胜：转录行按 seq append-only，同 seq 的行对象不会再变；保留已在
    // 旧页里的那一份，重放同一页/快照反复派发不会换行身份（React 不重挂）
    if (!bySeq.has(seq)) bySeq.set(seq, message);
  }
  if (bySeq.size === 0) return older.length ? [] : older;
  const merged = [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, message]) => message);
  // 内容与旧数组一致（同序同行）时保持引用：快照反复派发不产生新的投影输入
  if (
    merged.length === older.length &&
    merged.every((message, index) => message === older[index])
  ) {
    return older;
  }
  return merged;
};

const applySnapshot = (
  state: PiThreadState,
  snapshot: PiThreadSnapshot,
): PiThreadState => {
  const runStatus: PiRunStatus =
    snapshot.metadata.status === "running"
      ? "running"
      : snapshot.metadata.status === "failed"
        ? "failed"
        : "idle";
  // Older supervisors omit activity flags, so settled status remains their
  // only signal that neither operation is in flight.
  const settled = runStatus !== "running";
  const compactionActive =
    snapshot.metadata.compactionActive ??
    (settled ? false : state.compaction.active);
  const retryActive =
    snapshot.metadata.retryActive ?? (settled ? false : state.retry.active);

  const compaction = compactionActive
    ? { ...state.compaction, active: true }
    : { active: false };
  const retry = retryActive
    ? {
        active: true,
        attempt: snapshot.metadata.retryAttempt ?? state.retry.attempt,
      }
    : { active: false, attempt: 0 };

  // 运行中快照的尾巴可能是 sidecar thread_snapshot 并入的在飞 partial
  // （peekPartial）：该消息后续的直播 message_update/message_end 必须就地写
  // 这条尾巴。指针若留空，无指针分支会把同一 assistant 再 append 一份，
  // 投影把相邻 assistant 并成同一条 UI 消息后出现两份相同 toolCallId 的
  // part——@assistant-ui 按 toolCallId 键控消息 part 查找表，直接 Duplicate
  // key 崩溃。尾巴若是刚落定的完整 assistant（partial 台账已清、下一事件
  // 必是 message_start），复原的指针会被 start 指向的新消息覆盖，同样无害。
  const lastSnapshotMessage = snapshot.messages[snapshot.messages.length - 1];
  const streamingMessageIndex =
    runStatus === "running" && isAssistantMessage(lastSnapshotMessage)
      ? snapshot.messages.length - 1
      : undefined;

  return {
    ...state,
    metadata: withMetadataActivity(snapshot.metadata, compaction, retry),
    messages: snapshot.messages,
    // 分页窗：快照只含尾窗，前面已加载的旧行捡回（见 carryOlderRows）
    olderMessages: carryOlderRows(
      state.olderMessages,
      state.messages,
      snapshot.firstSeq,
    ),
    historyHasMore: snapshot.hasMore ?? false,
    // Snapshot is authoritative: drop transient streaming pointers/buffers so
    // any divergence self-heals — except the in-flight tail pointer rebuilt above.
    streamingMessageIndex,
    toolExecutions: {},
    runStatus,
    compaction,
    retry,
    // A missing `queuedMessages` means an empty queue (snapshots omit the
    // field when there is nothing queued, and cold threads have no queue at
    // all) — keeping the prior queue here would let items drained while the
    // event stream was down survive a reconnect snapshot forever.
    // 改动（4a）：快照条目直映（queuedMessages 的 id/content 即队列条目）。
    queue: {
      steering: (snapshot.metadata.queuedMessages ?? [])
        .filter((m) => m.mode === "steer")
        .map((m) => ({ id: m.id, content: m.content })),
      followUp: (snapshot.metadata.queuedMessages ?? [])
        .filter((m) => m.mode === "followUp")
        .map((m) => ({ id: m.id, content: m.content })),
    },
    contextUsage: snapshot.metadata.contextUsage ?? state.contextUsage,
    hostUiRequests: snapshot.hostUiRequests ?? [],
    readiness: snapshot.readiness ?? state.readiness,
    lastError: snapshot.lastError,
    loadState: "loaded",
  };
};

/** 上翻一页（§6）：更早的行前置进 olderMessages（seq 升序去重），并更新 hasMore。
 *  windowFirst 取当前窗首行的 seq——页行只会落在它之前；窗口为空（空会话）时
 *  视为无边界。全部行被去重吞掉时保持引用不变（避免无谓重渲）。 */
export const prependOlderHistory = (
  state: PiThreadState,
  rows: readonly PiAgentMessage[],
  hasMore: boolean,
): PiThreadState => {
  const windowFirst = seqOf(state.messages[0]) ?? Number.POSITIVE_INFINITY;
  const merged = carryOlderRows(state.olderMessages, rows, windowFirst);
  if (merged === state.olderMessages && state.historyHasMore === hasMore) {
    return state;
  }
  return { ...state, olderMessages: merged, historyHasMore: hasMore };
};

const replaceAt = <T>(arr: readonly T[], index: number, value: T): T[] => {
  const next = arr.slice();
  next[index] = value;
  return next;
};

const upsertToolExecution = (
  state: PiThreadState,
  toolCallId: string,
  patch: Partial<PiToolExecutionState>,
): PiThreadState => ({
  ...state,
  toolExecutions: {
    ...state.toolExecutions,
    [toolCallId]: {
      // 改动：上游写法为先铺默认值再展开旧值（toolCallId/status 会被旧值覆盖，
      // TS2783 报错），此处等价改写为「无旧值时才铺默认」，语义不变
      ...(state.toolExecutions[toolCallId] ?? {
        toolCallId,
        status: "running",
      }),
      ...patch,
    },
  },
});

export const removeHostUiRequest = (
  state: PiThreadState,
  requestId: string,
): PiThreadState => {
  if (!state.hostUiRequests.some((r) => r.id === requestId)) return state;
  return {
    ...state,
    hostUiRequests: state.hostUiRequests.filter((r) => r.id !== requestId),
  };
};

/**
 * Apply a single client event. Pure: returns a new state (or the same reference
 * when nothing changed). Non-snapshot events older than `lastSeq` are ignored;
 * current snapshots apply as authoritative state.
 */
export const reducePiThreadState = (
  state: PiThreadState,
  event: PiClientEvent,
): PiThreadState => {
  // Errors bypass the dedup guard alongside snapshots: they can be emitted
  // out-of-band (e.g. a failed `subscribe` is reported at seq 0, below any
  // live seq) and re-applying one is harmless.
  if (
    event.type !== "snapshot" &&
    event.type !== "error" &&
    event.seq <= state.lastSeq
  ) {
    return state;
  }

  const stamped = (next: PiThreadState): PiThreadState =>
    next === state && event.seq <= state.lastSeq
      ? next
      : { ...next, lastSeq: Math.max(state.lastSeq, event.seq) };

  switch (event.type) {
    case "snapshot": {
      const next = applySnapshot(state, event.snapshot);
      const sequenceReset = event.seq < state.lastSeq;
      return {
        ...next,
        lastSeq: sequenceReset
          ? Math.max(event.seq, event.snapshot.seq ?? 0)
          : Math.max(state.lastSeq, event.seq, event.snapshot.seq ?? 0),
      };
    }

    case "agent_start":
      return stamped({
        ...state,
        runStatus: "running",
        lastError: undefined,
        metadata: withMetadataStatus(state.metadata, "running"),
      });

    case "agent_end": {
      const running = event.willRetry === true;
      return stamped({
        ...state,
        runStatus: running ? "running" : "idle",
        streamingMessageIndex: undefined,
        metadata: withMetadataStatus(
          state.metadata,
          running ? "running" : "idle",
        ),
      });
    }

    case "message_start": {
      const messages = [...state.messages, event.message];
      return stamped({
        ...state,
        messages,
        streamingMessageIndex: isAssistantMessage(event.message)
          ? messages.length - 1
          : state.streamingMessageIndex,
      });
    }

    case "message_update": {
      // The event carries the full current assistant message; replace the
      // streaming tail in place. If we somehow have no streaming pointer yet
      // (e.g. update before start), append it.
      if (
        state.streamingMessageIndex !== undefined &&
        state.streamingMessageIndex < state.messages.length
      ) {
        return stamped({
          ...state,
          messages: replaceAt(
            state.messages,
            state.streamingMessageIndex,
            event.message,
          ),
        });
      }
      const messages = [...state.messages, event.message];
      return stamped({
        ...state,
        messages,
        streamingMessageIndex: messages.length - 1,
      });
    }

    case "message_end": {
      if (
        state.streamingMessageIndex !== undefined &&
        state.streamingMessageIndex < state.messages.length
      ) {
        return stamped({
          ...state,
          messages: replaceAt(
            state.messages,
            state.streamingMessageIndex,
            event.message,
          ),
          streamingMessageIndex: undefined,
        });
      }
      return stamped({ ...state, streamingMessageIndex: undefined });
    }

    case "tool_execution_start":
      return stamped(
        upsertToolExecution(state, event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
          status: "running",
        }),
      );

    case "tool_execution_update":
      return stamped(
        upsertToolExecution(state, event.toolCallId, {
          ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
          partialResult: event.partialResult,
          status: "running",
        }),
      );

    case "tool_execution_end":
      return stamped(
        upsertToolExecution(state, event.toolCallId, {
          partialResult: event.result,
          status: event.isError ? "error" : "complete",
        }),
      );

    case "queue_update":
      return stamped({
        ...state,
        queue: { steering: event.steering, followUp: event.followUp },
      });

    case "compaction_start": {
      const compaction = { active: true, reason: event.reason };
      return stamped({
        ...state,
        compaction,
        metadata: withMetadataActivity(state.metadata, compaction, state.retry),
      });
    }

    case "compaction_end": {
      const compaction = { active: false };
      return stamped({
        ...state,
        compaction,
        metadata: withMetadataActivity(state.metadata, compaction, state.retry),
      });
    }

    case "auto_retry_start": {
      const retry = { active: true, attempt: event.attempt };
      return stamped({
        ...state,
        retry,
        metadata: withMetadataActivity(state.metadata, state.compaction, retry),
      });
    }

    case "auto_retry_end": {
      const retry = { active: false, attempt: 0 };
      return stamped({
        ...state,
        retry,
        metadata: withMetadataActivity(state.metadata, state.compaction, retry),
      });
    }

    case "context_usage":
      return stamped({ ...state, contextUsage: event.contextUsage });

    case "session_info_changed": {
      const metadata = { ...state.metadata };
      if (event.name !== undefined) metadata.title = event.name;
      else delete metadata.title;
      return stamped({ ...state, metadata });
    }

    case "thinking_level_changed":
      return stamped({
        ...state,
        metadata: {
          ...state.metadata,
          config: { ...state.metadata.config, thinkingLevel: event.level },
        },
      });

    case "extension_ui_request": {
      const exists = state.hostUiRequests.some(
        (r) => r.id === event.request.id,
      );
      if (exists) return stamped(state);
      return stamped({
        ...state,
        hostUiRequests: [...state.hostUiRequests, event.request],
      });
    }

    case "extension_ui_resolved":
      return stamped(removeHostUiRequest(state, event.requestId));

    case "error":
      return stamped({
        ...state,
        lastError: event.error,
        runStatus: "failed",
        metadata: withMetadataStatus(state.metadata, "failed"),
      });

    case "agent_settled":
    case "entry_appended":
      return stamped(state);

    default:
      // Forward-compatible: unknown event types are tolerated (seq bumped via
      // `stamped`), the controller decides whether to full-refresh.
      return stamped(state);
  }
};
