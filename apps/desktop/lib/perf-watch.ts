/**
 * 主线程卡顿 / 冻结看门狗。
 *
 * 目标不是做性能分析，而是回答用户反馈「页面卡住了」时我们缺的那句话：
 * 卡了多久、什么时候卡的、卡之前刚跑过什么。整个实现不依赖任何性能 API，
 * 只靠一个 setInterval 计时器测漂移——macOS 的 桌面壳 用的是 WKWebView，
 * PerformanceObserver('longtask') 是 Chromium 独有的，在那儿根本不存在。
 * 所以这里把 longtask 当可选增强：能用就补上归因（哪个容器/脚本），
 * 不能用就退化成纯计时器结论，一样能落进 web.log。
 *
 * 采样粒度是「两次 tick 的间隔减去预期间隔」，估的是主线程被独占的时长。
 * 代价是系统性偏小：阻塞往往起在上一次 tick 之后，那段没被计到，最多少算
 * 一个 TICK_MS（实测 1200ms 的阻塞测出 900ms，3600ms 测出 3100ms）。当作
 * 「量级」看没问题，别拿它做回归基线。
 *
 * 漂移法有一个必须显式排除的假卡顿来源：窗口被遮挡/最小化时页面转 hidden，
 * 浏览器把定时器降频（秒级 → 分钟级），恢复可见时逾期任务又被立刻补跑。
 * 这段间隔里主线程并没有被占住，但回焦后的第一拍会把它整段算成阻塞——表现
 * 为「切到别的软件再切回来必弹一次界面冻结」。所以判定要求「自上次采样以来
 * 时钟一直可信」，隐藏期间与跨可见性变化的那一拍只对齐基准、不判定
 * （见 isMeasureableGap）。
 *
 * 计时器漂移只能证明**主线程**被占住。Windows 上还有另一类冻结：GPU 进程被
 * WebGL/驱动卡住（或 TDR 恢复），主线程完全空闲、定时器照跑，但合成器不再
 * 出帧，窗口一样一动不动。所以这里另开一路 rAF 间隔看门狗（source="frame"）：
 * rAF 由合成器的 BeginFrame 驱动，它停了才是真的「画面冻住」。判定沿用同一套
 * 可见性/焦点/时钟可信闸门，避免遮挡降频造成假 gap。
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
  /** 归因来源：tick = 计时器漂移（主线程）；longtask = Chromium 归因补充；
   *  frame = rAF 间隔（合成器/GPU 侧，主线程可能完全空闲） */
  source: "tick" | "longtask" | "frame";
  /** 仅 longtask 能给：容器类型/名称/来源脚本 */
  attribution?: string;
}

export interface PerfWatchOptions {
  /** 冻结时回调一次（已做频率限制），用来弹 toast 之类 */
  onFreeze?: (event: JankEvent) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let observer: PerformanceObserver | null = null;
let frameHandle: number | null = null;
/** rAF 看门狗是否在运行：uninstall 期间正在执行的 frameTick 不能把自己重新排上 */
let frameWatchActive = false;
let lastTick = 0;
/** 上一帧 rAF 的时刻（0=还没对齐基准）；与 lastTick 分开计时 */
let lastFrameAt = 0;
let lastFreezeToast = 0;
/** 最近一次「时钟不可信」的时刻：页面可见性变化 / 从冻结恢复 */
let lastClockUnstableAt = 0;
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
      // 计时器也漂了 ⇒ 主线程同样被占住，不是纯 GPU/合成器冻结：来源改回 tick，
      // 日志措辞才准确（rAF 停了但主线程空闲才是 frame）。
      if (e.source === "frame" && source === "tick") e.source = "tick";
      return { event: e, isNew: false };
    }
  }
  const event: JankEvent = { at, ms, kind: classify(ms), source, attribution };
  push(event);
  return { event, isNew: true };
}

/** 卡顿现场读数：Chromium 才有 performance.memory；DOM 节点数各宿主都能取。
 *  用来区分「CPU 忙」与「内存/GC 压垮」——渲染进程堆到 GB 级时，切会话的
 *  挂载与 full GC 才是冻结主因，单看时长分不出来 */
function describeScene(): string {
  const parts: string[] = [];
  try {
    const memory = (
      performance as Performance & {
        memory?: { usedJSHeapSize?: number };
      }
    ).memory;
    if (typeof memory?.usedJSHeapSize === "number") {
      parts.push(`heap ${Math.round(memory.usedJSHeapSize / 1048576)}MB`);
    }
  } catch {
    /* 取不到就不带 */
  }
  try {
    if (typeof document !== "undefined") {
      const nodes = document.getElementsByTagName("*").length;
      if (nodes > 0) parts.push(`DOM ${(nodes / 1000).toFixed(1)}k`);
    }
  } catch {
    /* 同上 */
  }
  return parts.length > 0 ? `，${parts.join("，")}` : "";
}

/** 落盘 + 冻结提示。落盘只在新建记录时做一次，冻结提示各来源都能触发（有限频） */
function announce(event: JankEvent, isNew: boolean): void {
  if (isNew) {
    const time = new Date(event.at).toTimeString().slice(0, 8);
    const src =
      event.source === "frame" ? "渲染帧/GPU" : event.source === "longtask" ? "longtask" : "计时器";
    // frame 的文案要和主线程卡顿分开：日志读者据此判断该查 JS 还是查 GPU
    const what =
      event.source === "frame"
        ? "渲染帧冻结（主线程未漂移，指向 GPU/合成器）"
        : event.kind === "freeze"
          ? "界面冻结"
          : "主线程卡顿";
    reportFrontendWarning(
      `[卡顿] ${what} ${event.ms}ms（${src}${describeScene()}）@ ${time}`,
    );
  }
  if (event.kind === "freeze" && event.at - lastFreezeToast >= FREEZE_TOAST_COOLDOWN_MS) {
    lastFreezeToast = event.at;
    options.onFreeze?.(event);
  }
}

/**
 * 标记一次「时钟不可信」：页面被隐藏期间 Chromium 会把定时器降频（先是秒级，
 * 超预算后分钟级），恢复可见时逾期任务又会被立刻补跑——回焦后的第一拍于是
 * 可能测到整段隐藏时长，被记成主线程冻结。踩个点，跨过它的间隔一律丢弃。
 */
function markClockUnstable(): void {
  lastClockUnstableAt = now();
}

/**
 * 这一拍能不能用来判定卡顿。三个否定条件：
 * - 此刻页面不可见：定时器正被降频，间隔不代表主线程被占用；
 * - 上一拍之后发生过可见性变化：这一格里夹着被挂起/降频的时间，无法归因于
 *   主线程（`prevTick > lastClockUnstableAt` 即「自上次采样以来时钟一直可信」）；
 * - 页面没有焦点：窗口被别的应用遮挡 / 切走 / 在内嵌预览的后台时，宿主可能
 *   仍报 visible 却把定时器钳到分钟级（实测定格 60s，正好报出 60000-TICK_MS
 *   的「冻结」），这种间隔同样不能归因于主线程。
 *
 * 只看 hidden 是不够的：降频期间的下一拍可能落在「已经可见」之后，届时
 * `document.hidden` 已是 false，测到的却是整段隐藏时长——这正是「切到别的
 * 软件再切回来必弹一次界面冻结」的成因。
 */
export function isMeasureableGap(
  prevTick: number,
  clockUnstableAt: number,
  hidden: boolean,
  focused: boolean,
): boolean {
  if (hidden || !focused) return false;
  return prevTick > clockUnstableAt;
}

function tick(): void {
  const t = now();
  // 首个 tick 只用来对齐基准，不是采样点
  if (!lastTick) {
    lastTick = t;
    return;
  }
  // 不可判定（页面隐藏 / 无焦点 / 间隔里发生过可见性变化）时只对齐基准：
  // 后台标签页的 setInterval 会被浏览器降频到分钟级，测出来的全是假卡顿
  const hasDoc = typeof document !== "undefined";
  const hidden = hasDoc && document.hidden;
  const focused = !hasDoc || document.hasFocus();
  if (!isMeasureableGap(lastTick, lastClockUnstableAt, hidden, focused)) {
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

/**
 * 渲染帧看门狗：rAF 由合成器的 BeginFrame 驱动。GPU 进程被 WebGL/驱动卡住
 * （或 Windows TDR 恢复）时，主线程计时器照跑、[lag] 也没有记录，但这里会
 * 出现一个几秒的帧间隔——这是「窗口一动不动」在渲染侧的唯一证据。
 *
 * 用和 tick 相同的可判定闸门：页面可见、有焦点、自上一帧以来没有发生过可见性
 * 变化。遮挡/最小化时 Chromium 会停/降频 rAF，不闸住会把「切走再切回」误报
 * 成 GPU 冻结。
 */
function frameTick(): void {
  if (!frameWatchActive) return;
  try {
    const t = now();
    const prev = lastFrameAt;
    // 先推进基准再跑归因：record/announce 抛错时也不能让同一段 gap 每帧重算
    lastFrameAt = t;
    if (prev) {
      const hasDoc = typeof document !== "undefined";
      const hidden = hasDoc && document.hidden;
      const focused = !hasDoc || document.hasFocus();
      if (isMeasureableGap(prev, lastClockUnstableAt, hidden, focused)) {
        const gap = t - prev;
        if (gap >= FREEZE_MS) {
          // gap 含一帧的正常间隔（~16ms），量级上可忽略
          const { event, isNew } = record(Math.round(gap), "frame");
          announce(event, isNew);
        }
      }
    }
  } catch (err) {
    // 看门狗自身绝不能因为 toast/日志回调抛错而停摆
    try {
      reportFrontendWarning(`[卡顿] 渲染帧采样失败：${String(err)}`);
    } catch {
      /* 日志通道也不可用：放弃这条诊断，继续看门狗 */
    }
  } finally {
    // uninstall 可能由 onFreeze 回调同步触发；此时不能再排下一帧
    frameHandle =
      frameWatchActive && typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(frameTick)
        : null;
  }
}

export function installPerfWatch(opts: PerfWatchOptions = {}): void {
  if (timer) return;
  options = opts;
  lastTick = 0;
  lastFrameAt = 0;
  lastFreezeToast = 0;
  lastClockUnstableAt = 0;
  installLongtask();
  // 可见性变化与「从冻结恢复」（Page Lifecycle）都要踩点：两者都意味着定时器
  // 可能被挂起过。resume 在多数宿主上根本不触发，多挂无害——removeEventListener
  // 用同一个函数引用，重复安装/卸载不会累积监听
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", markClockUnstable);
    document.addEventListener("resume", markClockUnstable);
  }
  // 失焦/被遮挡时 Chromium 会停或降频 rAF，但主窗口失焦通常只有 blur、
  // 不触发 visibilitychange；不在这里踩点，回焦后的第一帧会把整段失焦时间
  // 记成渲染帧冻结（误报 GPU）。
  if (typeof window !== "undefined") {
    window.addEventListener("focus", markClockUnstable);
    window.addEventListener("blur", markClockUnstable);
  }
  timer = setInterval(tick, TICK_MS);
  frameWatchActive = true;
  if (typeof requestAnimationFrame === "function") {
    frameHandle = requestAnimationFrame(frameTick);
  }
}

export function uninstallPerfWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
  frameWatchActive = false;
  if (frameHandle !== null) cancelAnimationFrame(frameHandle);
  frameHandle = null;
  observer?.disconnect();
  observer = null;
  lastTick = 0;
  lastFrameAt = 0;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", markClockUnstable);
    document.removeEventListener("resume", markClockUnstable);
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("focus", markClockUnstable);
    window.removeEventListener("blur", markClockUnstable);
  }
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
    const src =
      e.source === "frame" ? "渲染帧/GPU" : e.source === "longtask" ? "longtask" : "计时器";
    return `  ${time} ${e.kind === "freeze" ? "冻结" : "卡顿"} ${e.ms}ms（${src}）${
      e.attribution ? ` — ${e.attribution}` : ""
    }`;
  });
  return [`崩溃前 ${Math.round(withinMs / 60000)} 分钟内的主线程卡顿（${recent.length} 次）：`, ...lines].join(
    "\n",
  );
}
