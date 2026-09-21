/**
 * prompt 排队队列 v2（设计见 plans/queue-refactor-plan.md，参考 pi-message-queue）。
 *
 * 队列按线程隔离：每个 threadId 一条 FIFO，串行链也是每线程一条，
 * 不同线程的 turn 并行执行、互不阻塞；同一线程内，上一轮未结束时到达的新
 * prompt 不再直接打到 agent.prompt() 撞 "Agent is already processing" 守卫，
 * 而是进入该线程的 FIFO 队列，由 protocol.ts 的该线程串行链依次执行。
 *
 * v2 相对 v1 的核心变化：
 * - 稳定自增 id（持久化，跨重启不重复），派发/取消/编辑都以 id 寻址；
 * - 暂停/恢复：暂停只停派发（链节在队首等待唤醒），不清队列；
 * - 快照持久化：每次变更向 session JSONL 追加一行 queue_state 全量快照，
 *   sidecar 重启后经 get_queue_state 回放恢复（恢复的队列自动暂停，等用户确认）；
 * - 快照广播：每次变更经 sendEventChunk 向该线程发 data-queue-state 全量快照，
 *   前端「最后快照胜出」（线程无活跃请求时静默丢弃——空闲态变更都由前端
 *   自身的 invoke 发起，前端从回复里自更新）；
 * - 失败熔断：同线程连续 turn 级失败达阈值自动暂停（防级联报错轰炸），一键恢复。
 *
 * data-queue chunk 生命周期（同 id 原地更新，参照 data-compaction；v2 保留作
 * 流级信号，权威状态以 data-queue-state 快照为准）：
 *   { phase: "queued", position } 入队/位置变化 → { phase: "active" } 开跑；
 *   steer 走 { phase: "steered" }（退化流标记）；项被取消/中止时不发 active，
 *   流上直接 abort + finish 收尾。
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { sendChunk, sendEventChunk } from "../protocol/stream";
import { sessionPath } from "../storage/storage";

/** 每线程排队上限：超过直接拒绝（error chunk），防无限堆积 */
export const PROMPT_QUEUE_LIMIT = 5;

/** 失败熔断阈值：同线程连续 turn 级失败达到该数自动暂停队列 */
export const QUEUE_FAILURE_PAUSE_THRESHOLD = 2;

export type QueueItem = {
  /** 引擎内稳定自增 id（持久化，跨重启不重复） */
  id: number;
  reqId: string;
  threadId: string;
  text: string;
  createdAt: string;
  /** 原始 prompt 帧（sessionId/cwd/attachments 随项保留；恢复项为最小重建帧） */
  msg: Record<string, unknown>;
};

/** 广播/持久化用全量快照（不含 msg 帧——恢复项由前端按文本重建气泡） */
export type QueueSnapshot = {
  version: 2;
  threadId: string;
  items: { id: number; reqId: string; text: string; createdAt: string }[];
  paused: boolean;
  nextId: number;
};

type ThreadQueue = {
  items: QueueItem[];
  paused: boolean;
  nextId: number;
  consecutiveFailures: number;
  /** 暂停期间在队首等待派发的链节唤醒回调（resume 时全部唤醒） */
  pauseWaiters: Array<() => void>;
  /** 最近一次已知 sessionId（快照持久化定位 session 文件；空队列也能落盘） */
  lastSessionId?: string;
};

/** threadId -> 该线程引擎 */
const engines = new Map<string, ThreadQueue>();

/** 正在跑 turn 的线程集合（含会话准备到 finish 收尾的全过程）。
 *  由 protocol.ts 在链节首尾增删；入队判定用它而非 isPromptActive()
 *  （activeReqByThread 在无模型守卫等提前返回路径上不会置位）。 */
const busyThreads = new Set<string>();

export function queueChunkId(reqId: string): string {
  return `queue-${reqId}`;
}

function engineFor(threadId: string): ThreadQueue {
  let q = engines.get(threadId);
  if (!q) {
    q = {
      items: [],
      paused: false,
      nextId: 1,
      consecutiveFailures: 0,
      pauseWaiters: [],
    };
    engines.set(threadId, q);
  }
  return q;
}

function dropEngineIfEmpty(threadId: string): void {
  const q = engines.get(threadId);
  if (q && q.items.length === 0 && !q.paused && q.pauseWaiters.length === 0) {
    engines.delete(threadId);
  }
}

/** 变更出口：持久化（有 sessionId 时）+ 快照广播（有活跃请求时）。
 *  任何一路失败都不影响队列内存状态。 */
function emitQueueState(threadId: string, sessionId?: string): void {
  const q = engines.get(threadId);
  if (!q) return;
  const snapshot = snapshotOf(threadId);
  if (sessionId) q.lastSessionId = sessionId;
  const sid =
    sessionId ??
    q.lastSessionId ??
    (typeof q.items[0]?.msg.sessionId === "string"
      ? (q.items[0]!.msg.sessionId as string)
      : undefined);
  if (sid) {
    q.lastSessionId = sid;
    try {
      appendFileSync(
        sessionPath(sid),
        JSON.stringify({ type: "queue_state", snapshot }) + "\n",
      );
    } catch {
      // 持久化失败不阻断队列（重启后该批排队项丢失，可接受）
    }
  }
  sendEventChunk(threadId, {
    type: "data-queue-state",
    id: `queue-state-${snapshot.nextId}-${snapshot.items.length}`,
    data: snapshot,
  });
}

export function snapshotOf(threadId: string): QueueSnapshot {
  const q = engineFor(threadId);
  return {
    version: 2,
    threadId,
    items: q.items.map((item) => ({
      id: item.id,
      reqId: item.reqId,
      text: item.text,
      createdAt: item.createdAt,
    })),
    paused: q.paused,
    nextId: q.nextId,
  };
}

/** 从 session 转录回放最后一份队列快照（无/损坏返回 undefined） */
export function replayQueueState(sessionId: string): QueueSnapshot | undefined {
  const file = sessionPath(sessionId);
  if (!existsSync(file)) return undefined;
  let last: QueueSnapshot | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"queue_state"')) continue;
    try {
      const row = JSON.parse(line) as { type?: string; snapshot?: QueueSnapshot };
      if (row.type !== "queue_state" || row.snapshot?.version !== 2) continue;
      if (!Array.isArray(row.snapshot.items)) continue;
      last = row.snapshot;
    } catch {
      // 撕裂尾行：忽略
    }
  }
  return last;
}

function isQueueSnapshotRestorable(snapshot: QueueSnapshot): boolean {
  return (
    snapshot.version === 2 &&
    Array.isArray(snapshot.items) &&
    snapshot.items.every(
      (item) =>
        typeof item.id === "number" &&
        typeof item.reqId === "string" &&
        typeof item.text === "string" &&
        item.text.trim().length > 0,
    )
  );
}

/** 采纳回放快照：仅当该线程内存队列为空（不覆盖活状态）；恢复的队列自动
 *  暂停——重启后无人值守地自动重跑历史排队消息有风险，由用户确认后续发 */
export function adoptRestoredQueue(threadId: string, sessionId: string): QueueSnapshot | undefined {
  const restored = replayQueueState(sessionId);
  if (!restored || !isQueueSnapshotRestorable(restored)) return undefined;
  const q = engineFor(threadId);
  if (q.items.length > 0) return snapshotOf(threadId);
  q.items = restored.items.map((item) => ({
    id: item.id,
    reqId: item.reqId,
    threadId,
    text: item.text,
    createdAt: item.createdAt,
    // 最小重建帧：恢复项的派发走前端泵（queue_pop → 前端按文本重发），不依赖完整帧
    msg: { type: "prompt", text: item.text, threadId, sessionId },
  }));
  q.nextId = Math.max(restored.nextId, ...restored.items.map((item) => item.id + 1), 1);
  q.paused = true; // 恢复即暂停：用户确认后 resume 续发
  return snapshotOf(threadId);
}

/** 线程当前队列快照：内存优先；内存为空则尝试从 session 回放并采纳（自动暂停）。
 *  前端线程挂载/刷新恢复时调用。 */
export function getQueueStateForThread(
  threadId: string,
  sessionId?: string,
): QueueSnapshot | undefined {
  const q = engines.get(threadId);
  if (q && (q.items.length > 0 || q.paused)) return snapshotOf(threadId);
  if (!sessionId) return undefined;
  return adoptRestoredQueue(threadId, sessionId);
}

/** 是否应排队（该线程有 turn 在跑或该线程队列非空；其他线程不影响） */
export function shouldQueue(threadId: string): boolean {
  return busyThreads.has(threadId) || (engines.get(threadId)?.items.length ?? 0) > 0;
}

/** 入队；按线程限流，超限返回 false（调用方回 error chunk） */
export function enqueueTurn(
  reqId: string,
  threadId: string,
  msg: Record<string, unknown>,
): { ok: true; item: QueueItem } | { ok: false } {
  const q = engineFor(threadId);
  if (q.items.length >= PROMPT_QUEUE_LIMIT) return { ok: false };
  const item: QueueItem = {
    id: q.nextId++,
    reqId,
    threadId,
    text: String(msg.text ?? ""),
    createdAt: new Date().toISOString(),
    msg,
  };
  q.items.push(item);
  if (typeof msg.sessionId === "string") q.lastSessionId = msg.sessionId;
  emitQueueState(threadId);
  return { ok: true, item };
}

/** 标记线程 turn 开始（协议层在轮到该线程链节时调用） */
export function markTurnStart(threadId: string): void {
  busyThreads.add(threadId);
}

/** 标记线程 turn 结束 */
export function markTurnEnd(threadId: string): void {
  busyThreads.delete(threadId);
}

/** 该线程是否有 turn 在跑（测试断言 busy 窗口用） */
export function isTurnBusy(threadId: string): boolean {
  return busyThreads.has(threadId);
}

/** turn 结算：连续失败达阈值自动暂停队列（有排队项时），成功清零计数 */
export function markTurnOutcome(threadId: string, ok: boolean): void {
  const q = engines.get(threadId);
  if (!q) return;
  q.consecutiveFailures = ok ? 0 : q.consecutiveFailures + 1;
  if (
    !ok &&
    q.consecutiveFailures >= QUEUE_FAILURE_PAUSE_THRESHOLD &&
    !q.paused &&
    q.items.length > 0
  ) {
    pauseThread(threadId);
  }
}

/** 暂停派发：链节在队首等待（不打断正在跑的 turn），不清队列 */
export function pauseThread(threadId: string, sessionId?: string): void {
  const q = engineFor(threadId);
  if (q.paused) return;
  q.paused = true;
  emitQueueState(threadId, sessionId);
}

/** 恢复派发：唤醒全部在队首等待的链节（串行链保证依次取队首） */
export function resumeThread(threadId: string, sessionId?: string): void {
  const q = engineFor(threadId);
  if (!q.paused) return;
  q.paused = false;
  emitQueueState(threadId, sessionId);
  const waiters = q.pauseWaiters.splice(0);
  for (const wake of waiters) wake();
}

/** 链节用：队列暂停时等待恢复（未暂停立即返回；resume 唤醒全部等待节点，
 *  节点间由串行链保证依次取队首） */
export function waitQueueUnpaused(threadId: string): Promise<void> {
  const q = engineFor(threadId);
  if (!q?.paused) return Promise.resolve();
  return new Promise((resolve) => {
    q.pauseWaiters.push(resolve);
  });
}

/** 队首出队交由前端重新发送（恢复项没有链节点与流，派发只能由持有流的
 *  前端泵驱动）：仅在线程空闲且未暂停时弹出，否则返回 null */
export function popFrontForDispatch(threadId: string): QueueItem | null {
  const q = engines.get(threadId);
  if (!q || q.paused || q.items.length === 0) return null;
  if (busyThreads.has(threadId)) return null;
  const [item] = q.items.splice(0, 1);
  // 先广播（含空快照）再清引擎，见 takeFrontEntry
  emitQueueState(threadId);
  dropEngineIfEmpty(threadId);
  return item ?? null;
}

/** 链节开跑：取该线程当前队首项（promote 重排后顺序依然正确）。不在此处广播：
 *  派发出队的快照必须等调用方建立新请求的路由（setActiveReqId）后再发
 *  （broadcastQueueState），否则落在上一轮流收尾与下一轮开跑的空窗里被
 *  sendEventChunk 静默丢弃——排队消息的回填信号就丢在这里。队列为空
 *  （本项已被取消或被其他链节消费）返回 null，链节静默让位 */
export function takeFrontEntry(threadId: string): QueueItem | null {
  const q = engines.get(threadId);
  const item = q?.items.shift() ?? null;
  return item;
}

/** 快照广播（data-queue-state）：变更后调用；线程无活跃请求时静默丢弃 */
export function broadcastQueueState(threadId: string): void {
  emitQueueState(threadId);
}

/** 修改排队项文本（仅 queued 状态可改） */
export function updateEntryText(reqId: string, text: string): boolean {
  for (const q of engines.values()) {
    const item = q.items.find((t) => t.reqId === reqId);
    if (item) {
      item.text = text;
      emitQueueState(item.threadId);
      return true;
    }
  }
  return false;
}

/** 删除单个排队项：流立即 abort + finish 收尾，不执行 */
export function cancelEntry(reqId: string): boolean {
  for (const [threadId, q] of engines) {
    const idx = q.items.findIndex((t) => t.reqId === reqId);
    if (idx === -1) continue;
    const [item] = q.items.splice(idx, 1);
    if (item) sendChunkAbortFinish(item.reqId);
    // 先广播（含空快照）再清引擎，见 takeFrontEntry
    emitQueueState(threadId);
    dropEngineIfEmpty(threadId);
    return true;
  }
  return false;
}

/** 取消收尾：该项不执行，流立即 abort + finish 关闭 */
function sendChunkAbortFinish(reqId: string): void {
  sendChunk(reqId, { type: "abort" });
  sendChunk(reqId, { type: "finish" });
}

/** 把排队项提到该线程队首（立即发送：调用方随后中止该线程活跃 turn）；
 *  返回被提前的项（调用方需要它的 threadId），不存在返回 null */
export function promoteEntry(reqId: string): QueueItem | null {
  for (const [threadId, q] of engines) {
    const idx = q.items.findIndex((t) => t.reqId === reqId);
    if (idx === -1) continue;
    const [entry] = q.items.splice(idx, 1);
    q.items.unshift(entry);
    emitQueueState(threadId);
    return entry;
  }
  return null;
}

/** 并入当前轮：注入回调成功才移除排队项（随后快照广播）；回调返回 false
 *  （无可并入的活跃轮等）项原位保留，返回 false。移除后该项的流由注入方
 *  以 steered 退化生命周期收尾，串行链轮到时队列为空自然让位。 */
export function steerOutEntry(
  reqId: string,
  inject: (entry: QueueItem) => boolean,
): boolean {
  for (const [threadId, q] of engines) {
    const idx = q.items.findIndex((t) => t.reqId === reqId);
    if (idx === -1) continue;
    const entry = q.items[idx];
    if (!inject(entry)) return false;
    q.items.splice(idx, 1);
    // 先广播（含空快照）再清引擎，见 takeFrontEntry
    emitQueueState(threadId);
    dropEngineIfEmpty(threadId);
    return true;
  }
  return false;
}

/** 取消排队项（threadId 提供时仅该线程）：各自流立即 abort+finish 收尾；
 *  返回取消条数 */
export function cancelAllEntries(threadId?: string): number {
  const targets = threadId
    ? [...engines].filter(([tid]) => tid === threadId)
    : [...engines];
  let cancelled = 0;
  for (const [tid, q] of targets) {
    const entries = [...q.items];
    // 先广播（含空快照）再清引擎，见 takeFrontEntry
    emitQueueState(tid);
    engines.delete(tid);
    for (const entry of entries) {
      sendChunkAbortFinish(entry.reqId);
    }
    cancelled += entries.length;
  }
  return cancelled;
}

/** 排队快照（调试/测试用；threadId 提供时仅该线程） */
export function queueSnapshot(threadId?: string): { reqId: string; threadId: string; text: string; position: number }[] {
  const out: { reqId: string; threadId: string; text: string; position: number }[] = [];
  for (const [tid, q] of engines) {
    if (threadId && tid !== threadId) continue;
    q.items.forEach((t, i) =>
      out.push({ reqId: t.reqId, threadId: tid, text: t.text, position: i + 1 }),
    );
  }
  return out;
}

/** 清空队列与 busy 位（测试隔离用） */
export function resetQueueForTests(): void {
  engines.clear();
  busyThreads.clear();
}
