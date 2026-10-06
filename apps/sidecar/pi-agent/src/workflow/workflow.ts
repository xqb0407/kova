/**
 * 工作流模式的槽位与副作用层(形态仿 goal/goal.ts):
 * - per-thread 槽位:threadId -> 运行;线程键迁移原样挪动
 * - 每次变更经 sendEventChunk 推 data-workflow-state 全量快照(常驻条/面板水合;
 *   无活跃请求时静默丢弃,UI 靠 get_workflow_state 兜底)
 * - 每次变更同步落两处:转录 workflow_state 行(瘦身,水合源)+ 全量 run 文件
 *   (.kova/workflows/<runId>.json,含各步结果,resume 的指纹回放源)
 *
 * 与 goal 的分工差异:goal 的循环由 turn_end 驱动、模型宣布完成;工作流的执行由
 * runner 在后台确定性跑完,模型只有「提案」一个出口。所以这里没有 complete/blocked
 * 出口工具的结算路径,终态迁移都发生在 runner。
 */
import type { Running } from "../types";
import { sendEventChunk } from "../protocol/stream";
import { WORKFLOW_CONTINUE_PREFIX } from "pi-protocol";
import { appendWorkflowStateRow, readWorkflowStateRow } from "../sessions/transcript";
import {
  createWorkflowRun,
  formatWorkflowStatus,
  isWorkflowRun,
  rejectProposal,
  transitionRun,
  validateObjectiveText,
  type WorkflowRun,
} from "./plan-state";
import { pruneRunFiles, writeRunFile } from "./journal";

/** threadId -> 当前运行(per-thread 槽,对应 goal 的 goals) */
const workflows = new Map<string, WorkflowRun>();

export function getWorkflow(threadId: string): WorkflowRun | undefined {
  return workflows.get(threadId);
}

/** 线程键迁移(刷新后 run 改绑新 threadId):槽位原样挪过去 */
export function migrateWorkflow(oldThreadId: string, newThreadId: string): void {
  const wf = workflows.get(oldThreadId);
  if (wf) workflows.set(newThreadId, { ...wf, threadId: newThreadId });
  workflows.delete(oldThreadId);
}

/** 会话/线程销毁时回收槽位 */
export function clearWorkflow(threadId: string): void {
  workflows.delete(threadId);
}

/* --------------------- 执行器挂钩(避免 门面 -> runner 的模块环) ---------------------
 * runner 启动时注册;门面在「用户接管/切档/暂停」时调用,runner 收到即中止在跑
 * 步骤并结算。goal 不需要这层(它的循环长在 turn 边界上),工作流的执行在后台,
 * 必须有从槽位操作到执行器的通道。 */

let abortExecutionHook: ((threadId: string) => void) | undefined;

export function setWorkflowAbortHook(hook: (threadId: string) => void): void {
  abortExecutionHook = hook;
}

/**
 * 终局交付挂钩(runner complete 时调用;sessions.ts 注册):把合成报告经
 * dispatchPrompt 的续跑轮带回对话。挂钩在门面层只挂名,避免 门面 -> runner ->
 * prompt-pipeline 的模块环。
 */
let deliveryExecutionHook: ((run: Running, wf: WorkflowRun) => void) | undefined;

export function setWorkflowDeliveryHook(hook: (run: Running, wf: WorkflowRun) => void): void {
  deliveryExecutionHook = hook;
}

/** runner 专用:终局交付的出口(与 setWorkflowDeliveryHook 同一槽位) */
export function deliverWorkflowResult(run: Running, wf: WorkflowRun): void {
  deliveryExecutionHook?.(run, wf);
}

/* ------------------------------ 变更出口 ------------------------------ */

/**
 * 落盘 + 广播的唯一出口。三路各自失败都不影响内存状态:
 * - 转录行:瘦身后落(goal_state 行同款),get_workflow_state 水合源
 * - run 文件:全量(有 plan 才有账可写)
 * - chunk:常驻条/面板实时刷新
 * 终态顺手清一次目录(终态记录保留上限,最旧先弃)。
 */
export function commitWorkflow(run: Running, wf: WorkflowRun | undefined): void {
  const threadId = run.threadId;
  if (wf) {
    workflows.set(threadId, wf);
  } else {
    workflows.delete(threadId);
  }
  if (run.sessionId) {
    try {
      appendWorkflowStateRow(run.sessionId, wf ? slimRunForTranscript(wf) : null);
    } catch {
      // 落盘失败不阻断:内存里的事实还在,下一次变更会再落
    }
  }
  if (wf && wf.plan) {
    writeRunFile(run.cwd, wf);
    const terminal = wf.status === "complete" || wf.status === "failed";
    if (terminal) pruneRunFiles(run.cwd, (id) => workflows.get(threadId)?.id === id);
  }
  emitWorkflowState(run);
}

/** 转录行的瘦身投影:剥掉各步 result/fingerprint(结果可能 12k/步,行要能高频写) */
function slimRunForTranscript(wf: WorkflowRun): Record<string, unknown> {
  const steps: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(wf.steps)) {
    const { result: _result, fingerprint: _fingerprint, ...rest } = entry;
    steps[key] = rest;
  }
  return { ...wf, steps };
}

/** 推全量快照给常驻条/面板(无活跃请求时 sendEventChunk 自行丢弃) */
export function emitWorkflowState(run: Running): void {
  sendEventChunk(
    run.threadId,
    { type: "data-workflow-state", data: workflowStatePayload(run.threadId) },
    run.sessionId,
  );
}

/** 协议投影:只带 UI 要用的字段(prompt 模板、指纹、并发调度等内部判据不进协议) */
export function workflowStatePayload(threadId: string): {
  run: Record<string, unknown> | null;
} {
  const wf = workflows.get(threadId);
  if (!wf) return { run: null };
  const steps = (wf.plan?.steps ?? []).map((s) => ({
    key: s.key,
    kind: s.kind,
    phase: s.phase,
    title: s.title,
    ...(s.agent ? { agent: s.agent } : {}),
    ...(s.model ? { model: s.model } : {}),
    dependsOn: s.dependsOn,
    // gate 命令逐字进协议:确认卡展示的就是用户授权执行的那串字面量
    ...(s.gate ? { gate: { command: s.gate.command, ...(s.gate.args ? { args: s.gate.args } : {}) } } : {}),
    ...(s.foreach ? { foreach: { from: s.foreach.from } } : {}),
    ...(s.verify ? { verify: { reviewers: s.verify.reviewers ?? 2, threshold: s.verify.threshold ?? 0.5 } } : {}),
    ...(s.retries ? { retries: s.retries } : {}),
    ...(s.onFail ? { onFail: s.onFail } : {}),
  }));
  const stepStates = Object.values(wf.steps).map((e) => ({
    key: e.key,
    status: e.status,
    ...(e.error ? { error: e.error } : {}),
    ...(e.startedAt !== undefined ? { startedAt: e.startedAt } : {}),
    ...(e.endedAt !== undefined ? { endedAt: e.endedAt } : {}),
    ...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
    ...(e.delegationId ? { delegationId: e.delegationId } : {}),
    // foreach 子项:父键与项原文(截断)——运行卡要能展开显示每个子项
    ...(e.parent ? { parent: e.parent } : {}),
    ...(e.item ? { item: e.item.slice(0, 200) } : {}),
  }));
  return {
    run: {
      id: wf.id,
      objective: wf.objective,
      status: wf.status,
      statusLine: formatWorkflowStatus(wf),
      ...(wf.title ? { title: wf.title } : {}),
      ...(wf.plan ? { steps } : {}),
      ...(wf.plan ? { stepStates } : {}),
      ...(wf.proposalFeedback ? { proposalFeedback: wf.proposalFeedback } : {}),
      ...(wf.completionSummary ? { completionSummary: wf.completionSummary } : {}),
      tokensUsed: wf.tokensUsed,
      startedAt: wf.startedAt,
      updatedAt: wf.updatedAt,
    },
  };
}

/* ------------------------------ 对外操作 ------------------------------ */

/**
 * 用户切到工作流档后的首条消息即目标(建「编排中」运行)。
 * 已有运行时不动——与 goal 一致,新一轮从「清除」开始,不靠猜意图。
 */
export function startWorkflow(run: Running, objective: string): WorkflowRun {
  const wf = createWorkflowRun(run.threadId, objective);
  commitWorkflow(run, wf);
  return wf;
}

/** 提案驳回(proposed → proposing 并带回意见):重提轮据此修改剧本 */
export function rejectWorkflowPlan(run: Running, feedback?: string): WorkflowRun | undefined {
  const wf = getWorkflow(run.threadId);
  if (!wf) return undefined;
  const next = rejectProposal(wf, feedback);
  if (!next) return undefined;
  commitWorkflow(run, next);
  return next;
}

/**
 * 用户接管(running 时来了非注入消息):暂停 + 中止在跑步骤。
 * abort 挂钩由 runner 注册;挂钩缺席(执行器还没起)时只搬状态。
 */
export function pauseWorkflowForUserInput(run: Running): void {
  const wf = getWorkflow(run.threadId);
  if (!wf || wf.status !== "running") return;
  abortExecutionHook?.(run.threadId);
  const paused = transitionRun(wf, "paused", {
    expectedRunId: wf.id,
    reason: "user sent a message while the workflow was running",
  });
  if (paused) commitWorkflow(run, paused);
}

/** 离开 workflow 档时收尾(applyMode 调用):running 转 paused,切回来还能续 */
export function pauseWorkflowOnModeExit(run: Running): void {
  const wf = getWorkflow(run.threadId);
  if (!wf || wf.status !== "running") return;
  abortExecutionHook?.(run.threadId);
  const paused = transitionRun(wf, "paused", {
    expectedRunId: wf.id,
    reason: "user left workflow mode while the run was executing",
  });
  if (paused) commitWorkflow(run, paused);
}

/**
 * 用户消息进 run 时的工作流同步(prompt-pipeline 每轮开跑前调用)。
 * - workflow 档且无运行 → 这条消息就是编排目标(唯一入口,与 goal 同款)
 * - proposed → 这条消息是对剧本的意见:驳回并带回 feedback,本轮模型重提
 * - proposing → 静默(本轮本来就是提案轮,上下文里已有这条消息)
 * - running → 用户接管(暂停);paused/终态 → 不动(等人/已结算,清除走常驻条)
 */
export function syncWorkflowOnUserPrompt(run: Running, rawText: string): void {
  if (run.mode !== "workflow") return;
  // 我们自己注入的交付消息也走这条路;不在这里短路会被当成用户接管
  if (isInternalInjectionText(rawText)) return;
  const current = getWorkflow(run.threadId);
  if (!current) {
    const objective = rawText.trim();
    if (!validateObjectiveText(objective)) return;
    startWorkflow(run, objective);
    return;
  }
  if (current.status === "proposed") {
    const rejected = rejectWorkflowPlan(run, rawText);
    if (rejected) return;
  }
  if (current.status === "running") {
    pauseWorkflowForUserInput(run);
  }
  // proposing / paused / complete / failed:不动(见上)
}

/** 注入文本的识别:协议契约层的前缀判定单源 */
function isInternalInjectionText(text: string): boolean {
  return text.startsWith(WORKFLOW_CONTINUE_PREFIX);
}

/* -------------------------------- 恢复 -------------------------------- */

/**
 * 从转录回放运行(resolveSession 恢复分支调用,对齐 restoreGoal 的时点)。
 * 回放出来的 running 是个谎报:驱动执行的进程随重启没了,降级成 paused 并落一行,
 * 不自动续跑——重启后没人看着就自动扇出烧钱不是好默认,交给用户点「继续」。
 * 步骤结果的权威副本在 run 文件,resume 时由 runner 按指纹回放。
 */
export function restoreWorkflow(threadId: string, sessionId: string): void {
  const row = readWorkflowStateRow(sessionId);
  if (!row) return;
  const parsed: unknown = JSON.parse(JSON.stringify(row));
  if (!isWorkflowRun(parsed)) return;
  const wf: WorkflowRun =
    parsed.status === "running"
      ? {
          ...parsed,
          status: "paused",
          pauseReason: "sidecar restarted while the workflow was running",
          updatedAt: Date.now(),
        }
      : parsed;
  // 恢复的执行器必然不存在:任何 running 步骤都是中断残影,对齐 delegation 的恢复语义
  const settled: WorkflowRun = {
    ...wf,
    steps: Object.fromEntries(
      Object.entries(wf.steps).map(([key, entry]) => [
        key,
        entry.status === "running" ? { ...entry, status: "interrupted" as const } : entry,
      ]),
    ),
  };
  workflows.set(threadId, settled);
  if (settled !== parsed) {
    try {
      appendWorkflowStateRow(sessionId, slimRunForTranscript(settled));
    } catch {
      // 落盘失败不阻断:内存里已经是 paused
    }
  }
}
