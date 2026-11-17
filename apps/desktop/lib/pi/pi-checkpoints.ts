"use client";

import { useSyncExternalStore } from "react";

/**
 * 运行检查点 store（git 集成 M2）：每次 agent 运行前在影子仓库打快照
 * （见 原 Rust 宿主的 git.rs），运行结束 diff 出"本次改动"后写入这里，
 * 供消息尾部的检查点卡（components/agent-thread/checkpoint-card.tsx）消费。
 *
 * 每轮一条、互不覆盖：条目锚定"触发该轮的 user 消息下标"（anchorIndex），
 * 卡片渲染在该 user 消息之后第一条 assistant 消息的尾部——和产物卡一样
 * 各归各轮。锚点未知的条目（如刷新重挂后补结算）anchorIndex 为 null，
 * 兜底渲染在消息列表末尾。
 * 用位置而非消息 id：消息 id 在"live（ai-sdk 现造）"与"刷新后（侧车按
 * msg-N 重编）"两套命名下不一致，只有下标跨刷新稳定（手动压缩分隔线同理）。
 *
 * 列表持久化 localStorage（每会话一条 JSON 数组，键 = pi sessionId）：
 * 检查点卡属于会话历史，与转录同寿命——转录还在，卡片就必须还在。早先落
 * sessionStorage 是个 bug：它的命名空间每次应用启动都换新 GUID（见 Chromium
 * Session Storage 的 namespace-<uuid> 键），重启后新实例读不到旧数据，卡片
 * 整批消失（现场：重启后检查点卡不见）。localStorage 按 origin 存续，刷新与
 * 重启都能读回；上限 20 条，与影子仓库快照 LRU 对齐。
 * 读取侧一律经 useMainSessionId / sessionId 键（新建会话的 mainThreadId 是
 * __LOCALID_ 草稿 id，直接拿它读会 miss）。
 */
export type RunCheckpoint = {
  /** 快照所属工作目录 */
  cwd: string;
  /** 影子仓库检查点 commit hash */
  hash: string;
  files: number;
  added: number;
  removed: number;
  /** 触发本轮的 prompt requestId（条目所有权层按它查逐文件回滚资格，
   *  见 lib/pi/pi-edits.ts）；老条目/桥缺失为 undefined——卡片退化为仅整轮撤销 */
  turnId?: string | null;
  /**
   * 本轮归属的文件清单（主根 rel，结算时定格）：影子仓库是按工作目录共享的，
   * 直接拿快照做 live diff 会把同工作区其它会话后来改/新增的文件算进来。
   * 有值时卡片展开、产物页签、审查视图都只按这份清单过滤。
   * undefined = 老条目（无清单），保持 legacy 全仓 diff。
   */
  paths?: string[];
  /**
   * 本轮快照与同工作区其它会话并发过（shared）：整仓 diff 不可归因。
   * 卡片只展示本会话 write/edit 上报的文件，且不提供整轮撤销。
   */
  shared?: boolean;
};

export type CheckpointEntry = RunCheckpoint & {
  /** 触发该轮的 user 消息在列表中的下标；null = 锚点未知（列表末尾兜底） */
  anchorIndex: number | null;
  /**
   * 触发 user 行的稳定投影 id（pi-msg:<seq>）。渲染端优先按它匹配：下标会随
   * compaction/model-change 分隔线插入、截断漂移，id 跨列表结构变化稳定。
   * 老条目/老调用方没有它，回落 anchorIndex。
   */
  anchorMessageId?: string;
};

const MAX_ENTRIES = 20;

const slots = new Map<string, CheckpointEntry[]>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 结算结果落 localStorage：刷新/重启后卡片仍在；展开列表与撤销凭 hash 从
 *  影子仓库现算（快照已被 LRU 清掉时卡片降级为「读取不到逐文件变更」，头部
 *  统计不受影响）。 */
const RUN_CP_PREFIX = "pi-run-cp:";

function storageGet(scope: "localStorage" | "sessionStorage", key: string): string | null {
  try {
    return window[scope].getItem(key);
  } catch {
    /* 无 window（SSR）/存储被禁用 */
    return null;
  }
}

function writeStored(threadId: string, list: CheckpointEntry[]): void {
  try {
    window.localStorage.setItem(RUN_CP_PREFIX + threadId, JSON.stringify(list));
  } catch {
    /* 存储被禁用：静默降级为仅内存态 */
  }
}

function removeStored(threadId: string): void {
  try {
    window.localStorage.removeItem(RUN_CP_PREFIX + threadId);
  } catch {
    /* 同上 */
  }
  // 老版本落过 sessionStorage：一并清，避免下次读取把已撤销的条目迁回来
  try {
    window.sessionStorage.removeItem(RUN_CP_PREFIX + threadId);
  } catch {
    /* 同上 */
  }
}

/** 解析+校验持久层原文；空/脏数据一律 null（调用方按「无记录」处理） */
function parseStored(raw: string | null): CheckpointEntry[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return null;
    const list = v
      .filter(
        (e): e is CheckpointEntry =>
          !!e &&
          typeof (e as CheckpointEntry).cwd === "string" &&
          typeof (e as CheckpointEntry).hash === "string" &&
          Number.isFinite((e as CheckpointEntry).files) &&
          Number.isFinite((e as CheckpointEntry).added) &&
          Number.isFinite((e as CheckpointEntry).removed),
      )
      .map((e) => {
        // paths 是结算时定格的归属清单：脏数据按"无清单"降级（legacy 全仓 diff），
        // 不因为一条坏路径把整张卡丢掉。空数组是合法语义（shared 轮次无主根
        // 归属文件），必须原样保留——丢掉它会让刷新后的卡片退回全仓 diff。
        const next: CheckpointEntry = { ...e };
        const paths = Array.isArray(e.paths)
          ? e.paths.filter(
              (p): p is string => typeof p === "string" && p.length > 0,
            )
          : null;
        if (paths) next.paths = paths;
        else delete next.paths;
        if (e.shared === true) next.shared = true;
        else delete next.shared;
        return next;
      });
    return list.length ? list : null;
  } catch {
    /* 脏数据按无处理，下次结算覆盖 */
  }
  return null;
}

/**
 * 读持久层。老版本把列表存在 sessionStorage（应用重启即失效），首次读取时
 * 迁到 localStorage：先读新键；新键缺失或脏数据时再看老键，且**只在解析出
 * 合法条目后才迁移**——先搬后校验会把损坏数据搬进新键、老键又已删除，等于
 * 把唯一的备份也毁了。迁移幂等：搬完删老键，之后都走新键。
 */
function readStored(threadId: string): CheckpointEntry[] | null {
  const key = RUN_CP_PREFIX + threadId;
  const stored = parseStored(storageGet("localStorage", key));
  if (stored) return stored;
  const legacyRaw = storageGet("sessionStorage", key);
  const legacy = parseStored(legacyRaw);
  if (!legacy) return null;
  try {
    window.localStorage.setItem(key, legacyRaw!);
    window.sessionStorage.removeItem(key);
  } catch {
    /* 迁移失败：本次仍按老数据渲染，下次再试 */
  }
  return legacy;
}

/** 内存 miss 时从持久层（localStorage）回灌并缓存；后续增删一律走本模块双写 */
function getList(threadId: string): CheckpointEntry[] {
  const hit = slots.get(threadId);
  if (hit) return hit;
  const stored = readStored(threadId);
  if (stored) {
    slots.set(threadId, stored);
    return stored;
  }
  return EMPTY;
}

const EMPTY: CheckpointEntry[] = [];

/** 结算锚点：下标 + 稳定消息 id（可选）。id 优先去重/匹配，见 CheckpointEntry。 */
export type CheckpointAnchor = {
  anchorIndex: number | null;
  anchorMessageId?: string | null;
};

/**
 * 结算一条检查点：同锚点（重跑/重试同一轮）替换旧条目；
 * 新条目锚点未知时清掉旧的未知锚点条目，避免末尾兜底堆叠。
 */
export function pushRunCheckpoint(
  threadId: string,
  anchor: CheckpointAnchor,
  cp: RunCheckpoint,
): void {
  const anchorMessageId =
    typeof anchor.anchorMessageId === "string" && anchor.anchorMessageId
      ? anchor.anchorMessageId
      : null;
  const kept = getList(threadId).filter((e) => {
    if (anchorMessageId) {
      // 同一轮重结算（同轮多段 run）替换旧条目；老条目没有 id，按旧规则
      // index 去重，防同轮新老并存出两张卡
      if (e.anchorMessageId) return e.anchorMessageId !== anchorMessageId;
      return e.anchorIndex !== anchor.anchorIndex;
    }
    return anchor.anchorIndex === null
      ? e.anchorIndex !== null
      : e.anchorIndex !== anchor.anchorIndex;
  });
  const next = [
    ...kept,
    {
      ...cp,
      anchorIndex: anchor.anchorIndex,
      ...(anchorMessageId ? { anchorMessageId } : {}),
    },
  ].slice(-MAX_ENTRIES);
  slots.set(threadId, next);
  writeStored(threadId, next);
  // 排查卡不出现时的对账线：结算是否发生、锚在第几条消息（console 可搜 "[checkpoint]"）
  console.debug(
    "[checkpoint] settle",
    threadId,
    "anchor:",
    anchorMessageId ?? anchor.anchorIndex,
    cp.files,
    "files",
  );
  notify();
}

/**
 * 往上翻历史（prepend）后整体平移锚点：下标锚定的代价是"前面插入旧消息"会让
 * 已有下标全部失效，装载方按「新并入的消息条数」调一次本函数即可。只动本线程、
 * 只动非空锚点。
 */
export function shiftRunCheckpointAnchors(threadId: string, delta: number): void {
  if (delta === 0) return;
  const list = getList(threadId);
  if (list.length === 0) return;
  const next = list.map((e) =>
    e.anchorIndex === null ? e : { ...e, anchorIndex: e.anchorIndex + delta },
  );
  slots.set(threadId, next);
  writeStored(threadId, next);
  notify();
}

/** 撤销成功/放弃某一条：按快照 hash 精确移除，不动同线程其他轮次 */
export function clearRunCheckpoint(threadId: string, hash: string): void {
  const list = getList(threadId);
  const next = list.filter((e) => e.hash !== hash);
  if (next.length === list.length) return;
  if (next.length === 0) {
    slots.delete(threadId);
    removeStored(threadId);
  } else {
    slots.set(threadId, next);
    writeStored(threadId, next);
  }
  notify();
}

/** 订阅某线程的检查点条目列表（引用稳定：同一列表未变更时返回同一数组） */
export function useRunCheckpoints(
  threadId: string | undefined,
): CheckpointEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? getList(threadId) : EMPTY),
    () => EMPTY,
  );
}

/** 测试钩子：直读某线程当前条目（与 useRunCheckpoints 同源数据，绕开 React） */
export const runCheckpointsForTest = (threadId: string): CheckpointEntry[] =>
  getList(threadId);

/** 测试钩子：清内存缓存（模拟应用重启后的冷读——数据只剩持久层） */
export function resetRunCheckpointsForTest(): void {
  slots.clear();
}

/**
 * 会话删除：整条清掉（内存 + 持久层双键）。检查点属于会话历史，会话行都删了
 * 不能把卡片留在持久层——localStorage 不随标签页销毁，不主动清就会永久残留
 * （旧实现落 sessionStorage，靠"关标签页即失效"兜底；改 localStorage 后必须
 * 显式清）。
 */
export function clearRunCheckpointsForSession(threadId: string): void {
  const had = slots.delete(threadId);
  removeStored(threadId);
  if (had) notify();
}

/**
 * 进行中 turn 的检查点 hash 持久化（sessionStorage，**故意不跨重启**）：打快照
 * 与结算分属流的两端，页面刷新会丢掉原页面里的 Promise——把 {cwd, hash, 锚点}
 * 落盘，重挂后的流（reconnectToStream）在 finish 时照样能 diff 出检查点卡，
 * 且锚点随快照一起恢复（卡片仍钉回原轮次而不是掉到列表末尾）。
 * 与已结算列表（localStorage）分家的理由：这是"在飞 run"的桥，应用重启后
 * 那个 run 已经不存在（sidecar 也换代了），残留的 hash 只会在下一次 begin
 * 时被清掉；让它随会话作废比跨重启留下更安全。
 */
const RUN_HASH_PREFIX = "pi-run-hash:";

export type PersistedRunHash = {
  cwd: string;
  hash: string;
  anchorIndex?: number | null;
  /** 触发 user 行的稳定投影 id（pi-msg:<seq>）：渲染端优先按它匹配 */
  anchorMessageId?: string | null;
  turnId?: string | null;
};

export function saveRunHash(threadId: string, value: PersistedRunHash | null): void {
  try {
    const key = RUN_HASH_PREFIX + threadId;
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 无 window（SSR）或存储被禁用：静默降级为仅内存态 */
  }
}

export function loadRunHash(threadId: string): PersistedRunHash | null {
  try {
    const raw = window.sessionStorage.getItem(RUN_HASH_PREFIX + threadId);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PersistedRunHash> | null;
    if (v && typeof v.cwd === "string" && typeof v.hash === "string") {
      return {
        cwd: v.cwd,
        hash: v.hash,
        anchorIndex: Number.isFinite(v.anchorIndex) ? (v.anchorIndex as number) : null,
        ...(typeof v.anchorMessageId === "string" && v.anchorMessageId
          ? { anchorMessageId: v.anchorMessageId }
          : {}),
        ...(typeof v.turnId === "string" ? { turnId: v.turnId } : {}),
      };
    }
  } catch {
    /* 脏数据按无处理 */
  }
  return null;
}
