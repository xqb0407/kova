/**
 * 渲染耗时上报的极简中转：RenderProbe 往里写，PerfHud 每 500ms 取一次。
 *
 * 为什么不直接 console.log：读 console 得开 devtools，而 **Web Inspector 一旦
 * 挂在 WKWebView 上，本身就会让页面明显变慢**（录制 Timeline、尤其带截图采集
 * 更是重上加重）——用 devtools 测「卡不卡」，测到的主要是 devtools 自己。
 * 走屏上 HUD 就不存在这个问题。
 */

/** label → 本轮窗口内最慢的一次渲染耗时 */
const worst = new Map<string, number>();

export function noteRender(label: string, ms: number): void {
  if (ms > (worst.get(label) ?? 0)) worst.set(label, ms);
}

/** 取出并清空（HUD 每 500ms 一次，所以是「近 500ms 最慢」） */
export function takeWorst(): [string, number][] {
  const out = [...worst.entries()];
  worst.clear();
  return out;
}

/* --------------------------- 事实类上报（非耗时） --------------------------- */
/** 渲染耗时要配上下文才有意义：118ms 配 200 条消息和配 3000 条消息是两码事。
 *  这里收「最大值」类事实（如消息条数），同样每窗口被 HUD 取走。 */
const facts = new Map<string, number>();

export function noteFact(label: string, value: number): void {
  if (value > (facts.get(label) ?? 0)) facts.set(label, value);
}

export function takeFacts(): [string, number][] {
  const out = [...facts.entries()];
  facts.clear();
  return out;
}

/** 区间耗时上报（与 noteRender 同一张表、同一个出口）：给非渲染阶段的分段计时
 *  用，比如「投影+通知」这种夹在两帧之间的同步开销。 */
export const noteSpan = (label: string, ms: number): void => noteRender(label, ms);
