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
import {
  commitWorkflow,
  getWorkflow,
  startPlaybookRun,
} from "./workflow";
import {
  cachedPlaybooksSync,
  expandComposition,
  getPlaybook,
  validatePlaybookArgs,
} from "./library";
import { startWorkflowExecution } from "./runner";
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
      '"delegate" runs a subagent; "gate" runs a literal shell command and branches on its exit code; "verify" puts a result in front of N adversarial reviewers; "playbook" inlines a saved playbook (use.playbook) as prefixed sub-steps; "synthesize" (exactly one at the top level) produces the final report from upstream results.',
  }),
  phase: Type.Optional(
    Type.String({ description: "Display group shown in the progress panel, in the user's language (e.g. 勘察 / 执行).", maxLength: 40 }),
  ),
  title: Type.String({
    description: "Short step title shown to the user, in the user's language.",
    maxLength: MAX_WORKFLOW_TITLE_LENGTH,
  }),
  prompt: Type.Optional(
    Type.String({
      description:
        "delegate: the complete brief for the subagent (it cannot see this conversation); for a fanned-out delegate the item text replaces {{item}}. synthesize/verify: the instructions/what to judge; reference upstream results with {{step-key}} placeholders. gate: one sentence saying what this check decides (shown on the plan card). Required for every kind except playbook.",
      maxLength: MAX_STEP_TEXT_LENGTH,
    }),
  ),
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
  use: Type.Optional(
    Type.Object({
      playbook: Type.String({
        description:
          'kind:"playbook" only: name of a saved playbook (see the list in workflow_run_playbook). Its steps are inlined here at proposal time with the placeholder {{args.NAME}} values you pass in args.',
      }),
      args: Type.Optional(
        Type.Unsafe<Record<string, unknown>>({
          type: "object",
          description:
            "Values for the playbook's parameters; parameters you leave out stay runtime placeholders bound by this run's args.",
        }),
      ),
    }),
  ),
});

/**
 * 按协商阶段给工具:无运行/编排中只给 propose;proposed(等用户确认)一个都不给
 * (循环本就停着,给工具只会诱使模型去调);running 之后模型退场。
 */
export function buildWorkflowTools(run: Running): AgentTool[] {
  const wf = getWorkflow(run.threadId);
  // 无运行(极短暂)与编排中都可提剧本;有库时可改走「直接跑剧本」这条快路
  if (!wf || wf.status === "proposing") {
    return [buildProposeTool(run), buildRunPlaybookTool(run)];
  }
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
      'Each delegate step names a subagent definition with "agent" — call subagents_list first when you do not already know which definitions exist; a wrong name fails the run at execution, not at proposal.',
      "When the user asks you to design a workflow, this tool call IS the answer — never write the design out as prose. Must be the only tool call in your message. After submitting, stop — the user has to confirm the plan before anything runs.",
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
      // 组合展开:kind:"playbook" 的步骤在这里平铺成带前缀的子步骤(提案期 macro,
      // 运行期只有一份扁平 DAG);展开后的结构再过一遍校验(依赖/环/顶层汇点)
      let steps = checked.steps;
      if (steps.some((s) => s.kind === "playbook")) {
        const expanded = await expandComposition(steps);
        if (!expanded.ok) {
          return textResult(`workflow_propose_plan rejected: ${expanded.reason}`);
        }
        const recheck = validatePlan(expanded.steps);
        if (!recheck.ok) {
          return textResult(`workflow_propose_plan rejected: ${recheck.reason}`);
        }
        steps = recheck.steps;
      }
      const title = typeof p.title === "string" ? p.title : "";
      const accepted = acceptProposal(current, steps, title);
      commitWorkflow(run, accepted);
      // 剧本卡锚定:toolCallId ↔ runId 绑定(同 data-subagentDelegation 的消息行绑定),
      // 前端据此把整张运行卡挂到这次工具调用的行上,运行状态随对话历史留存
      sendEventChunk(
        run.threadId,
        { type: "data-workflowPlan", data: { toolCallId, runId: accepted.id } },
        run.sessionId,
      );
      const summary = steps
        .map(
          (s) =>
            `- [${s.kind}] ${s.key} (${s.title})${s.dependsOn.length ? ` <- ${s.dependsOn.join(", ")}` : ""}`,
        )
        .join("\n");
      return textResult(
        [
          `Plan "${accepted.title ?? accepted.objective.slice(0, 60)}" submitted with ${steps.length} step(s):`,
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

/**
 * 按名直接跑一条已存剧本(库路径):只有提出剧本与直接跑两条出口,没有第三条。
 * 与设置页「运行」同一落点(startPlaybookRun 直入 running)——剧本已检视过,
 * 不再走确认卡;描述里带库目录(名/说明/使用时机/参数),模型据此选路。
 */
function buildRunPlaybookTool(run: Running): AgentTool {
  const catalog = cachedPlaybooksSync() ?? [];
  const catalogText =
    catalog.length === 0
      ? "No playbooks are saved yet — propose a plan instead (the user can save it as a playbook afterwards)."
      : [
          "Saved playbooks:",
          ...catalog.map((p) => {
            const args = p.args.length
              ? ` args: ${p.args.map((a) => `${a.name}${a.required ? " (required)" : ""}`).join(", ")}`
              : " args: none";
            return `- ${p.name} (${p.steps.length} 步${args})${p.whenToUse ? ` — when: ${p.whenToUse}` : p.description ? ` — ${p.description}` : ""}`;
          }),
        ].join("\n");
  return {
    name: WORKFLOW_TOOL_NAMES.runPlaybook,
    label: "Run Saved Playbook",
    description: [
      "Run a SAVED playbook by name: its steps are executed immediately with the parameters you pass — no re-planning, no confirmation card, because the user already reviewed this playbook.",
      "Use this instead of workflow_propose_plan when one of the saved playbooks below fits the request. If it does not fit, propose a new plan.",
      "Must be the only tool call in your message. After calling it, stop and tell the user the run has started.",
      "",
      catalogText,
    ].join("\n"),
    parameters: Type.Object({
      name: Type.String({ description: "The playbook name exactly as listed above." }),
      args: Type.Optional(
        Type.Unsafe<Record<string, unknown>>({
          type: "object",
          description:
            "Values for the playbook's parameters (see the args list above). Missing required parameters are rejected — ask the user instead of guessing.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const p = params as { name?: unknown; args?: unknown };
      const current = getWorkflow(run.threadId);
      if (current && (current.status === "running" || current.status === "proposed" || current.status === "paused")) {
        return textResult(`${WORKFLOW_TOOL_NAMES.runPlaybook} rejected: this thread already has a workflow run in progress.`);
      }
      const playbook = await getPlaybook(String(p.name ?? ""));
      if (!playbook) {
        return textResult(
          `${WORKFLOW_TOOL_NAMES.runPlaybook} rejected: unknown playbook "${String(p.name ?? "")}". Saved playbooks:\n${catalogText}`,
        );
      }
      const checked = validatePlaybookArgs(
        playbook.args,
        (p.args && typeof p.args === "object" ? p.args : {}) as Record<string, unknown>,
      );
      if (!checked.ok) {
        return textResult(
          `${WORKFLOW_TOOL_NAMES.runPlaybook} rejected: ${checked.errors.join("; ")}. Ask the user for the missing values.`,
        );
      }
      // 换运行:清掉本轮刚建的「编排中」槽位,再按库路径直入 running
      commitWorkflow(run, undefined);
      startPlaybookRun(run, playbook, checked.values);
      void startWorkflowExecution(run);
      return textResult(
        [
          `Playbook "${playbook.name}" started with ${playbook.steps.length} step(s).`,
          "Stop here — the runtime executes it in the background and delivers the report when it finishes.",
        ].join("\n"),
        { playbook: playbook.name },
      );
    },
  } as unknown as AgentTool;
}
