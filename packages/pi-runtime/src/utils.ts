// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/utils.ts（runtime/ 子目录对应上游 src/runtime/）

/** Browser-safe error → message text. */
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
