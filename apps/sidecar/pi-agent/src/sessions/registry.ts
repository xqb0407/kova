/**
 * 会话注册表：threadId -> Agent 实例的内存映射、sessionId 反查索引、
 * 活跃 turn 追踪与驻留治理（LRU 驱逐）。会话解析与装配见 resolve.ts。
 */
import { logErr } from "../log";
import { send, isPromptActive } from "../protocol/stream";
import { seedEventSeq, withEventSeq } from "../protocol/event-seq";
import type { SessionPhase } from "pi-protocol";
import { isTurnBusy } from "./prompt-queue";
import {
  hasPendingInteractions,
  rememberThreadSession,
} from "./pending-interactions";
import { clearTodoState } from "../todo/todo";
import { clearGoal } from "../goal/goal";
import { clearLoadedSkills } from "../secrets/secrets";
import type { Running } from "../types";

/**
 * 派生相位广播（设计文档 §2）：session_state 自发帧带 eventSeq（§3 水印），
 * 前端缺口回拉 list_running 重水合。turn_changed 旧帧并行保留一个版本周期。
 * phase 是投影不是引擎：只由驻留表 + activeTurns 现算，不新增真相源。
 */
function sendSessionState(sessionId: string, phase: SessionPhase): void {
  send(withEventSeq(sessionId, { type: "session_state", sessionId, phase }));
}

/** threadId -> 活动会话（每个前端线程一个 Agent 实例） */
export const running = new Map<string, Running>();

/**
 * sessionId -> threadId 反查索引。
 * run 的驻留键是"发起 prompt 时的前端 thread id"：新草稿首条消息发出后，
 * 刷新使草稿 id 重随机、列表行以 sessionId 为 id——此时 tool_confirm /
 * abort 等后续请求带的都是新 id，只按 threadId 查 running 必然 miss。
 * 没有这个索引，resolveSession 会把同一会话从磁盘再物化出**第二个** Agent
 * （审批结算落到空表抛 no pending tool approval，原 run 的审批 Promise
 * 永久悬挂；双实例还会共写同一份转录）。
 */
const runningBySession = new Map<string, string>();

/**
 * 登记/覆盖会话的反查键（resolveSession 物化 run 后调用）。
 * seedFromTranscriptSeq：转录最大 seq，播种本会话事件水印（§3，幂等）；
 * 同时广播派生相位：有在跑轮次 = running，否则 idle（新物化/重绑都过这里）。
 */
export function trackSessionRun(
  sessionId: string,
  threadId: string,
  seedFromTranscriptSeq?: number,
): void {
  runningBySession.set(sessionId, threadId);
  if (seedFromTranscriptSeq !== undefined) seedEventSeq(sessionId, seedFromTranscriptSeq);
  // 交互台账的线程→会话解析（§4）：物化与改绑都经此，发起点只握 threadId
  rememberThreadSession(threadId, sessionId);
  sendSessionState(sessionId, activeTurns.has(threadId) ? "running" : "idle");
}

/** 按 sessionId 找驻留 run；索引指向已消失的键时自愈清除 */
export function findRunBySession(
  sessionId: string,
): { threadId: string; run: Running } | undefined {
  const tid = runningBySession.get(sessionId);
  if (!tid) return undefined;
  const run = running.get(tid);
  if (!run) {
    runningBySession.delete(sessionId);
    return undefined;
  }
  return { threadId: tid, run };
}

/** 从驻留表移除线程，并同步清掉指向它的反查索引 */
export function dropRun(threadId: string): void {
  const run = running.get(threadId);
  running.delete(threadId);
  if (run && runningBySession.get(run.sessionId) === threadId) {
    runningBySession.delete(run.sessionId);
  }
}

/* ----------------------- 会话驻留治理（迭代2 / P2） -----------------------
 * running 不再是"只进不出"：超过上限驱逐最久未访问的会话，被驱逐会话在
 * 前端重新打开时走本文件 resolveSession 的既有恢复路径（JSONL 是事实源，
 * 行为与重启续聊完全一致）。context_info 对未加载会话改走只读投影，
 * 不再为了看一眼面板而物化 Agent。
 */

/** 常驻 Agent 实例上限（个）。软上限：活跃/有跨轮用户意图的会话不可驱逐，
 *  全被跳过时宁可暂超也不踢掉干活中的会话。 */
export const MAX_RESIDENT_SESSIONS = 8;

/** 正在跑 prompt turn 的线程 -> { 会话 id, 本轮 requestId }（sessionId 可为
 *  undefined：发起方未带 sessionId 且会话尚未 resolve；此类轮次不广播、不出现在
 *  list_running，本地前端不受影响——transport 每条 prompt 都携带 sessionId）。
 *  protocol.ts dispatchPrompt 起止处通报；跑着 prompt 的会话永不驱逐
 *  （线程串行链，多线程可并行多个）。
 *  起止同时广播 turn_changed 通知行（无 id，宿主原样转发给所有前端）：
 *  侧边栏"会话运行中"指示的实时信号；页面刷新后的水合走 list_running。
 *  requestId 供 list_running 的 turns 字段回给前端：webview 存储被清时前端
 *  按运行态真相重建在飞流登记（刷新续流不依赖 sessionStorage 存活）。 */
interface ActiveTurn {
  sessionId?: string;
  requestId?: string;
}
const activeTurns = new Map<string, ActiveTurn>();

/** whenThreadIdle 的等待者：threadId -> 唤醒回调（noteActiveTurn(false) 时结算） */
const idleWaiters = new Map<string, Array<() => void>>();

export function noteActiveTurn(
  threadId: string,
  active: boolean,
  sessionId?: string,
  requestId?: string,
): void {
  if (active) {
    const sid = sessionId ?? running.get(threadId)?.sessionId;
    activeTurns.set(threadId, { sessionId: sid, requestId });
    if (sid) {
      send({ type: "turn_changed", sessionId: sid, active: true });
      sendSessionState(sid, "running");
    }
  } else {
    const sid = activeTurns.get(threadId)?.sessionId;
    activeTurns.delete(threadId);
    if (sid) {
      send({ type: "turn_changed", sessionId: sid, active: false });
      sendSessionState(sid, "idle");
    }
    const waiters = idleWaiters.get(threadId);
    if (waiters) {
      idleWaiters.delete(threadId);
      for (const wake of waiters) wake();
    }
  }
}

/** 该线程当前轮次彻底收尾（dispatchPrompt finally 走过 noteActiveTurn(false)）
 *  时 resolve；已空闲立即 resolve。刷新改绑要等旧键轮次跑完才动 run.threadId，
 *  见 protocol.runPromptTurn。busyThreads 一并判：markTurnStart 早于
 *  noteActiveTurn(true) 的间隙里 activeTurns 还没有条目，只看它会放改绑插进
 *  两节链之间把执行顺序倒过去；唤醒只挂在 noteActiveTurn(false) 上，而
 *  dispatchPrompt 的 finally 保证 markTurnStart 之后必然走到它（早退的链节
 *  也会 noteActiveTurn(false) 空转一次），等待者不会睡死。 */
export function whenThreadIdle(threadId: string): Promise<void> {
  if (!activeTurns.has(threadId) && !isTurnBusy(threadId)) return Promise.resolve();
  return new Promise((resolve) => {
    const list = idleWaiters.get(threadId);
    if (list) list.push(resolve);
    else idleWaiters.set(threadId, [resolve]);
  });
}

/** 当前正在跑 turn 的会话 id 清单（list_running 应答） */
export function listActiveTurnSessions(): string[] {
  return [...activeTurns.values()]
    .map((t) => t.sessionId)
    .filter((s): s is string => !!s);
}

/** 会话与请求 id 齐备的在跑轮次明细（list_running 应答 turns 字段） */
export function listActiveTurnDetails(): { sessionId: string; requestId: string }[] {
  return [...activeTurns.values()].flatMap((t) =>
    t.sessionId && t.requestId ? [{ sessionId: t.sessionId, requestId: t.requestId }] : [],
  );
}

/** 可驱逐判定：进行中的工作与跨轮的审批意图都要跳过。
 *  挂起交互改台账行支撑判定（§2/§4，取代 run.pendingToolApprovals 内存 size）：
 *  覆盖逐工具/MCP/Question 三类来源，且重启物化重放（restoreUnsettled）后仍成立。
 *  planning 仍是内存态、恢复路径不带回（resolveSession 恒以初始态重建），
 *  驻留期间被驱逐等于静默丢失，照旧拦截。 */
function isEvictable(threadId: string, run: Running): boolean {
  if (activeTurns.has(threadId)) return false;
  for (const d of run.delegations.values()) if (d.status === "running") return false;
  if (hasPendingInteractions(run.sessionId)) return false;
  if (run.planning !== "inactive") return false;
  return true;
}

/** 访问即续龄（resolveSession 命中与 context_info live 路径共用） */
export function touchSession(threadId: string): void {
  const run = running.get(threadId);
  if (run) run.lastSeenAt = Date.now();
}

/** 驱逐/删除的旁路状态清理：todo 可由转录事件溯源回放重建（下次 resolve
 *  时 replayTodoFromMessages），目标同款（restoreGoal 读 goal_state 行）；
 *  驻留期清掉防止 per-thread Map 泄漏；
 *  approval 挂在 run 上、question 挂在轮内——两者所在会话不可驱逐，无残留。 */
export function forgetThreadStates(threadId: string): void {
  clearTodoState(threadId);
  clearGoal(threadId);
  // 已加载技能台账同理：密钥注入的判定条件按线程累积，线程走了就清
  clearLoadedSkills(threadId);
}

/** 超上限即从最久未访问处驱逐（justLoaded 线程豁免：它代表用户当前意图）。
 *  在 resolveSession 末尾调用，Agent 实例随 run 引用消失由 GC 回收。 */
export function enforceResidency(justLoaded: string): void {
  let excess = running.size - MAX_RESIDENT_SESSIONS;
  if (excess <= 0) return;
  const doomed = [...running.entries()]
    .filter(([tid, run]) => tid !== justLoaded && isEvictable(tid, run))
    .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
  for (const [tid, run] of doomed) {
    if (excess <= 0) break;
    dropRun(tid);
    forgetThreadStates(tid);
    sendSessionState(run.sessionId, "evicted");
    logErr("session-evict:", `${tid} -> ${run.sessionId}`);
    excess -= 1;
  }
}

/** 线程静默判定：无在跑轮次（activeTurns/busyThreads）且无活跃请求路由
 *  （activeReqByThread）——三个 busy 窗口都覆盖才算静默，可安全改绑键。 */
export function threadQuiescent(threadId: string): boolean {
  return !activeTurns.has(threadId) && !isTurnBusy(threadId) && !isPromptActive(threadId);
}
