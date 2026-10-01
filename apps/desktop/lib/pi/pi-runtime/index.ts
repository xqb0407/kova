// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/index.ts（浏览器半入口）
// 改动：本仓库未 vendor client/httpClient 与 client/eventSource（HTTP/SSE 传输层
// 由 TauriPiClient 直接实现 PiClient 契约替代），对应导出移除。

export * from "./types";
export { piQueueItemId, isPiSteerQueueItemId } from "./queueIds";
export type { PiQueueMode } from "./queueIds";

export {
  createPiThreadState,
  reducePiThreadState,
} from "./runtime/threadState";
export type {
  PiThreadState,
  PiRunStatus,
  PiLoadState,
  PiToolExecutionState,
} from "./runtime/threadState";

export {
  projectPiThreadMessages,
  projectPiThreadRepository,
} from "./runtime/messageProjection";
export type {
  PiProjectionInput,
  PiProjectedContentPart,
} from "./runtime/messageProjection";

export {
  splitHostUiRequests,
  responseForApproval,
  responseForInterrupt,
  responseForRequest,
  responseForToolApproval,
} from "./runtime/hostUi";
export type { SplitHostUiRequests, PiInterruptAnswer } from "./runtime/hostUi";

export { PiThreadController } from "./runtime/ThreadController";
export type {
  PiThreadControllerLike,
  PiSendOptions,
} from "./runtime/ThreadController";

export { usePiRuntime } from "./runtime/usePiRuntime";
export {
  usePiRuntimeExtras,
  usePiSession,
  usePiThreadState,
  usePiHostUiRequests,
} from "./runtime/hooks";
export type { PiRuntimeOptions, PiRuntimeExtras } from "./runtime/runtimeTypes";
