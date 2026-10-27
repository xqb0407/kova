// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/hooks.ts（runtime/ 子目录对应上游 src/runtime/）

"use client";

import { useMemo } from "react";
import { piExtras } from "./piExtras";
import {
  EMPTY_RUNTIME_EXTRAS,
  NOOP_CONTROLLER,
  usePiControllerStateSelector,
} from "./usePiRuntime";
import type { PiRuntimeExtras } from "./runtimeTypes";
import type { PiThreadState } from "./threadState";
import type { PiThreadControllerLike } from "./ThreadController";
import type { PiThreadMetadata } from "../types";

/** The full Pi runtime extras for the active thread. */
export const usePiRuntimeExtras = (): PiRuntimeExtras =>
  piExtras.use((e) => e, EMPTY_RUNTIME_EXTRAS);

/** The active Pi thread's metadata, or `null` when none is attached. */
export const usePiSession = (): PiThreadMetadata | null =>
  piExtras.use((e) => e.metadata, null);

/**
 * The live Pi thread state, optionally projected through a selector.
 *
 * The selected value is compared with `Object.is`, so the component re-renders
 * only when that value changes. A selector returning a new object or array
 * literal re-renders on every controller notification; select primitives or
 * return a memoized reference.
 */
export function usePiThreadState(): PiThreadState;
export function usePiThreadState<T>(selector: (state: PiThreadState) => T): T;
export function usePiThreadState<T>(selector?: (state: PiThreadState) => T) {
  const controller = piExtras.use((e) => e.controller, NOOP_CONTROLLER);
  return usePiControllerStateSelector(
    controller,
    selector ?? ((state) => state as T),
  );
}

/**
 * 当前线程控制器（稳定引用，不随状态提交重渲）。
 *
 * 给需要「逐次状态提交」做边沿判断的场景用：`useAuiState`/渲染值会被 React
 * 批处理合并——本轮收尾与下一轮立即派发落在同一批时，组件只渲染一次，
 * 看不到运行态的下降沿（队列栏「已并入」徽标因此可能滞留）。直接订阅控制器
 * 通知可以逐次观察状态提交，不受渲染合批影响。
 */
export function usePiController(): PiThreadControllerLike {
  return piExtras.use((e) => e.controller, NOOP_CONTROLLER);
}

/** Pending free-standing host-UI requests plus a responder. */
export const usePiHostUiRequests = () => {
  const extras = piExtras.use((e) => e, undefined);

  return useMemo(
    () => ({
      requests: extras?.hostUiRequests ?? [],
      respond:
        extras?.respondToHostUiRequest ??
        (async () => {
          throw new Error("Pi runtime is not ready yet");
        }),
    }),
    [extras],
  );
};

/** 改动（4a）：队列条目 + 逐项操作。队列栏/composer 发送按钮共用；
 *  条目 id = 真实 reqId，content 为展示文本。编辑（检索到输入框）由调用方
 *  组合：composer 回填 + cancel(id)。 */
export const usePiQueue = () => {
  const extras = piExtras.use((e) => e, EMPTY_RUNTIME_EXTRAS);
  return useMemo(
    () => ({
      queue: extras.queue,
      cancel: extras.queueCancel,
      promote: extras.queuePromote,
      steer: extras.queueSteer,
      pop: extras.queuePop,
      resend: extras.queueResend,
      clear: extras.clearQueue,
    }),
    [extras],
  );
};
