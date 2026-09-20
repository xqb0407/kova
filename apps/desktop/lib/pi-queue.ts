"use client";

import { useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import { getPiChannel } from "@/lib/pi-channel";

/**
 * prompt 排队 store（sidecar prompt-queue 的前端镜像，形态同 pi-todo）：
 * - 事实源在 sidecar（按线程隔离：每线程一条 FIFO，线程内串行、跨线程并行）；
 *   prompt 流里的 data-queue chunk 经 pi-transport 拦截进来（不进消息流）
 * - 注册发生在 transport.sendMessages（拿到 requestId → 线程消息 id 的映射），
 *   收到 data-queue(queued) 才进可见队列，active 置位开跑、finish/error/abort 移除
 * - 排队条 UI（components/agent-thread/prompt-queue-bar.tsx）渲染在 composer 上方，
 *   支持 修改 / 删除 / 立即发送（对应 queue_update / queue_cancel / queue_promote）
 *
 * 消息数组同步（ChatGPT 式排队：确认排队的消息只在排队条展示）：
 * - 排队确认（onQueued）→ 把 user 消息从 Chat 消息数组摘除。必须摘：AI SDK 对
 *   「非末条消息的流式写入」走 pushMessage 在数组末尾追加重复项（外部 store 对
 *   重复 id 保留最后一次出现），上一轮回复会被顶到排队消息之后，激活/立即发送
 *   的任何顺序补偿都会被后续写入再次打乱；摘除后上一轮保持末条、写入走原地
 *   替换，顺序稳定（摘除前已产生的重复项也会随去重自愈）。
 * - 激活开跑 / 未开跑被取消（onReveal）→ 消息不在数组时回填到末尾，已存在则
 *   不动——回复内容可能已经追加在其后（流式写入/历史装载），再移动会把 user
 *   气泡排到自己的回复之后并诱发重复项写入循环。激活的时序由 sidecar 保证：
 *   上一轮流完整收尾（全部写入落地）之后才发 data-queue(active)，此刻回填
 *   不再有并发写入，新回复只会追加在其后。
 * 同步监听只作用于当前线程的 chat；线程切换期间错过的摘除由重挂载对账补齐
 * （仅摘除方向；回填不做对账——激活瞬间的 onReveal 已处理，若历史装载换过
 * 消息 id 再按乐观 id 追加，会与历史副本构成兄弟分支 2/2）。同步函数必须
 * 「无变化时不赋值」——Chat 的 messages setter 即使内容相同也会通知订阅者，
 * 无条件赋值会形成渲染↔同步死循环。
 */

export type QueuedPrompt = {
  /** transport 请求 id（sidecar 队列项的 key） */
  requestId: string;
  threadId: string;
  /** 线程内对应用户消息的 id（编辑/删除时同步消息流） */
  messageId: string;
  text: string;
  position: number;
  /** sendMessages 时暂存的完整 user 消息：排队期间从消息数组摘除，开跑/恢复时回填 */
  message?: UIMessage;
  /** 已开跑（data-queue active）：条目保留到流收尾，消息已回填数组、不再进排队条 */
  active: boolean;
  /** 用户主动删除/取回编辑（queue_cancel 在途）：sidecar 的 abort+finish 收尾
   *  chunk 可能先于 invoke 回复被前端消费，unregister 凭该标记跳过「未开跑
   *  收尾→恢复消息」，否则刚删掉的消息会被恢复回消息列表 */
  cancelled?: boolean;
  /** 已并入当前轮（steer）：条目退出排队条、消息保持摘除，随宿主轮收尾的
   *  finish 经 restore 回填到列表（期间宿主轮仍在写入，提前回填会被其
   *  pushMessage 重复项顶乱顺序） */
  steered?: boolean;
};

/** threadId -> (requestId -> entry)；未确认（还没收到 data-queue）的不进这层 */
const entries = new Map<string, Map<string, QueuedPrompt>>();
const listeners = new Set<() => void>();
/** 快照缓存：useSyncExternalStore 要求 getSnapshot 返回引用稳定的值 */
let version = 0;
const snapshotCache = new Map<string, { version: number; value: QueuedPrompt[] }>();

function notify() {
  version += 1;
  for (const l of listeners) l();
}

function threadMap(threadId: string): Map<string, QueuedPrompt> {
  let m = entries.get(threadId);
  if (!m) {
    m = new Map();
    entries.set(threadId, m);
  }
  return m;
}

/** transport 注册：sendMessages 时调用（此时还不知道是否真的排队） */
export function registerQueuedPrompt(entry: {
  requestId: string;
  threadId: string;
  messageId: string;
  text: string;
  /** 完整 user 消息（排队确认后从消息数组摘除、开跑时回填用） */
  message?: UIMessage;
}): void {
  threadMap(entry.threadId).set(entry.requestId, {
    requestId: entry.requestId,
    threadId: entry.threadId,
    messageId: entry.messageId,
    text: entry.text,
    position: 0, // 0 = 未确认（data-queue 未到），不显示
    message: entry.message,
    active: false,
  });
  notify();
}

/**
 * 消息数组同步监听（PromptQueueBar 注册，持有当前线程的 chat）：
 * - onQueued：排队确认 → 从消息数组摘除该 user 消息
 * - onReveal：激活开跑 / 未开跑被取消收尾 → 消息不在数组时回填到末尾（已存在不动）
 */
export type QueueSyncListener = {
  onQueued?: (entry: QueuedPrompt) => void;
  onReveal?: (entry: QueuedPrompt) => void;
};
let syncListener: QueueSyncListener | null = null;

/** 注册/注销消息同步监听（组件卸载时传 null） */
export function setQueueSyncListener(cb: QueueSyncListener | null) {
  syncListener = cb;
}

/** 消费 prompt 流里的 data-queue chunk（pi-transport 调用）。
 *  phase: "steered"（并入当前轮的退化流标记）不进排队条，走到兜底 return */
export function applyQueueChunk(
  requestId: string,
  threadId: string,
  data: unknown,
): void {
  const d = data as { phase?: string; position?: number } | null;
  if (!d || (d.phase !== "queued" && d.phase !== "active" && d.phase !== "steered")) {
    return;
  }
  // threadMap 兜底建档：map 可能不存在——刷新后重连重放 data-queue（entries
  // 是纯内存的）、取消最后一项后的重发竞态等场景，直接 map! 会崩
  //（"undefined is not an object (evaluating 'map.set')"）
  const map = threadMap(threadId);
  const entry = map.get(requestId);
  if (d.phase === "steered") {
    // 已并入当前轮：条目退出排队条显示（steered 过滤），消息保持摘除，随宿主
    // 轮收尾的 finish 经 restore 回填。未登记的 ghost（刷新重放）无消息可回填，
    // 忽略即可
    if (entry) {
      map.set(requestId, { ...entry, steered: true });
      notify();
    }
    return;
  }
  if (d.phase === "active") {
    // 开跑：置位 active（条目保留到收尾，排队条/抑制集按 active 过滤），
    // 消息经 onReveal 回填到数组末尾；pendingTurn 供加载动画跨过 status 空窗
    pendingTurnByThread.set(threadId, requestId);
    if (entry) {
      map.set(requestId, { ...entry, active: true });
      notify();
      syncListener?.onReveal?.({ ...entry, active: true });
    } else {
      // ghost（刷新重连重放）没有建档，但 pendingTurn 与加载动画仍然有效
      notify();
    }
    return;
  }
  const position = typeof d.position === "number" ? d.position : 0;
  if (entry) {
    // 已注册（sendMessages 时）：确认进可见队列；首次确认（0 → >0）触发消息摘除
    const firstConfirmation = entry.position === 0;
    const updated: QueuedPrompt = { ...entry, position };
    map.set(requestId, updated);
    notify();
    if (firstConfirmation) syncListener?.onQueued?.({ ...updated });
  } else {
    // 未注册的 ghost（刷新重连重放等）：建档占位，messageId/text/message 不可知，
    // 排队条对空文本条目不渲染，收尾时随流清理
    map.set(requestId, {
      requestId,
      threadId,
      messageId: "",
      text: "",
      position,
      active: false,
    });
    notify();
  }
}

/** 流终结（finish/error/abort）时移除登记 */
export function unregisterQueuedPrompt(requestId: string, threadId: string): void {
  const map = entries.get(threadId);
  const entry = map?.get(requestId);
  const wasPendingTurn = pendingTurnByThread.get(threadId) === requestId;
  if (!entry) {
    // ghost 激活后收尾（entries 里无条目）：pendingTurn 也要清
    if (wasPendingTurn) {
      pendingTurnByThread.delete(threadId);
      notify();
    }
    return;
  }
  map?.delete(requestId);
  if (wasPendingTurn) pendingTurnByThread.delete(threadId);
  // 确认排队但从未开跑就收尾（Stop / sidecar 清队等路径）：排队确认时消息已从
  // 数组摘除，这里回填恢复。用户主动删除（queue_cancel）不恢复——cancelled 标记
  // 在 invoke 发出前置位，收尾 chunk 先于回复被消费时也能正确判定
  const restore =
    !entry.active && entry.position > 0 && entry.message && !entry.cancelled;
  notify();
  if (restore) syncListener?.onReveal?.({ ...entry });
}

/** 订阅当前线程的可见排队项（按 position 排序；已开跑的不再显示） */
export function useThreadQueue(threadId: string | undefined): QueuedPrompt[] {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!threadId) return EMPTY;
      const cached = snapshotCache.get(threadId);
      if (cached && cached.version === version) return cached.value;
      const visible = [...(entries.get(threadId)?.values() ?? [])]
        // 空文本 = 刷新重连重放的 ghost 占位（messageId/text 不可恢复），不渲染；
        // steered = 已并入当前轮，消息回填随宿主轮收尾，期间不显示
        .filter((e) => e.position > 0 && e.text && !e.active && !e.steered)
        .sort((a, b) => a.position - b.position);
      const value = visible.length ? visible : EMPTY;
      snapshotCache.set(threadId, { version, value });
      return value;
    },
    () => EMPTY,
  );
}

const EMPTY: QueuedPrompt[] = [];

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 非响应式快照：线程重挂载对账用（错过监听事件的摘除/回填补齐） */
export function peekThreadQueue(threadId: string): QueuedPrompt[] {
  return [...(entries.get(threadId)?.values() ?? [])]
    .filter((e) => e.position > 0 && e.text)
    .sort((a, b) => a.position - b.position);
}

/* ------------------------------ 开跑空窗状态 ------------------------------ */

/** threadId -> 已激活开跑、但回复消息尚未落进列表的 requestId。
 *  上一轮（含被立即发送中止的轮）流收尾会把 chat status 短暂置回 ready，而新一
 *  轮要等首个内容 chunk 才翻回 streaming——这段空窗里 isRunning=false 且 AI 消息
 *  尚未创建，消息级指示器无处挂载；ThreadWorkingIndicator 凭它补点阵动画。 */
const pendingTurnByThread = new Map<string, string>();
const pendingTurnCache = new Map<string, { version: number; value: boolean }>();

/** 线程是否处于「排队项已开跑、回复未落列表」的空窗（useThreadPendingTurn 的
 *  快照计算，抽出纯函数供测试直接断言） */
export function hasPendingTurn(threadId: string): boolean {
  return pendingTurnByThread.has(threadId);
}

/** 订阅该线程是否处于「排队项已开跑、回复未落列表」的空窗 */
export function useThreadPendingTurn(threadId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!threadId) return false;
      const cached = pendingTurnCache.get(threadId);
      if (cached && cached.version === version) return cached.value;
      const value = hasPendingTurn(threadId);
      pendingTurnCache.set(threadId, { version, value });
      return value;
    },
    () => false,
  );
}

let queuedIdsCache: { version: number; value: Set<string> } | null = null;
const EMPTY_IDS = new Set<string>();

/** 确认排队中且未开跑的用户消息 id 集合（useQueuedMessageIds 的快照计算，
 *  抽出纯函数供测试直接断言，避免测试侧复刻判定条件漂移） */
export function getQueuedMessageIds(): Set<string> {
  if (queuedIdsCache?.version === version) return queuedIdsCache.value;
  const ids = new Set<string>();
  for (const map of entries.values()) {
    for (const e of map.values()) {
      // steered 条目保持抑制：消息已回填由 restore 负责，此刻仍在宿主轮窗口内
      if (e.position > 0 && e.messageId && !e.active && !e.steered) {
        ids.add(e.messageId);
      }
    }
  }
  queuedIdsCache = { version, value: ids };
  return ids;
}

/** 订阅「确认排队中」的用户消息 id 集合（消息列表渲染抑制用，ChatGPT 式：
 *  排队中的消息不进消息列表，只出现在排队条；开跑 active 后条目置位 active，
 *  消息自动出现）。position=0（未确认，含不会排队的空闲发送）不抑制 */
export function useQueuedMessageIds(): Set<string> {
  return useSyncExternalStore(subscribe, getQueuedMessageIds, () => EMPTY_IDS);
}

/* ----------------------------- 队列管理操作 ----------------------------- */

/** 修改排队消息文本（sidecar 队列项 + 本地镜像一起改；线程内消息由 UI 层同步） */
export async function updateQueuedPrompt(requestId: string, text: string): Promise<void> {
  await getPiChannel().request({ type: "queue_update", requestId, text });
  for (const map of entries.values()) {
    const entry = map.get(requestId);
    if (entry) {
      map.set(requestId, { ...entry, text });
      notify();
      break;
    }
  }
}

/** 删除排队消息（sidecar 侧流立即 abort+finish 收尾；线程内消息由 UI 层移除） */
export async function cancelQueuedPrompt(requestId: string): Promise<void> {
  // 先打删除标记再发请求：sidecar 的 abort+finish 收尾 chunk 可能先于 invoke
  // 回复被前端消费，届时 unregister 还能看到本条目，没有标记会把刚删掉的消息
  // 当作「未开跑收尾」恢复回消息列表
  for (const map of entries.values()) {
    const entry = map.get(requestId);
    if (entry) {
      entry.cancelled = true;
      break;
    }
  }
  await getPiChannel().request({ type: "queue_cancel", requestId });
  for (const [threadId, map] of entries) {
    if (map.delete(requestId)) {
      if (pendingTurnByThread.get(threadId) === requestId) {
        pendingTurnByThread.delete(threadId);
      }
      if (map.size === 0) entries.delete(threadId);
      notify();
      break;
    }
  }
}

/** 立即发送：中止当前活跃 turn，该项提到队首马上执行（其余排队项保留）。
 *  本地不做摘除/回填：上一轮收尾期间仍有流式写入，消息顺序以 data-queue(active)
 *  后的 onReveal 回填为准（sidecar 保证 active 在上一轮流完整收尾之后发出） */
export async function promoteQueuedPrompt(requestId: string): Promise<void> {
  await getPiChannel().request({ type: "queue_promote", requestId });
}

/** 并入当前轮：排队项注入该线程活跃轮（不中止不排队）；排队条随该项流
 *  finish 自动移除，线程内用户消息保留（线性转录） */
export async function steerQueuedPrompt(requestId: string): Promise<void> {
  await getPiChannel().request({ type: "queue_steer", requestId });
}
