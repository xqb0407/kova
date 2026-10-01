"use client";

import { useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import { getPiChannel } from "@/lib/pi/pi-channel";
import {
  queueSnapshotSchema,
  checkFrame,
  isStrictEnv,
  type QueueSnapshot,
  type QueueSnapshotItem,
} from "pi-protocol";

/**
 * prompt 排队 store v3（快照镜像 + 单路径消息同步）：
 *
 * 事实源在 sidecar QueueEngine（按线程隔离 FIFO，autoDrain 恒开），每次变更广播
 * `data-queue-state` 全量快照；本 store 是「最后快照胜出」的镜像。线程挂载/刷新
 * 恢复时经 get_queue_state 拉取（sidecar 内存为空则从 session 回放采纳）。
 *
 * 登记表：reqId → 单字段状态机（phase），替代 v2 的四布尔旗标：
 *   pending  sendMessages 已登记、乐观摘除已做，等 sidecar 定论
 *   queued   快照确认排队（消息保持在数组外）
 *   steered  已并入当前轮（徽标等宿主轮流收尾时清除，不回填气泡——并入内容
 *            已随本轮回复呈现）
 * 转移只有六条，全部幂等：
 *   pending → queued            快照确认（或登记表无记录时按快照合成，刷新恢复）
 *   pending → （销毁+回填）      start chunk：sidecar 空闲竞态直接开跑，没排队
 *   pending → （销毁+回填）      流终结：sidecar 拒绝（如队列已满）
 *   queued  → （销毁+回填）      出快照 = 派发出队，立即回填（此刻无并发写入）
 *   steered → （销毁，不回填）   宿主轮流收尾（steered 流 finish 补发时）
 *   steered → queued            快照里它仍在 = 并入被拒（竞态），回退排队态
 * 「回填」唯一出口是 syncListener(kind:"reveal")，追加乐观消息到数组末尾；
 * 用户取消的条目在调用前已销登记，出快照不会误回填。
 *
 * 消息数组同步规则（两条，均幂等且「无变化不赋值」——Chat 的 messages setter
 * 即使内容相同也会通知订阅者，无条件赋值会形成渲染↔同步死循环）：
 * - remove  入快照（排队确认）：消息从数组摘除。必须摘：AI SDK 对「非末条消息
 *   的流式写入」会 pushMessage 追加重复项（外部 store 对重复 id 保留最后一次
 *   出现）；摘除后上一轮保持末条、写入走原地替换，顺序稳定。
 * - reveal  出快照：消息回填数组末尾。回填时机都在安全窗口（无流式写入）：
 *   派发出队=链节取队首前宿主轮已完整收尾；steered=宿主轮流收尾后。
 */

// 快照契约单源 pi-protocol（设计文档 §5）：与 sidecar prompt-queue.ts
// 共用同一 schema，本文件不再手抄镜像。
export type { QueueSnapshot, QueueSnapshotItem };

/** 登记表条目：phase 即上文状态机 */
export type RegisteredMessage = {
  threadId: string;
  messageId: string;
  message: UIMessage;
  phase: "pending" | "queued" | "steered";
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
    // id 用真实 reqId（链节派发轮的 requestId 就是入队 reqId，见
    // prompt-pipeline turnReqId = next.reqId）：reveal 回填的占位气泡与
    // resumeStream 重放的正式 user 消息同 id —— 正式消息落位时按 id 收敛
    // 替换，不再出现「占位气泡闪现一下再被重放替换/双气泡」的竞态观感
    id: item.reqId,
    role: "user",
    parts: [{ type: "text", text: item.text }],
  };
}

/** transport 登记：sendMessages 时调用（regenerate 不登记，见 pi-transport） */
export function registerQueuedMessage(reqId: string, threadId: string, message: UIMessage): void {
  registry.set(reqId, { threadId, messageId: message.id, message, phase: "pending" });
}

/** 消费 data-queue-state 快照 chunk（pi-transport 调用）。入帧校验
 * （设计文档 §9）：dev/test 契约漂移即抛；prod 记 warn 后维持旧宽松路径 */
export function applyQueueStateChunk(threadId: string, data: unknown): void {
  const snapshot = checkFrame(queueSnapshotSchema, data, {
    strict: isStrictEnv,
    where: "applyQueueStateChunk",
    report: (where, issue) => console.warn(`pi-protocol ${where}:`, issue),
  });
  // prod 放行路径保住旧最小安全网：缺 items 的畸形帧直接丢弃（等 §3 回拉补平）
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.items)) return;
  applySnapshot({ ...snapshot, threadId });
}

/** 线程挂载/刷新恢复：向 sidecar 请求快照并入镜像（sidecar 内存为空会从
 *  session 回放采纳，不再自动暂停） */
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
  const seen = new Set<string>();
  for (const item of snapshot.items) seen.add(item.reqId);

  // 入快照：排队确认。已有登记 pending→queued；steered 仍在快照 = 并入被拒
  // （活跃轮恰好收尾等），回退 queued；无登记（刷新恢复/重启回放）按快照文本
  // 合成登记。pending/回退两者都发一次 remove（幂等：消息已不在数组时是 no-op）
  const onRemove: RegisteredMessage[] = [];
  for (const item of snapshot.items) {
    const existing = registry.get(item.reqId);
    if (existing) {
      if (existing.phase === "pending") {
        existing.phase = "queued";
        onRemove.push(existing);
      } else if (existing.phase === "steered") {
        // 快照权威：sidecar 队列里还有它 = 未受理并入，徽标随之消失，
        // 自愈一切「并入被拒但登记滞留 steered」的路径
        existing.phase = "queued";
      }
    } else {
      const reg: RegisteredMessage = {
        threadId: snapshot.threadId,
        messageId: item.reqId,
        message: synthesizedMessage(item),
        phase: "queued",
      };
      registry.set(item.reqId, reg);
      onRemove.push(reg);
    }
  }

  // 出快照：仅「queued」意味着派发出队 → 立即回填（安全窗口，宿主轮已收尾）。
  // steered 保持在表（宿主轮流收尾回填）；pending 与本快照无关（sidecar 可能
  // 直接开跑了，等 start chunk / 流终结定夺）；cancelled 在取消时已销登记
  const onReveal: RegisteredMessage[] = [];
  for (const [reqId, reg] of [...registry]) {
    if (reg.threadId !== snapshot.threadId || seen.has(reqId)) continue;
    if (reg.phase !== "queued") continue;
    registry.delete(reqId);
    onReveal.push(reg);
    markPendingTurn(snapshot.threadId, reqId);
  }

  snapshots.set(snapshot.threadId, snapshot);
  notify();
  for (const reg of onRemove) emitSync(reg, "remove");
  for (const reg of onReveal) emitSync(reg, "reveal");
}

/* --------------------- 入队预期门（渲染投影守门） ---------------------
 * 忙线程发送时框架的乐观 append 先于 transport 登记执行，且 AI SDK state
 * 是 React 外部 store——更新同步渲染、不吃批处理，任何摘除都晚一帧（气泡
 * 闪现 1-2 帧后才被摘掉）。gate 在 composer 发送前置位（早于 pushMessage），
 * thread 渲染回调对「gate 线程的最后一条 user 消息」直接不渲染——同帧生效，
 * 与摘除时序无关；transport 登记完成后清除（乐观摘除/快照链接管）。
 * 2s 过期是保命阀：transport 在 pushMessage 之前抛错（此时消息已乐观 append
 * 却没人摘）时，若只靠调用方 clear，UI 会把这条消息永久藏起来。过期**必须自带
 * 一次重绘**——只写 expiresAt 是不够的：那只是一次惰性比较，没有任何人会在
 * 第 2 秒去问它，于是"保命阀"变成"永久吞消息"。 */
let inboundGate: { threadId: string; expiresAt: number } | null = null;
let inboundGateTimer: ReturnType<typeof setTimeout> | null = null;

const INBOUND_GATE_TTL_MS = 2000;

/** 发送前置位：该线程本次发送预期入队（忙判定由调用方完成） */
export function markInboundGate(threadId: string): void {
  inboundGate = { threadId, expiresAt: Date.now() + INBOUND_GATE_TTL_MS };
  if (inboundGateTimer) clearTimeout(inboundGateTimer);
  inboundGateTimer = setTimeout(() => {
    inboundGateTimer = null;
    // 已被 clearInboundGate 取消：此处 gate 已空，不重绘
    if (!inboundGate) return;
    inboundGate = null;
    notify();
  }, INBOUND_GATE_TTL_MS);
  notify();
}

/** transport 登记完成/快照到达后清除（守门交给乐观摘除链或快照链） */
export function clearInboundGate(): void {
  if (inboundGateTimer) {
    clearTimeout(inboundGateTimer);
    inboundGateTimer = null;
  }
  if (inboundGate) {
    inboundGate = null;
    notify();
  }
}

/** 渲染守门查询：gate 活跃（未过期）且匹配线程 */
export function isInboundGateActive(threadId: string): boolean {
  return (
    !!inboundGate &&
    inboundGate.threadId === threadId &&
    inboundGate.expiresAt > Date.now()
  );
}

/* ------------------------- 消息数组同步（渲染侧） ------------------------- */

type SyncKind = "remove" | "reveal";
let syncListener: ((reg: RegisteredMessage, kind: SyncKind) => void) | null = null;

/** 监听器缺席时的信号缓冲：remove/reveal **不能静默丢**——reveal 丢 =
 *  消息永久消失（登记已在 applySnapshot/unregister 里销掉，无人再回填，
 *  转录有但 UI 没有，重启重建才恢复）。队列栏组件卸载/重挂的窗口期
 *  （线程切换、条件渲染）监听器为 null，此时信号入缓冲，注册时按序重放。 */
const pendingSyncSignals: Array<{ reg: RegisteredMessage; kind: SyncKind }> = [];

function emitSync(reg: RegisteredMessage, kind: SyncKind): void {
  if (syncListener) {
    syncListener(reg, kind);
    return;
  }
  pendingSyncSignals.push({ reg, kind });
  // 防泄漏上限：信号只在「摘除/回填后监听器长期不挂」的异常路径堆积。
  // 超限丢**最旧的 remove**（remove 重放是幂等的，丢了最坏留一个幽灵气泡，
  // 下次快照自愈）；reveal 绝不丢——它丢了就是消息永久从 UI 消失（登记早已
  // 销掉，无人回填，只能重启重建）。原实现 shift() 无差别丢最旧项，恰好
  // 会先吃掉 reveal：64 次连续 remove 之后的第一条 reveal 必丢。
  if (pendingSyncSignals.length > 64) {
    const victim = pendingSyncSignals.findIndex((s) => s.kind === "remove");
    if (victim >= 0) pendingSyncSignals.splice(victim, 1);
    // 全是 reveal（一次挂载窗口内 64+ 条在途消息，实践中不可能）：宁可不淘汰
    // 也不能吞消息。注册监听器时会全量重放，泄漏窗口有界。
  }
}

/** 注册/注销消息同步监听（PromptQueueBar 挂载时注册，随线程卸载注销）；
 *  注册时按序重放缺席期间缓冲的信号（remove 幂等：已不在数组 no-op；
 *  reveal 重复回填由 AI SDK 按 id 收敛 + dedupeMessagesById 兜底） */
export function setQueueSyncListener(
  fn: ((reg: RegisteredMessage, kind: SyncKind) => void) | null,
): void {
  syncListener = fn;
  if (fn) {
    const replay = pendingSyncSignals.splice(0);
    for (const s of replay) fn(s.reg, s.kind);
  }
}

/** 流终结（finish/error/abort/客户端停止）：该请求生命周期的收尾。
 *  - steered：宿主轮流已收尾，只清登记（徽标消失）；并入内容已随本轮回复
 *    呈现，不回填气泡（回填只会落在回复下面，与 transcript 顺序不符）
 *  - pending：sidecar 从未入队（直接拒绝，如队列已满）且已被乐观摘除 → 回填
 *  - 其余（派发项已回填销登记等）：no-op。并清除该线程的派发空窗标记。 */
export function unregisterQueuedMessage(requestId: string, threadId: string): void {
  if (pendingTurnByThread.get(threadId) === requestId) {
    pendingTurnByThread.delete(threadId);
    notify();
  }
  const reg = registry.get(requestId);
  if (!reg) return;
  if (reg.phase === "steered") {
    registry.delete(requestId);
    notify();
    return;
  }
  if (reg.phase === "pending") {
    registry.delete(requestId);
    notify();
    emitSync(reg, "reveal");
  }
}

/** 乐观摘除（pi-transport sendMessages 调用）：按「忙线程镜像」判定本请求
 *  必然入队时，不等 data-queue-state 快照往返（sidecar 回程 + ~20ms 合帧，
 *  期间乐观消息已被绘制 = 用户看到的"闪一下"）就同步摘除刚入列的消息。
 *  与 remove 信号同款幂等；摘早了（罕见竞态下 sidecar 直接开跑）由 start
 *  chunk 的 notifyQueueStreamStart 回填，被拒绝由流终结回填。 */
export function optimisticallyRemoveQueuedMessage(requestId: string): void {
  const reg = registry.get(requestId);
  if (!reg || reg.phase !== "pending") return;
  emitSync(reg, "remove");
}

/** 流 start chunk（pi-transport 调用）：该请求的 turn 真正开跑。登记若还停在
 *  pending（乐观摘除判错——sidecar 空闲竞态下直接放行，从未入过快照），此刻
 *  立即回填并销登记；真排队项此刻早已回填销登记，这里是 no-op。 */
export function notifyQueueStreamStart(requestId: string): void {
  const reg = registry.get(requestId);
  if (!reg || reg.phase !== "pending") return;
  registry.delete(requestId);
  notify();
  emitSync(reg, "reveal");
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

/** 该线程是否处于派发空窗（纯函数，供测试/非 React 场景读取） */
export function getThreadPendingTurn(threadId: string): boolean {
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
      const value = pendingTurnByThread.has(threadId);
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

/** 线程当前队列快照（纯函数；无快照返回空壳） */
export function getQueueSnapshot(threadId: string): QueueSnapshot {
  return snapshots.get(threadId) ?? emptySnapshot(threadId);
}

/** 订阅线程队列快照（无快照返回空壳，调用方免判空） */
export function useQueueSnapshot(threadId: string | undefined): QueueSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!threadId) return emptySnapshot("");
      const cached = snapshotCache.get(threadId);
      if (cached && cached.version === version) return cached.value;
      const value = snapshots.get(threadId) ?? emptySnapshot(threadId);
      snapshotCache.set(threadId, { version, value });
      return value;
    },
    () => emptySnapshot(""),
  );
}

function emptySnapshot(threadId: string): QueueSnapshot {
  return { version: 2, threadId, items: EMPTY_ITEMS, nextId: 1 };
}

const EMPTY_STEERED: SteeredQueueItem[] = [];

export type SteeredQueueItem = { reqId: string; text: string };

const steeredCache = new Map<string, { version: number; value: SteeredQueueItem[] }>();

/** 已并入当前轮、宿主轮流尚未收尾的条目（纯函数，供 hook 与测试共用） */
export function getSteeredEntries(threadId: string): SteeredQueueItem[] {
  const value: SteeredQueueItem[] = [];
  for (const [reqId, reg] of registry) {
    if (reg.threadId === threadId && reg.phase === "steered") {
      value.push({
        reqId,
        text: reg.message.parts
          .filter((p): p is Extract<UIMessage["parts"][number], { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("\n"),
      });
    }
  }
  return value;
}

/** 订阅「已并入当前回复」条目（排队条徽标区数据源，收尾后自动消失） */
export function useSteeredQueueItems(threadId: string | undefined): SteeredQueueItem[] {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!threadId) return EMPTY_STEERED;
      const cached = steeredCache.get(threadId);
      if (cached && cached.version === version) return cached.value;
      const value = getSteeredEntries(threadId);
      steeredCache.set(threadId, { version, value });
      return value;
    },
    () => EMPTY_STEERED,
  );
}

/* ------------------------------- 队列操作 ------------------------------- */

/** 弹出队首交由前端重发（接力泵「踢一脚」）。sidecar 仅在线程空闲且无链节时
 *  弹出，否则返回 null（链节仍在，泵转而在跑轮探测重挂）。popped.sessionId
 *  是该排队项归属会话的权威值（sidecar 从原帧带回）——泵重发前必须据此校正
 *  线程绑定，绝不能丢弃后用当前（可能漂移的）绑定重发。调用方重发前先
 *  dropQueuedEntry 销登记，防派发快照回填旧气泡造成双份 */
export async function popQueueHead(
  threadId: string,
  sessionId?: string,
): Promise<{ reqId: string; text: string; sessionId?: string } | null> {
  const res = await getPiChannel().request({
    type: "queue_pop",
    threadId,
    ...(sessionId ? { sessionId } : {}),
  });
  const popped =
    (res as { popped?: { reqId: string; text: string; sessionId?: string } | null }).popped ??
    null;
  if (popped) registry.delete(popped.reqId);
  return popped;
}

/** 本地销登记（接力泵弹出重发路径用）：重发走正常发送路径自建全新气泡 */
export function dropQueuedEntry(reqId: string): void {
  registry.delete(reqId);
}

/** 删除排队项（sidecar 侧流立即 abort + finish 收尾）。先销登记再发请求：
 *  随后的快照里该项消失时不得触发回填 */
export async function cancelQueueItem(reqId: string): Promise<void> {
  registry.delete(reqId);
  await getPiChannel().request({ type: "queue_cancel", requestId: reqId });
}

/** 立即发送：中止当前活跃 turn，该项提到队首马上执行 */
export async function promoteQueueItem(reqId: string): Promise<void> {
  await getPiChannel().request({ type: "queue_promote", requestId: reqId });
}

/** 并入当前轮：注入活跃轮（不中止不排队）。先置 steered 再发请求——随后的
 *  出快照不得派发回填，徽标等宿主轮流收尾；请求被拒（活跃轮恰好收尾等）
 *  则回退排队态并 notify（条目仍在快照里，排队条原样接住），防徽标滞留 */
export async function steerQueueItem(reqId: string): Promise<void> {
  const reg = registry.get(reqId);
  if (reg) reg.phase = "steered";
  try {
    await getPiChannel().request({ type: "queue_steer", requestId: reqId });
  } catch (err) {
    if (reg && reg.phase === "steered") {
      reg.phase = "queued";
      notify();
    }
    throw err;
  }
}

/**
 * 消息数组按 id 去重（保留最后一次出现，语义对齐框架 ExternalStore 的去重）。
 * 排队条 remove/reveal 与流式写入的竞态可能在数组里产生重复项（2026-09-28
 * web.log `duplicate message id` 密集告警实证）——所有经 syncListener 的写入
 * 在此统一收敛，消灭重复告警与双气泡。无重复时原数组原样返回（不触发
 * setMessages 的无谓通知）。
 */
export function dedupeMessagesById<T extends { id: unknown }>(msgs: T[]): T[] {
  const lastByKey = new Map<string, number>();
  for (let i = 0; i < msgs.length; i++) lastByKey.set(String(msgs[i].id), i);
  if (lastByKey.size === msgs.length) return msgs;
  return [...lastByKey.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([, i]) => msgs[i] as T);
}

/** 清空镜像/登记表/空窗标记（测试隔离用） */
export function resetQueueForTests(): void {
  snapshots.clear();
  registry.clear();
  pendingTurnByThread.clear();
  // 同步信号缓冲一并清：跨测试残留会在下次注册时重放，污染事件断言
  pendingSyncSignals.length = 0;
  notify();
}
