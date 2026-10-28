/**
 * 桌宠模块 · 动作状态机（纯逻辑，无 React；`components/pet/use-pet-motion.ts` 负责绑定）。
 *
 * 优先级：`dragging 手势 > 命令面 request() > 声明层 prop > idle`。
 *
 * 三条收尾规则（都来自参考实现的踩坑结论）：
 * 1. 同动作 + 同循环语义重复下发不重播（状态档反复上报不该让动画一直从头播）；
 *    要重播显式 `{ type, replay: true }`；已播完的一次性动作再下发会重新播；
 * 2. 一次性动作播完（`finish()`）：命令面下发的**交还声明层**（不是直接落 idle）——
 *    这样「常驻状态档 + 临时插播」能共存；声明层自己的一次性动作则标记 done 落回 idle；
 * 3. 声明层变化（内容指纹比较，忽略 replay）会清掉命令面的**循环**动作重新接管，
 *    但保留正在播的**一次性**命令到播完——聚合状态晚一拍回落时不掐断刚起播的动画。
 *
 * `dragging` 开始时作废未播完的一次性命令：手势接管后它永远等不到 finish，留着
 * 只会在松手后凭空重播一遍。循环命令是状态型，保留。
 *
 * 订阅模型按 `useSyncExternalStore` 设计：`getSnapshot()` 在两次变更之间返回同一引用。
 */

import type { PetMotion, PetMotionInput } from "./types";

/** 生效中的动作状态。`revision` 每次换动作/重播递增，播放器拿它当「从头播」信号。 */
export interface PetMotionState {
  type: PetMotion;
  loop: boolean;
  revision: number;
}

/** 常驻循环的动作：没有「播完」概念，直到被别的动作顶替。 */
export const LOOPING_MOTIONS: readonly PetMotion[] = [
  "idle",
  "working",
  "waiting",
  "moving-left",
  "moving-right",
];

export function isLoopingMotion(motion: PetMotion): boolean {
  return LOOPING_MOTIONS.includes(motion);
}

export function normalizeMotionInput(input: PetMotionInput): {
  type: PetMotion;
  loop: boolean;
  replay: boolean;
} {
  if (typeof input === "string") {
    return { type: input, loop: isLoopingMotion(input), replay: false };
  }
  return {
    type: input.type,
    loop: input.loop ?? isLoopingMotion(input.type),
    replay: input.replay === true,
  };
}

/** 声明层的内容指纹（忽略 replay：prop 里写 replay 没有意义，不应造成每渲染换键）。 */
export function motionInputKey(input: PetMotionInput | undefined): string {
  if (input === undefined) return "";
  const n = normalizeMotionInput(input);
  return `${n.type}|${n.loop ? 1 : 0}`;
}

export class PetMotionMachine {
  private revisionCounter = 0;
  private override: PetMotionState | null = null;
  private propState: PetMotionState;
  private doneRevision: number | null = null;
  private dragging = false;
  private snapshot: PetMotionState;
  private listeners = new Set<() => void>();

  constructor(prop?: PetMotionInput) {
    const n = normalizeMotionInput(prop ?? "idle");
    this.propState = { type: n.type, loop: n.loop, revision: 0 };
    this.snapshot = this.computeSnapshot();
  }

  /* ----------------------------- 订阅（useSyncExternalStore） ----------------------------- */

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): PetMotionState => this.snapshot;

  /** 当前生效动作（便捷读取）。 */
  get current(): PetMotion {
    return this.snapshot.type;
  }

  /* ---------------------------------- 变更入口 ---------------------------------- */

  /** 声明层变化（调用方先用 `motionInputKey` 比对，只在键变化时调）。 */
  setProp(input: PetMotionInput | undefined): void {
    const n = normalizeMotionInput(input ?? "idle");
    this.revisionCounter += 1;
    this.propState = { type: n.type, loop: n.loop, revision: this.revisionCounter };
    // 循环命令被声明值重新接管；正在播的一次性命令保留到 finish（见文件头规则 3）
    if (this.override !== null && this.override.loop) this.override = null;
    this.doneRevision = null;
    this.emit();
  }

  /** 命令面下发（`pet.motion(...)`）。 */
  request(input: PetMotionInput): void {
    const n = normalizeMotionInput(input);
    const prev = this.override;
    // 已播完的一次性动作不算「重复下发」：再点一次就是要再看一次
    const finished = this.doneRevision !== null && prev !== null && this.doneRevision === prev.revision;
    if (!n.replay && !finished && prev !== null && prev.type === n.type && prev.loop === n.loop) return;

    this.revisionCounter += 1;
    this.override = { type: n.type, loop: n.loop, revision: this.revisionCounter };
    this.doneRevision = null;
    this.emit();
  }

  /** 清掉命令面，回落声明层。 */
  clear(): void {
    if (this.override === null) return;
    this.override = null;
    this.doneRevision = null;
    this.emit();
  }

  /** 手势态开关。置 true 时作废未播完的一次性命令（理由见文件头）。 */
  setDragging(dragging: boolean): void {
    if (this.dragging === dragging) return;
    this.dragging = dragging;
    if (dragging && this.override !== null && !this.override.loop) {
      this.override = null;
      this.doneRevision = null;
      this.emit();
    }
  }

  /** 一次性动作播完（播放器回调）。循环动作调用是空操作。 */
  finish(): void {
    const base = this.override ?? this.propState;
    if (base.loop) return;
    if (this.override !== null && this.override.revision === base.revision) {
      // 命令面的一次性动作播完 → 交还声明层
      this.override = null;
      this.doneRevision = null;
      this.emit();
      return;
    }
    // 声明层的一次性动作播完 → 同 revision 标记 done，快照落 idle（幂等：重复 finish 不再发事件）
    if (this.doneRevision === base.revision) return;
    this.doneRevision = base.revision;
    this.emit();
  }

  /* ---------------------------------- 内部 ---------------------------------- */

  private computeSnapshot(): PetMotionState {
    const base = this.override ?? this.propState;
    if (this.doneRevision !== null && this.doneRevision === base.revision && !base.loop) {
      return { type: "idle", loop: true, revision: base.revision };
    }
    return base;
  }

  private emit(): void {
    this.snapshot = this.computeSnapshot();
    for (const fn of this.listeners) fn();
  }
}
