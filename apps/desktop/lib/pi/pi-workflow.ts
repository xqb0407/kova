"use client";

import { useEffect, useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import { piSessionIdForThread, piStoreKeyForThread } from "@/lib/pi/pi-thread-adapter";
import type { Playbook, WorkflowRunSummary, WorkflowState } from "pi-protocol";

/**
 * 工作流模式常驻条/面板的运行快照(sidecar workflow/workflow.ts 状态机镜像)。
 * 形态与 pi-goal.ts 同款:per-thread store + data-workflow-state chunk 推更 +
 * 请求水合,没有乐观本地写入——步骤状态只有 sidecar 的执行器算得准,
 * 按钮动作一律走请求-响应,等 sidecar 回包再刷新。
 */

export type WorkflowRunStatus =
  | "proposing"
  | "proposed"
  | "running"
  | "paused"
  | "complete"
  | "failed";

/** 步骤声明(UI 投影;完整 prompt 模板不进协议) */
export type WorkflowStepView = {
  key: string;
  kind: string;
  phase?: string;
  title: string;
  agent?: string;
  model?: string;
  dependsOn: string[];
  /** gate 的确定性命令(确认卡逐字展示;用户确认的就是它) */
  gate?: { command: string; args?: string[] };
  /** foreach 扇出(仅 delegate) */
  foreach?: { from: string };
  /** verify:N 个对抗式评审投票 */
  verify?: { reviewers?: number; threshold?: number };
  retries?: number;
  onFail?: string;
};

/** 步骤运行状态(与 steps 按 key 对齐;foreach 子项带 parent/item) */
export type WorkflowStepState = {
  key: string;
  status: "pending" | "running" | "done" | "failed" | "skipped" | "interrupted";
  error?: string;
  startedAt?: number;
  endedAt?: number;
  tokens?: number;
  delegationId?: string;
  parent?: string;
  item?: string;
};

export type WorkflowSnapshot = {
  id: string;
  objective: string;
  status: WorkflowRunStatus;
  statusLine: string;
  title?: string;
  steps?: WorkflowStepView[];
  stepStates?: WorkflowStepState[];
  proposalFeedback?: string;
  completionSummary?: string;
  /** 由哪个剧本发起（库路径运行；运行卡的「存为剧本」据此避免重复保存） */
  playbookName?: string;
  playbookId?: string;
  tokensUsed: number;
  startedAt: number;
  updatedAt: number;
};

export type WorkflowStoreState = { run: WorkflowSnapshot | null };

export const EMPTY_WORKFLOW_STATE: WorkflowStoreState = { run: null };

/** 待确认卡出得出来的判定(proposed ≠ running,条上不能报「进行中」) */
export function isWorkflowAwaitingConfirmation(run: WorkflowSnapshot): boolean {
  return run.status === "proposed";
}

function normalizeStatus(raw: unknown): WorkflowRunStatus | null {
  return raw === "proposing" ||
    raw === "proposed" ||
    raw === "running" ||
    raw === "paused" ||
    raw === "complete" ||
    raw === "failed"
    ? raw
    : null;
}

function normalizeSteps(raw: unknown): WorkflowStepView[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps: WorkflowStepView[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const s = entry as Record<string, unknown>;
    if (typeof s.key !== "string" || typeof s.kind !== "string" || typeof s.title !== "string") {
      continue;
    }
    const gateRaw = s.gate as { command?: unknown; args?: unknown } | undefined;
    const foreachRaw = s.foreach as { from?: unknown } | undefined;
    const verifyRaw = s.verify as { reviewers?: unknown; threshold?: unknown } | undefined;
    steps.push({
      key: s.key,
      kind: s.kind,
      ...(typeof s.phase === "string" ? { phase: s.phase } : {}),
      title: s.title,
      ...(typeof s.agent === "string" ? { agent: s.agent } : {}),
      ...(typeof s.model === "string" ? { model: s.model } : {}),
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d): d is string => typeof d === "string") : [],
      ...(gateRaw && typeof gateRaw.command === "string"
        ? {
            gate: {
              command: gateRaw.command,
              ...(Array.isArray(gateRaw.args)
                ? { args: gateRaw.args.filter((a): a is string => typeof a === "string") }
                : {}),
            },
          }
        : {}),
      ...(foreachRaw && typeof foreachRaw.from === "string" ? { foreach: { from: foreachRaw.from } } : {}),
      ...(verifyRaw
        ? {
            verify: {
              ...(typeof verifyRaw.reviewers === "number" ? { reviewers: verifyRaw.reviewers } : {}),
              ...(typeof verifyRaw.threshold === "number" ? { threshold: verifyRaw.threshold } : {}),
            },
          }
        : {}),
      ...(typeof s.retries === "number" ? { retries: s.retries } : {}),
      ...(typeof s.onFail === "string" ? { onFail: s.onFail } : {}),
    });
  }
  return steps;
}

function normalizeStepStates(raw: unknown): WorkflowStepState[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const states: WorkflowStepState[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const s = entry as Record<string, unknown>;
    if (typeof s.key !== "string") continue;
    const status = s.status;
    if (
      status !== "pending" &&
      status !== "running" &&
      status !== "done" &&
      status !== "failed" &&
      status !== "skipped" &&
      status !== "interrupted"
    ) {
      continue;
    }
    states.push({
      key: s.key,
      status,
      ...(typeof s.error === "string" ? { error: s.error } : {}),
      ...(typeof s.startedAt === "number" ? { startedAt: s.startedAt } : {}),
      ...(typeof s.endedAt === "number" ? { endedAt: s.endedAt } : {}),
      ...(typeof s.tokens === "number" ? { tokens: s.tokens } : {}),
      ...(typeof s.delegationId === "string" ? { delegationId: s.delegationId } : {}),
      ...(typeof s.parent === "string" ? { parent: s.parent } : {}),
      ...(typeof s.item === "string" ? { item: s.item } : {}),
    });
  }
  return states;
}

/** chunk / 响应里的运行是否形状完整(loose 协议:脏数据一律当无运行) */
function normalizeRun(raw: unknown): WorkflowSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<WorkflowSnapshot>;
  if (typeof r.id !== "string" || typeof r.objective !== "string") return null;
  const status = normalizeStatus(r.status);
  if (!status || typeof r.statusLine !== "string") return null;
  return {
    id: r.id,
    objective: r.objective,
    status,
    statusLine: r.statusLine,
    ...(typeof r.title === "string" ? { title: r.title } : {}),
    ...(normalizeSteps(r.steps) ? { steps: normalizeSteps(r.steps) } : {}),
    ...(normalizeStepStates(r.stepStates)
      ? { stepStates: normalizeStepStates(r.stepStates) }
      : {}),
    ...(typeof r.proposalFeedback === "string" ? { proposalFeedback: r.proposalFeedback } : {}),
    ...(typeof r.completionSummary === "string" ? { completionSummary: r.completionSummary } : {}),
    ...(typeof r.playbookName === "string" ? { playbookName: r.playbookName } : {}),
    ...(typeof r.playbookId === "string" ? { playbookId: r.playbookId } : {}),
    tokensUsed: typeof r.tokensUsed === "number" ? r.tokensUsed : 0,
    startedAt: typeof r.startedAt === "number" ? r.startedAt : 0,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

const states = new Map<string, WorkflowStoreState>();
/**
 * runId -> 运行快照(全局):供对话里的运行卡按 runId 直接取——工具行组件拿到的
 * 是 toolCallId,经锚点表查到 runId 后不依赖「当前线程」这个渲染期上下文
 * (历史线程、切线程后的行重渲染都能取到各自的运行)。
 */
const runsById = new Map<string, WorkflowSnapshot>();
/**
 * toolCallId -> 锚点(发起剧本提案的那次工具调用)。同 subagent-runs 的
 * data-subagentDelegation 绑定:prompt 流 chunk 建立,刷新 attach 回放重建。
 */
const anchors = new Map<string, { threadId: string; runId: string }>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function storeKey(threadId: string, migrate = false): string {
  const key = piStoreKeyForThread(threadId);
  if (migrate && key !== threadId) {
    const draft = states.get(threadId);
    if (draft && !states.has(key)) states.set(key, draft);
  }
  return key;
}

function setState(threadId: string, next: WorkflowStoreState) {
  states.set(storeKey(threadId, true), next);
  if (next.run) runsById.set(next.run.id, next.run);
  notify();
}

/** 消费 prompt 流里的 data-workflow-state chunk(pi-client-base 调用) */
export function applyWorkflowChunk(threadId: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as { run?: unknown };
  setState(threadId, { run: normalizeRun(d.run) });
}

/** 消费 data-workflowPlan chunk:把运行锚定到发起提案的工具行 */
export function applyWorkflowPlanChunk(threadId: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as { toolCallId?: unknown; runId?: unknown };
  if (typeof d.toolCallId !== "string" || typeof d.runId !== "string") return;
  anchors.set(d.toolCallId, { threadId, runId: d.runId });
  notify();
}

/** 工具行专用:这次提案锚定的运行(无锚点时 undefined,行渲染退化为普通行) */
export function useWorkflowAnchor(
  toolCallId: string,
): { threadId: string; runId: string } | undefined {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => anchors.get(toolCallId),
    () => undefined,
  );
}

/** 工具行专用:按 runId 取运行快照(路由与线程无关) */
export function useWorkflowRunById(runId: string | undefined): WorkflowSnapshot | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (runId ? (runsById.get(runId) ?? null) : null),
    () => null,
  );
}

/** 从工具结果文本兜底解析 Run ID(历史重建没有绑定 chunk 时的退化路径) */
export function parseRunIdFromResultText(text: string): string | undefined {
  const m = text.match(/Run ID:\s*(\S+)/);
  return m?.[1];
}

/** 订阅当前线程的运行快照 */
export function useWorkflowState(threadId: string | undefined): WorkflowStoreState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () =>
      threadId
        ? (states.get(storeKey(threadId, true)) ?? EMPTY_WORKFLOW_STATE)
        : EMPTY_WORKFLOW_STATE,
    () => EMPTY_WORKFLOW_STATE,
  );
}

/**
 * 拉取 sidecar 侧运行快照并水合(刷新 / 切线程 / 切档后常驻条要立刻恢复)。
 * 没有已知 sessionId 的线程直接跳过:sidecar 不可能持有它的运行,
 * 而请求会懒建空白会话(污染)。
 */
export function fetchWorkflowState(threadId: string): Promise<void> {
  if (!piSessionIdForThread(threadId)) return Promise.resolve();
  return requestWorkflow(threadId, { type: "get_workflow_state" });
}

async function requestWorkflow(
  threadId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const sessionId = piSessionIdForThread(threadId);
  // 回包的 run 形状由 normalizeRun 逐字段复核后才进 store,不直接信它
  const res = await piRequest<{ type: "workflow_state"; run: WorkflowState["run"] }>({
    ...payload,
    threadId,
    ...(sessionId ? { sessionId } : {}),
  });
  setState(threadId, { run: normalizeRun(res?.run) });
}

/**
 * 常驻条/面板的动作(确认 / 驳回 / 暂停 / 继续 / 清除)。
 * 不做乐观更新:这些动作的落点是运行状态机(确认会启动后台执行器、清除要落
 * 一行 workflow_state),前端算不出正确的新盘面,等 sidecar 回包刷新。
 */
export function confirmWorkflowNow(threadId: string): Promise<void> {
  return requestWorkflow(threadId, { type: "workflow_confirm" });
}

export function rejectWorkflowNow(threadId: string, feedback: string): Promise<void> {
  return requestWorkflow(threadId, { type: "workflow_reject", feedback });
}

export function pauseWorkflowNow(threadId: string): Promise<void> {
  return requestWorkflow(threadId, { type: "workflow_pause" });
}

export function resumeWorkflowNow(threadId: string): Promise<void> {
  return requestWorkflow(threadId, { type: "workflow_resume" });
}

export function clearWorkflowNow(threadId: string): Promise<void> {
  return requestWorkflow(threadId, { type: "workflow_clear" });
}

/**
 * 运行中定期水合:后台提交的推进 chunk 可能因线程键错位(草稿 __LOCALID_ vs
 * 会话 UUID)而丢——UI 会冻在「运行中 0/7 步」。轮询是兜底(status 离开 running
 * 即停),代价是每 2.5s 一个小请求。
 */
export function useWorkflowLiveHydration(
  threadId: string | undefined,
  active: boolean,
): void {
  useEffect(() => {
    if (!threadId || !active) return;
    const timer = setInterval(() => {
      fetchWorkflowState(threadId).catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [threadId, active]);
}

/* ------------------------------ 剧本库 ------------------------------ */

/** 剧本列表(设置页水合;保存/删除回包也是同一形状,直接复用) */
export async function listPlaybooksNow(): Promise<Playbook[]> {
  const res = await piRequest<{ type: "workflow_playbooks"; playbooks: Playbook[] }>({
    type: "workflow_list_playbooks",
  });
  return Array.isArray(res?.playbooks) ? res.playbooks : [];
}

/** 把当前线程的运行存为剧本(运行卡「存为剧本」按钮) */
export async function savePlaybookFromRunNow(
  threadId: string,
  name?: string,
): Promise<Playbook[]> {
  const sessionId = piSessionIdForThread(threadId);
  const res = await piRequest<{ type: "workflow_playbooks"; playbooks: Playbook[] }>({
    type: "workflow_save_playbook",
    threadId,
    ...(sessionId ? { sessionId } : {}),
    ...(name ? { name } : {}),
  });
  return Array.isArray(res?.playbooks) ? res.playbooks : [];
}

export async function deletePlaybookNow(name: string): Promise<Playbook[]> {
  const res = await piRequest<{ type: "workflow_playbooks"; playbooks: Playbook[] }>({
    type: "workflow_delete_playbook",
    name,
  });
  return Array.isArray(res?.playbooks) ? res.playbooks : [];
}

/**
 * 从剧本发起运行(设置页「运行」按钮)。回包是 workflow_state(该线程的运行),
 * 顺带写进本地 store——用户从设置页跑完回聊天能直接看到运行卡/常驻条
 */
export async function runPlaybookNow(
  threadId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const sessionId = piSessionIdForThread(threadId);
  const res = await piRequest<{ type: "workflow_state"; run: WorkflowState["run"] }>({
    type: "workflow_run_playbook",
    threadId,
    ...(sessionId ? { sessionId } : {}),
    name,
    args,
  });
  setState(threadId, { run: normalizeRun(res?.run) });
}

/** 运行历史(设置页;.kova/workflows 目录摘要) */
export async function listRunsNow(threadId: string | undefined): Promise<WorkflowRunSummary[]> {
  const sessionId = threadId ? piSessionIdForThread(threadId) : undefined;
  const res = await piRequest<{ type: "workflow_runs"; runs: WorkflowRunSummary[] }>({
    type: "workflow_list_runs",
    ...(threadId ? { threadId } : {}),
    ...(sessionId ? { sessionId } : {}),
  });
  return Array.isArray(res?.runs) ? res.runs : [];
}

/* ---------------- 测试缝 ---------------- */

/** 测试钩子:直读某线程运行快照(与 hook 同源数据,绕开渲染器) */
export const workflowSnapshotForTest = (threadId: string): WorkflowStoreState =>
  states.get(storeKey(threadId)) ?? EMPTY_WORKFLOW_STATE;
