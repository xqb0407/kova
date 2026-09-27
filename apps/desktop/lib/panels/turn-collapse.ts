/**
 * 轮次折叠状态与耗时台账（模块级 store，跨组件共享，键带会话维度）。
 *
 * 折叠策略：默认「最后一轮展开，更早的轮折叠」；用户的展开/收起是显式覆盖，
 * 一旦点过就以用户为准（自动策略不再翻回去）。
 *
 * 耗时台账：直播轮的开始时刻在轮次出现时记一次（Date.now），结束时刻取该轮
 * 末条 assistant 消息的 timing（框架在流结束时写入 metadata.timing）；历史轮
 * 两端都来自 sidecar 转录行的时间戳（loadPiHistory 装载时播种）。任一缺失
 * 就不显示耗时——宁可不显示，不显示错的。
 *
 * 键一律带会话维度（`threadId:messageId`）：消息 id 只在会话内唯一（历史重建
 * 用转录行 seq），跨会话可能撞号。
 */
import { useSyncExternalStore } from "react";

type Listener = () => void;

function makeMapStore<V>() {
  let snapshot: ReadonlyMap<string, V> = new Map();
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: (key: string): V | undefined => snapshot.get(key),
    has: (key: string): boolean => snapshot.has(key),
    set(key: string, value: V): void {
      const next = new Map(snapshot);
      next.set(key, value);
      snapshot = next;
      for (const listener of listeners) listener();
    },
    reset(): void {
      snapshot = new Map();
      for (const listener of listeners) listener();
    },
  };
}

/** 会话作用域的轮次键 */
export function scopedTurnKey(threadId: string | undefined, turnKey: string): string {
  return `${threadId ?? ""}:${turnKey}`;
}

/* ------------------------------ 折叠覆盖 ------------------------------ */

const collapseOverrides = makeMapStore<boolean>();

/** 用户显式展开/收起某轮（覆盖自动策略） */
export function setTurnCollapsed(scopedKey: string, collapsed: boolean): void {
  if (collapseOverrides.get(scopedKey) === collapsed) return;
  collapseOverrides.set(scopedKey, collapsed);
}

/** 展开某轮（编辑消息等场景下强制展开） */
export function expandTurn(scopedKey: string): void {
  setTurnCollapsed(scopedKey, false);
}

/** 读取显式覆盖（undefined = 尚未点过，走自动策略） */
export function getTurnCollapseOverride(scopedKey: string): boolean | undefined {
  return collapseOverrides.get(scopedKey);
}

/** 折叠态 = 用户覆盖 ?? 自动策略（autoExpanded 传"是否应保持展开"） */
export function useTurnCollapsed(scopedKey: string, autoExpanded: boolean): boolean {
  const override = useSyncExternalStore(
    collapseOverrides.subscribe,
    () => collapseOverrides.get(scopedKey),
    () => undefined,
  );
  return override ?? !autoExpanded;
}

/* ------------------------------ 耗时台账 ------------------------------ */

type TurnTiming = {
  /** 本轮开始（ms） */
  start?: number;
  /** 本轮结束（ms）：历史轮来自转录行时间戳 */
  end?: number;
  /** 内部标记：这个开始是我们"亲眼看着"记下的（直播轮）——只有这种轮才允许
   *  由我们补记结束时刻。历史播种的轮绝不去编造 end（那会造出假时长） */
  live?: boolean;
};

const turnTimings = makeMapStore<TurnTiming>();

/** 直播：轮次首次出现在消息流时记开始（已有的值不覆盖——历史播种是权威） */
export function noteTurnStart(scopedKey: string, at: number): void {
  if (turnTimings.get(scopedKey)?.start !== undefined) return;
  turnTimings.set(scopedKey, { ...turnTimings.get(scopedKey), start: at, live: true });
}

/**
 * 直播：轮子不再进行时补记结束时刻。
 * 需要它是因为框架的流式计时在**取消/中断**路径上不 finalize（manual stop 后
 * metadata.timing 缺失），光靠 timing 拿不到结束时刻——那样停止的轮只能显示
 * 「本轮过程」而不是耗时。只对 live 条目生效：历史播种的轮不补，避免造出假时长。
 */
export function noteTurnEnd(scopedKey: string, at: number): void {
  const current = turnTimings.get(scopedKey);
  if (!current || current.live !== true || current.end !== undefined) return;
  turnTimings.set(scopedKey, { ...current, end: at });
}

/**
 * 计时写入决策（纯函数，便于单测）：给定台账现状与"这一轮是否进行中"，
 * 该做哪一种写入。
 *  - 进行中且台账里两端都齐（跑过一次了）⇒ restart：重新生成，重开计时
 *  - 进行中其余情况 ⇒ start（已有的开始不覆盖；历史播种是权威）
 *  - 已结束 ⇒ end（只对直播轮补）
 */
export function resolveTurnTimingWrite(
  current: TurnTiming | undefined,
  live: boolean,
): "start" | "restart" | "end" {
  if (!live) return "end";
  if (current?.start !== undefined && current.end !== undefined) return "restart";
  return "start";
}

/**
 * 重新生成（Reload/重试）后重开计时：同一轮从"已结束"再次进入"进行中"，说明
 * 又跑了一次。不重置的话耗时会把上一次尝试到这一次之间的等待也算进去，看起来
 * 像"时间一直累积"。整体覆盖：旧的开始与结束都作废，从这一次重开算。
 */
export function restartTurnTiming(scopedKey: string, at: number): void {
  turnTimings.set(scopedKey, { start: at, live: true });
}

/** 历史装载：用转录行时间戳播种两端（整体覆盖——转录时间戳先于本次渲染写下） */
export function seedTurnTiming(scopedKey: string, timing: TurnTiming): void {
  turnTimings.set(scopedKey, timing);
}

/** 台账读取（组件走 useTurnDurationMs；这里给测试与调试用） */
export function getTurnTiming(scopedKey: string): TurnTiming | undefined {
  return turnTimings.get(scopedKey);
}

/** 亚秒级耗时不给数字：定时任务等场景转录两行同批落盘，算出来是 0 秒——
 *  显示"已工作 0 秒"是噪音，不如退回默认文案 */
const MIN_MEANINGFUL_DURATION_MS = 1000;

/**
 * 本轮耗时（ms）：开始取台账，结束优先取框架 finalized 的流结束时刻
 * （直播轮），其次取台账里的历史结束时刻。缺失 / 非正 / 亚秒级返回 undefined。
 */
export function computeTurnDurationMs(
  timing: TurnTiming | undefined,
  timingEnd: number | null,
  running: boolean,
): number | undefined {
  if (running) return undefined;
  const start = timing?.start;
  const end = timingEnd ?? timing?.end;
  if (start === undefined || end === undefined) return undefined;
  const duration = end - start;
  return duration >= MIN_MEANINGFUL_DURATION_MS ? duration : undefined;
}

export function useTurnDurationMs(
  scopedKey: string,
  timingEnd: number | null,
  running: boolean,
): number | undefined {
  const timing = useSyncExternalStore(
    turnTimings.subscribe,
    () => turnTimings.get(scopedKey),
    () => undefined,
  );
  return computeTurnDurationMs(timing, timingEnd, running);
}

/** 仅供测试：清空两个台账 */
export function __resetTurnStoresForTests(): void {
  collapseOverrides.reset();
  turnTimings.reset();
}
