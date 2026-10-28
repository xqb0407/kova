"use client";

/**
 * Codex 精灵图逐帧播放器 —— 把图集 clip 推进到 DOM 上。
 *
 * 画法：`background-size: 列数×100% 行数×100%` 固定在元素上，这里只按帧改
 * `background-position` 百分比（`toPercent`），与图集真实像素尺寸解耦。
 * 推进用 setTimeout 链而不是 CSS steps()，因为帧时长是逐帧的
 * （`durations[index]` 优先，缺项回落匀速 `interval`）。
 *
 * 与参考实现对齐的两个语义：
 * - **look 格优先**：`lookIndex` 非空（v2 视线追踪中）时暂停帧推进，只画 look 格；
 * - **一次性动作停在末帧再收尾**：`loop: false` 画完最后一帧后按末帧时长定格
 *  （无 durations 时额外多停一个 interval）再回调 `onFinish`，让「播完回 idle」不硬切。
 *
 * 减少动效（`prefers-reduced-motion`）：只画首帧；一次性动作按单帧时长收尾，
 * 保持「播完回落」的事件语义不变。
 */

import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import type { PetClip } from "@/lib/pet/types";
import { lookCellRowCol, toPercent } from "@/lib/pet/atlas";

export interface UseSpritePlayerOptions {
  /** 精灵图元素（`backgroundImage` 由组件层设，这里只写 position） */
  elementRef: RefObject<HTMLElement | null>;
  /** 当前动作的图集 clip；null（清单未就绪/非图集动作）时本 hook 空转 */
  clip: (PetClip & { kind: "atlas" }) | null;
  /** 图集列数 */
  columns: number;
  /** 图集行数 */
  rows: number;
  /** 动作代次（变化即从头播） */
  revision: number;
  reducedMotion: boolean;
  /** 视线格序号（undefined = 不追踪；追踪期间暂停帧推进） */
  lookIndex: number | undefined;
  /** 一次性动作播完（含末帧停留）时回调 */
  onFinish?: () => void;
}

export function useSpritePlayer(options: UseSpritePlayerOptions): void {
  const { elementRef, clip, columns, rows, revision, reducedMotion, lookIndex, onFinish } = options;
  const { row = 0, frames = 1, interval = 160, loop = true } = clip ?? {};
  const durations = clip?.durations;
  // durations 按内容签名进依赖：内联数组每次渲染都是新引用，按引用当依赖会让计时器反复重置
  const durationsKey = durations?.join(",");

  const indexRef = useRef(0);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  // 换动作/重播 → 帧号归零（声明在前，先于播放 effect 执行）
  useEffect(() => {
    indexRef.current = 0;
  }, [frames, revision, row]);

  useEffect(() => {
    const el = elementRef.current;
    // 清单未就绪 / 非 atlas clip：不画帧
    if (el === null || clip === null) return undefined;

    const paint = (targetRow: number, column: number) => {
      el.style.backgroundPosition = `${toPercent(column, columns)}% ${toPercent(targetRow, rows)}%`;
    };

    // 视线追踪：暂停帧推进，只画 look 格（v1 图集没有 look 行，调用方保证不传）
    if (lookIndex !== undefined) {
      const cell = lookCellRowCol(lookIndex);
      paint(cell.row, cell.column);
      return undefined;
    }

    const lastIndex = Math.max(0, frames - 1);
    const delayFor = (index: number): number => {
      const custom = durations?.[index];
      return typeof custom === "number" && custom > 0 ? custom : interval;
    };

    let timer: number | undefined;
    let disposed = false;
    const finish = () => {
      if (!disposed) onFinishRef.current?.();
    };

    const schedule = (callback: () => void, delay: number): void => {
      timer = window.setTimeout(callback, delay);
    };

    const step = (): void => {
      if (disposed) return;
      const index = Math.min(indexRef.current, lastIndex);
      paint(row, index);

      // 减少动效：只画首帧，一次性动作按单帧时长收尾
      if (reducedMotion) {
        if (!loop) schedule(finish, delayFor(index));
        return;
      }

      if (index >= lastIndex) {
        if (!loop) {
          // 停末帧再回落：有逐帧时长时按末帧自己的时长定格，否则多停一个 interval
          schedule(finish, durations ? delayFor(index) : interval);
          return;
        }
        indexRef.current = 0;
      } else {
        indexRef.current = index + 1;
      }
      schedule(step, delayFor(index));
    };

    step();

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react/exhaustive-deps -- durationsKey 是 durations 的内容签名（见上）
  }, [clip === null, columns, elementRef, frames, interval, durationsKey, lookIndex, loop, reducedMotion, revision, row, rows]);
}
