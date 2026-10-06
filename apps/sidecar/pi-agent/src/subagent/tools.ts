/**
 * 会话级子代理工具组：Task / TaskWait / TaskList / TaskStop，外加管理工具
 * subagents_list / subagents_save / subagents_delete（主代理创建、更新、删除
 * 子智能体定义，见 subagent-mgmt-tools.ts）。baseTools 是父代理的基础工具目录
 * （delegate 的工具按定义从里面取，绝不包含本组，delegate 不能继续委派、也不
 * 能管理定义）；definitions 是会话可用的子代理定义；reload 在管理工具改动后
 * 重建各会话的工具目录（sessions.ts 注入，避免模块环）。
 * 委派注册表与收敛原语见 delegation.ts，delegate 执行循环见 run.ts。
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "../model/model-catalog";
import { sendEventChunk } from "../protocol/stream";
import { normalizeSubagentName, type SubagentDefinition } from "./subagent-definitions";
import { buildSubagentMgmtTools } from "./subagent-mgmt-tools";
import type { DelegationRecord, Running } from "../types";
import {
  delegationHeartbeat,
  parseModelKey,
  pushActivity,
  registerDelegation,
  runningDelegations,
  settleDelegation,
  waitForDelegations,
  MAX_SUBAGENT_CONCURRENCY,
  SUBAGENT_LIST_TOOL_NAME,
  SUBAGENT_STOP_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
  SUBAGENT_WAIT_TOOL_NAME,
} from "./delegation";
import { SubagentRun } from "./run";

const TASKWAIT_DEFAULT_TIMEOUT_SECONDS = 300;
const TASKWAIT_MAX_TIMEOUT_SECONDS = 3600;

/**
 * 解析 delegate 用的模型：Task 的 model 覆盖 > 定义固定 > 继承会话当前模型。
 * 目录里查不到或没凭据时返回 error 文本（放进工具结果，模型可读）。
 * runner（工作流执行器）同样用它解析步骤的模型覆盖，所以 export。
 */
export async function resolveDelegateModel(
  run: Running,
  definition: SubagentDefinition,
  override: string,
): Promise<{ model?: Model<Api>; error?: string }> {
  const models = getModels();
  const key = override || definition.model;
  if (!key) {
    const parent = run.agent.state.model as Model<Api> | undefined;
    if (!parent) return { error: "No model is available for the subagent (session has no model)." };
    return { model: parent };
  }
  const parsed = parseModelKey(key);
  if (!parsed) {
    return {
      error: `Model "${key}" is not available. Use "provider/modelId", e.g. "anthropic/claude-sonnet-4".`,
    };
  }
  const model = models.getModel(parsed.provider, parsed.modelId);
  if (!model) return { error: `Model "${key}" was not found in the model catalog.` };
  const auth = await models.getAuth(parsed.provider).catch(() => undefined);
  if (!auth) {
    return {
      error: `No credentials configured for "${parsed.provider}". Open Settings → Model and add an API key.`,
    };
  }
  return { model };
}

/** 工具级错误：不抛出，把解释留在模型读得到的结果里 */
function subagentToolError(text: string) {
  return { content: [{ type: "text" as const, text }], details: { error: text } };
}

/** Task 返回的 delegationId 在正文里是 8 位短 id；查找时同时接受完整 id 与短 id 前缀 */
function findDelegation(run: Running, id: string): DelegationRecord | undefined {
  return (
    run.delegations.get(id) ??
    [...run.delegations.values()].find((r) => r.delegationId.startsWith(id) && id.length >= 4)
  );
}

/**
 * 会话级子代理工具组：Task / TaskWait / TaskList / TaskStop，外加
 * 管理工具 subagents_list / subagents_save / subagents_delete（主代理创建、
 * 更新、删除子智能体定义，见 subagent-mgmt-tools.ts）。
 * baseTools 是父代理的基础工具目录（delegate 的工具按定义从里面取，绝不包含本组，
 * delegate 不能继续委派、也不能管理定义）；definitions 是会话可用的子代理定义；
 * reload 在管理工具改动后重建各会话的工具目录（sessions.ts 注入，避免模块环）。
 */
export function buildSubagentTools(
  run: Running,
  baseTools: AgentTool[],
  definitions: SubagentDefinition[],
  reload: () => Promise<void>,
): AgentTool[] {
  const names = definitions.map((d) => d.name);

  const taskTool: AgentTool = {
    name: SUBAGENT_TOOL_NAME,
    label: "Task",
    description: [
      "Start one subagent in the background and return immediately; you keep working while it runs, then converge with TaskWait when you need its report.",
      "Use it when the work is separable: parallel exploration of independent directions (one Task per direction in the same assistant message), a multi-file implementation with a complete spec (fixer), an adversarial read-only review of a change you just made (code-reviewer), or a wide search / long log / multi-file survey whose intermediate output would otherwise fill this context (explorer, test-runner).",
      "Do not delegate what you can finish in a couple of tool calls, and do not delegate anything that needs the user — a subagent cannot ask a question or propose a plan on your behalf.",
      "`task` is the delegate's only instruction. It cannot see this conversation, and you cannot correct it while it runs, so state the goal, the paths and facts it cannot infer, and exactly what to report back.",
      "Pass `model` (\"provider/modelId\") only to pick a cheaper or faster model for a simple job; omit it to inherit this session's model.",
      "To run delegates concurrently, emit several Task calls in one assistant message. A message that mixes Task with any other tool runs one call at a time. You may keep working or talk to the user while they run; the runtime delivers their reports when they finish. Call TaskStop only to cancel.",
      `Available subagents:\n${definitions
        .map((d) => `- ${d.name} (tools: ${d.tools.join(", ")}): ${d.description}`)
        .join("\n")}`,
    ].join("\n\n"),
    parameters: Type.Object({
      agent: Type.String({
        description: `Name of the subagent to run: ${names.join(", ")}.`,
      }),
      task: Type.String({
        description:
          "The complete brief: goal, context the delegate cannot infer, and the exact report you want back.",
      }),
      description: Type.Optional(
        Type.String({
          description: "Short label for this delegation (3-6 words), shown to the user.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Override the delegate's model for this run, e.g. 'anthropic/claude-sonnet-4'. Omit to use the subagent's default.",
        }),
      ),
    }),
    // 同一条消息里的多个 Task 并发执行
    executionMode: "parallel",
    execute: async (toolCallId, params) => {
      const p = params as { agent?: string; task?: string; description?: string; model?: string };
      const requested = String(p.agent ?? "");
      const definition = definitions.find(
        (d) => normalizeSubagentName(d.name) === normalizeSubagentName(requested),
      );
      if (!definition) {
        return subagentToolError(
          `Unknown subagent "${requested}". Available: ${names.join(", ")}.`,
        );
      }
      const brief = String(p.task ?? "").trim();
      if (!brief) {
        return subagentToolError(
          `Delegating to ${definition.name} needs a non-empty \`task\` brief.`,
        );
      }
      if (runningDelegations(run).length >= MAX_SUBAGENT_CONCURRENCY) {
        return subagentToolError(
          `${MAX_SUBAGENT_CONCURRENCY} subagents are already running for this session. Wait for some with TaskWait or stop them with TaskStop before delegating more.`,
        );
      }
      const resolved = await resolveDelegateModel(run, definition, String(p.model ?? "").trim());
      const model = resolved.model;
      if (!model) return subagentToolError(resolved.error ?? "model unavailable");
      const tools = definition.tools
        .map((name) => baseTools.find((t) => t.name === name.toLowerCase()))
        .filter((t): t is AgentTool => t !== undefined);
      if (tools.length === 0) {
        return subagentToolError(
          `The ${definition.name} subagent declares no tool available in this session.`,
        );
      }
      const delegationId = randomUUID();
      const label = String(p.description ?? "").trim();
      const controller = new AbortController();
      let resolveCompletion: () => void = () => {};
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const record: DelegationRecord = {
        delegationId,
        agentName: definition.name,
        modelId: model.id,
        status: "running",
        description: label || undefined,
        activity: [],
        stopRequested: false,
        startedAt: Date.now(),
        turns: 0,
        toolCalls: 0,
        reportedToParent: false,
        completion,
        resolveCompletion,
        abort: () => controller.abort(),
      };
      run.delegations.set(delegationId, record);
      registerDelegation(record);
      // toolCallId ↔ delegationId 绑定：走本线程活跃请求流（刷新 attach 可回放，
      // 前端 Task 消息行据此开面板 tab）；历史重建时前端另有结果文本解析兜底
      sendEventChunk(run.threadId, {
        type: "data-subagentDelegation",
        data: {
          toolCallId,
          delegationId,
          agentName: definition.name,
          description: label || undefined,
        },
      });
      new SubagentRun({
        definition,
        task: brief,
        model,
        cwd: run.cwd,
        tools,
        sessionId: delegationId,
        traceSessionId: run.sessionId,
        // 轨迹因果边：把这次 Task tool_call 的父 run/父 span 身份写到子 run 上
        parentRunId: run.trace?.traceId,
        parentSpanId: run.trace?.spanIdForToolCall(toolCallId),
        signal: controller.signal,
        onActivity: (item) => pushActivity(record, item),
      })
        .run()
        .then(
          (result) => settleDelegation(run, record, result),
          // SubagentRun.run() 自会把错误折进结果；这个兜底只是防止意外 rejection
          // 让委派永远卡在 running。
          (error: unknown) =>
            settleDelegation(run, record, {
              agentName: definition.name,
              modelId: model.id,
              status: "failed",
              report: "",
              turns: 0,
              toolCalls: 0,
              error: {
                code: "UNEXPECTED_DELEGATION_REJECTION",
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        );
      return {
        content: [
          {
            type: "text" as const,
            text: `Delegation ${delegationId.slice(0, 8)} started: the ${definition.name} subagent is working in the background${label ? ` (${label})` : ""}. Continue your own independent work, then call TaskWait with this delegationId to converge, or TaskStop to stop it.`,
          },
        ],
        details: {
          delegationId,
          agent: definition.name,
          status: "running",
          modelId: model.id,
        },
      };
    },
  };

  const waitTool: AgentTool = {
    name: SUBAGENT_WAIT_TOOL_NAME,
    label: "Task Wait",
    description:
      "Wait for one or more subagents started by Task and return their reports. `delegationIds` defaults to every running subagent; use mode \"any\" with `minCompleted` to converge as soon as the first (or first N) finish. Settled delegations return immediately, so re-reading a report by id is cheap. A wait timeout is not a failure: unfinished delegates keep working and the runtime delivers their reports when they finish.",
    parameters: Type.Object({
      delegationIds: Type.Optional(
        Type.Array(Type.String({ description: "Delegation ids returned by Task (full or 8-char prefix)." }), {
          description: "Defaults to all running subagents.",
        }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("any")], {
          description: "Wait for every target (all) or the first to finish (any).",
        }),
      ),
      minCompleted: Type.Optional(
        Type.Number({
          minimum: 1,
          description: 'With mode "any": wait until at least this many finished.',
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: TASKWAIT_MAX_TIMEOUT_SECONDS,
          description: `Max seconds to wait; defaults to ${TASKWAIT_DEFAULT_TIMEOUT_SECONDS}.`,
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const p = params as {
        delegationIds?: string[];
        mode?: string;
        minCompleted?: number;
        timeoutSeconds?: number;
      };
      const ids = Array.isArray(p.delegationIds) ? p.delegationIds.map(String) : [];
      const mode = p.mode === "any" ? "any" : "all";
      const minCompleted = Math.max(1, Math.floor(p.minCompleted ?? 1));
      const timeoutSeconds = Math.min(
        Math.max(1, Math.floor(p.timeoutSeconds ?? TASKWAIT_DEFAULT_TIMEOUT_SECONDS)),
        TASKWAIT_MAX_TIMEOUT_SECONDS,
      );
      const targets = ids.length
        ? ids
            .map((id) => findDelegation(run, id))
            .filter((r): r is DelegationRecord => r !== undefined)
        : runningDelegations(run);
      if (targets.length === 0) {
        const text = ids.length
          ? "None of the requested delegation ids exist in this session. Call TaskList to see them."
          : "No subagents are currently running.";
        return { content: [{ type: "text" as const, text }], details: { delegations: [] } };
      }
      const unknownIds = ids.filter((id) => !findDelegation(run, id));
      const targetCompleted =
        mode === "all"
          ? targets.length
          : Math.min(Math.max(minCompleted, 1), targets.length);
      const deadline = Date.now() + timeoutSeconds * 1000;
      const timedOut = await waitForDelegations(targets, targetCompleted, deadline, signal);
      for (const record of targets) {
        if (record.status !== "running") record.reportedToParent = true;
      }
      const results = targets.map((record) => ({
        id: record.delegationId.slice(0, 8),
        agent: record.agentName,
        status: record.status,
        report:
          record.status === "running"
            ? delegationHeartbeat(record)
            : (record.result?.report ?? `(${record.status} without a report)`),
      }));
      const note = timedOut
        ? `Still running after ${timeoutSeconds}s: ${results.filter((r) => r.status !== "running").length}/${targets.length} finished. This is not a failure — unfinished delegates keep working and the runtime will deliver their reports when they finish. Call TaskStop only to cancel.`
        : mode === "any"
          ? `Converged after ${results.filter((r) => r.status !== "running").length} of ${targets.length} finished.`
          : "";
      const unknownNote = unknownIds.length
        ? `Unknown delegation ids (not found in this session): ${unknownIds.join(", ")}.`
        : "";
      const text = [
        results
          .map((r) => `- ${r.agent} (${r.id}, ${r.status}):\n${r.report}`)
          .join("\n\n"),
        note,
        unknownNote,
      ]
        .filter((part) => part.trim())
        .join("\n\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { status: timedOut ? "timeout" : "completed", delegations: results },
      };
    },
  };

  const listTool: AgentTool = {
    name: SUBAGENT_LIST_TOOL_NAME,
    label: "Task List",
    description:
      "List the subagents started by Task in this session with their status. Use it to check progress without waiting, or before TaskStop to choose what to stop.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async () => {
      const delegations = [...run.delegations.values()].sort(
        (a, b) => a.startedAt - b.startedAt,
      );
      const text =
        delegations.length === 0
          ? "No subagents have been started in this session."
          : delegations.map(delegationHeartbeat).join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: {
          delegations: delegations.map((r) => ({
            id: r.delegationId,
            agent: r.agentName,
            status: r.status,
          })),
        },
      };
    },
  };

  const stopTool: AgentTool = {
    name: SUBAGENT_STOP_TOOL_NAME,
    label: "Task Stop",
    description:
      "Stop one or more running subagents. `delegationIds` defaults to every running subagent. Stopped subagents report as stopped; their partial work is lost.",
    parameters: Type.Object({
      delegationIds: Type.Optional(
        Type.Array(Type.String({ description: "Delegation ids returned by Task (full or 8-char prefix)." }), {
          description: "Defaults to all running subagents.",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const p = params as { delegationIds?: string[] };
      const ids = Array.isArray(p.delegationIds) ? p.delegationIds.map(String) : [];
      const targets = ids.length
        ? ids
            .map((id) => findDelegation(run, id))
            .filter((r): r is DelegationRecord => r !== undefined)
        : runningDelegations(run);
      if (targets.length === 0) {
        const text = ids.length
          ? "None of the requested delegation ids exist in this session. Call TaskList to see them."
          : "No subagents are currently running.";
        return { content: [{ type: "text" as const, text }], details: { stopped: [] } };
      }
      const stopping = targets.filter((r) => r.status === "running");
      for (const record of stopping) {
        record.stopRequested = true;
        record.abort();
      }
      return {
        content: [
          {
            type: "text" as const,
            text: stopping.length
              ? `Stopping ${stopping.length} subagent(s): ${stopping.map((r) => r.agentName).join(", ")}. They report as stopped once they wind down.`
              : "Requested subagents are already settled; call TaskList to see their reports.",
          },
        ],
        details: { stopped: stopping.map((r) => r.delegationId) },
      };
    },
  };

  return [taskTool, waitTool, listTool, stopTool, ...buildSubagentMgmtTools(run, reload)];
}
