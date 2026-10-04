"use client";

import { piRequest, type PiSessionSummary } from "@/lib/pi/pi-bridge";
import { isLocalDraftThreadId } from "@/lib/pi/pi-thread-identity";

/**
 * 会话镜像（react-pi 新链路共用）：list_sessions 快照的前端内存落点。
 * 旧 AI SDK 链路的线程适配器（createPiThreadListAdapter / withFormat 历史
 * 装载 / piEnsureThreadSession）已随迁移阶段 5 删除——线程身份 = pi
 * sessionId，piSessionRegistry 由 pi-runtime 的 usePiRuntime 维护。
 */

/** local thread id -> pi sessionId（remoteId）。新链路 usePiRuntime 维护 */
export const piSessionRegistry = new Map<string, string>();

/** remoteId(pi session 文件路径) -> cwd。会话列表按 workspace 分组用 */
export const piSessionCwdMap = new Map<string, string>();

/** sessionId -> 最近一次列表快照（含会话级偏好 mode/approvalLevel/model）。
 *  mode/model picker 切回会话时据此水合，不依赖 sidecar 内存里的 Running 实例存活 */
export const piSessionPrefsMap = new Map<string, PiSessionSummary>();

/** 会话摘要镜像的变更订阅：分页列表下打开深页会话时，补到的偏好行异步到达，
 *  消费侧据此重跑水合（mode/model/thinking/appMode/cwd 的读取方都靠这张表） */
const prefsListeners = new Set<() => void>();

export function subscribeSessionPrefs(listener: () => void): () => void {
  prefsListeners.add(listener);
  return () => {
    prefsListeners.delete(listener);
  };
}

function notifySessionPrefs(): void {
  for (const listener of prefsListeners) listener();
}

/** 把 list_sessions 的快照落进内存映射（cwd 分组 + 偏好水合共用） */
export function applySessionSummaries(sessions: PiSessionSummary[]): void {
  for (const s of sessions) {
    // 空 cwd（set_session_cwd 解绑）必须删旧镜像条目：只 set 不 delete 的话，
    // WorkspaceThreadSync 会拿着镜像里的旧目录在切回会话时写回胶囊（幽灵写回）
    if (s.cwd) piSessionCwdMap.set(s.sessionId, s.cwd);
    else piSessionCwdMap.delete(s.sessionId);
    piSessionPrefsMap.set(s.sessionId, s);
  }
  notifySessionPrefs();
}

/** 在途去重：同一会话的补拉只发一次 */
const pendingSummaryFetches = new Set<string>();

/** §6 会话列表分页后镜像只含已加载页：切到某会话时若镜像缺它，按需补拉单条
 *  摘要（mode/model/thinking/appMode/cwd 的水合不能依赖该会话在已加载页里）。
 *  到达后经 subscribeSessionPrefs 通知重水合；失败静默——列表翻页与下次刷新
 *  仍会把该行带回来，用户看到的顶多是这一拍用默认值。 */
export function ensureSessionSummary(sessionId: string | undefined): void {
  if (!sessionId || piSessionPrefsMap.has(sessionId) || pendingSummaryFetches.has(sessionId)) {
    return;
  }
  pendingSummaryFetches.add(sessionId);
  void piRequest<{ type: "session_summary"; summary?: PiSessionSummary }>({
    type: "session_summary",
    sessionId,
  })
    .then((res) => {
      if (res.summary) applySessionSummaries([res.summary]);
    })
    .catch(() => {})
    .finally(() => {
      pendingSummaryFetches.delete(sessionId);
    });
}

/** 重新拉一份会话列表快照（轻量单条 SQL）：set_model / set_mode 后校准偏好镜像 */
export async function refreshSessionPrefs(): Promise<void> {
  try {
    const res = await piRequest<{ type: "sessions"; sessions: PiSessionSummary[] }>({
      type: "list_sessions",
    });
    applySessionSummaries(res.sessions);
  } catch {
    // sidecar 不可用：保留现状
  }
}

/** threadId 对应的偏好查找键：registry 命中用映射值；否则 threadId 本身
 *  可能就是 sessionId（刷新后恢复的线程行 id=sessionId） */
export function prefsSessionIdFor(threadId: string): string | undefined {
  return piSessionRegistry.get(threadId) ?? (piSessionPrefsMap.has(threadId) ? threadId : undefined);
}

/**
 * 请求应携带的 sidecar sessionId。registry 命中优先（本会话内创建的
 * 线程都靠它）；未命中时分两种：
 * - 框架本地草稿（__LOCALID_ 前缀）且未发送 → 尚无会话，返回 undefined。
 *   调用方必须跳过请求：threadId-only 地发给 resolveSession 会懒建空白会话，
 *   污染 running 键——真实会话的键一旦被空白 run 占住，后续 prompt 全落空会话
 *   （转录在盘但对话失忆，2026-10-01 迁移核对确认的危险链）；
 * - 其余 id 本身就是 sessionId（react-pi 新链路刷新后的行 id = pi sessionId），
 *   直接返回。
 */
export function piSessionIdForThread(threadId: string): string | undefined {
  return piSessionRegistry.get(threadId) ?? (isLocalDraftThreadId(threadId) ? undefined : threadId);
}

/**
 * per-thread 快照 store（pi-todo / pi-session-mode / pi-ask-needs-work 等）的键归一。
 *
 * 这些 store 的事实源是 prompt 流的 data-* chunk，而 chunk 行只带 sessionId
 * （pi-client-base 按 `parsed.sessionId` 写入）；渲染侧的 mainThreadId 对本会话
 * 新建的线程却恒为 `__LOCALID_` 草稿 id（只有刷新恢复的线程才两者同值）。不归一
 * 就会双键分裂：chunk 写会话键、UI 读草稿键，新建会话里这些状态永远不更新。
 *
 * 归一规则：能换出 sessionId 就用它；未发送草稿回落草稿 id——草稿期只有本地态
 * （set_mode 草稿分支、todo 水合早退），此时 sessionId 尚不存在，草稿 id 就是唯一
 * 可用的键；绑定后由 store 各自把草稿键上的本地快照搬到会话键（惰性 rekey）。
 */
export function piStoreKeyForThread(threadId: string): string {
  return piSessionIdForThread(threadId) ?? threadId;
}

/**
 * 分支对话：sidecar 把源会话转录复制成一个全新 pi 会话（新 sessionId、
 * 标题加「（分支）」后缀），返回新 remoteId；调用方随后
 * threads.reload() + switchToThread(newRemoteId) 打开分支。
 * cwd 映射本地先登记，让列表刷新前分组归属就已正确。
 * opts.upToSeq：位置分叉（消息气泡「分叉会话」入口）——只复制该转录 seq
 * 及之前的行（同回合收尾行由 sidecar 延展带上），下方的轮次不进新会话；
 * 缺省复制整个会话（会话列表的「分支对话」）。
 */
export async function forkPiSession(
  remoteId: string,
  opts?: { upToSeq?: number },
): Promise<string> {
  const res = await piRequest<{ type: "forked"; sessionId: string }>({
    type: "fork_session",
    sessionId: remoteId,
    ...(opts?.upToSeq !== undefined ? { upToSeq: opts.upToSeq } : {}),
  });
  const cwd = piSessionCwdMap.get(remoteId);
  if (cwd) piSessionCwdMap.set(res.sessionId, cwd);
  return res.sessionId;
}
