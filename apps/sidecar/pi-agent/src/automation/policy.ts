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
 * 档位语义（键名沿用 vendored task.toolPolicyProfile）——与交互式档位同名同义，
 * 差别只在"要问的"变成"即时拒绝"（没人在场答卡）：
 *   read-only       需审批的副作用工具（bash/write/edit/配置类）一律拒绝
 *   workspace-write write/edit 仅在工作区内或本机可写根清单内放行；bash 与 MCP
 *                   （任意执行/外部副作用）拒绝
 *   full            全部放行（MCP 亦需显式选 full 才无人值守放行）
 *
 * 各档都**不会**推翻用户显式记过的授权：allowCommands（命令词前缀）与
 * allowMcpTools（工具全名）是常驻授权，判在自动化档位之前。理由：无人值守要解决的
 * 是"没人应答挂起"，不是"把用户已授权的东西再收回去"——收回去只会让同一个
 * allow-list 在两条路径上语义相反。
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
  /** 补充说明（如"写目标在工作区与可写根清单之外"）：给模型能自我纠正的线索 */
  detail?: string,
): string {
  return (
    `Unattended automation run with tool policy "${profile}": ` +
    `"${toolName}" requires approval and was auto-denied (nobody is online to approve). ` +
    (detail ? `${detail} ` : "") +
    "Do not retry this tool; finish the task with allowed read-only operations, " +
    "state your assumption, and note what could not be done."
  );
}
