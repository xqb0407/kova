"use client";

import { useSyncExternalStore } from "react";

/**
 * 运行检查点 store（git 集成 M2）：每次 agent 运行前在影子仓库打快照
 * （见 src-tauri/src/git.rs），运行结束 diff 出"本次改动"后写入这里，
 * 供消息尾部的检查点卡（components/agent-thread/checkpoint-card.tsx）消费。
 *
 * 每轮一条、互不覆盖：条目锚定"触发该轮的 user 消息下标"（anchorIndex），
 * 卡片渲染在该 user 消息之后第一条 assistant 消息的尾部——和产物卡一样
 * 各归各轮。锚点未知的条目（如刷新重挂后补结算）anchorIndex 为 null，
 * 兜底渲染在消息列表末尾。
 * 用位置而非消息 id：消息 id 在"live（ai-sdk 现造）"与"刷新后（侧车按
 * msg-N 重编）"两套命名下不一致，只有下标跨刷新稳定（手动压缩分隔线同理）。
 *
 * 列表持久化 sessionStorage（每线程一条 JSON 数组）：随标签页刷新存活、
 * 随标签页销毁作废；上限 20 条，与影子仓库快照 LRU 对齐。
 */
export type RunCheckpoint = {
  /** 快照所属工作目录 */
  cwd: string;
  /** 影子仓库检查点 commit hash */
  hash: string;
  files: number;
  added: number;
  removed: number;
};

export type CheckpointEntry = RunCheckpoint & {
  /** 触发该轮的 user 消息在列表中的下标；null = 锚点未知（列表末尾兜底） */
  anchorIndex: number | null;
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

/** 结算结果落 sessionStorage：刷新后卡片仍在；展开列表与撤销凭 hash 从影子仓库现算 */
const RUN_CP_PREFIX = "pi-run-cp:";

function writeStored(threadId: string, list: CheckpointEntry[]): void {
  try {
    window.sessionStorage.setItem(RUN_CP_PREFIX + threadId, JSON.stringify(list));
  } catch {
    /* 存储被禁用：静默降级为仅内存态 */
  }
}

function removeStored(threadId: string): void {
  try {
    window.sessionStorage.removeItem(RUN_CP_PREFIX + threadId);
  } catch {
    /* 同上 */
  }
}

function readStored(threadId: string): CheckpointEntry[] | null {
  try {
    const raw = window.sessionStorage.getItem(RUN_CP_PREFIX + threadId);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return null;
    const list = v.filter(
      (e): e is CheckpointEntry =>
        !!e &&
        typeof (e as CheckpointEntry).cwd === "string" &&
        typeof (e as CheckpointEntry).hash === "string" &&
        Number.isFinite((e as CheckpointEntry).files) &&
        Number.isFinite((e as CheckpointEntry).added) &&
        Number.isFinite((e as CheckpointEntry).removed),
    );
    return list.length ? list : null;
  } catch {
    /* 脏数据按无处理，下次结算覆盖 */
  }
  return null;
}

/** 内存 miss 时从 sessionStorage 回灌并缓存；后续增删一律走本模块双写 */
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

/**
 * 结算一条检查点：同锚点（重跑/重试同一轮）替换旧条目；
 * 新条目锚点未知时清掉旧的未知锚点条目，避免末尾兜底堆叠。
 */
export function pushRunCheckpoint(
  threadId: string,
  anchorIndex: number | null,
  cp: RunCheckpoint,
): void {
  const kept = getList(threadId).filter((e) =>
    anchorIndex === null ? e.anchorIndex !== null : e.anchorIndex !== anchorIndex,
  );
  const next = [...kept, { ...cp, anchorIndex }].slice(-MAX_ENTRIES);
  slots.set(threadId, next);
  writeStored(threadId, next);
  // 排查卡不出现时的对账线：结算是否发生、锚在第几条消息（console 可搜 "[checkpoint]"）
  console.debug("[checkpoint] settle", threadId, "anchorIndex:", anchorIndex, cp.files, "files");
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

/**
 * 进行中 turn 的检查点 hash 持久化（sessionStorage）：打快照与结算分属
 * 流的两端，页面刷新会丢掉原页面里的 Promise——把 {cwd, hash, 锚点} 落盘，
 * 重挂后的流（reconnectToStream）在 finish 时照样能 diff 出检查点卡，
 * 且锚点随快照一起恢复（卡片仍钉回原轮次而不是掉到列表末尾）。
 * 与 resume storage 同用 sessionStorage：随标签页刷新存活、随标签页销毁作废。
 */
const RUN_HASH_PREFIX = "pi-run-hash:";

export type PersistedRunHash = {
  cwd: string;
  hash: string;
  anchorIndex?: number | null;
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
      };
    }
  } catch {
    /* 脏数据按无处理 */
  }
  return null;
}
