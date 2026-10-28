import { listen } from "@/desktop-bridge/event";

/**
 * pi-chunk-batch 的单点分发：一次前缀预筛、一次 JSON.parse，再按帧类型分发给
 * 所有订阅者。
 *
 * 此前 turns / subagent / automation / plugin / mcp / context / design /
 * sessions / running 各自 listen 同一个事件，同一批行要被逐行 startsWith
 * 十余次；多会话并发热路径上这个成本随订阅数线性叠加。这里收口成一条传输，
 * 订阅者只声明自己关心的帧类型。
 *
 * 解析保持惰性：只有命中某个已订阅类型前缀的行才会 JSON.parse，token 级
 * chunk 行（{id,chunk}）连解析都不会进。类型内部还有更细的分流时（如只关心
 * thread_event 里的 agent_start/agent_end），用 `accept` 在解析前再挡一层——
 * 流式 delta 也是 thread_event，不能为了挑出起止事件把它全部解析。
 */

/** pi-chunk-batch 载荷的一行（镜像 pi_agent.rs ChunkLine，只关心行文本） */
type WireLine = { i?: number | null; l: string };

type FrameEntry = {
  handle: (frame: unknown, raw: string) => void;
  /** 解析前的原始行预筛；返回 false 表示这条订阅不要这一行 */
  accept?: (raw: string) => boolean;
};

/** 前缀（`{"type":"xxx"`）→ 该类型的订阅者。前缀集合小，逐行遍历足够 */
const handlersByPrefix = new Map<string, Set<FrameEntry>>();

let stopListening: (() => void) | null = null;
let starting: Promise<void> | null = null;
/** 传输代际：reset 后递增，用于作废 reset 前还在飞的 listen */
let generation = 0;

function prefixOf(type: string): string {
  return `{"type":"${type}"`;
}

/** 单个订阅者抛错不能截断同帧的其他订阅者（等价于原多监听之间的隔离） */
function deliver(entry: FrameEntry, frame: unknown, raw: string): void {
  try {
    entry.handle(frame, raw);
  } catch (error) {
    console.error("[wire-bus] 订阅者处理帧失败", error);
  }
}

function dispatch(lines: WireLine[]): void {
  if (handlersByPrefix.size === 0) return;
  for (const wire of lines) {
    const raw = wire.l;
    for (const [prefix, entries] of handlersByPrefix) {
      if (!raw.startsWith(prefix)) continue;
      // 全部订阅者都用 accept 挡掉时连解析都不做（thread_event 的 delta 行）。
      // accept 每行只求值一次，预筛与投递共用结果；它和 handle 一样是订阅者
      // 代码，单个 accept 抛错只跳过该订阅者，不能截断同帧其它订阅者。
      let wanted: FrameEntry[] | null = null;
      for (const entry of entries) {
        if (!entry.accept) {
          (wanted ??= []).push(entry);
          continue;
        }
        try {
          if (entry.accept(raw)) (wanted ??= []).push(entry);
        } catch (error) {
          console.error("[wire-bus] 订阅者 accept 预筛失败", error);
        }
      }
      if (!wanted) break;
      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        break;
      }
      for (const entry of wanted) deliver(entry, frame, raw);
      break;
    }
  }
}

/** 订阅登记先于传输安装：安装窗口到达的行不会漏投 */
async function ensureTransport(): Promise<void> {
  if (stopListening) return;
  if (!starting) {
    const gen = generation;
    let pending: Promise<void>;
    pending = listen<WireLine[]>("pi-chunk-batch", (event) => dispatch(event.payload)).then(
      (off) => {
        // reset 换代期间才装好的监听立即释放：否则它会在 reset 之后回填
        // stopListening，让 bus 以「已安装」状态复活（测试里后续 listen 桩
        // 就再也不会被调用）。此时 starting 已被 reset 或新一次订阅改写，
        // 只在仍指向自己时才清空，避免把别人的 promise 抹掉。
        if (starting === pending) starting = null;
        if (gen !== generation) {
          off();
          return;
        }
        stopListening = off;
      },
      (error) => {
        // 传输装不上（网页端无桌面桥：listen 抛 kovaHost missing）：降级为
        // 「无传输」——订阅照常登记、只是收不到帧；错误不再外抛成 unhandled
        // rejection（与 git-status 的 wireEvents 同一护栏）。桌面端 listen
        // 不失败，这条分支实际只在纯浏览器 harness 里出现。
        if (starting === pending) starting = null;
        // 只打原因文本不带 Error 对象：Next dev 会把完整堆栈连同代码帧
        // 转发到终端/浏览器，看起来像崩溃，实际只是降级为「无传输」
        console.warn(
          "[wire-bus] 传输安装失败，帧订阅保持静默：",
          error instanceof Error ? error.message : error,
        );
      },
    );
    starting = pending;
  }
  await starting;
  releaseIfIdle();
}

function releaseIfIdle(): void {
  if (handlersByPrefix.size > 0) return;
  const off = stopListening;
  if (!off) return;
  stopListening = null;
  off();
}

export type WireFrameOptions = {
  /** 解析前的原始行预筛，用于同类型内的细分（如 thread_event 只取起止） */
  accept?: (raw: string) => boolean;
};

/**
 * 订阅若干帧类型。`types` 用帧的 `type` 字段（如 "sessions_changed"）。
 * resolve 时传输已就绪——订阅方据此「await 订阅 → 发种子」，杜绝登记窗口
 * 丢事件。返回同步退订函数。
 */
export async function subscribeWireFrames<T>(
  types: readonly string[],
  cb: (frame: T, raw: string) => void,
  options?: WireFrameOptions,
): Promise<() => void> {
  const entry: FrameEntry = { handle: (frame, raw) => cb(frame as T, raw), accept: options?.accept };
  const prefixes = types.map(prefixOf);
  function register(): void {
    for (const prefix of prefixes) {
      const entries = handlersByPrefix.get(prefix) ?? new Set<FrameEntry>();
      entries.add(entry);
      handlersByPrefix.set(prefix, entries);
    }
  }
  register();

  function unsubscribe(): void {
    for (const prefix of prefixes) {
      const entries = handlersByPrefix.get(prefix);
      if (!entries) continue;
      entries.delete(entry);
      if (entries.size === 0) handlersByPrefix.delete(prefix);
    }
    releaseIfIdle();
  }

  try {
    let gen = generation;
    for (;;) {
      await ensureTransport();
      if (gen === generation) break;
      // reset 换代：订阅表已被清空、在飞的 listen 也已被作废。重新登记并
      // 重装传输，否则会留下「resolve 成功、但既没登记也没传输」的假活订阅。
      gen = generation;
      register();
    }
  } catch (error) {
    unsubscribe();
    throw error;
  }

  return unsubscribe;
}

/**
 * 仅供测试：清空所有订阅并释放传输。bun test 同进程跑多个文件时模块是共享的，
 * 前一个文件（pi-running 的常驻订阅）会把 bus 留在「已安装」状态，后续文件
 * 的 listen 桩就再也不会被调用。
 */
export function resetWireBusForTests(): void {
  generation += 1;
  handlersByPrefix.clear();
  starting = null;
  const off = stopListening;
  stopListening = null;
  off?.();
}
