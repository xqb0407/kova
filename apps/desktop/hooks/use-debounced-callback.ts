"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 防抖回调（通用）：连续调用只执行最后一次，静默 delay 后触发（trailing）。
 * fn 永远取最新闭包（ref 转发），调用方无需 useCallback。
 * 卸载时丢弃挂起调用（不执行）——组件已死，执行常引发卸载后 setState；
 * 需要"卸载前冲刷"的场景在自身 cleanup 里显式 flush（且要先于本 hook 挂载），
 * 或像个性化设置页那样绕过 hook 直发最后一次保存。
 */
export type DebouncedRunner<A extends unknown[]> = {
  /** 防抖触发：重置计时器，delay 后执行最新一次入参 */
  run: (...args: A) => void;
  /** 立即执行挂起的调用（无挂起时 no-op） */
  flush: () => void;
  /** 丢弃挂起的调用 */
  cancel: () => void;
  /** 是否有挂起未执行的调用（响应式） */
  isPending: boolean;
};

export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): DebouncedRunner<A> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArgs = useRef<A | null>(null);
  const [isPending, setIsPending] = useState(false);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const settle = useCallback(() => {
    timer.current = null;
    const args = pendingArgs.current;
    pendingArgs.current = null;
    setIsPending(false);
    if (args) fnRef.current(...args);
  }, []);

  const run = useCallback(
    (...args: A) => {
      pendingArgs.current = args;
      setIsPending(true);
      clearTimer();
      timer.current = setTimeout(settle, delay);
    },
    [clearTimer, settle, delay],
  );

  const flush = useCallback(() => {
    if (timer.current === null) return;
    clearTimer();
    settle();
  }, [clearTimer, settle]);

  const cancel = useCallback(() => {
    clearTimer();
    pendingArgs.current = null;
    setIsPending(false);
  }, [clearTimer]);

  useEffect(() => cancel, [cancel]);

  return { run, flush, cancel, isPending };
}
