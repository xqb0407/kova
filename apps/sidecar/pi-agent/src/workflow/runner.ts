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
  allStepsSettled,
  expandForeach,
  findStepForEntry,
  hasOpenSteps,
  MAX_STEP_RESULT_CHARS,
  readyStepKeys,
  resolveStepPrompt,
  settleForeachParent,
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
              JSON.stringify(wf.args ?? {}),
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

  // 恢复展开:上次执行里 from 已 done 但父步还没展开的 foreach(中断在两步之间),
  // 按同一拆行规则重建子项——指纹链因此与原始执行完全一致,已结算的子项可回放
  let withExpansion = next;
  for (const step of next.plan?.steps ?? []) {
    if (!step.foreach) continue;
    const entry = withExpansion.steps[step.key];
    if (!entry || entry.status !== "pending" || entry.children?.length) continue;
    if (withExpansion.steps[step.foreach.from]?.status !== "done") continue;
    const expanded = expandForeach(withExpansion, step.key);
    if (expanded.ok) {
      withExpansion = expanded.run;
      continue;
    }
    withExpansion = settleStep(withExpansion, step.key, {
      status: step.onFail === "skip" ? "skipped" : "failed",
      error: expanded.reason,
      endedAt: Date.now(),
    });
    commitWorkflow(run, withExpansion);
    if (step.onFail !== "skip") {
      failRun(run, step, expanded.reason);
      return;
    }
  }
  if (withExpansion !== next) commitWorkflow(run, withExpansion);

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

/** 一步的一次执行结果(四种步骤统一收口;与 SubagentRunResult 解耦,gate 不是一个委派) */
type StepAttemptResult = {
  status: "completed" | "truncated" | "failed" | "aborted";
  report: string;
  tokens: number;
  delegationId?: string;
  error?: { code: string; message: string };
};

/** 一步的完整执行:journal 置 running → (按类型的)执行 → 结算回 journal → 推进下游/终局 */
async function spawnStep(run: Running, wfAtLaunch: WorkflowRun, key: string): Promise<void> {
  let step: WorkflowStep | undefined;
  try {
    const wf = getWorkflow(run.threadId);
    if (!wf) return;
    step = findStepForEntry(wf, key);
    if (!step) return;
    const fingerprint = stepFingerprint(
      step,
      step.dependsOn.map((d) => wf.steps[d]?.fingerprint ?? ""),
      JSON.stringify(wf.args ?? {}),
    );
    commitWorkflow(run, settleStep(wf, key, { status: "running", fingerprint, startedAt: Date.now() }));

    const result = await executeStepWithRetries(run, step, wf, key);
    const after = getWorkflow(run.threadId);
    if (!after || after.id !== wf.id) return; // 运行已被清除/替换:账不回写

    // 用户中止:执行返回 aborted——记 interrupted,终局由 abort 发起方搬成 paused
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
        error: undefined,
      };
      commitWorkflow(run, settleStep(addTokens(after, result.tokens ?? 0), key, entry));
      advanceAfterSettlement(run, key);
      return;
    }

    // failed:onFail 决定传播——abort(默认)整个 run 失败;skip 记 skipped、
    // 下游按缺口继续(插值出显式 <step … was skipped> 标记,不当事实)
    const reason = result.error?.message ?? "step failed";
    if (step.onFail === "skip") {
      commitWorkflow(
        run,
        settleStep(after, key, {
          status: "skipped",
          error: reason,
          endedAt: Date.now(),
          tokens: result.tokens,
        }),
      );
      advanceAfterSettlement(run, key);
      return;
    }
    commitWorkflow(
      run,
      settleStep(after, key, {
        status: "failed",
        error: reason,
        endedAt: Date.now(),
        tokens: result.tokens,
      }),
    );
    failRun(run, step, reason);
  } catch (err) {
    // spawnStep 永不 reject:意外异常折成步骤失败(runner 的调度循环依赖这一点)
    logErr(`workflow step ${key} crashed:`, err);
    const after = getWorkflow(run.threadId);
    if (after?.id === wfAtLaunch.id) {
      const reason = err instanceof Error ? err.message : String(err);
      const target = step ?? findStepForEntry(after, key);
      if (target?.onFail === "skip") {
        commitWorkflow(run, settleStep(after, key, { status: "skipped", error: reason, endedAt: Date.now() }));
        advanceAfterSettlement(run, key);
      } else {
        commitWorkflow(run, settleStep(after, key, { status: "failed", error: reason, endedAt: Date.now() }));
        failRun(run, target, reason);
      }
    }
  }
}

/**
 * 重试退避:gate 之外的步骤在可恢复失败上重试(默认 0 次,步骤声明 retries 可加)。
 * 退避与 pi-dw 同款:250ms 起指数、封顶 2s;中止/暂停后不再重试(下一次只会撞
 * 同一堵墙)。gate 的退出码是值不是失败,不重试——同一个命令重跑只会得到同一结果。
 */
async function executeStepWithRetries(
  run: Running,
  step: WorkflowStep,
  wf: WorkflowRun,
  key: string,
): Promise<StepAttemptResult> {
  const maxAttempts = step.kind === "gate" ? 1 : 1 + (step.retries ?? 0);
  let last: StepAttemptResult | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await executeStep(run, step, wf, key, attempt);
    if (last.status !== "failed" || attempt >= maxAttempts) break;
    const current = getWorkflow(run.threadId);
    if (!current || current.status !== "running") break;
    logAt(
      "event",
      `workflow step ${key} attempt ${attempt}/${maxAttempts} failed: ${last.error?.message ?? ""}; retrying`,
    );
    await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 2_000)));
  }
  return last!;
}

/** 按步骤类型分派:gate 确定性命令门 / verify 评审投票 / delegate+synthesize 委派 */
async function executeStep(
  run: Running,
  step: WorkflowStep,
  wf: WorkflowRun,
  key: string,
  attempt: number,
): Promise<StepAttemptResult> {
  if (step.kind === "gate") return executeGate(run, step, key, attempt);
  if (step.kind === "verify") return executeVerify(run, step, wf, key);
  return executeDelegateStep(run, step, wf, key);
}

/**
 * gate:确定性命令门。命令复用会话的 bash 宿主工具直接执行(不经模型),
 * 退出码即判定——对齐 ZCode world.run 的思想:命令能决定的事不烧委派、也不信
 * 任何模型的转述。命令字面量在提案时已被用户确认,这里不再走审批层。
 */
async function executeGate(
  run: Running,
  step: WorkflowStep,
  key: string,
  attempt: number,
): Promise<StepAttemptResult> {
  const gate = step.gate;
  if (!gate) return failedResult("gate command is missing");
  const bash = run.baseTools.find((t) => t.name === "bash");
  if (!bash) return failedResult("this session has no bash tool available for gate steps");
  const command = [gate.command, ...(gate.args ?? [])].join(" ");
  const controller = new AbortController();
  const abortEntry = { threadId: run.threadId, abort: () => controller.abort() };
  abortTargets.add(abortEntry);
  try {
    const res = (await bash.execute(
      `workflow-gate-${key}-${attempt}`,
      { command, ...(gate.timeoutMs ? { timeout: gate.timeoutMs } : {}) },
      controller.signal,
    )) as { content?: { type: string; text?: string }[] };
    if (controller.signal.aborted) return abortedResult();
    const output = (res?.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
      .join("\n")
      .trim();
    if (/\[timeout\]/.test(output)) {
      return failedResult(`gate command timed out: ${tail(output)}`);
    }
    const exit = output.match(/\[exit code:\s*(\d+)\]/);
    if (exit && exit[1] !== "0") {
      return failedResult(`gate command exited ${exit[1]}: ${tail(output)}`);
    }
    // 无 exit code 标记也无 timeout:宿主回的是成功输出(exit 0 常被省略)
    return {
      status: "completed",
      report: [`gate passed: ${command}`, tail(output)].filter((l) => l.trim()).join("\n\n"),
      tokens: 0,
    };
  } catch (err) {
    if (controller.signal.aborted) return abortedResult();
    return failedResult(
      `gate command failed to run: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    abortTargets.delete(abortEntry);
  }
}

/** verify 评审的对抗式要求 —— 与 pi-dw verify() 的投票 schema 同构 */
const VERDICT_INSTRUCTION =
  'Answer with a single JSON object on the last line: {"real": true, "reason": "<one sentence>"}';

function reviewerDefinition(): SubagentDefinition {
  return {
    name: "workflow-reviewer",
    description: "对抗式复核一个结论是否真实成立(只读)",
    tools: ["read", "glob", "grep"],
    prompt: [
      "You are an adversarial reviewer inside a multi-agent workflow. Your job is to REFUTE, not to approve.",
      "Check the claim against the actual files and evidence; read files as needed. Do not edit anything.",
      "Default to real=false when you are unsure.",
    ].join("\n"),
    scope: "builtin",
    stateKey: "workflow:reviewer",
  };
}

/**
 * verify:N 个只读评审委派对抗式投票,real 占比 ≥ threshold 判真。
 * 票面不可解析的评审不计入分母(与 pi-dw 过滤 Boolean 同款);一票都没有 = 失败。
 * 判伪 = 步骤 failed,由 onFail 决定整个 run 的传播。
 */
async function executeVerify(
  run: Running,
  step: WorkflowStep,
  wf: WorkflowRun,
  key: string,
): Promise<StepAttemptResult> {
  const reviewers = step.verify?.reviewers ?? 2;
  const threshold = step.verify?.threshold ?? 0.5;
  const claim = resolveStepPrompt(wf, step, key);
  const definition = reviewerDefinition();
  const resolved = await resolveDelegateModel(run, definition, step.model ?? "");
  const model = resolved.model;
  if (!model) return failedResult(resolved.error ?? "model unavailable");
  const tools = definition.tools
    .map((name) => run.baseTools.find((t) => t.name === name.toLowerCase()))
    .filter((t) => t !== undefined);
  const controller = new AbortController();
  const abortEntry = { threadId: run.threadId, abort: () => controller.abort() };
  abortTargets.add(abortEntry);
  try {
    const results = await Promise.all(
      Array.from({ length: reviewers }, (_v, i) =>
        new SubagentRun({
          definition,
          task: [
            `You are reviewer ${i + 1}. Adversarially verify whether the following work/claim is CORRECT and REAL. Try to refute it.`,
            VERDICT_INSTRUCTION,
            "",
            "<claim>",
            claim,
            "</claim>",
          ].join("\n"),
          model,
          cwd: run.cwd,
          tools,
          sessionId: randomUUID(),
          traceSessionId: run.sessionId,
          signal: controller.signal,
        }).run(),
      ),
    );
    if (controller.signal.aborted) return abortedResult();
    const tokens = results.reduce((sum, r) => sum + (r.tokens ?? 0), 0);
    const votes = results
      .filter((r) => r.status === "completed")
      .map((r) => extractVerdict(r.report))
      .filter((v): v is { real: boolean; reason?: string } => v !== undefined);
    if (votes.length === 0) {
      return {
        status: "failed",
        report: "",
        tokens,
        error: {
          code: "WORKFLOW_VERIFY_NO_VOTES",
          message: `${reviewers} reviewer(s) produced no parseable verdict`,
        },
      };
    }
    const realCount = votes.filter((v) => v.real).length;
    const passed = realCount / votes.length >= threshold;
    const summary = [
      `verify: ${realCount}/${votes.length} reviewers judged the claim real (threshold ${threshold}) → ${passed ? "verified" : "refuted"}`,
      ...votes.map(
        (v, i) => `- reviewer ${i + 1}: ${v.real ? "real" : "not real"}${v.reason ? ` — ${v.reason}` : ""}`,
      ),
    ].join("\n");
    if (!passed) {
      return {
        status: "failed",
        report: summary,
        tokens,
        error: { code: "WORKFLOW_VERIFY_REFUTED", message: summary.slice(0, MAX_STEP_RESULT_CHARS) },
      };
    }
    return { status: "completed", report: summary, tokens };
  } finally {
    abortTargets.delete(abortEntry);
  }
}

/** delegate / synthesize:走委派层;synthesize 是无工具的一次性合成委派 */
async function executeDelegateStep(
  run: Running,
  step: WorkflowStep,
  wf: WorkflowRun,
  key: string,
): Promise<StepAttemptResult> {
  const task = resolveStepPrompt(wf, step, key);

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
      return failedResult(
        `Unknown subagent "${step.agent}". Pick one of: ${definitions.map((d) => d.name).join(", ")}.`,
      );
    }
    definition = found;
  }

  const resolved = await resolveDelegateModel(run, definition, step.model ?? "");
  const model = resolved.model;
  if (!model) return failedResult(resolved.error ?? "model unavailable");

  const tools =
    step.kind === "synthesize"
      ? []
      : definition.tools
          .map((name) => run.baseTools.find((t) => t.name === name.toLowerCase()))
          .filter((t) => t !== undefined);
  if (tools.length === 0 && step.kind === "delegate") {
    return failedResult(`The ${definition.name} subagent declares no tool available in this session.`);
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
  const status: StepAttemptResult["status"] =
    result.status === "completed" || result.status === "truncated" || result.status === "aborted"
      ? result.status
      : "failed";
  return {
    status,
    report: result.report,
    tokens: result.tokens ?? 0,
    delegationId,
    ...(result.error ? { error: result.error } : {}),
  };
}

/** 从评审报告里提取投票面:围栏 JSON → 首个 {...} 块 → 整段(逐级退化,不可解析返回 undefined) */
function extractVerdict(text: string): { real: boolean; reason?: string } | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace =
    text.includes("{") && text.lastIndexOf("}") > text.indexOf("{")
      ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
      : undefined;
  for (const candidate of [fenced?.[1], brace, text]) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object" && typeof (parsed as { real?: unknown }).real === "boolean") {
        const reason = (parsed as { reason?: unknown }).reason;
        return { real: (parsed as { real: boolean }).real, ...(typeof reason === "string" ? { reason } : {}) };
      }
    } catch {
      /* 试下一个候选面 */
    }
  }
  return undefined;
}

function failedResult(message: string): StepAttemptResult {
  return {
    status: "failed",
    report: "",
    tokens: 0,
    error: { code: "WORKFLOW_STEP_FAILED", message },
  };
}

function abortedResult(): StepAttemptResult {
  return { status: "aborted", report: "", tokens: 0 };
}

function tail(text: string): string {
  const t = text.trim();
  return t.length <= 2_000 ? t : `…${t.slice(-2_000)}`;
}

/**
 * 结算后的盘面推进:子项结算推进父条目 → done 步骤触发下游 foreach 展开 →
 * 终局判定。展开失败(上游无项/超限)按该步的 onFail 传播。
 */
function advanceAfterSettlement(run: Running, settledKey: string): void {
  const before = getWorkflow(run.threadId);
  if (!before || before.status !== "running") return;
  let wf = settleForeachParent(before, settledKey);
  let failed: { step: WorkflowStep | undefined; reason: string } | undefined;
  if (wf.steps[settledKey]?.status === "done" && wf.plan) {
    for (const s of wf.plan.steps) {
      if (s.foreach?.from !== settledKey) continue;
      const entry = wf.steps[s.key];
      if (!entry || entry.status !== "pending" || entry.children?.length) continue;
      const expanded = expandForeach(wf, s.key);
      if (expanded.ok) {
        wf = expanded.run;
        continue;
      }
      if (s.onFail === "skip") {
        wf = settleStep(wf, s.key, { status: "skipped", error: expanded.reason, endedAt: Date.now() });
      } else {
        failed = { step: s, reason: expanded.reason };
      }
    }
  }
  if (wf !== before) commitWorkflow(run, wf);
  if (failed) {
    failRun(run, failed.step, failed.reason);
    return;
  }
  settleTerminal(run);
}

/** 全部条目结算后的终局判定:全 done/skipped(且汇总已 done)→ complete(交付) */
function settleTerminal(run: Running): void {
  const wf = getWorkflow(run.threadId);
  if (!wf || wf.status !== "running" || !wf.plan) return;
  if (!allStepsSettled(wf)) return;
  const synth = wf.plan.steps.find((s) => s.kind === "synthesize");
  const synthEntry = synth ? wf.steps[synth.key] : undefined;
  // 汇总步必须真的跑完:skip 语义在校验层就不许落在 synthesize 上,这里是兜底
  if (!synthEntry || synthEntry.status !== "done") return;
  const synthResult = synthEntry.result ?? "";
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
