/**
 * 会话管理门面：threadId -> Agent 实例的内存映射与会话解析。
 * sessionId 提供时优先恢复该会话（重启续聊）；否则懒建新会话（索引行 + JSONL header）。
 *
 * 物理布局（本文件为门面，签名与原单文件完全一致）：
 * - ./sessions/registry.ts  会话注册表（running/反查索引）+ 活跃 turn 追踪 + 驻留治理
 * - ./sessions/resolve.ts   resolveSession 装配 + 重建 helpers + 只读投影
 */
export {
  running,
  MAX_RESIDENT_SESSIONS,
  trackSessionRun,
  findRunBySession,
  dropRun,
  noteActiveTurn,
  whenThreadIdle,
  listActiveTurnSessions,
  listActiveTurnDetails,
  touchSession,
  forgetThreadStates,
  threadQuiescent,
} from "./registry";

export {
  rebindRunThread,
  isModelUnavailable,
  reloadSubagents,
  reloadMemoryTools,
  reloadSkills,
  resolveSession,
  setSessionCwd,
  projectContextInfo,
  removeTaskSessionDir,
  ensureTaskSessionDir,
} from "./resolve";
