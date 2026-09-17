/**
 * 本地文件（非 vendored）：无人值守审批档位注册表。
 *
 * 自动化 turn 的 threadId 由 runner 专用生成（`automation:<taskId>:<entryId>`，
 * 每次运行全新），runner 在 dispatchPrompt 前登记、turn 结束后注销。
 * 审批挂起点（modes.ts 逐工具审批、question 工具、MCP 审批、plan 模式入口）
 * 按 run.threadId / threadId 反查这张表：命中即走"永不挂起"的自动裁决，
 * 未命中保持现有交互式行为。
 *
 * 为什么不放 Running 字段：档位是"本次 turn"的属性而非"会话"的属性
 * （同一 automation 线程键理论上可被复用），且 threadId 表让 mcp-tools /
 * question-tools 零依赖接入（它们只有 threadId，拿不到 run）。
 *
 * 档位语义（键名沿用 vendored task.toolPolicyProfile）：
 *   read-only       需审批的副作用工具（bash/write/edit/子代理与技能管理）一律拒绝
 *   workspace-write write/edit 放行；bash 与 MCP（任意执行/外部副作用）拒绝
 *   full            全部放行（MCP 亦需显式选 full 才无人值守放行）
 */
export type AutomationToolPolicy = "read-only" | "workspace-write" | "full";

const PROFILES: readonly AutomationToolPolicy[] = [
  "read-only",
  "workspace-write",
  "full",
];

/** vendored 存储层 toolPolicyProfile 为开放 string：归一化，未知值回落最严档 */
export function normalizeToolPolicyProfile(raw: unknown): AutomationToolPolicy {
  return (PROFILES as readonly string[]).includes(String(raw))
    ? (String(raw) as AutomationToolPolicy)
    : "read-only";
}

const profiles = new Map<string, AutomationToolPolicy>();

export function registerAutomationThread(
  threadId: string,
  profile: AutomationToolPolicy,
): void {
  profiles.set(threadId, profile);
}

export function unregisterAutomationThread(threadId: string): void {
  profiles.delete(threadId);
}

/** 该线程当前是否处于无人值守自动化 turn（是则返回审批档位） */
export function getAutomationPolicy(threadId: string): AutomationToolPolicy | undefined {
  return profiles.get(threadId);
}

/** 拒绝挂起时给模型看的统一理由（含档位，提示模型改走只读路径收尾） */
export function automationDenyReason(
  profile: AutomationToolPolicy,
  toolName: string,
): string {
  return (
    `Unattended automation run with tool policy "${profile}": ` +
    `"${toolName}" requires approval and was auto-denied (nobody is online to approve). ` +
    "Do not retry this tool; finish the task with allowed read-only operations, " +
    "state your assumption, and note what could not be done."
  );
}
