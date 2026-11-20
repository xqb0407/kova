import { describe, expect, test } from "bun:test";

import { createHighlightQueue } from "./highlight-queue";

/** 手动调度器：测试里逐片驱动，断言"一次只执行一个任务" */
function manualScheduler() {
  const pending: (() => void)[] = [];
  return {
    schedule: (next: () => void) => {
      pending.push(next);
    },
    runNext: () => {
      const next = pending.shift();
      next?.();
    },
    runAll: () => {
      while (pending.length > 0) pending.shift()!();
    },
    pendingCount: () => pending.length,
  };
}

type Tokens = { html: string };

describe("createHighlightQueue：代码高亮排队", () => {
  test("首个请求一律排队（避免整批同步分词）；片内同步就绪则回调并缓存", () => {
    const scheduler = manualScheduler();
    const queue = createHighlightQueue<string, Tokens>({
      run: (code, done) => {
        const result = { html: code };
        done(result);
        return result;
      },
      schedule: scheduler.schedule,
    });
    const hits: Tokens[] = [];
    // 即便底层已经就绪，也不在渲染趟里同步执行——否则一次挂载又是整批分词
    expect(queue.request({ key: "a", value: "A" }, (r) => hits.push(r))).toBeNull();
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.runNext();
    expect(hits).toEqual([{ html: "A" }]);
    // 结果已缓存：后续渲染直接同步命中
    expect(queue.request({ key: "a", value: "A" })).toEqual({ html: "A" });
    expect(scheduler.pendingCount()).toBe(0);
  });

  test("未就绪：返回 null 并逐个调度执行，结果回调并缓存", () => {
    const scheduler = manualScheduler();
    const ran: string[] = [];
    const queue = createHighlightQueue<string, Tokens>({
      run: (code, done) => {
        ran.push(code);
        // 模拟 @streamdown/code：首次返回 null，稍后回调
        done({ html: code });
        return null;
      },
      schedule: scheduler.schedule,
    });
    const hits: Tokens[] = [];
    expect(queue.request({ key: "a", value: "A" }, (r) => hits.push(r))).toBeNull();
    expect(queue.request({ key: "b", value: "B" }, (r) => hits.push(r))).toBeNull();
    expect(ran).toEqual([]); // 还没到调度片
    scheduler.runNext();
    expect(ran).toEqual(["A"]); // 每片只跑一个
    scheduler.runNext();
    expect(ran).toEqual(["A", "B"]);
    expect(hits).toEqual([{ html: "A" }, { html: "B" }]);
    // 已完成：直接命中，不再排队/执行
    expect(queue.request({ key: "a", value: "A" })).toEqual({ html: "A" });
    expect(scheduler.pendingCount()).toBe(0);
  });

  test("同一 key 的结果回来前重复请求：只执行一次，回调合并", () => {
    const scheduler = manualScheduler();
    let runs = 0;
    const queue = createHighlightQueue<string, Tokens>({
      run: (code, done) => {
        runs += 1;
        done({ html: code });
        return null;
      },
      schedule: scheduler.schedule,
    });
    const hits: string[] = [];
    queue.request({ key: "a", value: "A" }, () => hits.push("first"));
    queue.request({ key: "a", value: "A" }, () => hits.push("second"));
    scheduler.runAll();
    expect(runs).toBe(1);
    expect(hits.sort()).toEqual(["first", "second"]);
  });

  test("执行抛错：只丢弃该任务，队列继续", () => {
    const scheduler = manualScheduler();
    const ran: string[] = [];
    const queue = createHighlightQueue<string, Tokens>({
      run: (code, done) => {
        ran.push(code);
        if (code === "boom") throw new Error("bad grammar");
        done({ html: code });
        return null;
      },
      schedule: scheduler.schedule,
    });
    const hits: Tokens[] = [];
    queue.request({ key: "x", value: "boom" }, (r) => hits.push(r));
    queue.request({ key: "y", value: "ok" }, (r) => hits.push(r));
    scheduler.runAll();
    expect(ran).toEqual(["boom", "ok"]);
    expect(hits).toEqual([{ html: "ok" }]);
  });

  test("LRU 上限：超限淘汰最旧，淘汰后重新排队", () => {
    const scheduler = manualScheduler();
    const ran: string[] = [];
    const queue = createHighlightQueue<string, Tokens>({
      maxEntries: 2,
      run: (code, done) => {
        ran.push(code);
        done({ html: code });
        return null;
      },
      schedule: scheduler.schedule,
    });
    const fill = (key: string) => {
      queue.request({ key, value: key });
      scheduler.runAll();
    };
    fill("a");
    fill("b");
    fill("c"); // 淘汰 a
    expect(queue.request({ key: "b", value: "b" })).toEqual({ html: "b" });
    expect(queue.request({ key: "a", value: "a" })).toBeNull(); // 已淘汰 → 重新排队
    scheduler.runAll();
    expect(ran).toEqual(["a", "b", "c", "a"]);
  });

  test("看门狗：底层不回调时丢弃等待项，下次请求可重新排队", async () => {
    const scheduler = manualScheduler();
    let runs = 0;
    const queue = createHighlightQueue<string, Tokens>({
      timeoutMs: 5,
      // 模拟 @streamdown/code 分词失败：返回 null 且永不回调
      run: () => {
        runs += 1;
        return null;
      },
      schedule: scheduler.schedule,
    });
    expect(queue.request({ key: "a", value: "A" })).toBeNull();
    scheduler.runAll();
    expect(runs).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    // 超时已丢弃等待项：再次请求重新入队（而不是永久悬挂）
    expect(queue.request({ key: "a", value: "A" })).toBeNull();
    scheduler.runAll();
    expect(runs).toBe(2);
  });

  test("命中同时刷新 LRU：近期命中的不会被先淘汰", () => {
    const scheduler = manualScheduler();
    const queue = createHighlightQueue<string, Tokens>({
      maxEntries: 2,
      run: (code, done) => {
        done({ html: code });
        return null;
      },
      schedule: scheduler.schedule,
    });
    const fill = (key: string) => {
      queue.request({ key, value: key });
      scheduler.runAll();
    };
    fill("a");
    fill("b");
    // 命中 a → a 变成最近使用
    expect(queue.request({ key: "a", value: "a" })).toEqual({ html: "a" });
    fill("c"); // 淘汰 b（最旧）
    expect(queue.request({ key: "c", value: "c" })).toEqual({ html: "c" });
    expect(queue.request({ key: "b", value: "b" })).toBeNull();
    expect(queue.request({ key: "a", value: "a" })).toEqual({ html: "a" });
  });
});
