/**
 * 工作流模式纯逻辑层(零 I/O、零依赖):剧本步骤、提案校验、运行状态机迁移、
 * 内容寻址指纹、就绪调度与 prompt 插值。
 *
 * 分层理由同 goal/goal-state.ts——状态机与副作用彻底分开,提案校验、DAG 调度
 * 与指纹计算都可以纯函数单测,不需要起 Agent、不碰磁盘。
 *
 * M1 边界(设计文档 §7):只有 delegate / synthesize 两类步骤,单发无 foreach,
 * 失败传播固定 abort(一步 failed 即 run failed),验证步(gate/verify)留给 M2。
 *
 * 与 goal 的关键差异:完成不是模型宣布的——执行器(runner)在 DAG 全部结算后
 * 自己把 run 转终态,编排器模型只有「提案」一个出口(workflow_propose_plan)。
 * 因此没有 goal 那对 complete/blocked 出口工具。
 */
import { createHash, randomUUID } from "node:crypto";

/* --------------------------------- 工具名 --------------------------------- */

/** 工作流模式专属工具(必须独占 tool call 批次,modes.ts 的 modeBeforeToolCall 拦) */
export const WORKFLOW_TOOL_NAMES = {
  propose: "workflow_propose_plan",
} as const;

export const WORKFLOW_TOOL_NAME_LIST: readonly string[] = [WORKFLOW_TOOL_NAMES.propose];

export function isWorkflowToolName(name: string): boolean {
  return name === WORKFLOW_TOOL_NAMES.propose;
}

/* --------------------------------- 类型 --------------------------------- */

export type WorkflowStepKind = "delegate" | "synthesize";

export type WorkflowStep = {
  /** 剧本内唯一、模型起的稳定键;journal 与插值的寻址键 */
  key: string;
  kind: WorkflowStepKind;
  /** 展示分组(中文);缺省落「执行」 */
  phase: string;
  /** 步骤卡标题(用户语言) */
  title: string;
  /** 任务说明。delegate:给子代理的 brief;synthesize:合成指令模板(可插 {{key}}) */
  prompt: string;
  /** delegate 必填:子智能体定义名 */
  agent?: string;
  /** 模型覆盖 "provider/modelId";缺省继承会话模型 */
  model?: string;
  dependsOn: string[];
};

/** journal 条目:一步的完整执行账(结果有界,见 MAX_STEP_RESULT_CHARS) */
export type StepJournalEntry = {
  key: string;
  status: StepStatus;
  fingerprint?: string;
  result?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  tokens?: number;
  delegationId?: string;
};

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "interrupted";

export type WorkflowRunStatus =
  | "proposing"
  | "proposed"
  | "running"
  | "paused"
  | "complete"
  | "failed";

export type WorkflowRun = {
  id: string;
  threadId: string;
  /** 用户切到工作流档后的第一句话 */
  objective: string;
  status: WorkflowRunStatus;
  title?: string;
  /** 提案被接受后的剧本;proposing 阶段为空 */
  plan?: { steps: WorkflowStep[] };
  /** 驳回意见:重提轮据此修改剧本 */
  proposalFeedback?: string;
  /** journal:key -> 条目;提案接受时初始化全 pending */
  steps: Record<string, StepJournalEntry>;
  pauseReason?: string;
  completionSummary?: string;
  /** 纯展示字段(goal-state 同款裁决:不做 token 预算阀,见其头注释) */
  tokensUsed: number;
  startedAt: number;
  updatedAt: number;
};

/* --------------------------------- 常量 --------------------------------- */

export const MAX_STEPS_PER_RUN = 100;
export const MAX_STEP_TEXT_LENGTH = 4000;
export const MAX_WORKFLOW_TITLE_LENGTH = 80;
/** 步骤结果进 journal 与插值的单步上限(与委派报告 12k 同量级,再小防炸上下文) */
export const MAX_STEP_RESULT_CHARS = 12_000;
/** 插值后单条 prompt 的上限:超限截断,防止上游全量结果把下游 brief 撑爆 */
export const MAX_INTERPOLATED_PROMPT_CHARS = 24_000;
export const STEP_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const DEFAULT_PHASE = "执行";

/* ------------------------------- 建档与提案 ------------------------------- */

/** 编排目标原文校验:非空、有界。空白消息(纯附件/提示行)建不出运行 */
export function validateObjectiveText(objective: string): boolean {
  const text = objective.trim();
  return text.length > 0 && text.length <= MAX_STEP_TEXT_LENGTH;
}

export function createWorkflowRun(threadId: string, objective: string): WorkflowRun {
  const now = Date.now();
  return {
    id: `wf-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
    threadId,
    objective,
    status: "proposing",
    steps: {},
    tokensUsed: 0,
    startedAt: now,
    updatedAt: now,
  };
}

/** 工具入参的宽松形状(只验形,集合完整性由 validatePlan 判) */
type RawStep = {
  key?: unknown;
  kind?: unknown;
  phase?: unknown;
  title?: unknown;
  prompt?: unknown;
  agent?: unknown;
  model?: unknown;
  dependsOn?: unknown;
};

function asTrimmedString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 提案校验 + 归一化:剧本是模型生成的 JSON,这里是把「随手写的」挡在外面、
 * 把「合法的」收窄成安全形状的唯一入口。
 * 逐条给可读 reason——被拒的提案要能让模型知道改哪里,而不是笼统的 invalid。
 */
export function validatePlan(raw: unknown): { ok: true; steps: WorkflowStep[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "steps must be an array of step objects." };
  }
  if (raw.length === 0) {
    return { ok: false, reason: "steps must contain at least one step." };
  }
  if (raw.length > MAX_STEPS_PER_RUN) {
    return { ok: false, reason: `steps exceeds the ${MAX_STEPS_PER_RUN}-step limit for one run.` };
  }
  const steps: WorkflowStep[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as RawStep;
    if (!entry || typeof entry !== "object") {
      return { ok: false, reason: `steps[${i}] must be an object.` };
    }
    const key = asTrimmedString(entry.key);
    if (!STEP_KEY_PATTERN.test(key)) {
      return {
        ok: false,
        reason: `steps[${i}].key "${key}" is invalid: use 1-64 letters/digits/-/_ (stable id reused by the journal).`,
      };
    }
    if (seen.has(key)) {
      return { ok: false, reason: `steps[${i}].key "${key}" is duplicated; keys must be unique.` };
    }
    seen.add(key);
    const kind = asTrimmedString(entry.kind);
    if (kind !== "delegate" && kind !== "synthesize") {
      return {
        ok: false,
        reason: `steps[${i}].kind must be "delegate" or "synthesize", got "${kind}".`,
      };
    }
    const title = asTrimmedString(entry.title).slice(0, MAX_WORKFLOW_TITLE_LENGTH);
    if (!title) {
      return { ok: false, reason: `steps[${i}].title is required (shown to the user on the step card).` };
    }
    const prompt = asTrimmedString(entry.prompt).slice(0, MAX_STEP_TEXT_LENGTH);
    if (!prompt) {
      return { ok: false, reason: `steps[${i}].prompt is required (the complete brief for this step).` };
    }
    const step: WorkflowStep = {
      key,
      kind,
      phase: asTrimmedString(entry.phase).slice(0, 40) || DEFAULT_PHASE,
      title,
      prompt,
      dependsOn: [],
    };
    if (kind === "delegate") {
      const agent = asTrimmedString(entry.agent);
      if (!agent) {
        return {
          ok: false,
          reason: `steps[${i}] (${key}) is a delegate step and needs "agent" — the name of a subagent definition.`,
        };
      }
      step.agent = agent;
      const model = asTrimmedString(entry.model);
      if (model) step.model = model;
    }
    const deps = Array.isArray(entry.dependsOn) ? entry.dependsOn : [];
    for (const d of deps) {
      const dep = asTrimmedString(d);
      if (!dep) continue;
      if (dep === key) {
        return { ok: false, reason: `steps[${i}] (${key}) depends on itself.` };
      }
      step.dependsOn.push(dep);
    }
    if (kind === "synthesize" && step.dependsOn.length === 0) {
      return {
        ok: false,
        reason: `steps[${i}] (${key}) is a synthesize step and must depend on at least one upstream step.`,
      };
    }
    steps.push(step);
  }
  // 依赖存在性:未知依赖让提案不可执行,提案时挡住而不是运行中炸
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!seen.has(dep)) {
        return {
          ok: false,
          reason: `step "${step.key}" depends on unknown step "${dep}".`,
        };
      }
    }
  }
  // 环检测(Kahn):A→B→A 的环不会被自依赖检查抓到,运行期会死等「永远到不了
  // 的就绪」——提案时直接拒,让模型拆环
  const indegree = new Map<string, number>(steps.map((s) => [s.key, s.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), step.key]);
    }
  }
  const queue = steps.filter((s) => indegree.get(s.key) === 0).map((s) => s.key);
  let settledCount = 0;
  while (queue.length > 0) {
    const key = queue.shift()!;
    settledCount += 1;
    for (const next of dependents.get(key) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (settledCount < steps.length) {
    const stuck = steps.map((s) => s.key).filter((k) => (indegree.get(k) ?? 0) > 0);
    return {
      ok: false,
      reason: `steps form a dependency cycle involving: ${stuck.join(", ")}.`,
    };
  }
  // synthesize 恰好一个,且必须能沿依赖边到达每个 delegate 步(M1 的收束语义;
  // M2 引 gate/verify 后放宽)。够不着的 delegate 的产出进不了最终报告,等于白跑
  const synths = steps.filter((s) => s.kind === "synthesize");
  if (synths.length !== 1) {
    return {
      ok: false,
      reason: `exactly one synthesize step is required (got ${synths.length}) — it produces the final report.`,
    };
  }
  const synth = synths[0]!;
  const unreachable = steps.find((s) => s.kind === "delegate" && !reaches(synth, s.key, steps));
  if (unreachable) {
    return {
      ok: false,
      reason: `synthesize step "${synth.key}" cannot reach delegate step "${unreachable.key}" — every delegate step must feed the final report (add it to dependsOn, directly or via an intermediate step).`,
    };
  }
  return { ok: true, steps };
}

/** dep 是否能沿依赖边走到 from(含中间层) */
function reaches(from: WorkflowStep, dep: string, steps: WorkflowStep[]): boolean {
  if (from.dependsOn.includes(dep)) return true;
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const stack = [...from.dependsOn];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    if (k === dep) return true;
    const node = byKey.get(k);
    if (node) stack.push(...node.dependsOn);
  }
  return false;
}

/**
 * 提案接受(或重提):proposing → proposed,并初始化全 pending 的 journal。
 * 重新提案(驳回后)整体替换剧本并重置 journal——旧剧本从未执行过,没有可保留的账。
 */
export function acceptProposal(run: WorkflowRun, steps: WorkflowStep[], title?: string): WorkflowRun {
  const stepJournal: Record<string, StepJournalEntry> = {};
  for (const step of steps) {
    stepJournal[step.key] = { key: step.key, status: "pending" };
  }
  return {
    ...run,
    status: "proposed",
    title: (title ?? "").trim().slice(0, MAX_WORKFLOW_TITLE_LENGTH) || undefined,
    plan: { steps },
    proposalFeedback: undefined,
    steps: stepJournal,
    updatedAt: Date.now(),
  };
}

/** 驳回:proposed → proposing 并带回意见,重提轮据此修改 */
export function rejectProposal(run: WorkflowRun, feedback?: string): WorkflowRun | undefined {
  if (run.status !== "proposed") return undefined;
  return {
    ...run,
    status: "proposing",
    proposalFeedback: (feedback ?? "").trim().slice(0, MAX_STEP_TEXT_LENGTH) || undefined,
    plan: undefined,
    steps: {},
    updatedAt: Date.now(),
  };
}

/** 确认开跑:proposed → running(执行器的启动是调用方职责,这里只搬状态) */
export function confirmProposal(run: WorkflowRun): WorkflowRun | undefined {
  if (run.status !== "proposed") return undefined;
  return { ...run, status: "running", updatedAt: Date.now() };
}

/* -------------------------------- 状态迁移 -------------------------------- */

export type TransitionOptions = {
  expectedRunId?: string;
  reason?: string;
  summary?: string;
};

/**
 * 带过期护栏的终局/暂停迁移(对齐 goal-state.transitionGoal):模型排队中的
 * tool_call 可能在用户清掉运行后才落地,没有护栏就会让旧运行的结算写到新运行上。
 */
export function transitionRun(
  run: WorkflowRun,
  status: "paused" | "complete" | "failed",
  opts: TransitionOptions = {},
): WorkflowRun | undefined {
  if (opts.expectedRunId !== undefined && opts.expectedRunId !== run.id) return undefined;
  if (run.status === "complete" || run.status === "failed") return undefined;
  return {
    ...run,
    status,
    ...(status === "paused" ? { pauseReason: opts.reason } : {}),
    ...(status === "complete" ? { completionSummary: opts.summary } : {}),
    updatedAt: Date.now(),
  };
}

/** 恢复到 running(resume):paused → running;终态不可恢复 */
export function resumeRun(run: WorkflowRun): WorkflowRun | undefined {
  if (run.status !== "paused") return undefined;
  return { ...run, status: "running", pauseReason: undefined, updatedAt: Date.now() };
}

/* ------------------------------- journal 操作 ------------------------------- */

export function stepEntry(run: WorkflowRun, key: string): StepJournalEntry | undefined {
  return run.steps[key];
}

export function settleStep(
  run: WorkflowRun,
  key: string,
  patch: Partial<Omit<StepJournalEntry, "key">>,
): WorkflowRun {
  const current = run.steps[key];
  if (!current) return run;
  return {
    ...run,
    steps: { ...run.steps, [key]: { ...current, ...patch, key } },
    updatedAt: Date.now(),
  };
}

/** 记账:把一次委派/一步的 token 折进展示计数(goal.drainUsagePending 同款意图) */
export function addTokens(run: WorkflowRun, tokens: number): WorkflowRun {
  if (!Number.isFinite(tokens) || tokens <= 0) return run;
  return { ...run, tokensUsed: run.tokensUsed + Math.round(tokens), updatedAt: Date.now() };
}

/* --------------------------- 内容寻址与调度 --------------------------- */

/**
 * 步骤指纹 = 步骤声明 + 依赖链指纹的 sha256。
 * 上游重跑产出不同 → 下游 prompt 插值内容变,但下游**声明**没变——所以指纹链里
 * 必须带上依赖的指纹,否则上游变了下游还命中旧账。指纹一致的 done 步骤在
 * resume/重跑时直接取 journal(0 token),这是内容寻址恢复的全部依据。
 */
export function stepFingerprint(step: WorkflowStep, depFingerprints: string[]): string {
  const normalized = {
    key: step.key,
    kind: step.kind,
    title: step.title,
    prompt: step.prompt,
    agent: step.agent,
    model: step.model,
    dependsOn: [...step.dependsOn].sort(),
  };
  return createHash("sha256")
    .update(JSON.stringify({ step: normalized, deps: [...depFingerprints].sort() }))
    .digest("hex");
}

/** 依赖全部 done 的 pending 步骤 = 现在可以调度的 */
export function readyStepKeys(run: WorkflowRun): string[] {
  if (!run.plan) return [];
  return run.plan.steps
    .filter((s) => {
      const entry = run.steps[s.key];
      if (!entry || entry.status !== "pending") return false;
      return s.dependsOn.every((d) => run.steps[d]?.status === "done");
    })
    .map((s) => s.key);
}

/** 是否还有会动/该动的步骤(running 或 pending) */
export function hasOpenSteps(run: WorkflowRun): boolean {
  return Object.values(run.steps).some((e) => e.status === "running" || e.status === "pending");
}

/* --------------------------------- 插值 --------------------------------- */

/**
 * 把 synthesize/delegate prompt 模板里的 {{key}} 换成上游结果。
 * - 未知 key 原样保留并留 <missing> 标记——静默替换成空串会让模型把缺口当事实;
 * - 每个插值有界(MAX_STEP_RESULT_CHARS),整条再截一道(MAX_INTERPOLATED_PROMPT_CHARS),
 *   上游全量结果永远进不了下游 brief 的「无界通道」。
 */
export function interpolatePrompt(
  template: string,
  resolveResult: (key: string) => string | undefined,
): string {
  const replaced = template.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_m, key: string) => {
    const value = resolveResult(key);
    if (value === undefined) return `<missing step result: ${key}>`;
    if (value.length <= MAX_STEP_RESULT_CHARS) return value;
    const marker = "\n\n[upstream result truncated]\n\n";
    const avail = MAX_STEP_RESULT_CHARS - marker.length;
    return value.slice(0, Math.ceil(avail / 2)) + marker + value.slice(-Math.floor(avail / 2));
  });
  if (replaced.length <= MAX_INTERPOLATED_PROMPT_CHARS) return replaced;
  const marker = "\n\n[prompt truncated]\n\n";
  const avail = MAX_INTERPOLATED_PROMPT_CHARS - marker.length;
  return replaced.slice(0, Math.ceil(avail / 2)) + marker + replaced.slice(-Math.floor(avail / 2));
}

/* --------------------------------- 展示 --------------------------------- */

/** 盘上 JSON 的运行记录形状守卫(撕烈/畸形行整条判废,调用方按「无记录」处理) */
export function isWorkflowRun(value: unknown): value is WorkflowRun {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.threadId === "string" &&
    typeof r.objective === "string" &&
    typeof r.status === "string" &&
    ["proposing", "proposed", "running", "paused", "complete", "failed"].includes(r.status) &&
    typeof r.steps === "object" &&
    r.steps !== null
  );
}

/** 常驻条一行摘要(sidecar 算成品,两端不各算一遍;对齐 formatGoalStatus) */
export function formatWorkflowStatus(run: WorkflowRun): string {
  const total = Object.keys(run.steps).length;
  const done = Object.values(run.steps).filter((e) => e.status === "done").length;
  switch (run.status) {
    case "proposing":
      return "编排中:正在拟剧本";
    case "proposed":
      return "剧本待你确认";
    case "running": {
      const running = Object.values(run.steps).filter((e) => e.status === "running").length;
      return running > 0
        ? `运行中 ${done}/${total} 步(并发 ${running})`
        : `运行中 ${done}/${total} 步`;
    }
    case "paused":
      return run.pauseReason ? `已暂停:${run.pauseReason}` : "已暂停";
    case "complete":
      return `已完成 ${done}/${total} 步`;
    case "failed":
      return run.pauseReason ? `失败:${run.pauseReason}` : "运行失败";
  }
}
