/**
 * 轮次折叠状态与耗时台账（模块级 store，跨组件共享，键带会话维度）。
 *
 * 折叠策略：默认「最后一轮展开，更早的轮折叠」；用户的展开/收起是显式覆盖，
 * 一旦点过就以用户为准（自动策略不再翻回去）。
 *
 * 耗时台账：直播轮的开始时刻在轮次出现时记一次（Date.now），结束时刻取该轮
 * 末条 assistant 消息的 timing（框架在流结束时写入 metadata.timing）；历史轮
 * 两端都来自 sidecar 转录行的时间戳（新链路在 PiClientBase.fetchSnapshot 读到
 * 快照即播种——唯一汇聚点，覆盖冷读与派发两条路径，seedHistoryTurnTimings）。
 * 任一缺失就不显示耗时——宁可不显示，不显示错的。
 *
 * 键一律带会话维度（`threadId:messageId`）：消息 id 只在会话内唯一（历史重建
 * 用转录行 seq），跨会话可能撞号。
 */
import { useSyncExternalStore } from "react";
import { registerPerfProbeSource } from "@/lib/perf-probe";

type Listener = () => void;

/**
 * 写入模型：**原地 set + 全量 notify**。旧实现每次 set 整表复制（O(n)），
 * 长会话首开逐轮播种 N 轮 = N 次整表复制（O(n²) 条目搬运）+ N 轮订阅者
 * 回调——「打开长会话卡一下」的贡献者之一。
 * 消费方（useSyncExternalStore 的 getSnapshot）全部经 `.get(key)` 读活值、
 * 不持有整表快照，原地改安全；对象值要触发重渲染仍由调用方换新对象。
 */
function makeMapStore<V>() {
  const data = new Map<string, V>();
  const listeners = new Set<Listener>();
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: (key: string): V | undefined => data.get(key),
    has: (key: string): boolean => data.has(key),
    get size(): number {
      return data.size;
    },
    set(key: string, value: V): void {
      data.set(key, value);
      notify();
    },
    /** 批量写：一次 notify（逐轮播种这类同帧多写场景专用） */
    setMany(entries: Iterable<[string, V]>): void {
      let n = 0;
      for (const [k, v] of entries) {
        data.set(k, v);
        n += 1;
      }
      if (n > 0) notify();
    },
    /** 按键前缀摘除（会话级台账清理：键一律 `threadId:…` 作用域） */
    purgePrefix(prefix: string): void {
      let n = 0;
      for (const k of [...data.keys()]) {
        if (k.startsWith(prefix)) {
          data.delete(k);
          n += 1;
        }
      }
      if (n > 0) notify();
    },
    reset(): void {
      data.clear();
      notify();
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
  /** 补记结束那一刻，本轮「有实质内容的 assistant 消息」条数（纯 data 的
   *  压缩/模型切换分隔线不算，见 TurnTimingRecorder 的 selector）。用来区分
   *  "同一轮真的重跑"与"下一轮 agent_start 把线程拉回 running 的空窗"：
   *  条数没涨就没重跑。 */
  endContentCount?: number;
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
 *
 * contentCount 是补记时的内容条数：结束时刻只写一次，但条数允许在后续提交里
 * 更新（消息 id 重锚、快照晚到一行都会让同一轮晚一步定型），它是判定"重跑"
 * 的基线，宁可跟着最新状态走。
 */
export function noteTurnEnd(
  scopedKey: string,
  at: number,
  contentCount?: number,
): void {
  const current = turnTimings.get(scopedKey);
  if (!current || current.live !== true) return;
  if (current.end === undefined) {
    turnTimings.set(scopedKey, {
      ...current,
      end: at,
      ...(contentCount !== undefined ? { endContentCount: contentCount } : {}),
    });
    return;
  }
  if (contentCount === undefined || current.endContentCount === contentCount) return;
  turnTimings.set(scopedKey, { ...current, endContentCount: contentCount });
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
 * 直播打点实际执行的动作：在 {@link resolveTurnTimingWrite} 之上过滤掉两类
 * 假 restart（都不该动已有台账）。
 *
 *  - 线程级 running 不代表末轮又在跑：排队项被接棒（含「立即发送」中止当前轮）
 *    时，上一轮 agent_end 刚补记结束，下一轮 agent_start 紧接着把线程拉回
 *    running，而末轮还是刚结束的那一条。此时若重开计时，会清掉刚记下的结束、
 *    把开始重置成此刻；下一轮用户消息一落位给上一轮补结束，时长只剩几毫秒，
 *    亚秒级不显示——摘要行直接退回「N 条较早消息」。判据用本轮**实质内容的
 *    条数**：没有新内容就不是重跑（不能看消息 status——下一轮 agent_start 会
 *    把上一轮末条 assistant 也标成 running）。
 *  - 历史播种的条目（live !== true）在轮内是权威：乐观 id 落盘换成
 *    `pi-msg:${seq}` 时同一轮会以新键再出现，播种条目已带两端（start = user
 *    行时间戳、end = 本轮最新行时间戳），不能因"两端齐了"就 restart。
 */
export function resolveObservedTurnTimingWrite(
  current: TurnTiming | undefined,
  live: boolean,
  contentCount: number,
): "start" | "restart" | "end" | "none" {
  const action = resolveTurnTimingWrite(current, live);
  if (action !== "restart") return action;
  if (current?.live !== true) return "none";
  if (
    current.endContentCount !== undefined &&
    contentCount <= current.endContentCount
  ) {
    return "none";
  }
  return "restart";
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

/** 历史装载批量播种：一次 notify（长会话逐轮写曾是 O(n²) 整表复制源） */
export function seedTurnTimings(entries: Iterable<[string, TurnTiming]>): void {
  turnTimings.setMany(entries);
}

/**
 * 会话级台账清理（控制器 LRU 淘汰 / 会话删除时调用）：两张表按 `threadId:`
 * 前缀摘除。轮耗时不丢——下次打开该会话由快照重新播种；用户显式折叠覆盖
 * 一并作废（会话都不在了，覆盖没有归属）。
 */
export function purgeThreadTurns(threadId: string): void {
  const prefix = `${threadId}:`;
  collapseOverrides.purgePrefix(prefix);
  turnTimings.purgePrefix(prefix);
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

registerPerfProbeSource("turn-collapse", () => ({
  turnTimings: turnTimings.size,
  collapseOverrides: collapseOverrides.size,
}));
