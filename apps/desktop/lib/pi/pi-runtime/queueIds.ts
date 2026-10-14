// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/queueIds.ts（runtime/ 子目录对应上游 src/runtime/）

/**
 * Queue item id scheme — `"<mode>:<index>"` — shared by the supervisor's
 * `PiQueuedMessage`s and the runtime's composer queue items, and parsed by UIs
 * (e.g. to style steering items differently from follow-ups).
 */

export type PiQueueMode = "steer" | "followUp";

export const piQueueItemId = (mode: PiQueueMode, index: number): string =>
  `${mode}:${index}`;

export const isPiSteerQueueItemId = (id: string): boolean =>
  id.startsWith("steer:");
