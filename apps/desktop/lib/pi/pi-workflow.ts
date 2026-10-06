"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import { piSessionIdForThread, piStoreKeyForThread } from "@/lib/pi/pi-thread-adapter";
import type { WorkflowState } from "pi-protocol";

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
    tokensUsed: typeof r.tokensUsed === "number" ? r.tokensUsed : 0,
    startedAt: typeof r.startedAt === "number" ? r.startedAt : 0,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

const states = new Map<string, WorkflowStoreState>();
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
  notify();
}

/** 消费 prompt 流里的 data-workflow-state chunk(pi-client-base 调用) */
export function applyWorkflowChunk(threadId: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as { run?: unknown };
  setState(threadId, { run: normalizeRun(d.run) });
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

/* ---------------- 测试缝 ---------------- */

/** 测试钩子:直读某线程运行快照(与 hook 同源数据,绕开渲染器) */
export const workflowSnapshotForTest = (threadId: string): WorkflowStoreState =>
  states.get(storeKey(threadId)) ?? EMPTY_WORKFLOW_STATE;
