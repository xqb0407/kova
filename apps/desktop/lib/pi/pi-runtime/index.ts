// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/index.ts（浏览器半入口）
// 改动：本仓库未 vendor client/httpClient 与 client/eventSource（HTTP/SSE 传输层
// 由 DesktopPiClient 直接实现 PiClient 契约替代），对应导出移除。

export * from "./types";
export { piQueueItemId, isPiSteerQueueItemId } from "pi-runtime";
export type { PiQueueMode } from "pi-runtime";

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
// 改动（v3.1）：排队内容退回 composer（停止生成回填最后一条/队列条「编辑」
// 单条退回共用；「删除」是纯删除不走这里），队列栏导入用
export { restoreQueueItemsToComposer } from "./runtime/usePiRuntime";
// 改动（划词辅助会话）：单线程嵌套宿主（固定子会话的 external-store runtime，
// 绕开 useRemoteThreadListRuntime 的嵌套 no-op 分支），右侧面板 side-chat 用
export {
  usePinnedPiRuntime,
  PinnedPiAuiBridge,
} from "./runtime/usePiRuntime";
export type { PinnedPiRuntime } from "./runtime/usePiRuntime";
export {
  usePiRuntimeExtras,
  usePiSession,
  usePiThreadState,
  usePiController,
  usePiHostUiRequests,
  usePiQueue,
} from "./runtime/hooks";
export type { PiRuntimeOptions, PiRuntimeExtras } from "./runtime/runtimeTypes";
