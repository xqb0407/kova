/**
 * 主线程卡顿 / 冻结看门狗。
 *
 * 目标不是做性能分析，而是回答用户反馈「页面卡住了」时我们缺的那句话：
 * 卡了多久、什么时候卡的、卡之前刚跑过什么。整个实现不依赖任何性能 API，
 * 只靠一个 setInterval 计时器测漂移——macOS 的 Tauri 用的是 WKWebView，
 * PerformanceObserver('longtask') 是 Chromium 独有的，在那儿根本不存在。
 * 所以这里把 longtask 当可选增强：能用就补上归因（哪个容器/脚本），
 * 不能用就退化成纯计时器结论，一样能落进 web.log。
 *
 * 采样粒度是「两次 tick 的间隔减去预期间隔」，估的是主线程被独占的时长。
 * 代价是系统性偏小：阻塞往往起在上一次 tick 之后，那段没被计到，最多少算
 * 一个 TICK_MS（实测 1200ms 的阻塞测出 900ms，3600ms 测出 3100ms）。当作
 * 「量级」看没问题，别拿它做回归基线。
 */
import { reportFrontendWarning } from "@/lib/frontend-logging";

/** 采样周期。越小越灵敏，但空转开销越高；500ms 足够捕捉可感知卡顿 */
const TICK_MS = 500;
/** 超过这个值算「卡顿」：用户能感到界面一顿一顿 */
const JANK_MS = 700;
/** 超过这个值算「冻结」：界面基本失去响应，值得当面提示用户 */
const FREEZE_MS = 3000;
/** 冻结提示的最小间隔，避免连续卡顿把 toast 刷屏 */
const FREEZE_TOAST_COOLDOWN_MS = 180_000;
/** longtask 归因归并窗口：这段时间内的 longtask 视为同一次卡顿的归因补充 */
const ATTRIBUTION_MERGE_MS = 1500;
/** 环形缓冲保留条数（供崩溃反馈附带最近卡顿） */
const BUFFER_MAX = 20;
/** 崩溃反馈里附带多近的卡顿记录 */
export const RECENT_JANK_WINDOW_MS = 5 * 60_000;

export type JankKind = "jank" | "freeze";

export interface JankEvent {
  /** performance.timeOrigin 相对时刻与墙钟时间的近似配对：这里存墙钟毫秒 */
  at: number;
  /** 估算的主线程独占时长（毫秒） */
  ms: number;
  kind: JankKind;
  /** 归因来源：tick = 计时器漂移（哪都有）；longtask = Chromium 归因补充 */
  source: "tick" | "longtask";
  /** 仅 longtask 能给：容器类型/名称/来源脚本 */
  attribution?: string;
}

export interface PerfWatchOptions {
  /** 冻结时回调一次（已做频率限制），用来弹 toast 之类 */
  onFreeze?: (event: JankEvent) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let observer: PerformanceObserver | null = null;
let lastTick = 0;
let lastFreezeToast = 0;
let options: PerfWatchOptions = {};
/** 事件按时间正序，尾部是最新 */
const events: JankEvent[] = [];

function classify(ms: number): JankKind {
  return ms >= FREEZE_MS ? "freeze" : "jank";
}

function push(event: JankEvent): void {
  events.push(event);
  if (events.length > BUFFER_MAX) events.splice(0, events.length - BUFFER_MAX);
}

/** longtask 的归因字段不在 TS 的 DOM lib 里声明，按规范自己描述一份 */
interface LongTaskEntry extends PerformanceEntry {
  attribution?: {
    name?: string;
    containerType?: string;
    containerName?: string;
    containerSrc?: string;
  }[];
}

/** Chromium 的 longtask 归因能指到具体容器/脚本，比「卡了 900ms」有用得多 */
function describeAttribution(entry: PerformanceEntry): string | undefined {
  const first = (entry as LongTaskEntry).attribution?.[0];
  if (!first) return undefined;
  const parts = [
    first.containerType && first.containerType !== "window" ? `容器 ${first.containerType}` : "",
    first.containerName,
    first.containerSrc,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

function installLongtask(): void {
  // 老 WebView 没有 supportedEntryTypes，直接 observe 会抛
  const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] })
    .supportedEntryTypes;
  if (!supported?.includes("longtask")) return;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ms = Math.round(entry.duration);
        if (ms < JANK_MS) continue;
        const { event, isNew } = record(ms, "longtask", describeAttribution(entry));
        announce(event, isNew);
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    observer = null;
  }
}

function now(): number {
  return Date.now();
}

/**
 * 记一次卡顿。同一次阻塞必然被两个来源各报一遍（longtask 和计时器漂移），
 * 谁的回调先跑还不定，所以合并必须双向：谁后到谁认领，先到的那条说了算。
 * 不合并的话一次 3.6 秒的冻结会在报告里显示成两次，排查时先要怀疑这份数据。
 */
function record(
  ms: number,
  source: JankEvent["source"],
  attribution?: string,
): { event: JankEvent; isNew: boolean } {
  const at = now();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    // 时长接近 + 时间接近 才算同一次；只看时间会把连着的两下抖动并成一条
    if (at - e.at < ATTRIBUTION_MERGE_MS && Math.abs(e.ms - ms) < ATTRIBUTION_MERGE_MS) {
      if (attribution && !e.attribution) e.attribution = attribution;
      return { event: e, isNew: false };
    }
  }
  const event: JankEvent = { at, ms, kind: classify(ms), source, attribution };
  push(event);
  return { event, isNew: true };
}

/** 落盘 + 冻结提示。落盘只在新建记录时做一次，冻结提示两个来源都能触发（有限频） */
function announce(event: JankEvent, isNew: boolean): void {
  if (isNew) {
    const time = new Date(event.at).toTimeString().slice(0, 8);
    reportFrontendWarning(
      `[卡顿] ${event.kind === "freeze" ? "界面冻结" : "主线程卡顿"} ${event.ms}ms @ ${time}`,
    );
  }
  if (event.kind === "freeze" && event.at - lastFreezeToast >= FREEZE_TOAST_COOLDOWN_MS) {
    lastFreezeToast = event.at;
    options.onFreeze?.(event);
  }
}

function tick(): void {
  const t = now();
  // 首个 tick 只用来对齐基准，不是采样点
  if (!lastTick) {
    lastTick = t;
    return;
  }
  // 后台标签页的 setInterval 会被浏览器降频到分钟级，测出来的全是假卡顿
  if (typeof document !== "undefined" && document.hidden) {
    lastTick = t;
    return;
  }
  const gap = t - lastTick;
  lastTick = t;
  const blocked = gap - TICK_MS;
  if (blocked < JANK_MS) return;

  const { event, isNew } = record(Math.round(blocked), "tick");
  announce(event, isNew);
}

export function installPerfWatch(opts: PerfWatchOptions = {}): void {
  if (timer) return;
  options = opts;
  lastTick = 0;
  lastFreezeToast = 0;
  installLongtask();
  timer = setInterval(tick, TICK_MS);
}

export function uninstallPerfWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
  observer?.disconnect();
  observer = null;
  lastTick = 0;
}

/** 取最近一段时间的卡顿记录，给崩溃反馈 / 排查当上下文用 */
export function recentJank(withinMs: number = RECENT_JANK_WINDOW_MS): JankEvent[] {
  const from = now() - withinMs;
  return events.filter((e) => e.at >= from);
}

/** 渲染成可直接粘进 issue 的几行文本；没有记录返回空串 */
export function recentJankReport(withinMs: number = RECENT_JANK_WINDOW_MS): string {
  const recent = recentJank(withinMs);
  if (recent.length === 0) return "";
  const lines = recent.map((e) => {
    const time = new Date(e.at).toTimeString().slice(0, 8);
    const src = e.source === "longtask" ? "longtask" : "计时器";
    return `  ${time} ${e.kind === "freeze" ? "冻结" : "卡顿"} ${e.ms}ms（${src}）${
      e.attribution ? ` — ${e.attribution}` : ""
    }`;
  });
  return [`崩溃前 ${Math.round(withinMs / 60000)} 分钟内的主线程卡顿（${recent.length} 次）：`, ...lines].join(
    "\n",
  );
}
