"use client";

/**
 * 线程 id 身份判定与绑定认领（piEnsureThreadSession 的「先认领再新建」阶梯）。
 *
 * 背景：threadId→sessionId 绑定（piSessionRegistry）只存前端内存，页面重载即空。
 * 恢复/列表线程的 id 就是 remoteId（= pi sessionId），重载后任何 ensure 调用若把
 * 「registry 未命中」当成「新草稿」去 new_session，会把用户正所在的会话劫持成
 * 全新空会话——后续消息落进空会话、AI 拿不到上下文、任务工作区目录也跟着换成
 * 空目录（2026-09-28 会话丢失事故：f79cd11c/7d55212d 即此产物）。
 *
 * id 形状判据（@assistant-ui/core remote-thread-state）：
 * - 新草稿恒为 "__LOCALID_<random>"（LOCAL_THREAD_ID_PREFIX）；
 * - 其余线程的 mapping id = remoteId = pi sessionId（randomUUID）。
 */
import { piResumableStorage } from "./pi-resume-storage";

const LOCAL_THREAD_ID_PREFIX = "__LOCALID_";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 新草稿线程（id 由运行时随机生成，重载后不复用） */
export function isLocalDraftThreadId(threadId: string): boolean {
  return threadId.startsWith(LOCAL_THREAD_ID_PREFIX);
}

/** 认领依赖注入（单测替换在飞登记源；生产用 piResumableStorage 单例） */
export type ClaimDeps = {
  peekEntries(): { ownerChatId: string; sessionId?: string }[];
};

/**
 * 从已知事实认领该线程的 sessionId；认领不到返回 null（调用方才允许 new_session）。
 * 阶梯：
 * 1. threadId 非 __LOCALID_ 且是 UUID 形状 = 恢复/列表线程，id 即 sessionId——
 *    不依赖 list_sessions 水合进度（正是水合竞态窗口里最容易发生劫持）；
 * 2. 在飞流登记（sessionStorage + localStorage 镜像，重载存活）按 ownerChatId /
 *    sessionId 命中的条目。
 * 刻意不认领「最近会话指针」：__LOCALID_ 草稿发送时指针已被写通清空，若认领
 * 会把用户明确新开的对话绑回旧会话（2026-09-22 反向 bug）。
 * 认领了一个实际不存在的 UUID（如会话刚被删）：后续 prompt 会被 sidecar 以
 * session not found 拒绝——可见错误优于静默劫持。
 */
export function claimKnownSession(
  threadId: string,
  deps: ClaimDeps = piResumableStorage,
): string | null {
  if (!isLocalDraftThreadId(threadId) && UUID_RE.test(threadId)) return threadId;
  const entry = deps
    .peekEntries()
    .find((e) => e.ownerChatId === threadId || e.sessionId === threadId);
  return entry?.sessionId ?? null;
}
