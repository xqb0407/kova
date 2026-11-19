/**
 * 审批/提问结算的领域函数：协议 handler 与 Inbox action 共用同一实现，
 * 避免「从收件箱批准」和「从会话卡片批准」走两条会漂移的逻辑。
 */
import { resolveSession } from "../sessions/sessions";
import { resolveToolApproval } from "../agent/modes";
import { resolveMcpApproval, type McpRememberScope } from "../mcp/mcp-tools";
import {
  cancelMcpElicitation,
  resolveMcpElicitation,
} from "../mcp/elicitation";
import {
  cancelQuestionAnswer,
  resolveQuestionAnswer,
  type QuestionAnswerItem,
} from "../tools/question-tools";
import { settleInteraction } from "../sessions/pending-interactions";

export type ToolConfirmInput = {
  threadId: string;
  sessionId?: string;
  approvalId: string;
  approved: boolean;
  remember?: boolean;
  /** MCP 审批的「记住」作用域；非 MCP 审批忽略（维持 project 语义） */
  rememberScope?: McpRememberScope;
  reason?: string;
};

/** 线格式里的记住作用域：只认三个白名单值，其余当未传（回落 project） */
export function parseRememberScope(value: unknown): McpRememberScope | undefined {
  return value === "session" || value === "project" || value === "user" ? value : undefined;
}

/** 逐工具审批结算；陈旧条目走 settleInteraction 只落行解禁（同 interactive.ts 旧路径） */
export async function applyToolConfirm(input: ToolConfirmInput): Promise<void> {
  const approvalId = input.approvalId;
  const approved = input.approved;
  const remember = input.remember === true;
  const reason =
    typeof input.reason === "string" ? input.reason.trim().slice(0, 4000) : "";
  if (resolveMcpApproval(approvalId, approved, remember, input.rememberScope)) return;
  const run = await resolveSession(input.threadId, input.sessionId);
  if (!resolveToolApproval(run, approvalId, approved, remember, reason)) {
    if (!settleInteraction(approvalId, approved ? "approved" : "denied")) {
      throw new Error(`no pending tool approval: ${approvalId}`);
    }
  }
}

export type QuestionAnswerInput = {
  questionId: string;
  cancelled?: boolean;
  answers?: QuestionAnswerItem[];
};

/** Question 作答/取消；返回是否命中活 promise（陈旧条目由 settleInteraction 兜底） */
export function applyQuestionAnswer(input: QuestionAnswerInput): void {
  // MCP elicitation 与普通 Question 共用 question_answer 线格式；先按
  // pending 表判定归属，避免把 MCP 的 selectedIds 当成普通 Question 文案。
  const mcpSettled = input.cancelled
    ? cancelMcpElicitation(input.questionId)
    : resolveMcpElicitation(input.questionId, input.answers ?? []);
  if (mcpSettled) return;
  const settled = input.cancelled
    ? cancelQuestionAnswer(input.questionId)
    : resolveQuestionAnswer(input.questionId, input.answers ?? []);
  if (!settled && !settleInteraction(input.questionId, input.cancelled ? "cancelled" : "answered")) {
    throw new Error(`no pending question: ${input.questionId}`);
  }
}
