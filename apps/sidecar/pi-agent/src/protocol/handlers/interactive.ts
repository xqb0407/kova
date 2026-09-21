/**
 * 交互命令：逐工具审批结算（含 MCP 网关审批与 plan_exit 确认）、Question 工具
 * 应答、会话模式切换与 planning 快照。审批/提问的发起在 prompt 流内
 * （data-toolApproval / data-question chunk），这里是结算侧。
 */
import { send } from "../stream";
import { resolveSession } from "../../sessions/sessions";
import { applyMode, planningPayload, resolveToolApproval } from "../../agent/modes";
import { resolveMcpApproval } from "../../mcp/mcp-tools";
import { resolveQuestionAnswer, type QuestionAnswerItem } from "../../tools/question-tools";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  tool_confirm: async (reqId, msg) => {
    // 结算逐工具审批：approved = 放行执行，false = 拦截（模型收到 blocked 工具结果）
    const approvalId = String(msg.approvalId ?? "");
    // MCP 网关工具的审批挂起不在 run 内（模块级表，见 mcp-tools.ts）：先查它，
    // 命中即结算返回，不去 resolveSession（审批期间会话可能尚未落库）
    if (resolveMcpApproval(approvalId, Boolean(msg.approved))) {
      send({ id: reqId, type: "tool_confirmed", approvalId });
      return;
    }
    const run = await resolveSession(
      String(msg.threadId ?? "default"),
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    );
    if (!resolveToolApproval(run, approvalId, Boolean(msg.approved))) {
      throw new Error(`no pending tool approval: ${approvalId}`);
    }
    send({ id: reqId, type: "tool_confirmed", approvalId });
  },

  question_answer: async (reqId, msg) => {
    // 结算 Question 工具的挂起提问：execute 拿到答案后格式化回模型（toolCallId 全局唯一，无需按会话查 run）
    const questionId = String(msg.questionId ?? "");
    const answers = Array.isArray(msg.answers)
      ? (msg.answers as QuestionAnswerItem[])
      : [];
    if (!resolveQuestionAnswer(questionId, answers)) {
      throw new Error(`no pending question: ${questionId}`);
    }
    send({ id: reqId, type: "question_answered", questionId });
  },

  set_mode: async (reqId, msg) => {
    // 手动切换会话模式（agent/plan），可选携带审批级别（agent 模式的
    // ask/auto-edit/auto 对应前端"变更前确认/自动编辑/完全访问"）；重建工具集与系统提示词
    const run = await resolveSession(
      String(msg.threadId ?? "default"),
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      typeof msg.cwd === "string" ? msg.cwd : undefined,
    );
    const mode = String(msg.mode ?? "agent");
    if (mode !== "agent" && mode !== "plan") {
      throw new Error(`invalid mode: ${mode}`);
    }
    if (typeof msg.approvalLevel === "string") {
      if (msg.approvalLevel !== "ask" && msg.approvalLevel !== "auto-edit" && msg.approvalLevel !== "auto") {
        throw new Error(`invalid approval level: ${msg.approvalLevel}`);
      }
      run.approvalLevel = msg.approvalLevel;
    }
    applyMode(run, mode);
    send({ id: reqId, type: "mode_changed", ...planningPayload(run) });
  },

  get_planning_state: async (reqId, msg) => {
    // 模式快照拉取：前端刷新/切线程后恢复模式选择器（plan_exit 的执行确认
    // 挂起属于 toolApproval 通道，不在此快照内）
    const run = await resolveSession(
      String(msg.threadId ?? "default"),
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    );
    send({ id: reqId, type: "planning_state", ...planningPayload(run) });
  },
};
