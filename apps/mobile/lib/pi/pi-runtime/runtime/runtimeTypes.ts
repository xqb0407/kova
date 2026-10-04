// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/runtimeTypes.ts（runtime/ 子目录对应上游 src/runtime/）
// 改动：AssistantCloud 改为直接从 assistant-cloud 导入——
// @assistant-ui/react-native 不再转出该类型（0.15.22 起 cloud 独立成包）。
// 移动端不配 cloud（无 NEXT_PUBLIC_ASSISTANT_BASE_URL），该字段恒为 undefined，
// 但保留以维持与上游的运行时结构一致。

import type { AssistantCloud } from "assistant-cloud";
import type {
  ExternalStoreAdapter,
  ExternalStoreSharedOptions,
  ThreadMessageLike,
} from "@assistant-ui/react-native";
import type { PiThreadControllerLike } from "./ThreadController";
import type { PiInterruptAnswer } from "./hostUi";
import type { PiThreadState } from "./threadState";
import type {
  PiClient,
  PiContextUsage,
  PiHostUiRequest,
  PiHostUiResponse,
  PiQueueEntry,
  PiRuntimeReadiness,
  PiThinkingLevel,
  PiThreadMetadata,
  PiThreadStatus,
} from "../types";

export type PiRuntimeOptions = ExternalStoreSharedOptions & {
  /** The transport-agnostic Pi client (HTTP/SSE, RPC, IPC). */
  client: PiClient;
  /** Backs the thread list with Assistant Cloud; each cloud thread maps to a Pi thread. */
  cloud?: AssistantCloud | undefined;
  /** Workspace scoping for the thread list. With `cloud`, the list holds every thread of the cloud project and this only places new Pi threads. */
  workspacePath?: string;
  /** Lists archived threads too. Not used with `cloud`, whose list keeps archived threads apart. */
  includeArchived?: boolean;
  /** The thread to open first: a Pi thread id, or with `cloud` a cloud thread id. */
  initialThreadId?: string;
  /** The thread to show: a Pi thread id, or with `cloud` a cloud thread id. */
  threadId?: string;
  /** Notified when the active thread's settled remote ID changes; `undefined` while still optimistic. */
  onThreadIdChange?: ((threadId: string | undefined) => void) | undefined;
  onError?: (error: unknown) => void;
  adapters?: ExternalStoreAdapter<ThreadMessageLike>["adapters"];
};

export interface PiRuntimeExtras {
  state: PiThreadState;
  metadata: PiThreadMetadata;
  status: PiThreadStatus;
  readiness: PiRuntimeReadiness | undefined;
  contextUsage: PiContextUsage | undefined;
  /** Pending side-channel (free-standing) host-UI requests — those not attached
   * to a tool call. Tool-associated requests render as the tool call's
   * approval instead. */
  hostUiRequests: readonly PiHostUiRequest[];
  /** All pending host-UI requests, including tool-associated ones. */
  allHostUiRequests: readonly PiHostUiRequest[];
  queue: PiThreadState["queue"];
  compaction: PiThreadState["compaction"];
  retry: PiThreadState["retry"];
  lastError: string | undefined;
  /** 分页窗（§6）：本窗/已加载页之前还有更早的历史（列表上沿可加载）。 */
  historyHasMore: boolean;
  /** 上一页拉取在途（列表上沿 loading 态）。 */
  historyLoading: boolean;
  /** 上翻一页更早的历史（前置进投影前部；幂等）。 */
  loadMoreHistory: () => Promise<void>;
  cancel: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Clear Pi's queued (steering + follow-up) messages; resolves with the
   * cleared text so it can be restored into the composer. */
  clearQueue: () => Promise<{ steering: string[]; followUp: string[] }>;
  // 改动（4a）：逐项队列操作（id = 真实 reqId）。编辑 = 回填 composer +
  // queueCancel，由队列栏 UI 组合，不单设 edit 面。
  queueCancel: (id: string) => Promise<void>;
  queuePromote: (id: string) => Promise<void>;
  queueSteer: (id: string) => Promise<void>;
  // 改动（4a）：弹出队首交由前端重发（接力泵用）；无孤儿队列时为 null。
  queuePop: () => Promise<PiQueueEntry | null>;
  setModel: (input: { provider: string; modelId: string }) => Promise<void>;
  setThinkingLevel: (level: PiThinkingLevel) => Promise<void>;
  respondToHostUiRequest: (response: PiHostUiResponse) => Promise<void>;
  respondToToolApproval: (id: string, approved: boolean) => Promise<void>;
  resumeToolCall: (
    toolCallId: string,
    payload: PiInterruptAnswer,
  ) => Promise<void>;
}

export type PiRuntimeExtrasInternal = PiRuntimeExtras & {
  controller: PiThreadControllerLike;
};
