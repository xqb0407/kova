/**
 * 代码高亮排队：把「一次挂载里所有代码块的同步分词」摊到多帧。
 *
 * 背景（会话切换卡顿的根因之一）：@streamdown/code 的 highlight 首次返回
 * null，等 highlighter 就绪后在 **微任务**里跑 codeToTokens——同一轮挂载的
 * 所有代码块会在同一批微任务里连续分词。100+ 轮、代码块很多的长会话切换时，
 * 这就是一次持续数秒的主线程阻塞（long task / 界面冻结）。
 *
 * 这里在插件外层排队：
 * - 命中已完成缓存 → 同步返回结果（调用方直接上色，不再排队）；
 * - 未命中 → 登记回调并返回 null（调用方先渲染纯文本），之后**每个调度片
 *   只执行一个任务**，分词成本被摊到多帧，单次长任务退化为多段短任务；
 * - 同一 key 的重复请求（同一块在结果回来前的多次渲染）只执行一次，
 *   回调全部合并到结果到达时统一触发；
 * - 已完成缓存按 LRU 限量，key 采用「语言/主题/长度/首尾片段」与
 *   @streamdown/code 自身的缓存键同构（同一块文本不会误配）。
 */

export type HighlightQueueTask<T> = { key: string; value: T };

export type HighlightQueueOptions<T, R> = {
  /** 执行一次高亮：同步就绪返回结果，否则在 done 回调里返回 */
  run: (value: T, done: (result: R) => void) => R | null;
  /** 调度下一个执行片。默认 setTimeout 0（每块之间让出主线程） */
  schedule?: (next: () => void) => void;
  /** 已完成结果缓存上限（LRU） */
  maxEntries?: number;
  /** 单块等待上限：超时仍未回调就丢弃等待项（下一次渲染可重新排队）。
   *  底层（@streamdown/code）分词失败时只清自己的回调、不通知调用方，
   *  没有看门狗的话该块会永久 pending 且每次渲染都白问一遍 */
  timeoutMs?: number;
};

export type HighlightQueue<T, R> = {
  /** 命中返回结果；未命中入队并返回 null（调用方按"未就绪"渲染纯文本） */
  request(
    task: HighlightQueueTask<T>,
    callback?: (result: R) => void,
  ): R | null;
};

const scheduleDefault = (next: () => void): void => {
  // 每块之间隔一个宏任务：既不像微任务那样攒成一整批分词（长任务来源），
  // 也不依赖 requestIdleCallback——空闲回调在连续滚动/流式时会被长期饿死
  // （带 200ms timeout 时 100+ 块要几十秒才全部上色），宏任务则由主线程
  // 按真实负载自然控速：忙时排后、闲时迅速排空
  setTimeout(next, 0);
};

export function createHighlightQueue<T, R>(
  options: HighlightQueueOptions<T, R>,
): HighlightQueue<T, R> {
  const { run } = options;
  const schedule = options.schedule ?? scheduleDefault;
  const maxEntries = Math.max(1, options.maxEntries ?? 200);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 10_000);
  /** 已完成：key → tokens（LRU，最近命中在尾部） */
  const done = new Map<string, R>();
  /** 排队中：key → 首个请求的任务体 + 等待回调集合 */
  const waiting = new Map<
    string,
    { value: T; callbacks: Set<(result: R) => void> }
  >();
  /** FIFO 待执行 key（已取消/已完成的条目执行时跳过） */
  const queue: string[] = [];
  let draining = false;
  /** key → 看门狗计时器（底层迟迟不回调时兜底释放等待项） */
  const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();

  const clearWatchdog = (key: string): void => {
    const timer = watchdogs.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      watchdogs.delete(key);
    }
  };

  const remember = (key: string, result: R): void => {
    done.delete(key);
    done.set(key, result);
    while (done.size > maxEntries) {
      const oldest = done.keys().next().value;
      if (oldest === undefined) break;
      done.delete(oldest);
    }
  };

  const settle = (key: string, result: R): void => {
    clearWatchdog(key);
    remember(key, result);
    const item = waiting.get(key);
    if (!item) return;
    waiting.delete(key);
    for (const callback of item.callbacks) {
      try {
        callback(result);
      } catch {
        // 单个消费者异常不影响其它回调/队列继续
      }
    }
  };

  const step = (): void => {
    // 取下一个仍有人等的任务；已不需要的条目直接丢弃
    let key: string | undefined;
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (candidate !== undefined && waiting.has(candidate)) {
        key = candidate;
        break;
      }
    }
    if (key === undefined) {
      draining = false;
      return;
    }
    const item = waiting.get(key);
    if (!item) {
      draining = false;
      return;
    }
    try {
      const sync = run(item.value, (result) => settle(key!, result));
      if (sync !== null) {
        settle(key, sync);
      } else if (timeoutMs > 0) {
        // 看门狗：底层分词失败时 @streamdown/code 只清自己的回调、不通知
        // 调用方。超时丢弃等待项，下一次渲染可重新排队——否则该块永久
        // pending（waiting 里还攥着整段代码字符串）
        clearWatchdog(key);
        watchdogs.set(
          key,
          setTimeout(() => {
            watchdogs.delete(key!);
            waiting.delete(key!);
          }, timeoutMs),
        );
      }
    } catch {
      // 同步抛错：丢弃该任务，后续请求会重新排队
      clearWatchdog(key);
      waiting.delete(key);
    }
    if (queue.length === 0) {
      draining = false;
      return;
    }
    schedule(step);
  };

  const startDrain = (): void => {
    if (draining) return;
    draining = true;
    schedule(step);
  };

  return {
    request(task, callback) {
      const hit = done.get(task.key);
      if (hit !== undefined) {
        // LRU 触碰：命中项挪到尾部
        done.delete(task.key);
        done.set(task.key, hit);
        return hit;
      }
      const item = waiting.get(task.key);
      if (item) {
        if (callback) item.callbacks.add(callback);
      } else {
        const callbacks = new Set<(result: R) => void>();
        if (callback) callbacks.add(callback);
        waiting.set(task.key, { value: task.value, callbacks });
        queue.push(task.key);
      }
      startDrain();
      return null;
    },
  };
}
