"use client";

import { useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import { getPiChannel } from "@/lib/pi-channel";

/**
 * prompt 排队 store v2（快照镜像，设计见 plans/queue-refactor-plan.md）：
 * - 事实源在 sidecar QueueEngine（按线程隔离 FIFO + 暂停 + 失败熔断），每次变更
 *   广播 `data-queue-state` 全量快照；本 store 是「最后快照胜出」的镜像，
 *   没有增量对账。线程挂载/刷新恢复时经 get_queue_state 拉取（sidecar 内存
 *   为空会从 session 回放采纳并返回暂停态队列）。
 * - reqId → 消息注册表：sendMessages 时登记乐观 user 消息；刷新后注册表清空，
 *   回填退化为按快照文本重建气泡（`queued-<id>`，附件不保留——已知限制）。
 *
 * 消息数组同步规则（三条，幂等，由快照状态驱动）：
 * - R1 入快照（queued）：消息只在排队条（Chat 数组摘除）。必须摘：AI SDK 对
 *   「非末条消息的流式写入」会 pushMessage 追加重复项（外部 store 对重复 id
 *   保留最后一次出现），上一轮回复会被顶到排队消息之后；摘除后上一轮保持
 *   末条、写入走原地替换，顺序稳定。
 * - R2 出快照（派发出队）：消息回填到数组末尾。派发时序由 sidecar 保证：宿主
 *   轮流完整收尾后链节才取队首，此刻回填不再有并发写入。
 * - R3 steered（并入当前轮）：并入瞬间消息保持摘除，回填挂在宿主轮流收尾
 *   （steered 流 finish 挂起语义，见 protocol.ts steerIntoActiveRun）——期间
 *   宿主轮仍在写入，提前回填会触发重复项增长与乱序。
 * 同步必须「无变化时不赋值」——Chat 的 messages setter 即使内容相同也会通知
 * 订阅者，无条件赋值会形成渲染↔同步死循环。
 */

export type QueueItemState = "queued";

/** 快照条目（sidecar 广播形态，无前端消息 id） */
export type QueueSnapshotItem = {
  id: number;
  reqId: string;
  text: string;
  createdAt: string;
  state: QueueItemState;
};

export type QueueSnapshot = {
  version: 2;
  threadId: string;
  items: QueueSnapshotItem[];
  paused: boolean;
  nextId: number;
};

/** 注册表条目：reqId → 乐观/重建消息（摘除与回填都用它寻址） */
export type RegisteredMessage = {
  threadId: string;
  messageId: string;
  message?: UIMessage;
  /** 已进入快照（消息已从数组摘除） */
  queued: boolean;
  /** 用户主动删除：出快照时不回填 */
  cancelled: boolean;
  /** 已并入当前轮：出快照后保持摘除，宿主轮流收尾时回填 */
  steered: boolean;
  /** 曾被乐观摘除（快照确认前就摘出数组）：入队判定落空时由 start/收尾回填 */
  preRemoved: boolean;
};

const snapshots = new Map<string, QueueSnapshot>();
const registry = new Map<string, RegisteredMessage>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version += 1;
  for (const l of listeners) l();
}

function synthesizedMessage(item: QueueSnapshotItem): UIMessage {
  return {
    id: `queued-${item.id}`,
    role: "user",
    parts: [{ type: "text", text: item.text }],
  };
}

/** transport 登记：sendMessages 时调用（regenerate 不登记，见 pi-transport） */
export function registerQueuedMessage(reqId: string, threadId: string, message: UIMessage): void {
  registry.set(reqId, {
    threadId,
    messageId: message.id,
    message,
    queued: false,
    cancelled: false,
    steered: false,
    preRemoved: false,
  });
}

/** 消费 data-queue-state 快照 chunk（pi-transport 调用） */
export function applyQueueStateChunk(threadId: string, data: unknown): void {
  const snapshot = data as QueueSnapshot | null;
  if (!snapshot || snapshot.version !== 2 || !Array.isArray(snapshot.items)) return;
  applySnapshot({ ...snapshot, threadId });
}

/** 线程挂载/刷新恢复：向 sidecar 请求快照并入镜像（sidecar 内存为空时会从
 *  session 回放采纳并返回暂停态队列） */
export async function refreshQueueSnapshot(threadId: string, sessionId?: string): Promise<void> {
  try {
    const res = await getPiChannel().request({
      type: "get_queue_state",
      threadId,
      ...(sessionId ? { sessionId } : {}),
    });
    const snapshot = (res as { snapshot?: QueueSnapshot }).snapshot;
    if (snapshot && snapshot.version === 2 && snapshot.threadId === threadId) {
      applySnapshot(snapshot);
    }
  } catch {
    // 通道异常：排队条留空，下一次广播/请求再对齐
  }
}

function applySnapshot(snapshot: QueueSnapshot): void {
  const previous = snapshots.get(snapshot.threadId);
  const seen = new Set<string>();
  for (const item of snapshot.items) seen.add(item.reqId);

  // R1 入快照：新出现的条目 → 消息摘除信号（未登记的按快照文本重建注册，
  // 刷新后回填有据可依）
  const onQueued: RegisteredMessage[] = [];
  for (const item of snapshot.items) {
    const existing = registry.get(item.reqId);
    if (existing) {
      if (!existing.queued) {
        existing.queued = true;
        onQueued.push(existing);
      }
    } else {
      const reg: RegisteredMessage = {
        threadId: snapshot.threadId,
        messageId: `queued-${item.id}`,
        message: synthesizedMessage(item),
        queued: true,
        cancelled: false,
        steered: false,
        preRemoved: false,
      };
      registry.set(item.reqId, reg);
      onQueued.push(reg);
    }
  }

  // R2/R3 出快照：消失的条目按标记分类——删除（cancelled）静默清理；
  // 派发出队（queued）立即回填；steered 保持摘除，等宿主轮流收尾的
  // unregisterQueuedMessage 回填
  const onReveal: RegisteredMessage[] = [];
  for (const [reqId, reg] of [...registry]) {
    if (reg.threadId !== snapshot.threadId || seen.has(reqId)) continue;
    if (reg.cancelled) {
      registry.delete(reqId);
    } else if (reg.steered) {
      // 保持登记：宿主轮流收尾时 unregisterQueuedMessage 触发回填
    } else if (!reg.queued) {
      // 乐观摘除尚未被快照确认（sidecar 还没把它入队，可能压根不排队）：
      // 本次快照与它无关，不动——回填由 start chunk / error 收尾负责
    } else {
      registry.delete(reqId);
      onReveal.push(reg);
      markPendingTurn(snapshot.threadId, reqId);
    }
  }

  snapshots.set(snapshot.threadId, snapshot);
  notify();
  for (const reg of onQueued) syncListener?.(reg, "remove");
  for (const reg of onReveal) syncListener?.(reg, "reveal");
}

/* ------------------------- 消息数组同步（渲染侧） ------------------------- */

type SyncKind = "remove" | "reveal";
let syncListener: ((reg: RegisteredMessage, kind: SyncKind) => void) | null = null;

/** 注册/注销消息同步监听（PromptQueueBar 挂载时注册，随线程卸载注销）：
 *  - remove：条目入快照（queued）→ 消息从数组摘除
 *  - reveal：条目出快照（派发出队 / steered 宿主轮收尾）→ 消息回填末尾 */
export function setQueueSyncListener(
  fn: ((reg: RegisteredMessage, kind: SyncKind) => void) | null,
): void {
  syncListener = fn;
}

/** 流终结（finish/error/abort/客户端停止）：该请求生命周期的收尾。
 *  steered 项在此刻回填（宿主轮流已收尾，不再有并发写入）；并清除该线程的
 *  派发空窗标记。 */
export function unregisterQueuedMessage(requestId: string, threadId: string): void {
  const reg = registry.get(requestId);
  if (pendingTurnByThread.get(threadId) === requestId) {
    pendingTurnByThread.delete(threadId);
    notify();
  }
  if (!reg) return;
  registry.delete(requestId);
  // steered：并入的消息此刻回填（排队确认时已摘除）；被乐观摘除却始终没
  // 入进快照的（sidecar 直接拒绝，如队列已满）同样回填——它已被摘出数组
  // 且不会再有派发/start 信号。其余路径消息本就不在数组里，回填是 no-op。
  if (reg.steered || (reg.preRemoved && !reg.queued && !reg.cancelled)) {
    notify();
    syncListener?.(reg, "reveal");
  }
}

/** 乐观摘除（pi-transport sendMessages 调用）：按「忙线程镜像」判定本请求
 *  必然入队时，不等 data-queue-state 快照往返（sidecar 回程 + ~20ms 合帧，
 *  期间乐观消息已被绘制 = 用户看到的"闪一下"）就同步摘除刚入列的消息。
 *  信号与 R1 同款（渲染侧幂等，快照到达再摘一次是 no-op）；摘早了（sidecar
 *  实际直接开跑）由 notifyQueueStreamStart 回填，被拒绝由收尾回填。 */
export function optimisticallyRemoveQueuedMessage(requestId: string): void {
  const reg = registry.get(requestId);
  if (!reg || reg.queued || reg.cancelled) return;
  reg.preRemoved = true;
  syncListener?.(reg, "remove");
}

/** 流 start chunk（pi-transport 调用）：该请求的 turn 真正开跑。登记若还
 *  停在「未入过快照」状态（乐观摘除判错——sidecar 空闲竞态下直接放行），
 *  此刻立即回填并销登记；真排队项派发出快照时已回填销登记，这里是 no-op。 */
export function notifyQueueStreamStart(requestId: string): void {
  const reg = registry.get(requestId);
  if (!reg || reg.queued || reg.cancelled) return;
  registry.delete(requestId);
  if (reg.preRemoved) syncListener?.(reg, "reveal");
}

/* ------------------------------ 派发空窗标记 ------------------------------ */

/** threadId -> 已派发开跑、但回复消息尚未落进列表的请求 id。链节取队首到
 *  新一轮首个内容 chunk 之间，chat status 处于上一轮流收尾造成的 ready 空窗
 *  （isRunning=false）且 AI 消息尚未创建——ThreadWorkingIndicator 凭它补
 *  「思考中」动画。 */
const pendingTurnByThread = new Map<string, string>();
const pendingTurnCache = new Map<string, { version: number; value: boolean }>();

function markPendingTurn(threadId: string, requestId: string): void {
  pendingTurnByThread.set(threadId, requestId);
}

/** 线程是否处于「排队项已派发、回复未落列表」的空窗（纯函数，测试用） */
export function hasPendingTurn(threadId: string): boolean {
  return pendingTurnByThread.has(threadId);
}

/** 订阅该线程是否处于派发空窗 */
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

/* ------------------------------- 订阅 hooks ------------------------------- */

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const EMPTY_ITEMS: QueueSnapshotItem[] = [];

const snapshotCache = new Map<string, { version: number; value: QueueSnapshot }>();

/** 线程当前队列快照（纯函数，测试用；无快照返回空壳） */
export function getQueueSnapshot(threadId: string): QueueSnapshot {
  return snapshots.get(threadId) ?? emptySnapshot(threadId);
}

/** 清空镜像/注册表/空窗标记（测试隔离用） */
export function resetQueueForTests(): void {
  snapshots.clear();
  registry.clear();
  pendingTurnByThread.clear();
  notify();
}

/** 订阅线程队列快照（无快照返回空壳，调用方免判空） */
export function useQueueSnapshot(threadId: string | undefined): QueueSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!threadId) return emptySnapshot("");
      const cached = snapshotCache.get(threadId);
      if (cached && cached.version === version) return cached.value;
      const value =
        snapshots.get(threadId) ?? emptySnapshot(threadId);
      snapshotCache.set(threadId, { version, value });
      return value;
    },
    () => emptySnapshot(""),
  );
}

function emptySnapshot(threadId: string): QueueSnapshot {
  return { version: 2, threadId, items: EMPTY_ITEMS, paused: false, nextId: 1 };
}

const EMPTY_IDS = new Set<string>();
const queuedIdsCache = new Map<string, { version: number; value: Set<string> }>();

/** 确认排队中（含并入挂起）的用户消息 id 集合（消息列表渲染抑制用）。派发
 *  出队后条目离开快照、消息回填，自动移出集合；steered 挂起项保持抑制。 */
export function getQueuedMessageIds(): Set<string> {
  const cached = queuedIdsCache.get("*");
  if (cached && cached.version === version) return cached.value;
  const ids = new Set<string>();
  for (const snapshot of snapshots.values()) {
    for (const item of snapshot.items) {
      const reg = registry.get(item.reqId);
      ids.add(reg?.messageId ?? `queued-${item.id}`);
    }
  }
  for (const reg of registry.values()) {
    if (reg.steered) ids.add(reg.messageId);
  }
  queuedIdsCache.set("*", { version, value: ids });
  return ids;
}

/** 订阅「确认排队中」的用户消息 id 集合（消息列表渲染抑制用，ChatGPT 式：
 *  排队中的消息不进消息列表，只出现在排队条） */
export function useQueuedMessageIds(): Set<string> {
  return useSyncExternalStore(subscribe, getQueuedMessageIds, () => EMPTY_IDS);
}

/* ------------------------------- 队列操作 ------------------------------- */

export async function pauseQueue(threadId: string, sessionId?: string): Promise<void> {
  await getPiChannel().request({
    type: "queue_pause",
    threadId,
    ...(sessionId ? { sessionId } : {}),
  });
}

/** 恢复派发。线程空闲且队列非空时，sidecar 会弹出队首交由前端重发（恢复项
 *  没有流与链节点，派发只能由持有流的前端驱动）——调用方拿到非 null 返回值
 *  后按文本重发（走正常发送路径，附件不保留） */
export async function resumeQueue(
  threadId: string,
  sessionId?: string,
): Promise<{ id: number; text: string; sessionId?: string } | null> {
  const res = await getPiChannel().request({
    type: "queue_resume",
    threadId,
    ...(sessionId ? { sessionId } : {}),
  });
  return (
    (res as { resumed?: { id: number; text: string; sessionId?: string } | null })
      .resumed ?? null
  );
}

/** 修改排队项文本（仅 queued 状态可改） */
export async function updateQueueItemText(reqId: string, text: string): Promise<void> {
  await getPiChannel().request({ type: "queue_update", requestId: reqId, text });
}

/** 删除排队项（sidecar 侧流立即 abort + finish 收尾；出快照后不回填） */
export async function cancelQueueItem(reqId: string): Promise<void> {
  const reg = registry.get(reqId);
  if (reg) reg.cancelled = true;
  await getPiChannel().request({ type: "queue_cancel", requestId: reqId });
  registry.delete(reqId);
}

/** 立即发送：中止当前活跃 turn，该项提到队首马上执行 */
export async function promoteQueueItem(reqId: string): Promise<void> {
  await getPiChannel().request({ type: "queue_promote", requestId: reqId });
}

/** 并入当前轮：注入活跃轮（不中止不排队）；消息随宿主轮流收尾回填 */
export async function steerQueueItem(reqId: string): Promise<void> {
  const reg = registry.get(reqId);
  if (reg) reg.steered = true;
  await getPiChannel().request({ type: "queue_steer", requestId: reqId });
}
