// pi-runtime：桌面（Next）与移动端（Expo/RN）共享的 Pi 运行时核。
// 已收编：协议契约类型、事件判定、hostUi、threadState、消息 id 钉扎、快照校验、
// useReplaySafeEffect 与零依赖工具。
// 未收编：messageProjection / ThreadController / usePiRuntime / PiClientBase —
// 它们依赖 @assistant-ui/core 运行时值（直接搬会制造第二份 core 单例）或宿主
// 状态端口，需先做注入与端口化。

export * from "./types";
export { parsePartialJsonObject } from "./partial-json";
export { errorText } from "./utils";
export { PI_SDK } from "./sdkIdentity";
export { piQueueItemId, isPiSteerQueueItemId } from "./queueIds";
export type { PiQueueMode } from "./queueIds";
export { disposeControllers } from "./runtime/disposeControllers";
