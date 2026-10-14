// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/disposeControllers.ts（runtime/ 子目录对应上游 src/runtime/）

export const disposeControllers = (
  controllers: Iterable<{ dispose(): void }>,
) => {
  let cleanupFailed = false;
  let cleanupError: unknown;

  for (const controller of controllers) {
    try {
      controller.dispose();
    } catch (error) {
      if (cleanupFailed) {
        console.error(error);
      } else {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
  }

  if (cleanupFailed) throw cleanupError;
};
