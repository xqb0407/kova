/**
 * prompt 排队队列（设计见 docs/prompt-queue-design.md）。
 *
 * 队列按线程（session）隔离：每个 threadId 一条 FIFO，串行链也是每线程一条，
 * 不同线程的 turn 并行执行、互不阻塞；同一线程内，上一轮未结束时到达的新
 * prompt 不再直接打到 agent.prompt() 撞 "Agent is already processing" 守卫，
 * 而是进入该线程的 FIFO 队列，由 protocol.ts 的该线程串行链依次执行。
 *
 * 线程串行链的每一节是可互换的「工人槽」：轮到某节时取该线程当前队首项执行
 * （而非绑定派发顺序），这样 queue_promote 重排队列后顺序依然正确；被取消的项
 * 已在取消时收尾流，轮到时队列为空或项已不在，链节静默让位。
 *
 * data-queue chunk 生命周期（同 id 原地更新，参照 data-compaction）：
 *   { phase: "queued", position } 入队/位置变化 → { phase: "active" } 开跑；
 *   项被取消/中止时不发 active，流上直接 abort + finish 收尾。
 */
import { sendChunk } from "./stream";

/** 每线程排队上限：超过直接拒绝（error chunk），防无限堆积 */
export const PROMPT_QUEUE_LIMIT = 5;

export type QueuedTurn = {
  reqId: string;
  threadId: string;
  /** 原始 prompt 消息（text 可被 queue_update 改写） */
  msg: Record<string, unknown>;
  /** 被取消/中止：轮到它时不执行（流已在取消时收尾），静默让位 */
  aborted: boolean;
};

/** threadId -> 该线程的排队 turn（不含活跃项） */
const queues = new Map<string, QueuedTurn[]>();

/** 正在跑 turn 的线程集合（含会话准备到 finish 收尾的全过程）。
 *  由 protocol.ts 在链节首尾增删；入队判定用它而非 isPromptActive()
 *  （activeReqByThread 在无模型守卫等提前返回路径上不会置位）。 */
const busyThreads = new Set<string>();

export function queueChunkId(reqId: string): string {
  return `queue-${reqId}`;
}

function queueFor(threadId: string): QueuedTurn[] {
  let q = queues.get(threadId);
  if (!q) {
    q = [];
    queues.set(threadId, q);
  }
  return q;
}

function chunkFor(entry: QueuedTurn): { type: "data-queue"; id: string; data: Record<string, unknown> } {
  const q = queues.get(entry.threadId) ?? [];
  return {
    type: "data-queue",
    id: queueChunkId(entry.reqId),
    data: { phase: "queued", position: q.indexOf(entry) + 1 },
  };
}

/** 队列位置变化后重发该线程所有项的 position（前端排队条序号跟着变） */
function reemitPositions(threadId: string): void {
  const q = queues.get(threadId);
  if (!q) return;
  for (const entry of q) sendChunk(entry.reqId, chunkFor(entry));
}

/** 是否应排队（该线程有 turn 在跑或该线程队列非空；其他线程不影响） */
export function shouldQueue(threadId: string): boolean {
  return busyThreads.has(threadId) || (queues.get(threadId)?.length ?? 0) > 0;
}

/** 入队；按线程限流，超限返回 false（调用方回 error chunk） */
export function enqueueTurn(
  reqId: string,
  threadId: string,
  msg: Record<string, unknown>,
): { ok: true; entry: QueuedTurn } | { ok: false } {
  const q = queueFor(threadId);
  if (q.length >= PROMPT_QUEUE_LIMIT) return { ok: false };
  const entry: QueuedTurn = { reqId, threadId, msg, aborted: false };
  q.push(entry);
  sendChunk(reqId, chunkFor(entry));
  return { ok: true, entry };
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

/** 清空队列与 busy 位（测试隔离用） */
export function resetQueueForTests(): void {
  queues.clear();
  busyThreads.clear();
}

/** 链节开跑：取该线程当前队首项（promote 重排后顺序依然正确）并重发位置；
 *  队列为空（本项已被取消或被其他链节消费）返回 null，链节静默让位 */
export function takeFrontEntry(threadId: string): QueuedTurn | null {
  const q = queues.get(threadId);
  const entry = q?.shift() ?? null;
  if (entry && q) {
    if (q.length === 0) queues.delete(threadId);
    reemitPositions(threadId);
  }
  return entry;
}

/** 修改排队项文本（仅 queued 状态可改） */
export function updateEntryText(reqId: string, text: string): boolean {
  for (const q of queues.values()) {
    const entry = q.find((t) => t.reqId === reqId);
    if (entry) {
      if (entry.aborted) return false;
      entry.msg = { ...entry.msg, text };
      return true;
    }
  }
  return false;
}

/** 删除单个排队项：流立即 abort + finish 收尾，不执行 */
export function cancelEntry(reqId: string): boolean {
  for (const [threadId, q] of queues) {
    const idx = q.findIndex((t) => t.reqId === reqId);
    if (idx === -1) continue;
    const [entry] = q.splice(idx, 1);
    if (q.length === 0) queues.delete(threadId);
    entry.aborted = true;
    sendChunk(entry.reqId, { type: "abort" });
    sendChunk(entry.reqId, { type: "finish" });
    reemitPositions(threadId);
    return true;
  }
  return false;
}

/** 把排队项提到该线程队首（立即发送：调用方随后中止该线程活跃 turn）；
 *  返回被提前的项（调用方需要它的 threadId），不存在返回 null */
export function promoteEntry(reqId: string): QueuedTurn | null {
  for (const [threadId, q] of queues) {
    const idx = q.findIndex((t) => t.reqId === reqId);
    if (idx === -1) continue;
    const [entry] = q.splice(idx, 1);
    entry.aborted = false;
    q.unshift(entry);
    reemitPositions(threadId);
    return entry;
  }
  return null;
}

/** 并入当前轮：注入回调成功才移除排队项（随后位置重发）；回调返回 false
 *  （无可并入的活跃轮等）项原位保留，返回 false。移除后该项的流由注入方
 *  以 steered 退化生命周期收尾，串行链轮到时队列为空自然让位。 */
export function steerOutEntry(
  reqId: string,
  inject: (entry: QueuedTurn) => boolean,
): boolean {
  for (const [threadId, q] of queues) {
    const idx = q.findIndex((t) => t.reqId === reqId);
    if (idx === -1) continue;
    const entry = q[idx];
    if (!inject(entry)) return false;
    q.splice(idx, 1);
    if (q.length === 0) queues.delete(threadId);
    reemitPositions(threadId);
    return true;
  }
  return false;
}

/** 取消排队项（threadId 提供时仅该线程）：各自流立即 abort+finish 收尾；
 *  返回取消条数 */
export function cancelAllEntries(threadId?: string): number {
  const targets = threadId
    ? [...queues].filter(([tid]) => tid === threadId)
    : [...queues];
  let cancelled = 0;
  for (const [tid, q] of targets) {
    const entries = [...q];
    queues.delete(tid);
    for (const entry of entries) {
      entry.aborted = true;
      sendChunk(entry.reqId, { type: "abort" });
      sendChunk(entry.reqId, { type: "finish" });
    }
    cancelled += entries.length;
  }
  return cancelled;
}

/** 排队快照（调试/测试用；threadId 提供时仅该线程） */
export function queueSnapshot(threadId?: string): { reqId: string; threadId: string; text: string; position: number }[] {
  const out: { reqId: string; threadId: string; text: string; position: number }[] = [];
  for (const [tid, q] of queues) {
    if (threadId && tid !== threadId) continue;
    q.forEach((t, i) =>
      out.push({ reqId: t.reqId, threadId: tid, text: String(t.msg.text ?? ""), position: i + 1 }),
    );
  }
  return out;
}
