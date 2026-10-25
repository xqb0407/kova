"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 连续输入（滑杆拖动 / 取色拖动）的"松手才生效"提交。
 *
 * live=false（默认）：拖动过程中只更新控件本地 preview，不写 store；松手或
 * 键盘提交（onValueCommitted / onValueCommit）时才一次性应用主题。拖动期间
 * 没有任何主题变量重算，手感只取决于控件自身。
 * previewOnSchedule=false 给非受控取色器用：面板自己持有拖动状态，父组件
 * 连本地 preview 都不需要更新。
 *
 * live=true 保留节流模式（当前外观页未使用），用于将来需要实时预览的控件。
 */
export function useThrottledCommit<T>(
  external: T,
  commit: (value: T) => void,
  interval = 50,
  options: { previewOnSchedule?: boolean; live?: boolean } = {},
) {
  const previewOnSchedule = options.previewOnSchedule !== false;
  const live = options.live === true;
  const [preview, setPreview] = useState<T>(external);
  /** 外部换色计数：给非受控控件做 key，只在外来变化时递增 */
  const [revision, setRevision] = useState(0);
  /** null = 没有待提交值（本项目的值类型是 number/string，不会为 null） */
  const pending = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAt = useRef(0);
  /** 最近一次由本控件提交出去的值：用来区分"自己提交的回声"和外部切换 */
  const lastCommitted = useRef<T>(external);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const flush = useCallback(() => {
    clearTimer();
    const next = pending.current;
    pending.current = null;
    if (next === null) return;
    lastAt.current = performance.now();
    lastCommitted.current = next;
    commitRef.current(next);
  }, []);

  const schedule = useCallback(
    (next: T) => {
      pending.current = next;
      if (previewOnSchedule) setPreview(next);
      if (!live) return; // 松手才提交：拖动期间不碰 store
      const wait = interval - (performance.now() - lastAt.current);
      if (wait <= 0) flush();
      else if (timer.current === null) {
        timer.current = setTimeout(flush, wait);
      }
    },
    [flush, interval, live, previewOnSchedule],
  );

  /** 松手 / 键盘提交 / 点选：应用最终值 */
  const commitNow = useCallback(
    (next: T) => {
      pending.current = next;
      if (previewOnSchedule) setPreview(next);
      flush();
    },
    [flush, previewOnSchedule],
  );

  useEffect(() => {
    // 自己提交产生的回声：有后续拖动时不要覆盖 preview
    if (external === lastCommitted.current) {
      if (pending.current === null) setPreview(external);
      return;
    }
    // 外部切换（换编辑模式/重置/预设/导入）：取消尚未提交的旧值，跟随外部
    pending.current = null;
    clearTimer();
    lastCommitted.current = external;
    setPreview(external);
    setRevision((value) => value + 1);
  }, [external]);

  useEffect(() => clearTimer, []);

  return { preview, revision, schedule, commitNow, flush };
}
