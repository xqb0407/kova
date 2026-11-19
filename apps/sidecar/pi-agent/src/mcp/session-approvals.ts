/**
 * 会话级 MCP 免审批清单（内存）。
 *
 * 用户在审批卡上选「本会话记住」后，本线程再调同一工具不再询问；进程重启即
 * 失效——这是「本会话」的字面语义，不落盘、不跨线程。独立成模块是为了让
 * sessions/registry 能清理它，而不把 mcp-tools 反向依赖进会话注册表。
 */

const byThread = new Map<string, Set<string>>();

export function approveMcpToolForSession(threadId: string, fullName: string): void {
  const set = byThread.get(threadId) ?? new Set<string>();
  set.add(fullName);
  byThread.set(threadId, set);
}

export function isSessionApprovedMcpTool(threadId: string, fullName: string): boolean {
  return byThread.get(threadId)?.has(fullName) === true;
}

/** 线程驱逐/删除时清理（registry.forgetThreadStates 调用），防 per-thread Map 泄漏 */
export function forgetSessionMcpApprovals(threadId: string): void {
  byThread.delete(threadId);
}

/** 刷新后 threadId 改绑（draft id → sessionId）：本会话授权跟着走，不因 UI 刷新失效 */
export function migrateSessionMcpApprovals(oldThreadId: string, newThreadId: string): void {
  if (oldThreadId === newThreadId) return;
  const source = byThread.get(oldThreadId);
  if (!source) return;
  byThread.delete(oldThreadId);
  const target = byThread.get(newThreadId) ?? new Set<string>();
  for (const fullName of source) target.add(fullName);
  byThread.set(newThreadId, target);
}

/** 测试钩子 */
export function resetSessionMcpApprovalsForTest(): void {
  byThread.clear();
}
