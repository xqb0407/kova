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
import { arr, lit, map, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "../model/model-catalog";
import { sendEventChunk } from "../protocol/stream";
import {
  loadSubagentDefinitions,
  normalizeSubagentName,
  type SubagentDefinition,
} from "./subagent-definitions";
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
  findDelegationRecord,
  SUBAGENT_LIST_TOOL_NAME,
  SUBAGENT_STOP_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
  SUBAGENT_WAIT_TOOL_NAME,
} from "./delegation";
import { SubagentRun } from "./run";
import { resolveSubagentCapabilities } from "./capabilities";
import { clearApprovalsForDelegation, subagentToolGate } from "../agent/modes";
import { recordGoalToolResult } from "../goal/goal-evidence";
import { logErr } from "../log";
import { SUBAGENT_MESSAGE_TOOL_NAME } from "./delegation";
import { openDelegationActivity, writeDelegationHistory } from "./activity-store";
import { getSubagentMaxConcurrency } from "./settings";
import type { SubagentHistoryMessage } from "../types";

const TASKWAIT_DEFAULT_TIMEOUT_SECONDS = 180;
const TASKWAIT_MAX_TIMEOUT_SECONDS = 3600;

/** 当前会话的并发占用：Task 与 resume 共用；导出便于单测运行时设置是否生效 */
export function subagentConcurrencyState(run: Running): {
  running: number;
  limit: number;
  reached: boolean;
} {
  const limit = getSubagentMaxConcurrency();
  const running = runningDelegations(run).length;
  return { running, limit, reached: running >= limit };
}

/**
 * 解析 delegate 用的模型：Task 的 model 覆盖 > 定义固定 > 继承会话当前模型。
 * 目录里查不到或没凭据时返回 error 文本（放进工具结果，模型可读）。
 */
async function resolveDelegateModel(
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
  const local =
    run.delegations.get(id) ??
    [...run.delegations.values()].find((r) => r.delegationId.startsWith(id) && id.length >= 4);
  if (local) return local;
  // 重启后父会话的委派表是空的：按 id 回读磁盘。只认属于本会话的记录
  // （ownerSession 是归属证明；老记录没有这个字段就不猜）。
  if (id.length < 4) return undefined;
  const restored = findDelegationRecord(id);
  if (!restored?.ownerSession) return undefined;
  // 会话 id 是归属证明：同一 thread 换过会话（new_session）后，老委派不能
  // 被新会话的父代理寻址。
  if (restored.ownerSession.sessionId !== run.sessionId) return undefined;
  run.delegations.set(restored.delegationId, restored);
  return restored;
}

/** 一次启动的公共参数（Task 初次与 resume 共用） */
type LaunchParams = {
  run: Running;
  record: DelegationRecord;
  definition: SubagentDefinition;
  model: Model<Api>;
  tools: AgentTool[];
  capabilityBlock: string;
  /** 初次启动的 brief；resume 轮省略（上下文由 initialMessages 承载） */
  brief?: string;
  initialMessages?: SubagentHistoryMessage[];
  /** resume 轮的轮次/工具计数基数（对外值 = 本轮实例计数 + 基数） */
  turnBase?: number;
  toolCallBase?: number;
};

/**
 * 拉起一个 SubagentRun 并接好结算链：审批清理、结算、历史存档。
 * Task 初次启动与 SendMessage-resume 共用——两条路只有 initialMessages/task
 * 的差别，审批链/证据回调/轨迹因果边完全一致。
 */
function launchSubagentRun(launch: LaunchParams): void {
  const {
    run,
    record,
    definition,
    model,
    tools,
    capabilityBlock,
    brief,
    initialMessages,
    turnBase,
    toolCallBase,
  } = launch;
  const controller = new AbortController();
  record.abort = () => controller.abort();
  const delegate = new SubagentRun({
    definition,
    ...(brief ? { task: brief } : {}),
    ...(initialMessages?.length ? { initialMessages } : {}),
    ...(turnBase !== undefined ? { turnBase } : {}),
    ...(toolCallBase !== undefined ? { toolCallBase } : {}),
    model,
    cwd: run.cwd,
    tools,
    capabilityBlock,
    sessionId: record.delegationId,
    traceSessionId: run.sessionId,
    // 轨迹因果边：把这次 Task tool_call 的父 run/父 span 身份写到子 run 上
    parentRunId: run.trace?.traceId,
    // 子代理的 write/edit/bash 走**父会话**的审批链：档位、工作区边界、
    // 写根清单、无人值守策略与主代理同一套判定（见 modes.subagentToolGate）
    toolGate: subagentToolGate(run, record.delegationId),
    onToolResult: (context) => recordGoalToolResult(run, context),
    signal: controller.signal,
    onActivity: (item) => pushActivity(record, item),
    // 每轮中途存档：sidecar 在委派执行中被重启时，resume 仍能拿到最后一个
    // 完整轮次（settle 的终态存档仍是权威版本）
    onHistory: (messages) => {
      if (!messages.length) return;
      record.history = messages;
      writeDelegationHistory(record.delegationId, messages);
    },
  });
  // 运行中插话通道：SendMessage / 对话页输入经 record.sendMessage 进 delegate
  record.sendMessage = (text: string) => delegate.steer(text);
  // 结束时的会话历史存档：settleDelegation 消费（resume 初始上下文）
  record.archiveHistory = () => delegate.historySnapshot();
  delegate
    .run()
    .then(
      (result) => {
        // 委派结束即清理它名下的挂起审批：子代理不会再等它们了，
        // 留着就是一张永远没人答的卡（子代理已返回，没人在等）
        clearApprovalsForDelegation(run, record.delegationId);
        return settleDelegation(run, record, result);
      },
      // SubagentRun.run() 自会把错误折进结果；这个兜底只是防止意外 rejection
      // 让委派永远卡在 running。
      (error: unknown) => {
        clearApprovalsForDelegation(run, record.delegationId);
        return settleDelegation(run, record, {
          agentName: definition.name,
          modelId: model.id,
          status: "failed",
          report: "",
          // 意外 rejection 也要保住跨轮基数，不能把累计计数清零
          turns: turnBase ?? 0,
          toolCalls: toolCallBase ?? 0,
          error: {
            code: "UNEXPECTED_DELEGATION_REJECTION",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
}

/** 正在异步准备 resume 的委派：两次并发发送不能拉起两个 SubagentRun */
const resuming = new Set<string>();

/**
 * resume 一条已结束的委派：存档历史 + 新消息整体作为初始上下文，
 * 原位重置 record 为 running（同 id：面板 tab、TaskWait 寻址都不换）。
 * 父会话按需物化（resolveSession 懒建/恢复）：对话页不要求父会话仍驻留。
 * 返回错误文本（模型可读）或 undefined（成功）。
 * 工具（SendMessage）与协议 handler（send_subagent_message）共用。
 *
 * 并发闸只覆盖异步准备段：准备完成、record 翻成 running 后，后续消息走
 * steer（handler/tool 都会先看 status），不会再进来。
 */
export async function resumeDelegation(
  record: DelegationRecord,
  text: string,
  fallbackOwner?: { sessionId: string; threadId: string; cwd?: string },
): Promise<string | undefined> {
  if (record.status === "running") {
    return `Cannot resume ${record.agentName} (${record.delegationId.slice(0, 8)}): it is still running; use SendMessage to steer it.`;
  }
  if (resuming.has(record.delegationId)) {
    return `Cannot resume ${record.agentName} (${record.delegationId.slice(0, 8)}): a resume is already starting.`;
  }
  resuming.add(record.delegationId);
  try {
    return await resumeDelegationOnce(record, text, fallbackOwner);
  } finally {
    resuming.delete(record.delegationId);
  }
}

async function resumeDelegationOnce(
  record: DelegationRecord,
  text: string,
  fallbackOwner?: { sessionId: string; threadId: string; cwd?: string },
): Promise<string | undefined> {
  // 没有存档历史就不能叫 resume：只带一条新消息重开会伪造"上下文仍在"，
  // 子代理会声称记得从未发生过的事。明确拒绝，让调用方重新 Task。
  if (!record.history?.length) {
    return record.status === "interrupted"
      ? `Cannot resume ${record.agentName} (${record.delegationId.slice(0, 8)}): the run was interrupted before any conversation history was saved. Start a new Task instead.`
      : `Cannot resume ${record.agentName} (${record.delegationId.slice(0, 8)}): no saved conversation is available. Start a new Task instead.`;
  }
  // 父会话按需物化；记录里没有 ownerSession 时用调用方提供的当前会话兜底
  // （老活动文件没有这个字段，但工具路径始终知道自己属于哪个父会话）。
  const owner = record.ownerSession ?? fallbackOwner;
  if (!owner) {
    return `Cannot resume ${record.agentName} (${record.delegationId.slice(0, 8)}): the owning session could not be determined.`;
  }
  // 动态 import 避环：sessions/resolve.ts 组装工具表时引用本模块（buildSubagentTools），
  // 静态引 resolveSession 会成环；运行时模块图已闭合，动态取无开销。
  const { resolveSession } = await import("../sessions/sessions");
  let run: Running;
  try {
    run = await resolveSession(owner.threadId, owner.sessionId);
  } catch (err) {
    return `Cannot resume ${record.agentName} (${record.delegationId.slice(0, 8)}): its owning session is no longer available (${
      err instanceof Error ? err.message : String(err)
    }).`;
  }
  record.ownerSession = {
    sessionId: run.sessionId,
    threadId: run.threadId,
    cwd: run.cwd,
  };
  // 先看并发占用，超限时不必再加载定义/模型/能力
  const capacity = subagentConcurrencyState(run);
  if (capacity.reached) {
    return `Cannot resume: ${capacity.running} subagent(s) are running (limit ${capacity.limit}). Wait with TaskWait or stop some with TaskStop first.`;
  }
  const definition = await findDefinitionForResume(run, record);
  if (!definition) {
    return `Cannot resume ${record.agentName} (${record.delegationId.slice(0, 8)}): its definition is no longer available in this session.`;
  }
  const resolved = await resolveDelegateModel(run, definition, "");
  const model = resolved.model;
  if (!model) return resolved.error ?? "model unavailable";
  const caps = await resolveSubagentCapabilities(
    definition,
    run.cwd,
    run.baseTools,
    run.threadId,
    () => run.approvalLevel,
  );
  if (caps.tools.length === 0) {
    return `Cannot resume: the ${definition.name} subagent declares no tool available in this session.`;
  }
  // 初检之后还有模型/能力解析的 await；并发 resume 可能同时通过初检。
  // 这里到 record.status="running" 全同步，作为权威名额闸门。
  const finalCapacity = subagentConcurrencyState(run);
  if (finalCapacity.reached) {
    return `Cannot resume: ${finalCapacity.running} subagent(s) are running (limit ${finalCapacity.limit}). Wait with TaskWait or stop some with TaskStop first.`;
  }
  const history = record.history ?? [];
  // 跨轮累加的基数：resume 轮的对外轮次/工具计数 = 本轮实例计数 + 基数
  const turnBase = record.turns;
  const toolCallBase = record.toolCalls;
  // 从磁盘恢复的记录不在父会话的委派表里：不补登记的话 TaskWait/TaskList/
  // TaskStop 都看不见它，并发上限也会漏算。
  if (!run.delegations.has(record.delegationId)) {
    run.delegations.set(record.delegationId, record);
  }
  // 恢复的记录也没有活动写盘器（原进程的 writer 已随重启消失）：不重开的话
  // 本轮活动只广播不落盘，下次重启就丢了。open 是幂等的，同进程不重复写 meta。
  openDelegationActivity(record);
  // 原位重置：同 id 继续，轮次/工具计数经 base 累加（由 launch/settle 回写）
  // 保存上一轮终态：同步启动失败时原样还回去，不能把已有报告弄丢
  const previousStatus = record.status;
  const previousResult = record.result;
  const previousCompletedAt = record.completedAt;
  const previousReported = record.reportedToParent;
  record.status = "running";
  record.stopRequested = false;
  record.result = undefined;
  record.reportedToParent = false;
  record.completedAt = undefined;
  let resolveCompletion: () => void = () => {};
  record.completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  record.resolveCompletion = resolveCompletion;
  // 先记消息再拉起运行：run 的第一批活动（turn/thinking）不能排在用户追问前面
  pushActivity(record, { kind: "message", text, at: Date.now() });
  // resume 开始标记：活动文件里上一轮的 completed/failed 不能让重启后的回读
  // 把这一轮误判成已结束（回读把文件里的 running 映射为 interrupted）。
  pushActivity(record, {
    kind: "status",
    status: "running",
    turns: turnBase,
    toolCalls: toolCallBase,
    canResume: false,
    at: Date.now(),
  });
  try {
    launchSubagentRun({
      run,
      record,
      definition,
      model,
      tools: caps.tools,
      capabilityBlock: caps.promptBlock,
      initialMessages: [
        ...history,
        { role: "user", content: `[user follow-up] ${text}` },
      ],
      turnBase,
      toolCallBase,
    });
  } catch (err) {
    // 同步启动失败（构造 Agent 抛错等）：不能让 record 永远停在 running，
    // 也不能让 TaskWait 等到一个不存在的轮次；上一轮终态/报告原样还回。
    record.status = previousStatus;
    record.result = previousResult;
    record.completedAt = previousCompletedAt;
    record.reportedToParent = previousReported;
    record.resolveCompletion();
    pushActivity(record, {
      kind: "status",
      status: previousStatus,
      turns: record.turns,
      toolCalls: record.toolCalls,
      report: previousResult?.report,
      canResume:
        (record.history?.length ?? 0) > 0 && record.ownerSession !== undefined,
      at: previousCompletedAt ?? Date.now(),
    });
    return `Cannot resume ${record.agentName} (${record.delegationId.slice(0, 8)}): ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  return undefined;
}

/** resume 时找回定义：内存定义优先，找不到再按名字全量加载一次 */
async function findDefinitionForResume(
  run: Running,
  record: DelegationRecord,
): Promise<SubagentDefinition | undefined> {
  const { definitions } = await loadSubagentDefinitions({ cwd: run.cwd });
  return (
    definitions.find((d) => d.name === record.agentName) ??
    definitions.find(
      (d) => normalizeSubagentName(d.name) === normalizeSubagentName(record.agentName),
    )
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
      "`task` is the delegate's only initial instruction. It cannot see this conversation, so state the goal, the paths and facts it cannot infer, and exactly what to report back. If it goes off track, use SendMessage with its delegationId to inject a correction at its next step (running) or continue the same conversation after it finishes.",
      "Pass `model` (\"provider/modelId\") only to pick a cheaper or faster model for a simple job; omit it to inherit this session's model.",
      "To run delegates concurrently, emit several Task calls in one assistant message. A message that mixes Task with any other tool runs one call at a time. You may keep working or talk to the user while they run; the runtime delivers their reports when they finish. Call TaskStop only to cancel.",
      "Concurrent delegates are capped by the app's subagent concurrency setting; when the cap is reached, Task returns an error instead of queueing.",
      `Available subagents:\n${definitions
        .map((d) => `- ${d.name} (tools: ${d.tools.join(", ")}): ${d.description}`)
        .join("\n")}`,
    ].join("\n\n"),
    parameters: obj({
      agent: str({
        description: `Name of the subagent to run: ${names.join(", ")}.`,
      }),
      task: str({
        description:
          "The complete brief: goal, context the delegate cannot infer, and the exact report you want back.",
      }),
      description: opt(
        str({
          description: "Short label for this delegation (3-6 words), shown to the user.",
        }),
      ),
      model: opt(
        str({
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
      const capacity = subagentConcurrencyState(run);
      if (capacity.reached) {
        return subagentToolError(
          `${capacity.running} subagent(s) are running (limit ${capacity.limit}). Wait for some with TaskWait or stop them with TaskStop before delegating more.`,
        );
      }
      const resolved = await resolveDelegateModel(run, definition, String(p.model ?? "").trim());
      const model = resolved.model;
      if (!model) return subagentToolError(resolved.error ?? "model unavailable");
      // 五个能力维度在一次解析里全部落地（tools / skills / knowledge / mcp / memory）
      const caps = await resolveSubagentCapabilities(
        definition,
        run.cwd,
        baseTools,
        run.threadId,
        () => run.approvalLevel,
      );
      const tools = caps.tools;
      for (const d of caps.diagnostics) logErr("subagent capability:", d);
      if (tools.length === 0) {
        return subagentToolError(
          `The ${definition.name} subagent declares no tool available in this session.`,
        );
      }
      // 初检之后还有模型/能力解析的 await；同一条消息里的多个 Task 会同时通过
      // 初检。这里到写入 run.delegations 之间没有 await，才是权威名额闸门。
      const finalCapacity = subagentConcurrencyState(run);
      if (finalCapacity.reached) {
        return subagentToolError(
          `${finalCapacity.running} subagent(s) are running (limit ${finalCapacity.limit}). Wait for some with TaskWait or stop them with TaskStop before delegating more.`,
        );
      }
      const delegationId = randomUUID();
      const label = String(p.description ?? "").trim();
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
        // launchSubagentRun 同步接管 abort（用自己的 AbortController）
        abort: () => {},
      };
      run.delegations.set(delegationId, record);
      record.ownerSession = { sessionId: run.sessionId, threadId: run.threadId, cwd: run.cwd };
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
      launchSubagentRun({
        run,
        record,
        definition,
        model,
        tools,
        capabilityBlock: caps.promptBlock,
        brief,
      });
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
    parameters: obj({
      delegationIds: opt(
        arr(str({ description: "Delegation ids returned by Task (full or 8-char prefix)." }), {
          description: "Defaults to all running subagents.",
        }),
      ),
      mode: opt(
        union([lit("all"), lit("any")], {
          description: "Wait for every target (all) or the first to finish (any).",
        }),
      ),
      minCompleted: opt(
        num({
          minimum: 1,
          description: 'With mode "any": wait until at least this many finished.',
        }),
      ),
      timeoutSeconds: opt(
        num({
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
    parameters: obj({}),
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
    parameters: obj({
      delegationIds: opt(
        arr(str({ description: "Delegation ids returned by Task (full or 8-char prefix)." }), {
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
        // 挂起中的审批按拒绝结算：abort 断不了子代理挂在工具调用里的 await，
        // 不结算掉它就停不下来（而那张卡此刻也没人会点）
        clearApprovalsForDelegation(run, record.delegationId);
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

  const messageTool: AgentTool = {
    name: SUBAGENT_MESSAGE_TOOL_NAME,
    label: "Send Message",
    description:
      "Send a follow-up message to a subagent started with Task. Running subagent: the message is consumed at its next model-call boundary — no interruption, no restart; use it to correct the brief or add context it cannot infer. Finished subagent (completed/failed/truncated/stopped): it RESUMES with its full prior conversation plus your message as a new turn and returns to running; wait with TaskWait for the new report. Do not use it to re-state the original task.",
    parameters: obj({
      delegationId: str({
        description: "Delegation id returned by Task (full or 8-char prefix).",
      }),
      message: str({
        description:
          "The follow-up: what to correct, add, or do next. Self-contained — the subagent sees its own prior conversation but nothing else from this chat.",
      }),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const p = params as { delegationId?: string; message?: string };
      const id = String(p.delegationId ?? "").trim();
      const text = String(p.message ?? "").trim();
      if (!id) return subagentToolError("delegationId is required.");
      if (!text) return subagentToolError("message is required.");
      const record = findDelegation(run, id);
      if (!record) {
        return subagentToolError(
          `Unknown delegation id "${id}". Call TaskList to see the delegations of this session.`,
        );
      }
      if (record.status === "running") {
        const accepted = record.sendMessage?.(text) ?? false;
        if (!accepted) {
          if (record.status === "running") {
            // steer 失败且仍是 running（未 settle 的窄窗口）：让模型重试一次
            return subagentToolError(
              `The ${record.agentName} subagent (${record.delegationId.slice(0, 8)}) just finished; retry to resume it with this message.`,
            );
          }
          // settle 已把状态翻成终态：落回下面的 resume 路径
        } else {
          pushActivity(record, { kind: "message", text, at: Date.now() });
          return {
            content: [
              {
                type: "text" as const,
                text: `Delivered to ${record.agentName} (${record.delegationId.slice(0, 8)}). It keeps running and will see the message at its next step.`,
              },
            ],
            details: { delegationId: record.delegationId, delivered: true, resumed: false },
          };
        }
      }
      // 已结束：resume（无存档历史 = 无法续聊，明确报错）
      if (!record.history?.length) {
        return subagentToolError(
          `The ${record.agentName} subagent (${record.delegationId.slice(0, 8)}) finished without an archived conversation, so it cannot be resumed. Start a new Task instead.`,
        );
      }
      const error = await resumeDelegation(record, text, {
        sessionId: run.sessionId,
        threadId: run.threadId,
        cwd: run.cwd,
      });
      if (error) return subagentToolError(error);
      return {
        content: [
          {
            type: "text" as const,
            text: `Resumed ${record.agentName} (${record.delegationId.slice(0, 8)}) with your follow-up; it is running again with its prior conversation as context. Call TaskWait with this delegationId for the new report.`,
          },
        ],
        details: { delegationId: record.delegationId, delivered: true, resumed: true },
      };
    },
  };

  return [
    taskTool,
    waitTool,
    listTool,
    stopTool,
    messageTool,
    ...buildSubagentMgmtTools(run, reload),
  ];
}
