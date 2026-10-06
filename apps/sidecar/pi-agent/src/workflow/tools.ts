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
    description: '"delegate" runs a subagent; "synthesize" (exactly one) produces the final report from upstream results.',
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
      "delegate: the complete brief for the subagent (it cannot see this conversation). synthesize: the report instructions; reference upstream results inline with {{step-key}} placeholders.",
    maxLength: MAX_STEP_TEXT_LENGTH,
  }),
  agent: Type.Optional(
    Type.String({ description: "delegate only: name of the subagent definition to run." }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        'delegate only: model override "provider/modelId" (e.g. "anthropic/claude-sonnet-4"). Omit to inherit the session model.',
    }),
  ),
  dependsOn: Type.Optional(
    Type.Array(Type.String({ description: "Step key this step waits on." }), {
      description: "Dependencies: this step starts only after all of them are done.",
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
      "Each delegate step runs a subagent with an isolated context; state in `prompt` everything it cannot infer. The single synthesize step weaves upstream results (reference them with {{step-key}}) into the report the user will read.",
      "Steps run concurrently once their dependsOn are done; keep independent steps dependency-free and chain only real data dependencies.",
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
    async execute(_toolCallId: string, params: Record<string, unknown>) {
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
          "Stop here. Do not start any step yourself — the user confirms the plan first, then the runtime executes it.",
        ].join("\n"),
        { runId: accepted.id, stepCount: checked.steps.length },
      );
    },
  } as unknown as AgentTool;
}
