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
import {
  sessionForThread,
  settleInteraction,
} from "../../sessions/pending-interactions";
import { scanTranscript } from "../../sessions/transcript";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  tool_confirm: async (reqId, msg) => {
    // 结算逐工具审批：approved = 放行执行，false = 拦截（模型收到 blocked 工具结果）
    const approvalId = String(msg.approvalId ?? "");
    const approved = Boolean(msg.approved);
    // MCP 网关工具的审批挂起不在 run 内（模块级表，见 mcp-tools.ts）：先查它，
    // 命中即结算返回，不去 resolveSession（审批期间会话可能尚未落库）
    if (resolveMcpApproval(approvalId, approved)) {
      send({ id: reqId, type: "tool_confirmed", approvalId });
      return;
    }
    const run = await resolveSession(
      String(msg.threadId ?? "default"),
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    );
    if (!resolveToolApproval(run, approvalId, approved)) {
      // 重启后重放的陈旧条目（§4）：活 promise 已随旧进程消亡，结算只落行解禁
      // （台账里也没有 = 真不存在，维持原报错）
      if (!settleInteraction(approvalId, approved ? "approved" : "denied")) {
        throw new Error(`no pending tool approval: ${approvalId}`);
      }
    }
    send({ id: reqId, type: "tool_confirmed", approvalId });
  },

  question_answer: async (reqId, msg) => {
    // 结算 Question 工具的挂起提问：execute 拿到答案后格式化回模型（toolCallId 全局唯一，无需按会话查 run）
    const questionId = String(msg.questionId ?? "");
    const answers = Array.isArray(msg.answers)
      ? (msg.answers as QuestionAnswerItem[])
      : [];
    if (
      !resolveQuestionAnswer(questionId, answers) &&
      // 陈旧条目兜底（同 tool_confirm）
      !settleInteraction(questionId, "answered")
    ) {
      throw new Error(`no pending question: ${questionId}`);
    }
    send({ id: reqId, type: "question_answered", questionId });
  },

  list_pending: async (reqId, msg) => {
    // 权威拉取（§3 回拉表 / §4）：交互行即事实源（发起/结算都落行），
    // 不依赖会话驻留——刷新、驱逐、重启后同一入口补齐挂起卡。
    const sessionId =
      typeof msg.sessionId === "string"
        ? msg.sessionId
        : sessionForThread(String(msg.threadId ?? "default"));
    const items = sessionId ? scanTranscript(sessionId).pending : [];
    send({ id: reqId, type: "pending", items });
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
