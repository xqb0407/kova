/**
 * 渲染耗时上报的极简中转：RenderProbe 往里写，性能汇总（perf-hud）每 500ms 取一次。
 *
 * 为什么不直接 console.log：读 console 得开 devtools，而 **Web Inspector 一旦
 * 挂在 WKWebView 上，本身就会让页面明显变慢**（录制 Timeline、尤其带截图采集
 * 更是重上加重）——用 devtools 测「卡不卡」，测到的主要是 devtools 自己。
 */

/**
 * 性能日志总开关（默认关）：控制台上那些 `[perf]` 行——采样汇总的定期上报
 * （perf-hud）与探针的慢帧提示（render-probe）——都归它管。默认为关是让控制台
 * 干净；收集本身仍在跑（几张 label→最大值的小表，成本可忽略），要排性能时把
 * 这里改回 true，采样循环与上报会一起活过来，屏上那行已经不画了（见 perf-hud）。
 */
export const PERF_LOG = false;

/** label → 本轮窗口内最慢的一次渲染耗时 */
const worst = new Map<string, number>();

export function noteRender(label: string, ms: number): void {
  if (ms > (worst.get(label) ?? 0)) worst.set(label, ms);
}

/** 取出并清空（采样汇总每 500ms 取一次，所以是「近 500ms 最慢」） */
export function takeWorst(): [string, number][] {
  const out = [...worst.entries()];
  worst.clear();
  return out;
}

/* --------------------------- 事实类上报（非耗时） --------------------------- */
/** 渲染耗时要配上下文才有意义：118ms 配 200 条消息和配 3000 条消息是两码事。
 *  这里收「最大值」类事实（如消息条数），同样每窗口被采样汇总取走。 */
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

/* ------------------------ 分段累计（对照实验用） ------------------------ */

/**
 * 累计器：sum / count / worst，只有实验方 takeSpanAccums 主动取走才清空。
 *
 * 与上面 noteRender 的「500ms 窗口最大值」分工不同：那边被 perf-hud 定期取走，
 * 只能看瞬时峰值；这里回答的是「同一条路径跑了 N 次、总共花了多少、最慢一次
 * 多少」——用于改前/改后的对照（dev-preview/long-turn 的 scroll= 变体就是这么
 * 比的）。代价只是 Map 里几个数字的累加，留在生产也无所谓。
 */
const accums = new Map<
  string,
  { sum: number; count: number; worst: number }
>();

export function noteSpanAccum(label: string, ms: number): void {
  // 与探针同口径：累计器与计数只在开发构建收集（生产零开销）。noteRender 不设闸
  // 是因为 perf-hud 的定期上报在所有构建都跑，这张新表没有那个用途。
  if (process.env.NODE_ENV === "production") return;
  const entry = accums.get(label);
  if (!entry) {
    accums.set(label, { sum: ms, count: 1, worst: ms });
    return;
  }
  entry.sum += ms;
  entry.count += 1;
  if (ms > entry.worst) entry.worst = ms;
}

/** 取出并清空（一次实验只在结束时取一次：中途取会把总量拆散） */
export function takeSpanAccums(): [
  string,
  { sum: number; count: number; worst: number },
][] {
  const out = [...accums.entries()];
  accums.clear();
  return out;
}

/** 开始一次实验前清空，剔掉挂载期的噪声 */
export function resetSpanAccums(): void {
  accums.clear();
  counts.clear();
}

/**
 * 计数类上报（与累计器同一个出口）：只数次数、不看耗时——回答「这条分支走了几
 * 次」这类事实（如「贴尾写了几次」「用户让位几次」）。与耗时累计同样等到实验
 * 结束才 takeCounts。
 */
const counts = new Map<string, number>();

export function noteCount(label: string): void {
  if (process.env.NODE_ENV === "production") return;
  counts.set(label, (counts.get(label) ?? 0) + 1);
}

export function takeCounts(): [string, number][] {
  const out = [...counts.entries()];
  counts.clear();
  return out;
}
