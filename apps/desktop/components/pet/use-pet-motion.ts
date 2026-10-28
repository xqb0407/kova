"use client";

/**
 * `lib/pet/motion.ts` 状态机的 React 绑定。
 *
 * - 状态经 `useSyncExternalStore` 订阅（状态机保证两次变更之间快照引用稳定）；
 * - 声明层 `motion` prop 按内容指纹比较，键变化才 `setProp`（对象字面量每渲染都是
 *   新引用，直接进依赖会无限回写）；
 * - `dragging` 直通状态机（手势接管作废未播完的一次性命令）；
 * - 命令面通过 ref 交出：`motion / clear / current`。
 */

import * as React from "react";
import type { PetMotion, PetMotionInput, PetRef } from "@/lib/pet/types";
import { motionInputKey, type PetMotionState, PetMotionMachine } from "@/lib/pet/motion";

export interface UsePetMotionOptions {
  /** 声明式动作（回落层）。命令面下发持续生效，直到这里变化或一次性播完。 */
  motion?: PetMotionInput;
  /** 手势态（拖拽中），最高优先级信号 */
  dragging?: boolean;
  /** PetRef（命令面） */
  ref?: React.Ref<PetRef | null>;
  /** 生效动作变化回调（拖拽渲染映射不影响它：报的是逻辑动作） */
  onMotionChange?: (motion: PetMotion) => void;
}

export function usePetMotion(options: UsePetMotionOptions): {
  machine: PetMotionMachine;
  state: PetMotionState;
} {
  const { motion, dragging, ref, onMotionChange } = options;

  const machineRef = React.useRef<PetMotionMachine | null>(null);
  if (machineRef.current === null) machineRef.current = new PetMotionMachine(motion);
  const machine = machineRef.current;

  // getServerSnapshot 传同一个 getter：快照是纯数据，SSR 预渲染也能安全取（缺了会整页 500）
  const state = React.useSyncExternalStore(machine.subscribe, machine.getSnapshot, machine.getSnapshot);

  // 声明层：内容指纹变化才推进（replay 在 prop 里无意义，指纹已忽略）
  const propKey = motionInputKey(motion);
  const lastKeyRef = React.useRef(propKey);
  React.useEffect(() => {
    if (lastKeyRef.current === propKey) return;
    lastKeyRef.current = propKey;
    machine.setProp(motion);
  }, [machine, motion, propKey]);

  React.useEffect(() => {
    machine.setDragging(dragging === true);
  }, [dragging, machine]);

  // 生效动作变化回调（与参考实现对齐：仅 type 变化时通知）
  const onMotionChangeRef = React.useRef(onMotionChange);
  onMotionChangeRef.current = onMotionChange;
  const notifiedRef = React.useRef(machine.current);
  React.useEffect(() => {
    const type = machine.current;
    if (notifiedRef.current === type) return;
    notifiedRef.current = type;
    onMotionChangeRef.current?.(type);
  });

  React.useImperativeHandle(
    ref,
    (): PetRef => ({
      motion: (input) => machine.request(input),
      clear: () => machine.clear(),
      get current() {
        return machine.current;
      },
    }),
    [machine],
  );

  return { machine, state };
}
