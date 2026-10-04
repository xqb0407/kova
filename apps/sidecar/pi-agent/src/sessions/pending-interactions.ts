/**
 * 挂起交互台账（设计文档 §4）：逐工具审批（modes）、MCP 网关审批（mcp-tools）、
 * Question 追问（question-tools）三类挂起源统一登记 + 转录行落盘。
 *
 * 分工：各发起点继续自持 resolve promise（挂起/唤醒机制不动），台账只做四件事——
 * 1. 发起即落 `pending_interaction` 行、结算/取消落 `interaction_resolved` 行
 *    （行事件溯源照抄 queue_state：不占 seq 号段，读端未知行跳过 = 向前兼容）；
 * 2. 权威清单 listPendingForSession：list_pending 回拉与 get_history 回放读转录行，
 *    台账条目供内存视图；重启后 resolveSession 物化时用 restoreUnsettled 重放行，
 *    挂起卡跨刷新/重启不丢（前端点陈旧卡 → 结算落行并解禁，活 promise 已随进程消亡）；
 * 3. 驱逐保护谓词 hasPendingInteractions：行支撑跨重启成立，取代
 *    run.pendingToolApprovals.size 的内存判定（§2）；
 * 4. threadId→sessionId 解析：审批/提问发起点大多只握 threadId，会话归属由
 *    驻留登记（registry trackSessionRun）与物化路径回填；
 * 5. 结算广播：settle 时在活跃 prompt 流上补发 data-interactionResolved chunk——
 *    发起的 data-question/data-toolApproval chunk 行会进 Rust 重放缓冲，"已结算"
 *    若只是命令应答与转录行，刷新重放会把已答卡原样复活（pi_attach 整轮重放
 *    chunk，get_history/list_pending 的配对相减拦不住直播路）。resolved 帧入
 *    同一条缓冲，重放序列 begin→resolved 收敛为空；无活跃请求时静默丢（行是
 *    事实源，卡片视图随 run 共存亡）。
 *
 * 降级：thread 尚无会话绑定（理论上仅出现在会话落库前发起的 MCP 审批）时不落行、
 * 卡片只走直播流——不阻塞发起本身。
 */
import { appendFileSync } from "node:fs";
import { sessionPath } from "../storage/storage";
import { logErr } from "../log";
import { sendEventChunk } from "../protocol/stream";
import type { InteractionResolution, PendingInteraction } from "pi-protocol";

type LedgerEntry = { sessionId: string; threadId: string; interaction: PendingInteraction };

/** interactionId -> 未结算条目（发起/重放写入，结算/删除清理） */
const byId = new Map<string, LedgerEntry>();
/** threadId -> sessionId（trackSessionRun 与 resolveSession 物化回填；delete_session 清理） */
const threadSessions = new Map<string, string>();

/** 会话绑定回填（幂等；同一 thread 换绑以最新为准——rebind 路径会话 id 不变） */
export function rememberThreadSession(threadId: string, sessionId: string): void {
  threadSessions.set(threadId, sessionId);
}

export function sessionForThread(threadId: string): string | undefined {
  return threadSessions.get(threadId);
}

function appendRow(sessionId: string, row: Record<string, unknown>): void {
  try {
    appendFileSync(sessionPath(sessionId), JSON.stringify(row) + "\n");
  } catch (err) {
    // 落行失败不吞挂起本身：卡片照常直播、结算照常唤醒，只丢跨重启恢复能力
    logErr("pending-interaction row append failed:", err);
  }
}

/**
 * 登记一条挂起交互并落 pending_interaction 行（发起点在推 chunk 前后调用均可，
 * 推荐推 chunk 前——行先于卡存在，崩溃窗口偏向可恢复一侧）。
 * 同 id 重复发起按最新条目覆盖（toolCallId/approvalId 天然唯一，属防御）。
 */
export function beginInteraction(threadId: string, interaction: PendingInteraction): void {
  const sessionId = threadSessions.get(threadId);
  if (!sessionId) return;
  byId.set(interaction.interactionId, { sessionId, threadId, interaction });
  appendRow(sessionId, {
    type: "pending_interaction",
    ts: new Date().toISOString(),
    interaction,
  });
}

/**
 * 结算并落 interaction_resolved 行；返回台账是否命中。
 * 双路复用：发起点的 resolve/cancel 函数在删自己 promise 表项时调用（live），
 * tool_confirm/question_answer 命令对重启后重放的陈旧条目也走此出口（stale，
 * 只落行解禁，无 promise 可唤醒）。
 */
export function settleInteraction(
  interactionId: string,
  resolution: InteractionResolution,
): boolean {
  const entry = byId.get(interactionId);
  if (!entry) return false;
  byId.delete(interactionId);
  appendRow(entry.sessionId, {
    type: "interaction_resolved",
    ts: new Date().toISOString(),
    interactionId,
    resolution,
    resolvedAt: new Date().toISOString(),
  });
  // 结算广播（头注第⑤条）：行在前 chunk 在后；无活跃请求静默丢不影响行事实源
  sendEventChunk(entry.threadId, {
    type: "data-interactionResolved",
    data: { interactionId, resolution },
  }, entry.sessionId);
  return true;
}

/** 会话的未结算交互清单（list_pending 应答 / isEvictable 判定共用） */
export function listPendingForSession(sessionId: string): PendingInteraction[] {
  return [...byId.values()]
    .filter((e) => e.sessionId === sessionId)
    .map((e) => e.interaction);
}

export const hasPendingInteractions = (sessionId: string): boolean =>
  [...byId.values()].some((e) => e.sessionId === sessionId);

/**
 * 物化重放：resolveSession 从转录行恢复未结算项为台账条目（陈旧、无 promise）。
 * 已在台账的 id 跳过——重启前就驻留的活条目是更新的事实。
 */
export function restoreUnsettled(
  sessionId: string,
  threadId: string,
  interactions: PendingInteraction[],
): void {
  rememberThreadSession(threadId, sessionId);
  for (const interaction of interactions) {
    if (byId.has(interaction.interactionId)) continue;
    byId.set(interaction.interactionId, { sessionId, threadId, interaction });
  }
}

/** 会话删除：清台账条目与线程绑定（行随转录文件一起消失） */
export function dropSessionInteractions(sessionId: string): void {
  for (const [id, entry] of [...byId]) {
    if (entry.sessionId === sessionId) byId.delete(id);
  }
  for (const [threadId, sid] of [...threadSessions]) {
    if (sid === sessionId) threadSessions.delete(threadId);
  }
}

/** 测试钩子：台账规模与内容快照 */
export const ledgerSnapshotForTest = (): PendingInteraction[] =>
  [...byId.values()].map((e) => e.interaction);
