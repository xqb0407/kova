/**
 * 审批/提问结算的领域函数：协议 handler 与 Inbox action 共用同一实现，
 * 避免「从收件箱批准」和「从会话卡片批准」走两条会漂移的逻辑。
 */
import { resolveSession } from "../sessions/sessions";
import { resolveToolApproval } from "../agent/modes";
import { resolveMcpApproval } from "../mcp/mcp-tools";
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
  reason?: string;
};

/** 逐工具审批结算；陈旧条目走 settleInteraction 只落行解禁（同 interactive.ts 旧路径） */
export async function applyToolConfirm(input: ToolConfirmInput): Promise<void> {
  const approvalId = input.approvalId;
  const approved = input.approved;
  const remember = input.remember === true;
  const reason =
    typeof input.reason === "string" ? input.reason.trim().slice(0, 4000) : "";
  if (resolveMcpApproval(approvalId, approved, remember)) return;
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
  const settled = input.cancelled
    ? cancelQuestionAnswer(input.questionId)
    : resolveQuestionAnswer(input.questionId, input.answers ?? []);
  if (!settled && !settleInteraction(input.questionId, input.cancelled ? "cancelled" : "answered")) {
    throw new Error(`no pending question: ${input.questionId}`);
  }
}
