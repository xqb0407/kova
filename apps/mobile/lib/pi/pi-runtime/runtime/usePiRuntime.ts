// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/usePiRuntime.ts（runtime/ 子目录对应上游 src/runtime/）

"use client";

import {
  ExportedMessageRepository,
  useAui,
  useAuiState,
  useCloudThreadListAdapter,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react-native";
import type {
  AssistantRuntime,
  ExternalStoreAdapter,
  ExternalThreadQueueAdapter,
  ThreadMessage,
  ThreadMessageLike,
} from "@assistant-ui/react-native";
import { invokeUserCallback } from "@assistant-ui/core/internal";
import { useReplaySafeEffect } from "./useReplaySafeEffect";
import {
  useEffect,
  useEffectEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  PiThreadController,
  type PiThreadControllerLike,
} from "./ThreadController";
import { createPiThreadState, type PiThreadState } from "./threadState";
import type { PiClient, PiThreadMetadata } from "../types";
import {
  responseForToolApproval,
  splitHostUiRequests,
  type PiInterruptAnswer,
} from "./hostUi";
import { piExtras } from "./piExtras";
import type { PiRuntimeExtrasInternal, PiRuntimeOptions } from "./runtimeTypes";
import { PI_SDK } from "../sdkIdentity";
import { disposeControllers } from "./disposeControllers";
// 桌面扩展（迁移 4c/5）：本地线程 id -> pi sessionId 绑定登记。新链路的
// threadListItem.id 在本会话内保持 __LOCALID_ 原值（core reconcileInitializedThread
// 保留原 mapping id），只有刷新后才等于 sessionId——消费侧请求（context_info/
// set_mode/主题胶囊等）全靠这张表把线程 id 换成 sessionId，否则 threadId-only
// 请求会让 sidecar 懒建空白会话（对话失忆）。
import { piSessionRegistry } from "@/lib/pi/pi-thread-adapter";
import { setImageRematerializeHandler } from "@/lib/pi/image-materialize";
import {
  MAX_CACHED_CONTROLLERS,
  pruneControllers,
  touchController,
} from "./controllerCache";
import { flushDraftAppModeSelection } from "@/lib/pi/pi-session-app-mode";
import { flushDraftModelSelection } from "@/lib/pi/pi-session-model";
import { flushDraftThinkingSelection } from "@/lib/pi/pi-session-thinking";

const EMPTY_THREAD_STATE = createPiThreadState("__pending__");
const EMPTY_PROJECTED_MESSAGES: readonly ThreadMessageLike[] = [];
const EMPTY_MESSAGE_REPOSITORY = ExportedMessageRepository.fromArray([]);

/** §6 会话列表页大小：一页 40 条，滚到底自动续下一页（桌面端无分页，恒全量） */
const SESSION_LIST_PAGE_SIZE = 40;

// ---------------------------------------------------------------------------
// Controller registry (cached across StrictMode remounts).
// ---------------------------------------------------------------------------

type PiControllerRegistry = {
  /** The client these controllers are bound to (a new client ⇒ a new registry). */
  client: PiClient;
  controllers: Map<string, PiThreadController>;
  readonly disposed: boolean;
  activate(): void;
  dispose(): void;
};

const createRegistry = (client: PiClient): PiControllerRegistry => {
  const controllers = new Map<string, PiThreadController>();
  let disposed = false;
  return {
    client,
    controllers,
    get disposed() {
      return disposed;
    },
    activate() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      disposeControllers(controllers.values());
      // Controllers stay cached so a StrictMode cleanup/remount reuses them;
      // a real unmount drops this whole registry.
    },
  };
};

/** 内存治理：LRU 台账与逐出规则收在 controllerCache（纯逻辑，有单测）。
 *  默认保留最近使用的 3 个；切会话时 useRuntimeHook 会收紧到「只留活动会话」，
 *  上一会话的转录窗口（含图片 base64）随之可回收——RN 的 Image 没有清缓存 API
 *  （0.86 只有 queryCache/prefetch），图片内存的闸门就在「行对象还有没有人引用」。 */
const getController = (registry: PiControllerRegistry, threadId: string) => {
  const existing = registry.controllers.get(threadId);
  if (!existing) {
    const created = new PiThreadController(registry.client, threadId);
    registry.controllers.set(threadId, created);
  }
  touchController(threadId);
  pruneControllers(registry.controllers, threadId, MAX_CACHED_CONTROLLERS, (error) =>
    console.error("[pi-runtime] controller dispose failed", error),
  );
  return registry.controllers.get(threadId)!;
};

export const NOOP_CONTROLLER: PiThreadControllerLike = {
  getState: () => EMPTY_THREAD_STATE,
  getProjectedMessages: () => EMPTY_PROJECTED_MESSAGES,
  getMessageRepository: () => EMPTY_MESSAGE_REPOSITORY,
  getVersion: () => 0,
  subscribe: () => () => {},
  subscribeMetadata: () => () => {},
  subscribeMessages: () => () => {},
  connect: () => () => {},
  load: async () => {},
  refresh: async () => {},
  // 分页窗（§6）：无活动线程时上翻是 no-op
  loadMoreHistory: async () => {},
  sendMessage: async () => {},
  // 症状3：reload/edit 桩（无活动线程时静默 no-op，与 4a 队列桩同款语义）
  reloadMessage: async () => {},
  editMessage: async () => {},
  cancel: async () => {},
  clearQueue: async () => ({ steering: [], followUp: [] }),
  // 改动（4a）：NOOP 桩补齐逐项操作（无活动线程时静默 no-op）
  queueCancel: async () => {},
  queuePromote: async () => {},
  queueSteer: async () => {},
  queuePop: async () => null,
  setModel: async () => {},
  setThinkingLevel: async () => {},
  respondToToolApproval: async () => {},
  resumeToolCall: async () => {},
  respondToHostUiRequest: async () => {},
  dispose: () => {},
};

const invokePiErrorCallback = (
  onError: PiRuntimeOptions["onError"],
  error: unknown,
) => {
  void invokeUserCallback("react-pi", "onError", onError, error);
};

const buildExtras = (
  controller: PiThreadControllerLike,
  state: PiThreadState,
): PiRuntimeExtrasInternal => {
  const { freeStanding } = splitHostUiRequests(state.hostUiRequests);
  return piExtras.provide({
    controller,
    state,
    metadata: state.metadata,
    status: state.runStatus === "failed" ? "failed" : state.runStatus,
    readiness: state.readiness,
    contextUsage: state.contextUsage,
    hostUiRequests: freeStanding,
    allHostUiRequests: state.hostUiRequests,
    queue: state.queue,
    compaction: state.compaction,
    retry: state.retry,
    lastError: state.lastError,
    // 分页窗（§6）：列表上沿加载更多的开关/在途态 + 动作
    historyHasMore: state.historyHasMore,
    historyLoading: state.historyLoading,
    loadMoreHistory: () => controller.loadMoreHistory(),
    cancel: () => controller.cancel(),
    refresh: () => controller.refresh(),
    clearQueue: () => controller.clearQueue(),
    // 改动（4a）：逐项队列操作透出
    queueCancel: (id) => controller.queueCancel(id),
    queuePromote: (id) => controller.queuePromote(id),
    queueSteer: (id) => controller.queueSteer(id),
    queuePop: () => controller.queuePop(),
    setModel: (input) => controller.setModel(input),
    setThinkingLevel: (level) => controller.setThinkingLevel(level),
    respondToHostUiRequest: (response) =>
      controller.respondToHostUiRequest(response),
    respondToToolApproval: (id, approved) =>
      controller.respondToToolApproval(id, approved),
    resumeToolCall: (toolCallId, payload) =>
      controller.resumeToolCall(toolCallId, payload),
  });
};

export const EMPTY_RUNTIME_EXTRAS = buildExtras(
  NOOP_CONTROLLER,
  EMPTY_THREAD_STATE,
);

// ---------------------------------------------------------------------------
// Per-thread runtime.
// ---------------------------------------------------------------------------

const stateSnapshotOf = (controller: PiThreadControllerLike): PiThreadState =>
  controller.getStateSnapshot?.() ?? controller.getState();

const usePiControllerState = (
  controller: PiThreadControllerLike,
): PiThreadState => {
  const getSnapshot = useCallback(
    () => stateSnapshotOf(controller),
    [controller],
  );
  return useSyncExternalStore(
    useCallback(
      (listener: () => void) => controller.subscribe(listener),
      [controller],
    ),
    getSnapshot,
    getSnapshot,
  );
};

const usePiControllerMessageRepository = (
  controller: PiThreadControllerLike,
): ExportedMessageRepository => {
  const getSnapshot = useCallback(
    () => controller.getMessageRepository(),
    [controller],
  );
  return useSyncExternalStore(
    useCallback(
      (listener: () => void) => controller.subscribeMessages(listener),
      [controller],
    ),
    getSnapshot,
    getSnapshot,
  );
};

export const usePiControllerStateSelector = <T>(
  controller: PiThreadControllerLike,
  selector: (state: PiThreadState) => T,
): T => {
  // `useSyncExternalStore` compares snapshots with `Object.is`, so selecting
  // inside `getSnapshot` is what lets the store observe the selected slice
  // rather than the whole state. Memoizing on the source state keeps repeated
  // reads of one state object referentially stable; re-keying the memo on the
  // selector re-runs a changed closure instead of replaying its last result.
  const getSelection = useMemo(() => {
    let memo: { state: PiThreadState; selection: T } | undefined;
    return () => {
      const state = stateSnapshotOf(controller);
      if (!memo || memo.state !== state)
        memo = { state, selection: selector(state) };
      return memo.selection;
    };
  }, [controller, selector]);

  return useSyncExternalStore(
    useCallback(
      (listener: () => void) => controller.subscribe(listener),
      [controller],
    ),
    getSelection,
    getSelection,
  );
};

const isPiStateRunning = (state: PiThreadState): boolean =>
  state.runStatus === "running" ||
  state.compaction.active ||
  state.retry.active;

const usePiThreadStore = (
  controller: PiThreadControllerLike,
  options: PiRuntimeOptions,
): ExternalStoreAdapter<ThreadMessage> => {
  const state = usePiControllerState(controller);
  const messageRepository = usePiControllerMessageRepository(controller);

  const {
    adapters,
    isDisabled,
    isSendDisabled,
    onError,
    suggestions,
    unstable_capabilities,
  } = options;
  const isLoading = state.loadState === "loading";
  const isRunning = isPiStateRunning(state);

  const onLoadError = useEffectEvent((error: unknown) => {
    invokePiErrorCallback(onError, error);
  });

  useEffect(() => {
    if (controller === NOOP_CONTROLLER) return;
    void controller.load().catch(onLoadError);
  }, [controller]);

  // A running thread must stream live events even when this client never
  // called `sendMessage` — e.g. the first message of a new thread starts the
  // run server-side inside `createThread`. The supervisor already holds a live
  // record for a running thread, so subscribing attaches to it; idle threads
  // never connect and the cold-read path stays cheap.
  // 改动（4a）：队列非空时同样保持订阅——空闲断开后，sidecar 串行链在上一轮
  // 收尾时自派发的下一轮 agent_start 对前端不可见（事件路由按订阅分流），
  // 接力泵无从感知；订阅保活让链节派发原生可见，泵只剩孤儿队列一种场景。
  // 活动会话**常驻订阅**（2026-10-04 改）：订阅只是本地登记监听（sidecar 的
  // thread_event 本来就广播给这条连接，不订阅只是把帧丢掉），所以常驻订阅零流量
  // 增量，换来的是"正看着的会话"对桌面/网页端改动的实时跟随——队列、计划、
  // todo/目标、模式、轮次状态都走这条；此前空闲会话不订阅，看着会话也收不到它的
  // 实时变更，只能等下一次快照（表现为"桌面改了手机不动"）。
  // 后台线程仍不订阅：只有活动线程走到这里（非主线程传的是 NOOP_CONTROLLER）。
  useReplaySafeEffect(() => {
    if (controller === NOOP_CONTROLLER) return;
    return controller.connect();
  }, [controller]);

  const extras = useMemo<PiRuntimeExtrasInternal>(
    () => buildExtras(controller, state),
    [controller, state],
  );

  // Pi queues natively (`prompt()` steers/follows up mid-run), so the queue
  // adapter forwards every send straight to the controller instead of
  // buffering client-side. Exposing it flips on `capabilities.queue`, which is
  // what lets the composer keep accepting input while a run is streaming
  // (mid-run sends steer by default; `send({ steer: false })` queues a
  // follow-up).
  // 改动（4a）：条目 id 用真实 reqId（state.queue 条目化）；框架面的
  // move/edit/remove 接到逐项操作——move 无锚点进 steer 车道 = 立即发送
  // （中止当前轮并执行该项，语义与 queue_promote 一致），edit = 删旧项重发。
  const queue = useMemo<ExternalThreadQueueAdapter>(
    () => ({
      items: state.queue.followUp.map((entry) => ({
        id: entry.id,
        prompt: entry.content,
        parts: [{ type: "text" as const, text: entry.content }],
      })),
      steerItems: state.queue.steering.map((entry) => ({
        id: entry.id,
        prompt: entry.content,
        parts: [{ type: "text" as const, text: entry.content }],
      })),
      enqueue: (message) => {
        void controller
          .sendMessage(message)
          .catch((error: unknown) => invokePiErrorCallback(onError, error));
      },
      steer: (message) => {
        void controller
          .sendMessage(message, { streamingBehavior: "steer" })
          .catch((error: unknown) => invokePiErrorCallback(onError, error));
      },
      move: (queueItemId, placement) => {
        if (placement.lane !== "steer") return;
        void controller
          .queuePromote(queueItemId)
          .catch((error: unknown) => invokePiErrorCallback(onError, error));
      },
      edit: (queueItemId, message) => {
        void (async () => {
          await controller.queueCancel(queueItemId);
          await controller.sendMessage(message);
        })().catch((error: unknown) => invokePiErrorCallback(onError, error));
      },
      remove: (queueItemId) => {
        void controller
          .queueCancel(queueItemId)
          .catch((error: unknown) => invokePiErrorCallback(onError, error));
      },
    }),
    [controller, state.queue, onError],
  );

  const store = useMemo<ExternalStoreAdapter<ThreadMessage>>(
    () => ({
      isDisabled,
      isSendDisabled,
      unstable_capabilities,
      suggestions,
      isLoading,
      isRunning,
      messageRepository,
      extras,
      queue,
      ...(adapters ? { adapters } : {}),
      onNew: async (message) => {
        try {
          await controller.sendMessage(message);
        } catch (error) {
          invokePiErrorCallback(onError, error);
          throw error;
        }
      },
      // 症状3：接上 onReload/onEdit 即激活重新生成/编辑按钮（capabilities
      // 由字段存在性推导）；截断+重发在 controller 内完成，运行中由
      // sidecar busy 守卫拒绝并走 onError 呈现。core 对这两个 handler 是
      // 即发即忘（不 await 不 catch），失败必须收敛于此、禁止再抛——
      // 否则成为未处理的 Promise 拒绝直接触发运行时错误遮罩
      onReload: async (parentId) => {
        try {
          await controller.reloadMessage(parentId);
        } catch (error) {
          invokePiErrorCallback(onError, error);
        }
      },
      onEdit: async (message) => {
        try {
          await controller.editMessage(message);
        } catch (error) {
          invokePiErrorCallback(onError, error);
        }
      },
      onCancel: async () => {
        try {
          // 改动（4a）：去掉上游的 cancel 前 clearQueue——我们的停止语义 =
          // 整线程停止（sidecar abort 命令在中止活跃轮的同时取消该线程全部
          // 排队项），不存在「cancel 与队列续派之间被提升」的窗口
          await controller.cancel();
        } catch (error) {
          invokePiErrorCallback(onError, error);
          throw error;
        }
      },
      onRespondToToolApproval: async (response) => {
        try {
          const request = controller
            .getState()
            .hostUiRequests.find((r) => r.id === response.approvalId);
          if (!request) {
            throw new Error(
              `No pending host-UI request "${response.approvalId}"`,
            );
          }
          await controller.respondToHostUiRequest(
            responseForToolApproval(request, response),
          );
        } catch (error) {
          invokePiErrorCallback(onError, error);
          throw error;
        }
      },
      onResumeToolCall: ({ toolCallId, payload }) => {
        void controller
          .resumeToolCall(toolCallId, payload as PiInterruptAnswer)
          .catch((error) => invokePiErrorCallback(onError, error));
      },
    }),
    [
      controller,
      extras,
      messageRepository,
      queue,
      adapters,
      isDisabled,
      isLoading,
      isRunning,
      isSendDisabled,
      onError,
      suggestions,
      unstable_capabilities,
    ],
  );

  return store;
};

/** 本地改动（UI 格式回归）：新会话乐观消息与 messageProjection 的
 * projectUserContent 对齐——图片投成 attachments（气泡外附件卡），不再拍进
 * 气泡 content。composer 附件（CompleteAttachment，图片带 image 内容 part →
 * useAttachmentSrc 出缩略图）直接透传；content 里的 image/file part 同样转成
 * 附件形态。 */
const toOptimisticThreadMessage = (
  message: Parameters<ExternalStoreAdapter<ThreadMessageLike>["onNew"]>[0],
  index: number,
): ThreadMessageLike => {
  const id = `pi-new-user:${index}`;
  const parts: Exclude<ThreadMessageLike["content"], string>[number][] = [];
  const attachments: NonNullable<ThreadMessageLike["attachments"]>[number][] = [
    ...(message.attachments ?? []),
  ];
  let imgSeq = 0;
  for (const part of message.content) {
    if (part.type === "image") {
      imgSeq += 1;
      attachments.push({
        id: `${id}-att-${imgSeq}`,
        type: "image",
        name: part.filename ?? `image-${imgSeq}`,
        status: { type: "complete" },
        content: [part],
      });
    } else if (part.type === "file") {
      const isImage = part.mimeType.startsWith("image/");
      imgSeq += 1;
      attachments.push({
        id: `${id}-att-${imgSeq}`,
        type: isImage ? "image" : "document",
        name: part.filename ?? (isImage ? `image-${imgSeq}` : "attachment"),
        contentType: part.mimeType,
        status: { type: "complete" },
        content: [part],
      });
    } else {
      parts.push(part);
    }
  }
  return {
    id,
    role: "user",
    createdAt: new Date(),
    content: parts,
    ...(attachments.length ? { attachments } : {}),
  };
};

const useNewPiThreadStore = (
  registry: PiControllerRegistry,
  options: PiRuntimeOptions,
): ExternalStoreAdapter<ThreadMessage> => {
  const aui = useAui();
  const {
    adapters,
    cloud,
    isDisabled,
    isSendDisabled,
    onError,
    suggestions,
    unstable_capabilities,
  } = options;
  const [optimisticMessages, setOptimisticMessages] = useState<
    readonly ThreadMessageLike[]
  >([]);
  const optimisticMessageIndexRef = useRef(0);
  const optimisticRepository = useMemo(
    () => ExportedMessageRepository.fromArray(optimisticMessages),
    [optimisticMessages],
  );

  const store = useMemo<ExternalStoreAdapter<ThreadMessage>>(
    () => ({
      isDisabled: isDisabled ?? false,
      isSendDisabled,
      unstable_capabilities,
      suggestions,
      isLoading: false,
      isRunning: false,
      messageRepository: optimisticRepository,
      extras: EMPTY_RUNTIME_EXTRAS,
      ...(adapters ? { adapters } : {}),
      onNew: async (message) => {
        const optimistic = toOptimisticThreadMessage(
          message,
          optimisticMessageIndexRef.current++,
        );
        setOptimisticMessages((messages) => [...messages, optimistic]);
        const removeOptimisticMessage = () => {
          setOptimisticMessages((messages) =>
            messages.filter((candidate) => candidate !== optimistic),
          );
        };
        try {
          // The core starts thread initialization before dispatching onNew,
          // so adapter.initialize has already created the thread empty;
          // deliver the message to the live thread.
          const { remoteId, externalId } =
            await aui.threadListItem.initialize();
          if (registry.disposed) {
            removeOptimisticMessage();
            return;
          }
          const piThreadId = cloud ? externalId : (externalId ?? remoteId);
          if (!piThreadId) {
            throw new Error("This thread has no Pi thread to send to.");
          }
          await getController(registry, piThreadId).sendMessage(message);
          removeOptimisticMessage();
        } catch (error) {
          removeOptimisticMessage();
          invokePiErrorCallback(onError, error);
          throw error;
        }
      },
    }),
    [
      aui,
      optimisticRepository,
      registry,
      adapters,
      cloud,
      isDisabled,
      isSendDisabled,
      onError,
      suggestions,
      unstable_capabilities,
    ],
  );

  return store;
};

const useRuntimeHook = (
  registry: PiControllerRegistry,
  options: PiRuntimeOptions,
) => {
  const threadListItem = useAuiState((state) => state.threadListItem);
  const isMainThread = useAuiState(
    (state) => state.threads.mainThreadId === state.threadListItem.id,
  );
  const threadId = options.cloud
    ? threadListItem.externalId
    : (threadListItem.externalId ?? threadListItem.remoteId);

  // No render-local cache on top: `getController` is already an idempotent
  // registry lookup, and a second cache could outlive a recreated registry.
  const controller = threadId
    ? getController(registry, threadId)
    : NOOP_CONTROLLER;

  // 切会话即放（内存）：上一会话的控制器连同转录窗口（含图片 base64）立刻可回收。
  // 直播中/有排队的控制器不逐出（逐出会拆事件订阅），切回来冷读快照重建。
  useEffect(() => {
    if (!threadId) return;
    pruneControllers(registry.controllers, threadId, 1, (error) =>
      console.error("[pi-runtime] controller dispose failed", error),
    );
  }, [registry, threadId]);

  const threadStore = usePiThreadStore(
    isMainThread ? controller : NOOP_CONTROLLER,
    options,
  );
  const newThreadStore = useNewPiThreadStore(registry, options);

  // One runtime whose store CONTENT switches between the new-thread and
  // live-thread branches. Returning two alternating runtime instances breaks
  // the remote-thread-list main binding: it can latch onto the runtime that
  // was current at switch time and miss the other one's later updates.
  return useExternalStoreRuntime<ThreadMessage>(
    threadId ? threadStore : newThreadStore,
  );
};

// ---------------------------------------------------------------------------
// Thread-list metadata mapping.
// ---------------------------------------------------------------------------

const mapThreadMetadata = (metadata: PiThreadMetadata) => ({
  status: metadata.archived ? ("archived" as const) : ("regular" as const),
  remoteId: metadata.id,
  externalId: metadata.id,
  ...(metadata.title !== undefined ? { title: metadata.title } : {}),
  // updatedAt（sidecar session.modified）→ AUI 列表项 lastMessageAt：侧边栏
  // 「距最后一条消息」的时间源。上游映射漏了它，列表时间整体消失（2026-10-01）
  ...(metadata.updatedAt ? { lastMessageAt: new Date(metadata.updatedAt) } : {}),
  custom: {
    status: metadata.status,
    ...(metadata.workspacePath !== undefined
      ? { workspacePath: metadata.workspacePath }
      : {}),
    ...(metadata.sessionFile !== undefined
      ? { sessionFile: metadata.sessionFile }
      : {}),
    ...(metadata.parentSessionPath !== undefined
      ? { parentSessionPath: metadata.parentSessionPath }
      : {}),
  },
});

// ---------------------------------------------------------------------------
// Public hook.
// ---------------------------------------------------------------------------

export const usePiRuntime = (options: PiRuntimeOptions): AssistantRuntime => {
  const { client, cloud } = options;
  const [pinnedRegistry, setPinnedRegistry] = useState(() => ({
    client,
    registry: createRegistry(client),
  }));
  let currentRegistry = pinnedRegistry;
  if (pinnedRegistry.client !== client) {
    currentRegistry = { client, registry: createRegistry(client) };
    setPinnedRegistry(currentRegistry);
  }
  const { registry } = currentRegistry;

  useReplaySafeEffect(() => {
    registry.activate();
    return () => registry.dispose();
  }, [registry]);

  // 图片落盘失败的自愈入口（渲染层报"file:// 读不出来"时调用）：本运行时把
  // 请求转给各控制器——摘掉坏 uri + 后台拉快照拿回 base64，随后重新落盘。
  // 注册放这里是因为控制器登记表只在本 hook 内可见（单一实例，全局一份足够）。
  useReplaySafeEffect(() => {
    setImageRematerializeHandler(() => {
      for (const controller of registry.controllers.values()) {
        controller.handleImageMaterializationFailure();
      }
    });
    return () => setImageRematerializeHandler(null);
  }, [registry]);

  const { workspacePath, includeArchived } = options;
  const createAdapter = () => ({
    // §6 会话列表分页：首屏 limit 条，滚到底由 core 带 after=nextOffset 再拉
    // 下一页（loadMore）。列表帧与 store 里的条目数都随之下限，聚焦重拉的
    // 那一次 list() 也只重建一页（旧行为是 400+ 条整表重建）。
    list: async (params?: { after?: string }) => {
      const offset = params?.after ? Number(params.after) : 0;
      const listThreadsPage = client.listThreadsPage?.bind(client);
      if (listThreadsPage && Number.isFinite(offset) && offset >= 0) {
        const page = await listThreadsPage({
          ...(workspacePath !== undefined ? { workspacePath } : {}),
          ...(includeArchived !== undefined ? { includeArchived } : {}),
          limit: SESSION_LIST_PAGE_SIZE,
          offset,
        });
        return {
          threads: page.threads.map(mapThreadMetadata),
          ...(page.nextOffset !== undefined
            ? { nextCursor: String(page.nextOffset) }
            : {}),
        };
      }
      // 旧端（无分页面）：整表一页，无游标
      const threads = await client.listThreads({
        ...(workspacePath !== undefined ? { workspacePath } : {}),
        ...(includeArchived !== undefined ? { includeArchived } : {}),
      });
      return { threads: threads.map(mapThreadMetadata) };
    },
    rename: async (remoteId: string, newTitle: string) => {
      await client.renameThread(remoteId, newTitle);
    },
    archive: async (remoteId: string) => {
      await client.archiveThread?.(remoteId);
    },
    unarchive: async (remoteId: string) => {
      await client.unarchiveThread?.(remoteId);
    },
    delete: async (remoteId: string) => {
      await client.deleteThread?.(remoteId);
      // 桌面端在此清 agent 面板的会话桶（shell 桥回收终端、浏览器计数重估）。
      // 移动端没有面板，会话删除即止。
    },
    initialize: async (threadId?: string) => {
      const snapshot = await client.createThread({
        ...(workspacePath !== undefined ? { workspacePath } : {}),
      });
      const remoteId = snapshot.metadata.id;
      // 桌面扩展：登记本地线程 id -> sessionId 绑定（与旧链路 adapter 的
      // unstable_useAdapters 同职责）。core 在首条消息派发前必跑 initialize，
      // 故发送前绑定已就位；消费侧请求随后都能换出正确 sessionId。
      if (threadId) piSessionRegistry.set(threadId, remoteId);
      // 桌面端此处还会把面板桶从草稿 id 迁到 sessionId 键下（rekeyPanelThread），
      // 移动端没有面板桶，省略。
      // 会话级选择的补写：草稿期（尚无 sessionId）选的模型/思考档位/工作模式只记在
      // 前端内存，此刻 sessionId 已绑定、会话行已建，定靶落库后首条消息即用该选择应答
      //（三者均 fire-and-forget 语义：内部自吞失败并回退显示）
      if (threadId) {
        flushDraftModelSelection(threadId);
        flushDraftThinkingSelection(threadId);
        flushDraftAppModeSelection(threadId);
      }
      return {
        remoteId,
        externalId: snapshot.metadata.id,
      };
    },
    generateTitle: async () =>
      // Pi has no server-side title summarization; titles come from
      // `session_info_changed`. Satisfy the contract with an empty stream.
      new ReadableStream({
        start(streamController) {
          streamController.close();
        },
      }) as never,
    fetch: async (threadId: string) => {
      const snapshot = await client.getThread(threadId);
      return mapThreadMetadata(snapshot.metadata);
    },
  });
  const [pinnedAdapter, setPinnedAdapter] = useState(() => ({
    client,
    workspacePath,
    includeArchived,
    adapter: createAdapter(),
  }));
  let currentAdapter = pinnedAdapter;
  if (
    pinnedAdapter.client !== client ||
    pinnedAdapter.workspacePath !== workspacePath ||
    pinnedAdapter.includeArchived !== includeArchived
  ) {
    currentAdapter = {
      client,
      workspacePath,
      includeArchived,
      adapter: createAdapter(),
    };
    setPinnedAdapter(currentAdapter);
  }
  const piAdapter = currentAdapter.adapter;

  const cloudAdapter = useCloudThreadListAdapter({
    cloud,
    sdk: cloud ? PI_SDK : undefined,
    create: async () => {
      const snapshot = await client.createThread({
        ...(options.workspacePath !== undefined
          ? { workspacePath: options.workspacePath }
          : {}),
      });
      return { externalId: snapshot.metadata.id };
    },
    delete: async (threadId) => {
      if (!cloud) return;
      const { external_id } = await cloud.threads.get(threadId);
      if (external_id) await client.deleteThread?.(external_id);
    },
  });

  const adapter = cloud ? cloudAdapter : piAdapter;

  return useRemoteThreadListRuntime({
    runtimeHook: () => {
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- runtimeHook is invoked by useRemoteThreadListRuntime at the correct hook position
      return useRuntimeHook(registry, options);
    },
    adapter,
    allowNesting: true,
    ...(options.initialThreadId !== undefined
      ? { initialThreadId: options.initialThreadId }
      : {}),
    ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
    ...(options.onThreadIdChange !== undefined
      ? { onThreadIdChange: options.onThreadIdChange }
      : {}),
  });
};
