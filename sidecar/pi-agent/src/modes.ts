/**
 * 模式系统（对齐 PI-Desktop-main/packages/agent-runtime 的 Plan/Goal 机制）：
 * - agent：正常执行，工具全集 + EnterPlanMode/EnterGoalMode
 * - plan：只读契约协商（read/glob/grep/bash + SubmitPlan），产出实施计划交用户审批
 * - goal：目标契约协商（read/glob/grep/bash + SubmitGoal），产出验收标准交用户审批
 *
 * 规则（与参考实现一致）：
 * - 模式切换工具必须独占 assistant 消息的 tool call 批次（beforeToolCall 拦截）
 * - Enter 工具仅 agent 模式可用；Submit 工具仅对应模式可用
 * - 切换不重建 Agent：直接热替换 agent.state.systemPrompt / agent.state.tools
 * - 审批流：Submit → awaiting_approval →（批准）回 agent 模式继续实施 /（拒绝）留在原模式修改
 *
 * 提案内容不落盘（无 artifact 文件）：SubmitPlan/SubmitGoal 的 toolCall 参数随转录
 * 持久化，模型上下文天然保留；批准后由前端走正常 prompt 管道发"已批准"消息。
 */
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type {
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { SYSTEM_PROMPT_CORE, workspacePromptLine } from "./tools";
import { sendEventChunk } from "./stream";
import type {
  ApprovalLevel,
  PendingProposal,
  PlanningState,
  ProposalKind,
  Running,
  SessionMode,
} from "./types";

/** 模式切换工具名（Enter = 请求进入契约模式；Submit = 提交契约等审批） */
export const ENTER_TOOL_NAMES: Record<ProposalKind, string> = {
  plan: "EnterPlanMode",
  goal: "EnterGoalMode",
};
export const SUBMIT_TOOL_NAMES: Record<ProposalKind, string> = {
  plan: "SubmitPlan",
  goal: "SubmitGoal",
};
/** 模式切换必须独占批次 */
const MODE_TRANSITION_TOOL_NAMES = new Set([
  ...Object.values(ENTER_TOOL_NAMES),
  ...Object.values(SUBMIT_TOOL_NAMES),
]);

/** 契约模式（plan/goal）允许的工具：只读（含联网勘察 WebFetch/WebSearch）+ bash（承诺仅用于勘察，靠提示词约束）+ Question（规划正需要澄清提问） */
const CONTRACT_TOOL_NAMES = new Set(["read", "glob", "grep", "bash", "WebFetch", "WebSearch", "Question"]);

const enterToolKind = (name: string): ProposalKind | undefined =>
  name === ENTER_TOOL_NAMES.plan ? "plan" : name === ENTER_TOOL_NAMES.goal ? "goal" : undefined;
const submitToolKind = (name: string): ProposalKind | undefined =>
  name === SUBMIT_TOOL_NAMES.plan ? "plan" : name === SUBMIT_TOOL_NAMES.goal ? "goal" : undefined;

const modeLabel = (mode: SessionMode) =>
  mode === "plan" ? "Plan" : mode === "goal" ? "Goal" : "Agent";

/* ------------------------------- 系统提示词 ------------------------------- */

/** 契约模式附加提示（改写自参考项目 mode-prompts.ts，去掉 artifact 文件相关约定） */
const CONTRACT_MODE_PROMPTS: Record<ProposalKind, string> = {
  plan: [
    "You are operating in Plan mode: inspect the workspace and reason about the requested change, then formulate a concrete implementation plan (files, behavior, validation steps).",
    "Do not use Write or Edit in Plan mode. Bash is available but may mutate files — use it only when it materially helps inspection or planning.",
    "When the plan is ready, call SubmitPlan exactly once in the current turn with one complete Markdown snapshot, a short title, and the question that needs approval.",
    "After submission, stop and wait for the user's approval. Do not implement changes while approval is pending. If the plan is rejected, revise it in the next turn and submit again.",
  ].join("\n"),
  goal: [
    "You are operating in Goal mode: negotiate a goal contract before any autonomous work. A goal is what to achieve, not how — outcome, objectively checkable acceptance criteria, and boundaries. Do not enumerate implementation steps.",
    "Do not use Write or Edit in Goal mode. Bash is available but may mutate files — use it only when it materially helps understand the goal.",
    "When the goal, its acceptance criteria, and its boundaries are ready, call SubmitGoal exactly once in the current turn with one complete Markdown snapshot, a short title, and the question that needs approval.",
    "After submission, stop and wait for the user's approval. Do not start autonomous work while approval is pending. If the goal is rejected, revise it in the next turn and submit again.",
    "Once approved, pursue the goal autonomously: choose your own approach, verify every acceptance criterion yourself, and stop only when all criteria are met or a boundary blocks you.",
  ].join("\n"),
};

const AGENT_MODE_PROMPT =
  "You are operating in Agent mode: carry out the requested work with the available tools and report the result clearly. When it helps, propose an implementation plan via EnterPlanMode, or negotiate a goal contract via EnterGoalMode.";

/**
 * 各模式完整系统提示 = 静态核心 + 模式附加段 + cwd 行。
 * 顺序保证缓存命中：静态核心在前（跨会话字节级一致），模式段夹中间（会话内
 * 切换时整段重排不可避免，但同一模式内前缀稳定），cwd 行永远在最尾。
 */
export function composeModeSystemPrompt(mode: SessionMode, cwd: string): string {
  const extra =
    mode === "plan"
      ? CONTRACT_MODE_PROMPTS.plan
      : mode === "goal"
        ? CONTRACT_MODE_PROMPTS.goal
        : AGENT_MODE_PROMPT;
  return [SYSTEM_PROMPT_CORE, extra, workspacePromptLine(cwd)].join("\n\n");
}

/* --------------------------------- 工具集 --------------------------------- */

/** 按模式重建工具目录：agent = 基础 + Task 组 + Enter；契约模式 = 只读子集 + 对应 Submit */
export function toolsForMode(run: Running): AgentTool[] {
  const transition = buildTransitionTools(run);
  if (run.mode === "agent") {
    const enterNames = new Set(Object.values(ENTER_TOOL_NAMES));
    return [
      ...run.baseTools,
      ...run.subagentTools,
      ...transition.filter((t) => enterNames.has(t.name)),
    ];
  }
  const submitName = SUBMIT_TOOL_NAMES[run.mode];
  return [
    ...run.baseTools.filter((t) => CONTRACT_TOOL_NAMES.has(t.name)),
    ...transition.filter((t) => t.name === submitName),
  ];
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

/** 四个模式切换工具（构建时捕获 run 引用；run.agent 在构造后回填） */
function buildTransitionTools(run: Running): AgentTool[] {
  const enterTool = (kind: ProposalKind): AgentTool => ({
    name: ENTER_TOOL_NAMES[kind],
    label: kind === "plan" ? "Enter Plan Mode" : "Enter Goal Mode",
    description:
      kind === "plan"
        ? "Switch this session into Plan mode: read-only planning, then submit an implementation plan for user approval via SubmitPlan. Must be the only tool call in your message."
        : "Switch this session into Goal mode: negotiate an outcome contract with acceptance criteria, then submit it for user approval via SubmitGoal. Must be the only tool call in your message.",
    parameters: Type.Object({}),
    execute: async () => {
      applyMode(run, kind);
      return textResult(
        kind === "plan"
          ? "Entered Plan mode. Inspect the workspace, then submit your implementation plan with SubmitPlan."
          : "Entered Goal mode. Negotiate the goal contract, then submit it with SubmitGoal.",
      );
    },
  });

  const submitTool = (kind: ProposalKind): AgentTool => ({
    name: SUBMIT_TOOL_NAMES[kind],
    label: kind === "plan" ? "Submit Plan" : "Submit Goal",
    description:
      kind === "plan"
        ? "Submit your complete implementation plan (Markdown) for user approval. Must be the only tool call in your message; stop after calling it."
        : "Submit your complete goal contract (Markdown) for user approval. Must be the only tool call in your message; stop after calling it.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title of the plan/goal" }),
      markdown: Type.String({
        description:
          kind === "plan"
            ? "Complete implementation plan in Markdown (files, behavior, validation steps)"
            : "Complete goal contract in Markdown (outcome, acceptance criteria, boundaries)",
      }),
      question: Type.String({ description: "The question the user should answer when approving" }),
    }),
    execute: async (_id, params) => {
      const p = params as { title: string; markdown: string; question: string };
      const proposal: PendingProposal = {
        kind,
        title: String(p.title ?? ""),
        markdown: String(p.markdown ?? ""),
        question: String(p.question ?? ""),
      };
      if (!proposal.markdown.trim()) throw new Error("markdown is required");
      run.planning = "awaiting_approval";
      run.proposal = proposal;
      emitPlanningState(run);
      return textResult(
        "Submitted for approval. Stop now and wait for the user's decision; do not continue working.",
        { submitted: true },
      );
    },
  });

  return [enterTool("plan"), enterTool("goal"), submitTool("plan"), submitTool("goal")];
}

/* ------------------------------ beforeToolCall ------------------------------ */

/** 需要用户逐次确认的工具（有副作用的写操作） */
export const APPROVAL_REQUIRED_TOOLS = new Set(["bash", "write", "edit"]);

/** 模式切换工具的批次独占与可用性校验（与参考实现一致） */
export function modeBeforeToolCall(
  run: Running,
  context: BeforeToolCallContext,
): BeforeToolCallResult | undefined {
  const toolCalls = (context.assistantMessage.content as Array<{ type?: string; name?: string }>)
    .filter((b) => b.type === "toolCall");
  const transition = MODE_TRANSITION_TOOL_NAMES.has(context.toolCall.name);
  const transitionInBatch = toolCalls.some((b) => MODE_TRANSITION_TOOL_NAMES.has(b.name ?? ""));
  if (transitionInBatch && toolCalls.length !== 1) {
    return {
      block: true,
      reason: `${[...MODE_TRANSITION_TOOL_NAMES].join(", ")} must be the only tool call in the assistant message.`,
    };
  }
  if (!transition) return undefined;
  const enterKind = enterToolKind(context.toolCall.name);
  if (enterKind && run.mode !== "agent") {
    return { block: true, reason: `${context.toolCall.name} is available only in Agent mode.` };
  }
  const submitKind = submitToolKind(context.toolCall.name);
  if (submitKind && run.mode !== submitKind) {
    return {
      block: true,
      reason: `${context.toolCall.name} is available only in ${modeLabel(submitKind)} mode.`,
    };
  }
  return undefined;
}

/**
 * 逐工具审批钩子（sessions.ts 注册的最终 beforeToolCall）：
 * 先做模式门控，再按审批级别决定 bash/write/edit 是否等待用户确认——
 * ask = 全部确认；auto-edit = 编辑免确认、bash 仍确认；auto = 全免。
 * 挂起项记入 run.pendingToolApprovals 并经当前请求流推 data-toolApproval
 * chunk，await 到 tool_confirm（批准/拒绝）或清理（abort）后才放行/拦截。
 */
export async function approvalBeforeToolCall(
  run: Running,
  context: BeforeToolCallContext,
): Promise<BeforeToolCallResult | undefined> {
  const gated = modeBeforeToolCall(run, context);
  if (gated) return gated;
  if (run.approvalLevel === "auto") return undefined;
  if (!APPROVAL_REQUIRED_TOOLS.has(context.toolCall.name)) return undefined;
  if (run.approvalLevel === "auto-edit" && context.toolCall.name !== "bash") {
    return undefined;
  }

  const approvalId = randomUUID();
  sendEventChunk({
    type: "data-toolApproval",
    data: {
      approvalId,
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      input: context.args ?? null,
    },
  });
  const approved = await new Promise<boolean>((resolve) => {
    run.pendingToolApprovals.set(approvalId, {
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      input: context.args ?? null,
      resolve,
    });
  });
  if (!approved) {
    return {
      block: true,
      reason: "User rejected this tool call. Ask how to proceed or adjust the approach.",
    };
  }
  return undefined;
}

/** 结算一条挂起审批（protocol 的 tool_confirm 调用）；返回是否存在 */
export function resolveToolApproval(run: Running, approvalId: string, approved: boolean): boolean {
  const pending = run.pendingToolApprovals.get(approvalId);
  if (!pending) return false;
  run.pendingToolApprovals.delete(approvalId);
  pending.resolve(approved);
  return true;
}

/** 清理全部挂起审批（按拒绝结算）：用户 Stop / 新 prompt 前的兜底 */
export function clearPendingToolApprovals(run: Running): void {
  for (const pending of run.pendingToolApprovals.values()) {
    pending.resolve(false);
  }
  run.pendingToolApprovals.clear();
}

/* ------------------------------ 模式切换与审批 ------------------------------ */

/** 切换模式：热替换 systemPrompt/tools 并推进审批状态机 */
export function applyMode(run: Running, mode: SessionMode): void {
  run.mode = mode;
  run.planning = mode === "agent" ? "inactive" : "planning";
  run.proposal = null;
  run.agent.state.systemPrompt = composeModeSystemPrompt(mode, run.cwd);
  run.agent.state.tools = toolsForMode(run);
}

/** 当前审批状态的对外快照（响应/chunk 共用） */
export function planningPayload(run: Running): {
  mode: SessionMode;
  approvalLevel: ApprovalLevel;
  planning: PlanningState;
  proposal: PendingProposal | null;
} {
  return {
    mode: run.mode,
    approvalLevel: run.approvalLevel,
    planning: run.planning,
    proposal: run.proposal,
  };
}

/** 经当前活跃请求流把审批状态推给前端（data-planningState chunk）；无活跃请求时丢弃 */
export function emitPlanningState(run: Running): void {
  sendEventChunk({ type: "data-planningState", data: planningPayload(run) });
}

/** 用户新输入隐式关闭未决审批（批准/拒绝之外的唯一出口） */
export function closeProposalOnNewPrompt(run: Running): void {
  if (run.planning !== "awaiting_approval") return;
  run.planning = "planning";
  run.proposal = null;
  emitPlanningState(run);
}
