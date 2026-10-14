/**
 * 会话控制器缓存（纯逻辑，可单测）：内存治理的两条规则收在这里。
 *
 * 背景：每个控制器持有一份转录窗口（含图片 base64）+ 投影 + 消息仓库。没有上限
 * 的话，切一次会话内存就长一截且永不释放（真机 RAM 一路涨的主因之一）。
 *
 * 两条规则：
 * 1. LRU 上限（默认 3）：超出按最近使用逐出，切回来冷读快照重建（与冷打开同一条路径）；
 * 2. **切走即放**（keep = 1，由调用方在换会话时触发）：上一会话的窗口连同图片
 *    base64 立刻可回收——RN 的 Image 没有清缓存 API（0.86 只有 queryCache/
 *    prefetch），所以图片内存唯一的闸门就在这里：行对象一没，base64 就能被 GC。
 *
 * 逐出豁免：直播中 / 有排队项的控制器永不逐出（逐出会拆掉事件订阅，直播就断了）。
 */
export type CacheableController = {
  getState(): {
    runStatus: string;
    queue: { steering: readonly unknown[]; followUp: readonly unknown[] };
  };
  dispose(): void;
};

export const MAX_CACHED_CONTROLLERS = 3;

const lastUsed = new Map<string, number>();
let useClock = 0;

/** 记一次使用（进入某会话时调用），LRU 依据 */
export function touchController(threadId: string): void {
  lastUsed.set(threadId, ++useClock);
}

/** 逐出记分：直播/有排队 → 永不逐出（MAX_SAFE_INTEGER），其余按 LRU */
function scoreOf(controllers: Map<string, CacheableController>, threadId: string): number {
  let score = lastUsed.get(threadId) ?? 0;
  try {
    const state = controllers.get(threadId)?.getState();
    if (
      state &&
      (state.runStatus === "running" ||
        state.queue.steering.length > 0 ||
        state.queue.followUp.length > 0)
    ) {
      score = Number.MAX_SAFE_INTEGER;
    }
  } catch {
    /* 状态读不到就按 LRU 处理 */
  }
  return score;
}

/**
 * 逐出到 `keep` 个以内（活动会话恒保留）。返回被逐出的线程 id，便于调用方断言/日志。
 */
export function pruneControllers(
  controllers: Map<string, CacheableController>,
  activeId: string,
  keep = MAX_CACHED_CONTROLLERS,
  onError?: (error: unknown) => void,
): string[] {
  if (controllers.size <= keep) return [];
  const ranked = [...controllers.keys()]
    .map((threadId) => ({ threadId, score: scoreOf(controllers, threadId) }))
    .sort((a, b) => b.score - a.score);
  // 豁免项（直播/有排队）与活动会话从候选里剔除，并占用保留名额——否则
  // keep 很小时（如切会话 keep=1）仍有豁免项会被排进逐出集（2026-10-04 修：
  // 当时两个直播会话只保得住一个）。
  const evictable = ranked.filter(
    (entry) => entry.score !== Number.MAX_SAFE_INTEGER && entry.threadId !== activeId,
  );
  const budget = Math.max(0, keep - (ranked.length - evictable.length));
  const evicted: string[] = [];
  for (const { threadId } of evictable.slice(budget)) {
    try {
      controllers.get(threadId)?.dispose();
    } catch (error) {
      onError?.(error);
    }
    controllers.delete(threadId);
    lastUsed.delete(threadId);
    evicted.push(threadId);
  }
  return evicted;
}

/** 仅供测试：清空 LRU 台账 */
export function __resetControllerCacheForTests(): void {
  lastUsed.clear();
  useClock = 0;
}
