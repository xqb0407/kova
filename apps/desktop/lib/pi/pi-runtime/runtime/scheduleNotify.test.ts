// 回归：回焦首帧长任务。
//
// 现象（Windows 打包版）：对话在跑着，窗口切到别的软件再切回来首帧卡顿，
// 卡顿看门狗据此弹「界面卡住了」。成因之一是合并刷新挂在 rAF 上——隐藏页
// rAF 不跑，整段隐藏期间的 message_update 会憋到回焦第一帧一次性渲染。
// 隐藏时必须给合并窗口一个上限，让渲染量摊开而不是全堆到那一帧。
import { afterEach, afterAll, describe, expect, it } from "bun:test";
import { defaultScheduleNotify } from "./ThreadController";

type MutableGlobals = {
  document?: unknown;
  requestAnimationFrame?: (cb: () => void) => number;
};

const g = globalThis as unknown as MutableGlobals;
const original = { document: g.document, requestAnimationFrame: g.requestAnimationFrame };

afterEach(() => {
  g.document = undefined;
  g.requestAnimationFrame = undefined;
});

afterAll(() => {
  g.document = original.document;
  g.requestAnimationFrame = original.requestAnimationFrame;
});

/** 记录被挂起的帧回调；返回值长度 = 挂了几帧 */
const trackRaf = () => {
  const frames: Array<() => void> = [];
  g.requestAnimationFrame = (cb) => frames.push(cb);
  return frames;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("defaultScheduleNotify（合并刷新调度）", () => {
  it("可见时挂在 rAF 上，且不在调度时同步执行", () => {
    const frames = trackRaf();
    g.document = { hidden: false };
    let flushed = 0;
    defaultScheduleNotify(() => (flushed += 1));
    expect(frames.length).toBe(1);
    expect(flushed).toBe(0);
    frames[0]!();
    expect(flushed).toBe(1);
  });

  it("隐藏时不挂在 rAF 上：退回定时器，刷新不再无限期推迟", async () => {
    const frames = trackRaf();
    g.document = { hidden: true };
    let flushed = 0;
    defaultScheduleNotify(() => (flushed += 1));
    expect(frames.length).toBe(0);
    expect(flushed).toBe(0);
    await wait(40);
    expect(flushed).toBe(1);
  });

  it("宿主没有 rAF 时退回定时器", async () => {
    g.document = { hidden: false };
    let flushed = 0;
    defaultScheduleNotify(() => (flushed += 1));
    await wait(40);
    expect(flushed).toBe(1);
  });
});
