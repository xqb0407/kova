/**
 * 交互命令：逐工具审批结算（含 MCP 网关审批与 plan_exit 确认）、Question 工具
 * 应答、会话模式切换与 planning 快照。审批/提问的发起在 prompt 流内
 * （data-toolApproval / data-question chunk），这里是结算侧。
 */
import { send, sendSessionsChanged } from "../stream";
import { resolveSession } from "../../sessions/sessions";
import {
  applyMode,
  normalizeSessionMode,
  planningPayload,
  resolveToolApproval,
} from "../../agent/modes";
import { resolveMcpApproval } from "../../mcp/mcp-tools";
import {
  cancelQuestionAnswer,
  resolveQuestionAnswer,
  type QuestionAnswerItem,
} from "../../tools/question-tools";
import {
  sessionForThread,
  settleInteraction,
} from "../../sessions/pending-interactions";
import { scanTranscript } from "../../sessions/transcript";
import { logAt } from "../../log";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  tool_confirm: async (reqId, msg) => {
    // 结算逐工具审批：approved = 放行执行，false = 拦截（模型收到 blocked 工具结果）
    const approvalId = String(msg.approvalId ?? "");
    const approved = Boolean(msg.approved);
    // 「允许并记住」：把这次要写的目录写进本机清单（sidecar 侧落盘，见 modes.ts）
    const remember = Boolean(msg.remember);
    // MCP 网关工具的审批挂起不在 run 内（模块级表，见 mcp-tools.ts）：先查它，
    // 命中即结算返回，不去 resolveSession（审批期间会话可能尚未落库）。
    // remember 一起带过去：「允许并记住这个工具」要落盘，记的是这次批准的范围
    if (resolveMcpApproval(approvalId, approved, remember)) {
      send({ id: reqId, type: "tool_confirmed", approvalId });
      return;
    }
    const run = await resolveSession(
      String(msg.threadId ?? "default"),
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    );
    if (!resolveToolApproval(run, approvalId, approved, remember)) {
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
    //
    // cancelled = 用户关掉提问卡而不作答。它与「回答」是两种结算，但**都不是停轮**：
    // 两种情况模型都拿到一条 tool result（取消时是「用户取消了这次提问，自行判断
    // 是否继续」），这一轮照常走完。关掉一张卡就 abort 整轮，会把目标模式的自治
    // 循环一起打断——用户只是收起了一张卡，不是要停掉整条目标
    const questionId = String(msg.questionId ?? "");
    const cancelled = msg.cancelled === true;
    const answers = Array.isArray(msg.answers)
      ? (msg.answers as QuestionAnswerItem[])
      : [];
    const settled = cancelled
      ? cancelQuestionAnswer(questionId)
      : resolveQuestionAnswer(questionId, answers);
    if (
      !settled &&
      // 陈旧条目兜底（同 tool_confirm）
      !settleInteraction(questionId, cancelled ? "cancelled" : "answered")
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
    // 手动切换会话模式（agent/plan/ask/goal），可选携带审批级别（agent 模式的
    // ask/workspace-write/auto-edit/auto 对应前端"变更前确认/工作区内自动/自动编辑/完全访问"）；
    // 重建工具集与系统提示词
    const run = await resolveSession(
      String(msg.threadId ?? "default"),
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      typeof msg.cwd === "string" ? msg.cwd : undefined,
    );
    const mode = normalizeSessionMode(msg.mode);
    if (mode !== msg.mode) {
      throw new Error(`invalid mode: ${String(msg.mode)}`);
    }
    if (typeof msg.approvalLevel === "string") {
      if (
        msg.approvalLevel !== "ask" &&
        msg.approvalLevel !== "workspace-write" &&
        msg.approvalLevel !== "auto-edit" &&
        msg.approvalLevel !== "auto"
      ) {
        throw new Error(`invalid approval level: ${msg.approvalLevel}`);
      }
      run.approvalLevel = msg.approvalLevel;
    }
    applyMode(run, mode);
    // 模式是用户可见的状态变更，此前没有任何痕迹：出问题时无从判断是"前端发错了"
    // 还是"服务端算错了"（排查「显示的模式莫名其妙变成另一档」时就需要这一行）
    logAt(
      "event",
      `set_mode: thread=${run.threadId} session=${run.sessionId} ` +
        `mode=${run.mode} approval=${run.approvalLevel} ` +
        `(requested mode=${String(msg.mode)} approval=${String(msg.approvalLevel ?? "-")})`,
    );
    // 跨端同步：模式/权限是会话级状态，另一端的模式胶囊要跟着变（清单帧 → 对端重拉偏好）。
    // 注意发在**响应之前**：响应恒为最后一行（测试与前端都依赖 last() 约定）
    sendSessionsChanged("updated", run.sessionId);
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
