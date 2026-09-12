/**
 * prompt 排队队列（设计见 docs/prompt-queue-design.md）。
 *
 * sidecar 事件路由依赖全局 currentReqId（stream.ts），本质一次只能跑一个
 * prompt turn；上一轮未结束时到达的新 prompt 不再直接打到 agent.prompt()
 * 撞 "Agent is already processing" 守卫，而是进入本模块的 FIFO 队列，
 * 由 protocol.ts 的串行链依次执行。
 *
 * 串行链的每一节是可互换的「工人槽」：轮到某节时取当前队首项执行（而非绑定
 * 派发顺序），这样 queue_promote 重排队列后顺序依然正确；被取消的项已在
 * 取消时收尾流，轮到时队列为空或项已不在，链节静默让位。
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

const queue: QueuedTurn[] = [];

/** 串行链当前是否有 turn 在跑（含会话准备到 finish 收尾的全过程）。
 *  由 protocol.ts 在链节首尾置位；入队判定用它而非 isPromptActive()
 *  （currentReqId 在无模型守卫等提前返回路径上不会置位）。 */
let turnBusy = false;

export function queueChunkId(reqId: string): string {
  return `queue-${reqId}`;
}

function chunkFor(entry: QueuedTurn): { type: "data-queue"; id: string; data: Record<string, unknown> } {
  return {
    type: "data-queue",
    id: queueChunkId(entry.reqId),
    data: { phase: "queued", position: queue.indexOf(entry) + 1 },
  };
}

/** 队列位置变化后重发所有项的 position（前端排队条序号跟着变） */
function reemitPositions(): void {
  for (const entry of queue) sendChunk(entry.reqId, chunkFor(entry));
}

/** 是否应排队（有 turn 在跑或队列非空） */
export function shouldQueue(): boolean {
  return turnBusy || queue.length > 0;
}

/** 入队；按线程限流，超限返回 false（调用方回 error chunk） */
export function enqueueTurn(
  reqId: string,
  threadId: string,
  msg: Record<string, unknown>,
): { ok: true; entry: QueuedTurn } | { ok: false } {
  const queuedForThread = queue.filter((q) => q.threadId === threadId).length;
  if (queuedForThread >= PROMPT_QUEUE_LIMIT) return { ok: false };
  const entry: QueuedTurn = { reqId, threadId, msg, aborted: false };
  queue.push(entry);
  sendChunk(reqId, chunkFor(entry));
  return { ok: true, entry };
}

/** 标记 turn 开始（协议层在轮到该链节时调用） */
export function markTurnStart(): void {
  turnBusy = true;
}

/** 标记 turn 结束 */
export function markTurnEnd(): void {
  turnBusy = false;
}

/** 是否有 turn 在跑（测试断言 busy 窗口用） */
export function isTurnBusy(): boolean {
  return turnBusy;
}

/** 清空队列与 busy 位（测试隔离用） */
export function resetQueueForTests(): void {
  queue.length = 0;
  turnBusy = false;
}

/** 链节开跑：取当前队首项（promote 重排后顺序依然正确）并重发位置；
 *  队列为空（本项已被取消或被其他链节消费）返回 null，链节静默让位 */
export function takeFrontEntry(): QueuedTurn | null {
  const entry = queue.shift() ?? null;
  if (entry) reemitPositions();
  return entry;
}

/** 修改排队项文本（仅 queued 状态可改） */
export function updateEntryText(reqId: string, text: string): boolean {
  const entry = queue.find((q) => q.reqId === reqId);
  if (!entry || entry.aborted) return false;
  entry.msg = { ...entry.msg, text };
  return true;
}

/** 删除单个排队项：流立即 abort + finish 收尾，不执行 */
export function cancelEntry(reqId: string): boolean {
  const idx = queue.findIndex((q) => q.reqId === reqId);
  if (idx === -1) return false;
  const [entry] = queue.splice(idx, 1);
  entry.aborted = true;
  sendChunk(entry.reqId, { type: "abort" });
  sendChunk(entry.reqId, { type: "finish" });
  reemitPositions();
  return true;
}

/** 把排队项提到队首（立即发送：调用方随后中止活跃 turn） */
export function promoteEntry(reqId: string): boolean {
  const idx = queue.findIndex((q) => q.reqId === reqId);
  if (idx === -1) return false;
  const [entry] = queue.splice(idx, 1);
  entry.aborted = false;
  queue.unshift(entry);
  reemitPositions();
  return true;
}

/** 取消全部排队项（用户 Stop：停下一切；返回取消条数） */
export function cancelAllEntries(): number {
  const entries = [...queue];
  queue.length = 0;
  for (const entry of entries) {
    entry.aborted = true;
    sendChunk(entry.reqId, { type: "abort" });
    sendChunk(entry.reqId, { type: "finish" });
  }
  return entries.length;
}

/** 排队快照（调试/测试用） */
export function queueSnapshot(): { reqId: string; threadId: string; text: string; position: number }[] {
  return queue.map((q, i) => ({
    reqId: q.reqId,
    threadId: q.threadId,
    text: String(q.msg.text ?? ""),
    position: i + 1,
  }));
}
