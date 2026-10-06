/**
 * 工作流执行器:提案确认后由 handler 层调 startWorkflowExecution 起后台执行。
 *
 * 调度形态:就绪集循环——每轮取「依赖全 done 的 pending 步骤」并发派发(上限
 * 复用委派并发 8),await 最先结算的一个后重查就绪集。与逐波 allSettled 相比,
 * 下游步骤不等同波最慢者;M1 步数小,这个粒度已经够,foreach(M2)引入后再演进。
 *
 * 与 goal 循环的本质差异:这里没有模型在环。步骤的执行单元就是委派层现成的
 * SubagentRun(独立 pi Agent 实例,provider 重试/长度续跑/轨迹全白得),执行器的
 * 判定全是确定性的——状态来自 journal,不来自任何模型的自述。
 *
 * journal 回放(设计文档 §4.2):执行起点先重算每步指纹——done 且指纹一致的步骤
 * 直接保留(0 token 回放),不一致或中断的回到 pending 重跑。内容寻址,与位置索引
 * 无关,插删步骤不影响其他步骤的缓存。
 */
import { randomUUID } from "node:crypto";
import { logErr, logAt } from "../log";
import { normalizeSubagentName, loadSubagentDefinitions, type SubagentDefinition } from "../subagent/subagent-definitions";
import {
  MAX_SUBAGENT_CONCURRENCY,
  pushActivity,
  registerDelegation,
  settleDelegation,
} from "../subagent/delegation";
import { SubagentRun } from "../subagent/run";
import { resolveDelegateModel } from "../subagent/tools";
import type { Running, SubagentRunResult, DelegationRecord } from "../types";
import {
  deliverWorkflowResult,
  getWorkflow,
  commitWorkflow,
  setWorkflowAbortHook,
} from "./workflow";
import {
  addTokens,
  hasOpenSteps,
  interpolatePrompt,
  MAX_STEP_RESULT_CHARS,
  readyStepKeys,
  settleStep,
  stepFingerprint,
  transitionRun,
  type StepJournalEntry,
  type WorkflowRun,
  type WorkflowStep,
} from "./plan-state";

/** 一次执行的活动身份(abort 挂钩按 threadId 找到它) */
interface WorkflowExecution {
  runId: string;
  threadId: string;
  /** 用户接管/切档置位:在跑步骤中止后,run 落 paused(状态由门面先搬好) */
  stopped: boolean;
  /** 已派发过的步骤 key(防重复派发;journal 是权威,这只是本次执行的现场簿) */
  launched: Set<string>;
  /** 在跑步骤的 promise(spawnStep 保证 resolve 不 reject) */
  active: Set<Promise<void>>;
}

/** runId -> 执行(全局一份:同一 run 的执行器进程内只允许一份) */
const executions = new Map<string, WorkflowExecution>();

/** 终局交付经门面的挂钩槽位(sessions.ts 注册),runner 不持有 hook 引用 */

/** 模块装配(session 物化时调用一次):注册「用户接管 → 中止在跑步骤」通道 */
export function registerWorkflowRunner(): void {
  setWorkflowAbortHook((threadId) => {
    for (const exec of executions.values()) {
      if (exec.threadId !== threadId) continue;
      exec.stopped = true;
    }
    abortByThread(threadId);
  });
}

/** 本进程内活委派的 abort 闭包(带线程归属:暂停/失败只中止本线程的) */
const abortTargets = new Set<{ threadId: string; abort: () => void }>();

function abortByThread(threadId: string): void {
  for (const entry of abortTargets) {
    if (entry.threadId !== threadId) continue;
    abortTargets.delete(entry);
    entry.abort();
  }
}

/**
 * 启动一次执行(proposed → running 的确认之后调用)。幂等:同一 run 已有执行
 * 在跑时直接返回。永不 reject——所有失败都折进 journal 与 run 状态。
 */
export async function startWorkflowExecution(run: Running): Promise<void> {
  const wf = getWorkflow(run.threadId);
  if (!wf || wf.status !== "running" || !wf.plan) return;
  for (const exec of executions.values()) {
    if (exec.threadId === run.threadId || exec.runId === wf.id) return;
  }
  // 指纹重算:done 且指纹一致 → 保留;不一致 / interrupted / running 残影 → pending。
  // 失败步骤在 resume 时也重试:失败的 run 本身是终态进不来这里,能 resume 的
  // paused 里失败步只可能来自「失败前已被中止的现场」,重跑是用户要的语义
  let replayed = 0;
  const next: WorkflowRun = {
    ...wf,
    steps: Object.fromEntries(
      await Promise.all(
        Object.entries(wf.steps).map(async ([key, entry]) => {
          const step = wf.plan!.steps.find((s) => s.key === key);
          if (!step) return [key, entry] as const;
          if (entry.status === "done") {
            const fp = stepFingerprint(
              step,
              step.dependsOn.map((d) => wf.steps[d]?.fingerprint ?? ""),
            );
            if (entry.fingerprint === fp) {
              replayed += 1;
              return [key, entry] as const;
            }
            return [key, { ...entry, status: "pending" as const }] as const;
          }
          if (entry.status === "running" || entry.status === "interrupted") {
            return [key, { ...entry, status: "pending" as const }] as const;
          }
          return [key, entry] as const;
        }),
      ),
    ),
  };
  commitWorkflow(run, next);
  if (replayed > 0) {
    logAt("event", `workflow ${wf.id}: replaying ${replayed} journaled step(s) from cache`);
  }

  const exec: WorkflowExecution = {
    runId: wf.id,
    threadId: run.threadId,
    stopped: false,
    launched: new Set(),
    active: new Set(),
  };
  executions.set(wf.id, exec);
  try {
    while (!exec.stopped) {
      const current = getWorkflow(run.threadId);
      // 门面已把 run 搬出 running(用户接管/切档):停派发,在跑的等它们结算
      if (!current || current.status !== "running") break;
      const ready = readyStepKeys(current);
      for (const key of ready) {
        if (exec.active.size >= MAX_SUBAGENT_CONCURRENCY) break;
        if (exec.launched.has(key)) continue;
        exec.launched.add(key);
        const promise = spawnStep(run, current, key).finally(() => {
          exec.active.delete(promise);
        });
        exec.active.add(promise);
      }
      if (exec.active.size === 0) {
        // 无在跑且无可派发:要么全部结算,要么就绪缺口(校验过的无环 DAG 理论
        // 不可达,这里兜底防死循环)
        break;
      }
      await Promise.race([...exec.active]);
    }
    await Promise.allSettled([...exec.active]);
    // 停摆兜底:循环退出时 run 仍挂着 running(既没全结算也没被门面搬走)——
    // 校验过的无环 DAG 理论上到不了这里,但「条上永远进行中」是这套机制里最贵的
    // 谎报,宁可多一道闸
    const settled = getWorkflow(run.threadId);
    if (settled?.status === "running") {
      if (hasOpenSteps(settled)) {
        const paused = transitionRun(settled, "paused", {
          expectedRunId: settled.id,
          reason: "执行器停摆:存在无法就绪的步骤(就绪缺口)",
        });
        if (paused) commitWorkflow(run, paused);
      } else {
        settleTerminal(run);
      }
    }
  } finally {
    executions.delete(wf.id);
  }
}

/** 一步的完整执行:journal 置 running → 委派/合成 → 结算回 journal → 终局判定 */
async function spawnStep(run: Running, wfAtLaunch: WorkflowRun, key: string): Promise<void> {
  try {
    const wf = getWorkflow(run.threadId);
    const step = (wf ?? wfAtLaunch).plan?.steps.find((s) => s.key === key);
    if (!step || !wf) return;
    const fingerprint = stepFingerprint(
      step,
      step.dependsOn.map((d) => wf.steps[d]?.fingerprint ?? ""),
    );
    const startedAt = Date.now();
    commitWorkflow(run, settleStep(wf, key, { status: "running", fingerprint, startedAt }));

    const result = await executeStep(run, step, wf);
    const after = getWorkflow(run.threadId);
    if (!after || after.id !== wf.id) return; // 运行已被清除/替换:账不回写

    // 用户中止:委派返回 aborted——记 interrupted,终局由 abort 发起方搬成 paused
    if (result.status === "aborted") {
      commitWorkflow(
        run,
        settleStep(after, key, {
          status: "interrupted",
          endedAt: Date.now(),
          tokens: result.tokens,
        }),
      );
      return;
    }

    if (result.status === "completed" || result.status === "truncated") {
      const entry: Partial<StepJournalEntry> = {
        status: "done",
        result: result.report,
        endedAt: Date.now(),
        tokens: result.tokens,
        delegationId: result.delegationId,
      };
      commitWorkflow(run, settleStep(addTokens(after, result.tokens ?? 0), key, entry));
      settleTerminal(run);
      return;
    }

    // failed:传播固定 abort(M1)。一步失败整个 run 转 failed,原因带上步骤名
    commitWorkflow(
      run,
      settleStep(after, key, {
        status: "failed",
        error: result.error?.message ?? "step failed",
        endedAt: Date.now(),
        tokens: result.tokens,
      }),
    );
    failRun(run, step, result.error?.message ?? "step failed");
  } catch (err) {
    // spawnStep 永不 reject:意外异常折成步骤失败(runner 的调度循环依赖这一点)
    logErr(`workflow step ${key} crashed:`, err);
    const after = getWorkflow(run.threadId);
    if (after?.id === wfAtLaunch.id) {
      commitWorkflow(
        run,
        settleStep(after, key, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          endedAt: Date.now(),
        }),
      );
      failRun(run, wfAtLaunch.plan?.steps.find((s) => s.key === key), err instanceof Error ? err.message : String(err));
    }
  }
}

/** delegate:走委派层;synthesize:无工具的一次性合成委派(prompt 模板插值上游结果) */
async function executeStep(
  run: Running,
  step: WorkflowStep,
  wf: WorkflowRun,
): Promise<SubagentRunResult & { delegationId?: string }> {
  const task =
    step.kind === "synthesize"
      ? interpolatePrompt(step.prompt, (dep) => wf.steps[dep]?.result)
      : step.prompt;

  let definition: SubagentDefinition;
  if (step.kind === "synthesize") {
    definition = {
      name: "workflow-synthesizer",
      description: "汇总各步骤产出,写出最终报告",
      tools: [],
      prompt:
        "You write the final report of a multi-step workflow. Work only from the material in the task; do not invent results that are not in it. Answer in the user's language.",
      scope: "builtin",
      stateKey: "workflow:synthesizer",
    };
  } else {
    const { definitions } = await loadSubagentDefinitions({ cwd: run.cwd });
    const found = definitions.find(
      (d) => normalizeSubagentName(d.name) === normalizeSubagentName(String(step.agent)),
    );
    if (!found) {
      return failedResult(step, `Unknown subagent "${step.agent}". Pick one of: ${definitions.map((d) => d.name).join(", ")}.`);
    }
    definition = found;
  }

  const resolved = await resolveDelegateModel(run, definition, step.model ?? "");
  const model = resolved.model;
  if (!model) return failedResult(step, resolved.error ?? "model unavailable");

  const tools =
    step.kind === "synthesize"
      ? []
      : definition.tools
          .map((name) => run.baseTools.find((t) => t.name === name.toLowerCase()))
          .filter((t) => t !== undefined);
  if (tools.length === 0 && step.kind === "delegate") {
    return failedResult(step, `The ${definition.name} subagent declares no tool available in this session.`);
  }

  const delegationId = randomUUID();
  const controller = new AbortController();
  const abortEntry = { threadId: run.threadId, abort: () => controller.abort() };
  abortTargets.add(abortEntry);
  let resolveCompletion: () => void = () => {};
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const record: DelegationRecord = {
    delegationId,
    agentName: definition.name,
    modelId: model.id,
    status: "running",
    description: `[workflow] ${step.title}`,
    activity: [],
    stopRequested: false,
    startedAt: Date.now(),
    turns: 0,
    toolCalls: 0,
    reportedToParent: true, // 报告进 journal,不走委派层的父投递通路
    completion,
    resolveCompletion,
    abort: abortEntry.abort,
  };
  registerDelegation(record);

  const result = await new SubagentRun({
    definition,
    task,
    model,
    cwd: run.cwd,
    tools,
    sessionId: delegationId,
    traceSessionId: run.sessionId,
    signal: controller.signal,
    onActivity: (item) => pushActivity(record, item),
  }).run();
  abortTargets.delete(abortEntry);
  settleDelegation(run, record, result);
  return { ...result, delegationId };
}

function failedResult(step: WorkflowStep, message: string): SubagentRunResult {
  return {
    agentName: step.kind === "synthesize" ? "workflow-synthesizer" : String(step.agent),
    modelId: "",
    status: "failed",
    report: "",
    turns: 0,
    toolCalls: 0,
    tokens: 0,
    error: { code: "WORKFLOW_STEP_FAILED", message },
  };
}

/** 全部步骤结算后的终局判定:全 done → complete(交付);有 failed/skip 缺口已由 failRun 处理 */
function settleTerminal(run: Running): void {
  const wf = getWorkflow(run.threadId);
  if (!wf || wf.status !== "running" || !wf.plan) return;
  const entries = Object.values(wf.steps);
  if (entries.length === 0 || !wf.plan.steps.every((s) => wf.steps[s.key]?.status === "done")) return;
  // 空产出舰队警告的对应物:全 done 但合成报告为空的 run 不许装成功
  const synth = wf.plan.steps.find((s) => s.kind === "synthesize");
  const synthResult = synth ? wf.steps[synth.key]?.result ?? "" : "";
  const summary = synthResult.trim().slice(0, 400);
  const done = transitionRun(wf, "complete", {
    expectedRunId: wf.id,
    summary: summary || "(synthesizer produced an empty report)",
  });
  if (!done) return;
  commitWorkflow(run, done);
  if (synthResult.trim().length > 0) {
    deliverWorkflowResult(run, done);
  } else {
    logErr(`workflow ${wf.id} completed with an empty synthesizer report`);
  }
}

/** 一步失败 → run failed + 中止其余在跑(M1 的传播固定 abort) */
function failRun(run: Running, step: WorkflowStep | undefined, message: string): void {
  const wf = getWorkflow(run.threadId);
  if (!wf || wf.status !== "running") return;
  const title = step?.title ?? step?.key ?? "step";
  const failed = transitionRun(wf, "failed", {
    expectedRunId: wf.id,
    reason: `步骤「${title}」失败:${message.slice(0, MAX_STEP_RESULT_CHARS)}`,
  });
  if (!failed) return;
  commitWorkflow(run, failed);
  for (const exec of executions.values()) {
    if (exec.threadId !== run.threadId) continue;
    exec.stopped = true;
  }
  abortByThread(run.threadId);
}
