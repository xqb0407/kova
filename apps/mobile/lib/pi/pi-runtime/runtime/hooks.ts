// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/hooks.ts（runtime/ 子目录对应上游 src/runtime/）

"use client";

import { useCallback, useMemo } from "react";
import { piExtras } from "./piExtras";
import {
  EMPTY_RUNTIME_EXTRAS,
  NOOP_CONTROLLER,
  usePiControllerStateSelector,
} from "./usePiRuntime";
import type { PiRuntimeExtras } from "./runtimeTypes";
import type { PiThreadState } from "./threadState";
import type { PiThreadMetadata } from "../types";

/**
 * `piExtras.use` 的钩子名别名。**React Compiler 陷阱**：编译器按「use + 大写」
 * 识别钩子，而 `piExtras.use(...)` 的属性名是裸 `use`（小写）——它被当作普通
 * 函数 memo 进条件分支，第二次渲染起整段跳过（见编译产物里的
 * `if ($[1] === memo_cache_sentinel) t0 = piExtras.use(...)`）。自定义钩子里
 * 一旦这么写，宿主组件的钩子序列随之错位：React 抛
 * "Rendered fewer hooks than expected."，整屏白（2026-10-04 移动端聊天页实测，
 * 本文件 usePiHistory 触发；上游 usePiThreadState 同形，一并改掉）。
 * 经 use* 别名调用后编译器按钩子处理，恒被调用。
 */
const usePiExtras = piExtras.use;

/** The full Pi runtime extras for the active thread. */
export const usePiRuntimeExtras = (): PiRuntimeExtras =>
  usePiExtras((e) => e, EMPTY_RUNTIME_EXTRAS);

/** The active Pi thread's metadata, or `null` when none is attached. */
export const usePiSession = (): PiThreadMetadata | null =>
  usePiExtras((e) => e.metadata, null);

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
  const controller = usePiExtras((e) => e.controller, NOOP_CONTROLLER);
  return usePiControllerStateSelector(
    controller,
    selector ?? ((state) => state as T),
  );
}

/** Pending free-standing host-UI requests plus a responder. */
export const usePiHostUiRequests = () => {
  const extras = usePiExtras((e) => e, undefined);

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

/** 分页窗（§6）：列表上沿「加载更多」的 history 适配对象。字段名对齐
 *  assistant-ui Thread 元素的 history prop（hasMore/isLoadingMore/loadMore）；
 *  只在两个布尔翻转时换引用，供宿主的 useMemo（Thread 元素）稳定复用。
 *  loadMore 走 controller 直连而非 extras 闭包——extras 每次状态变更重建，
 *  取它的闭包会让引用每帧变。 */
export const usePiHistory = (): {
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
} => {
  // 三个选择器各自只取原始值/稳定引用：extras 对象本身每次状态变更都换新的，
  // 直接选它会让宿主（Thread 元素）的 memo 每帧重建
  const hasMore = usePiExtras((e) => e.historyHasMore, false);
  const isLoadingMore = usePiExtras((e) => e.historyLoading, false);
  const controller = usePiExtras((e) => e.controller, NOOP_CONTROLLER);
  const loadMore = useCallback(() => {
    void controller.loadMoreHistory();
  }, [controller]);
  return useMemo(
    () => ({ hasMore, isLoadingMore, loadMore }),
    [hasMore, isLoadingMore, loadMore],
  );
};

/** 改动（4a）：队列条目 + 逐项操作。队列栏/composer 发送按钮共用；
 *  条目 id = 真实 reqId，content 为展示文本。编辑（检索到输入框）由调用方
 *  组合：composer 回填 + cancel(id)。 */
export const usePiQueue = () => {
  const extras = usePiExtras((e) => e, EMPTY_RUNTIME_EXTRAS);
  return useMemo(
    () => ({
      queue: extras.queue,
      cancel: extras.queueCancel,
      promote: extras.queuePromote,
      steer: extras.queueSteer,
      pop: extras.queuePop,
      clear: extras.clearQueue,
    }),
    [extras],
  );
};
