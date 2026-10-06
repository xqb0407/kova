/**
 * 工作流模式工具组(只挂 workflow 档,见 modes.ts toolsForMode):
 * - workflow_propose_plan:协商轮唯一出口——提交结构化剧本。
 *
 * 与 goal 的 propose 同一个不挂起哲学:提交即改状态(proposed),本轮终止,
 * 由常驻条上的确认卡片决定下一步。运行期不给任何工具——活是执行器干的,
 * 模型在环只会重复「编排器上下文」这个工作流要避免的东西。
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sendEventChunk } from "../protocol/stream";
import { MAX_STEP_TEXT_LENGTH, MAX_WORKFLOW_TITLE_LENGTH, MAX_STEPS_PER_RUN } from "./plan-state";
import {
  acceptProposal,
  validatePlan,
  WORKFLOW_TOOL_NAMES,
} from "./plan-state";
import { commitWorkflow, getWorkflow } from "./workflow";
import type { Running } from "../types";

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

const stepSchema = Type.Object({
  key: Type.String({
    description:
      "Stable unique id for this step (1-64 letters/digits/-/_). It addresses the step in the run journal — choose meaningful keys like 'audit-routes'.",
  }),
  kind: Type.String({
    description:
      '"delegate" runs a subagent; "gate" runs a literal shell command and branches on its exit code; "verify" puts a result in front of N adversarial reviewers; "synthesize" (exactly one) produces the final report from upstream results.',
  }),
  phase: Type.Optional(
    Type.String({ description: "Display group shown in the progress panel, in the user's language (e.g. 勘察 / 执行).", maxLength: 40 }),
  ),
  title: Type.String({
    description: "Short step title shown to the user, in the user's language.",
    maxLength: MAX_WORKFLOW_TITLE_LENGTH,
  }),
  prompt: Type.String({
    description:
      "delegate: the complete brief for the subagent (it cannot see this conversation); for a fanned-out delegate the item text replaces {{item}}. synthesize/verify: the instructions/what to judge; reference upstream results with {{step-key}} placeholders. gate: one sentence saying what this check decides (shown on the plan card).",
    maxLength: MAX_STEP_TEXT_LENGTH,
  }),
  agent: Type.Optional(
    Type.String({ description: "delegate only: name of the subagent definition to run." }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        'Model override "provider/modelId" (e.g. "anthropic/claude-sonnet-4"). Omit to inherit the session model.',
    }),
  ),
  dependsOn: Type.Optional(
    Type.Array(Type.String({ description: "Step key this step waits on." }), {
      description: "Dependencies: this step starts only after all of them are done.",
    }),
  ),
  foreach: Type.Optional(
    Type.Object({
      from: Type.String({
        description:
          "Step key whose result is split into items (one per non-empty line). This step runs once per item; {{item}} in the prompt is replaced by the item text.",
      }),
    }),
  ),
  gate: Type.Optional(
    Type.Object({
      command: Type.String({
        description:
          'The literal command to run (e.g. "npm"), approved by the user with the plan — never build it from a variable. Runtime values go in args.',
      }),
      args: Type.Optional(
        Type.Array(Type.String({ description: "One argv entry." }), {
          description: "Arguments passed after the command; {{step-key}} placeholders may be used here.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({ description: "Timeout in ms (1000-600000). Omit for the bash tool default." }),
      ),
    }),
  ),
  verify: Type.Optional(
    Type.Object({
      reviewers: Type.Optional(
        Type.Number({ description: "Number of adversarial reviewers (1-5, default 2)." }),
      ),
      threshold: Type.Optional(
        Type.Number({
          description: "Fraction of reviewers that must judge it real, in (0,1]; default 0.5.",
        }),
      ),
    }),
  ),
  retries: Type.Optional(
    Type.Number({
      description:
        "Extra attempts after a recoverable failure (provider error / empty report), 0-3; default 0. Gate steps never retry — an exit code is a value.",
    }),
  ),
  onFail: Type.Optional(
    Type.String({
      description:
        '"abort" (default) fails the whole run; "skip" marks the step skipped and lets downstream continue with an explicit gap marker. Only delegate/verify may skip.',
    }),
  ),
});

/**
 * 按协商阶段给工具:无运行/编排中只给 propose;proposed(等用户确认)一个都不给
 * (循环本就停着,给工具只会诱使模型去调);running 之后模型退场。
 */
export function buildWorkflowTools(run: Running): AgentTool[] {
  const wf = getWorkflow(run.threadId);
  if (!wf) return [];
  if (wf.status === "proposing") return [buildProposeTool(run)];
  return [];
}

function buildProposeTool(run: Running): AgentTool {
  return {
    name: WORKFLOW_TOOL_NAMES.propose,
    label: "Propose Workflow Plan",
    description: [
      "Propose the complete workflow plan for the user's request: the steps, who runs each one, and how their results flow into the final report.",
      "Each delegate step runs a subagent with an isolated context; state in `prompt` everything it cannot infer. A delegate with `foreach` fans out over the lines of an upstream result ({{item}} per line). The single synthesize step weaves upstream results (reference them with {{step-key}}) into the report the user will read.",
      "A gate step runs a literal shell command (user-approved with the plan) and branches on its exit code — use it wherever a command can decide. A verify step puts an upstream result in front of N adversarial reviewers and fails when they refute it.",
      "Steps run concurrently once their dependsOn are done; keep independent steps dependency-free and chain only real data dependencies. Steps that may fail without killing the run can set onFail:\"skip\".",
      "Must be the only tool call in your message. After submitting, stop — the user has to confirm the plan before anything runs.",
    ].join("\n"),
    parameters: Type.Object({
      title: Type.Optional(
        Type.String({
          description: "Short run title shown on the progress bar, in the user's language.",
          maxLength: MAX_WORKFLOW_TITLE_LENGTH,
        }),
      ),
      steps: Type.Array(stepSchema, {
        minItems: 1,
        maxItems: MAX_STEPS_PER_RUN,
        description: "The complete plan, in execution order where it matters.",
      }),
    }),
    async execute(toolCallId: string, params: Record<string, unknown>) {
      const p = params as { title?: unknown; steps?: unknown };
      const current = getWorkflow(run.threadId);
      if (!current || current.status !== "proposing") {
        return textResult(
          "workflow_propose_plan rejected: there is no workflow awaiting a plan (it may already be proposed, running or cleared).",
        );
      }
      const checked = validatePlan(p.steps);
      if (!checked.ok) {
        // 校验 reason 是给模型改错的完整诊断:哪里不合法、该改成什么样
        return textResult(`workflow_propose_plan rejected: ${checked.reason}`);
      }
      const title = typeof p.title === "string" ? p.title : "";
      const accepted = acceptProposal(current, checked.steps, title);
      commitWorkflow(run, accepted);
      // 剧本卡锚定:toolCallId ↔ runId 绑定(同 data-subagentDelegation 的消息行绑定),
      // 前端据此把整张运行卡挂到这次工具调用的行上,运行状态随对话历史留存
      sendEventChunk(
        run.threadId,
        { type: "data-workflowPlan", data: { toolCallId, runId: accepted.id } },
        run.sessionId,
      );
      const summary = checked.steps
        .map(
          (s) =>
            `- [${s.kind}] ${s.key} (${s.title})${s.dependsOn.length ? ` <- ${s.dependsOn.join(", ")}` : ""}`,
        )
        .join("\n");
      return textResult(
        [
          `Plan "${accepted.title ?? accepted.objective.slice(0, 60)}" submitted with ${checked.steps.length} step(s):`,
          summary,
          "",
          `Run ID: ${accepted.id}`,
          "Stop here. Do not start any step yourself — the user confirms the plan first, then the runtime executes it.",
        ].join("\n"),
        { runId: accepted.id, stepCount: checked.steps.length },
      );
    },
  } as unknown as AgentTool;
}
