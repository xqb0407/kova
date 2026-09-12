"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 节流回调（通用）：interval 内最多执行一次，默认 leading + trailing——
 * 突发调用的首次立即执行、末次在窗口收尾时补执行，中间的折叠为最后一次入参。
 * fn 永远取最新闭包（ref 转发），调用方无需 useCallback。
 * 卸载时丢弃挂起调用（不执行），与 useDebouncedCallback 同款约定。
 */
export type ThrottledRunner<A extends unknown[]> = {
  /** 节流触发：窗口内首次（leading）立即执行，其余折叠到窗口末尾（trailing） */
  run: (...args: A) => void;
  /** 立即执行挂起的末次调用并收口当前窗口（无挂起时 no-op） */
  flush: () => void;
  /** 丢弃挂起的调用（已开启的窗口不重置） */
  cancel: () => void;
  /** 是否有挂起等待 trailing 补执行的调用（响应式） */
  isPending: boolean;
};

export function useThrottledCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  interval: number,
  options?: { leading?: boolean; trailing?: boolean },
): ThrottledRunner<A> {
  const leading = options?.leading ?? true;
  const trailing = options?.trailing ?? true;
  const leadingRef = useRef(leading);
  const trailingRef = useRef(trailing);
  leadingRef.current = leading;
  trailingRef.current = trailing;
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRun = useRef(0);
  const pendingArgs = useRef<A | null>(null);
  const [isPending, setIsPending] = useState(false);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const execute = useCallback((args: A) => {
    lastRun.current = Date.now();
    pendingArgs.current = null;
    setIsPending(false);
    fnRef.current(...args);
  }, []);

  const armTimer = useCallback(
    (now: number) => {
      const remaining = Math.max(0, interval - (now - lastRun.current));
      clearTimer();
      timer.current = setTimeout(() => {
        timer.current = null;
        if (!trailingRef.current) {
          setIsPending(false);
          return;
        }
        const args = pendingArgs.current;
        pendingArgs.current = null;
        setIsPending(false);
        if (args) execute(args);
      }, remaining);
    },
    [clearTimer, execute, interval],
  );

  const run = useCallback(
    (...args: A) => {
      const now = Date.now();
      const elapsed = now - lastRun.current;
      // 窗口外且无挂起：leading 直接执行；否则折叠为末次调用等 trailing
      if (leadingRef.current && timer.current === null && elapsed >= interval) {
        execute(args);
        return;
      }
      pendingArgs.current = args;
      setIsPending(true);
      if (timer.current === null) armTimer(now);
    },
    [armTimer, execute, interval],
  );

  const flush = useCallback(() => {
    if (pendingArgs.current === null) return;
    const args = pendingArgs.current;
    clearTimer();
    execute(args);
  }, [clearTimer, execute]);

  const cancel = useCallback(() => {
    clearTimer();
    pendingArgs.current = null;
    setIsPending(false);
  }, [clearTimer]);

  useEffect(() => cancel, [cancel]);

  return { run, flush, cancel, isPending };
}

/**
 * 节流值（通用）：高频变化的 value 折叠为至多每 interval 一次的渲染值，
 * leading 立即跟上首次变化、trailing 保证最终值落位。用于把昂贵的下游渲染
 * （如 Markdown 重解析）与高频上游输入解耦。
 */
export function useThrottledValue<T>(value: T, interval: number): T {
  const [throttled, setThrottled] = useState(value);
  const { run } = useThrottledCallback(setThrottled, interval);
  useEffect(() => {
    run(value);
  }, [run, value]);
  return throttled;
}
