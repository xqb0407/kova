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
import { send, sendEventChunk } from "../protocol/stream";
import { logAt } from "../log";
import {
  WORKFLOW_CONTINUE_PREFIX,
  type Playbook,
  type WorkflowRunSummary,
  type WorkflowStepDetail,
} from "pi-protocol";
import { appendWorkflowStateRow, readWorkflowStateRow } from "../sessions/transcript";
import {
  acceptProposal,
  confirmProposal,
  createWorkflowRun,
  DEFAULT_STEP_TIMEOUT_MS,
  findStepForEntry,
  formatWorkflowStatus,
  hydrateRestoredRun,
  isWorkflowRun,
  rejectProposal,
  resolveStepPrompt,
  transitionRun,
  validateObjectiveText,
  type WorkflowRun,
} from "./plan-state";
import { listRunFiles, pruneRunFiles, readRunFile, writeRunFile } from "./journal";
import {
  deriveArgsFromSteps,
  playbookSteps,
  validatePlaybookArgs,
} from "./library";

/** threadId -> 当前运行(per-thread 槽,对应 goal 的 goals) */
const workflows = new Map<string, WorkflowRun>();

export function getWorkflow(threadId: string): WorkflowRun | undefined {
  return workflows.get(threadId);
}

/** 线程键迁移(刷新后 run 改绑新 threadId):槽位原样挪过去。
 *  迁移后必须补推一次快照——键换了而 UI 还捧着迁移前那一份的话,状态会僵在
 *  旧值上(实机:运行明明在跑,常驻条显示「已暂停」,用户点「继续」得到
 *  「not resumable」——按钮看起来坏了,其实只是快照过期)。 */
export function migrateWorkflow(oldThreadId: string, newThreadId: string): void {
  const wf = workflows.get(oldThreadId);
  if (wf) workflows.set(newThreadId, { ...wf, threadId: newThreadId });
  workflows.delete(oldThreadId);
  if (wf) emitWorkflowStateFor(newThreadId);
}

/**
 * 按线程键找运行,找不到再按会话找一次。
 *
 * 线程键会漂移:本会话新建的线程用草稿 id(`__LOCALID_*`),页面刷新/热更新后变成
 * 会话 UUID;不同调用方(桌面请求 / 服务端自身路径)也可能各用各的。**只查找、不搬运**
 * ——搬运会让两个键轮流把槽拽回自己那边,变成每几秒一次的 flapping,每次还推一份
 * 快照,UI 直接被刷爆(实机:「Maximum update depth exceeded」+ 看着像卡死)。
 * 槽的写入键只有一处:`commitWorkflow(run, …)` 用 `run.threadId`(每个 run 一个稳定键)。
 */
export function findWorkflowRun(threadId: string, sessionId?: string): WorkflowRun | undefined {
  const direct = workflows.get(threadId);
  if (direct) return direct;
  const sid = sessionId?.trim();
  if (!sid) return undefined;
  for (const wf of workflows.values()) {
    if (wf.sessionId === sid) return wf;
  }
  return undefined;
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
    // 会话 id 随槽一起记:线程键漂移时按它找回来(见 findWorkflowRun;只查不搬)
    workflows.set(threadId, { ...wf, sessionId: run.sessionId ?? wf.sessionId });
  } else {
    workflows.delete(threadId);
  }
  if (run.sessionId) {
    try {
      // cwd 一并落行:重启恢复时据此找到 .kova/workflows/<runId>.json 的
      // 全量 journal(结果与指纹都在文件里,行只留状态)
      appendWorkflowStateRow(
        run.sessionId,
        wf ? { ...slimRunForTranscript(wf), cwd: run.cwd } : null,
      );
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

/**
 * 推全量快照给常驻条/面板。两条通道,分工不同:
 * - sendEventChunk:轮内即时刷新(依赖活跃请求;回合外静默丢弃);
 * - workflow_state_push 通知行:后台推进的**主通道**——执行器大多数提交发生在
 *   模型回合之外,轮内 chunk 根本发不出去(实机表现:条冻在「运行中 0/7」)。
 *   通知行无 id、Rust 原样广播,与 subagent_activity 同款(turn 无关)。
 */
export function emitWorkflowState(run: Running): void {
  emitWorkflowStateFor(run.threadId, run.sessionId);
}

/** 按线程键推送快照(迁移路径用:那里没有 Running 对象,只有新旧键) */
export function emitWorkflowStateFor(threadId: string, sessionId?: string): void {
  const payload = workflowStatePayload(threadId, sessionId);
  sendEventChunk(threadId, { type: "data-workflow-state", data: payload }, sessionId);
  send({
    type: "workflow_state_push",
    threadId,
    ...(sessionId ? { sessionId } : {}),
    data: payload,
  });
}

/** gate 未声明超时时的兜底:与宿主 bash 工具的默认时限(120s)同值 */
const GATE_DEFAULT_TIMEOUT_MS = 120_000;

/** 协议投影:只带 UI 要用的字段(prompt 模板、指纹、并发调度等内部判据不进协议) */
export function workflowStatePayload(
  threadId: string,
  sessionId?: string,
): {
  run: Record<string, unknown> | null;
} {
  const wf = findWorkflowRun(threadId, sessionId);
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
    // 单步超时上限(已解析成执行器实际用的值):UI 据此画「运行超时兜底标记」。
    // 缺省在投影层解析——两端各写一份默认值就是漂移的种子(审计缺陷 4 的 UI 显式化)
    ...(s.kind === "gate"
      ? { timeoutMs: s.gate?.timeoutMs ?? GATE_DEFAULT_TIMEOUT_MS }
      : { timeoutMs: s.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS }),
  }));
  const stepStates = Object.values(wf.steps).map((e) => ({
    key: e.key,
    status: e.status,
    ...(e.error ? { error: e.error } : {}),
    ...(e.startedAt !== undefined ? { startedAt: e.startedAt } : {}),
    ...(e.endedAt !== undefined ? { endedAt: e.endedAt } : {}),
    ...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
    ...(e.delegationId ? { delegationId: e.delegationId } : {}),
    ...(e.delegationIds?.length ? { delegationIds: e.delegationIds } : {}),
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
      // 参数声明与当前值:提案卡渲染参数槽表单(确认 = 授权步骤清单 + 这组参数)。
      // 声明从步骤 prompt 的 {{args.NAME}} 现算——提案时模型可能带 use 展开的子步骤,
      // 声明的唯一事实源是「展开后的步骤文本」,不另存一份会漂移的副本
      ...(wf.plan ? { args: deriveArgsFromSteps(wf.plan.steps) } : {}),
      ...(wf.args && Object.keys(wf.args).length ? { argValues: wf.args } : {}),
      ...(wf.proposalFeedback ? { proposalFeedback: wf.proposalFeedback } : {}),
      ...(wf.completionSummary ? { completionSummary: wf.completionSummary } : {}),
      ...(wf.playbookName ? { playbookName: wf.playbookName } : {}),
      ...(wf.playbookId ? { playbookId: wf.playbookId } : {}),
      // 瘦身行恢复的显式标注(结果不可用 → UI 提示相关步骤将重跑)
      ...(wf.resultsUnavailable ? { resultsUnavailable: true } : {}),
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

/**
 * 从剧本库发起一次运行(设置页「运行」按钮 / 参数化重放):
 * 校验过的参数与剧本溯源一并写进 run,直接到 running——剧本本身在保存时
 * 已经过提案校验与人工检视,不再走确认卡(与 ZCode 的「运行」按钮同语义)。
 * 执行器由调用方(handler)启动。
 */
export function startPlaybookRun(
  run: Running,
  playbook: Playbook,
  args: Record<string, unknown>,
): WorkflowRun {
  const steps = playbookSteps(playbook);
  const objective = playbook.description.trim() || playbook.name;
  let wf = createWorkflowRun(run.threadId, objective);
  wf = {
    ...wf,
    args,
    playbookId: playbook.id,
    playbookName: playbook.name,
  };
  wf = acceptProposal(wf, steps, playbook.name);
  const running = confirmProposal(wf);
  if (!running) throw new Error("failed to start the playbook run (not in proposed state)");
  commitWorkflow(run, running);
  return running;
}

/** 运行历史(设置页):.kova/workflows 目录投影成摘要列表 */
export function listRunSummaries(cwd: string): WorkflowRunSummary[] {
  return listRunFiles(cwd).map((wf) => {
    const topKeys = wf.plan?.steps.map((s) => s.key) ?? [];
    return {
      runId: wf.id,
      ...(wf.title ? { title: wf.title } : {}),
      objective: wf.objective,
      status: wf.status,
      // 会话定位(历史行「查看」跳回对话现场):草稿期线程键(__LOCALID_)不是
      // 可切换的会话 id,不发——UI 据此决定跳转按钮出不出
      ...(wf.threadId && !wf.threadId.startsWith("__LOCALID_") ? { threadId: wf.threadId } : {}),
      startedAt: wf.startedAt,
      updatedAt: wf.updatedAt,
      tokensUsed: wf.tokensUsed,
      stepCount: topKeys.length,
      doneCount: topKeys.filter((k) => wf.steps[k]?.status === "done").length,
      ...(wf.playbookName ? { playbookName: wf.playbookName } : {}),
      ...(wf.playbookId ? { playbookId: wf.playbookId } : {}),
    };
  });
}

/** 提案驳回(proposed → proposing 并带回意见):重提轮据此修改剧本 */
export function rejectWorkflowPlan(run: Running, feedback?: string): WorkflowRun | undefined {
  const wf = findWorkflowRun(run.threadId, run.sessionId);
  if (!wf) return undefined;
  const next = rejectProposal(wf, feedback);
  if (!next) return undefined;
  commitWorkflow(run, next);
  return next;
}

/**
 * 提案确认(proposed → running),带可选参数值(提案卡的参数槽表单)。
 *
 * 参数必须在 confirmProposal 之前落到 run 上:执行器起点的指纹计算读 run.args,
 * 晚一步赋值 = 参数不进指纹 = 同剧本改参重跑会错误命中旧缓存。
 * 校验口径与剧本库运行完全同源(validatePlaybookArgs),不另写一套。
 * 校验失败不迁移状态——用户改完值再点一次即可,不把提案打回让模型重拟。
 */
export function confirmWorkflowPlan(
  run: Running,
  args?: Record<string, unknown>,
): { ok: true; wf: WorkflowRun } | { ok: false; errors: string[] } {
  const wf = findWorkflowRun(run.threadId, run.sessionId);
  if (!wf) return { ok: false, errors: [`no workflow to confirm: ${run.threadId}`] };
  if (wf.status !== "proposed") {
    return { ok: false, errors: [`workflow is not awaiting confirmation: ${run.threadId}`] };
  }
  let next = wf;
  if (wf.plan) {
    const decls = deriveArgsFromSteps(wf.plan.steps);
    const checked = validatePlaybookArgs(decls, args);
    if (!checked.ok) return { ok: false, errors: checked.errors };
    const values = checked.values;
    // 空表不写字段:与库路径 run 的形态一致(无参运行不带 args 键)
    next = { ...next, ...(Object.keys(values).length ? { args: values } : {}) };
  }
  const confirmed = confirmProposal(next);
  if (!confirmed) return { ok: false, errors: [`failed to confirm workflow: ${run.threadId}`] };
  commitWorkflow(run, confirmed);
  logAt("event", `workflow: confirmed run ${confirmed.id} (thread ${run.threadId}, ${Object.keys(args ?? {}).length} args)`);
  return { ok: true, wf: confirmed };
}

/**
 * 单步详情(步骤抽屉按需拉取)。prompt(插值后)与结果是百步 run 里最重的两块,
 * 刻意不进常规快照——每次步骤结算的推进推送都带上它们,一 run 就是几百 KB 的
 * 重复传输;按需 RPC 一次只送点开的那一步。
 */
export function workflowStepDetailPayload(
  threadId: string,
  key: string,
  sessionId?: string,
): { detail: WorkflowStepDetail | null } {
  const wf = findWorkflowRun(threadId, sessionId);
  if (!wf?.plan || !key) return { detail: null };
  const step = findStepForEntry(wf, key);
  if (!step) return { detail: null };
  const entry = wf.steps[key];
  return {
    detail: {
      key,
      kind: step.kind,
      title: step.title,
      status: entry?.status ?? "pending",
      ...(step.phase ? { phase: step.phase } : {}),
      ...(step.agent ? { agent: step.agent } : {}),
      ...(step.model ? { model: step.model } : {}),
      // 插值后的最终 prompt({{item}}/{{args.x}}/上游结果的替换结果)——用户
      // 在抽屉里看到的就该是执行器实际要发出去的那段文本
      prompt: resolveStepPrompt(wf, step, key),
      ...(step.gate
        ? { gate: { command: step.gate.command, ...(step.gate.args ? { args: step.gate.args } : {}) } }
        : {}),
      ...(step.verify
        ? { verify: { reviewers: step.verify.reviewers ?? 2, threshold: step.verify.threshold ?? 0.5 } }
        : {}),
      ...(step.foreach ? { foreach: { from: step.foreach.from } } : {}),
      ...(step.retries ? { retries: step.retries } : {}),
      ...(step.onFail ? { onFail: step.onFail } : {}),
      // 与常规快照同一口径:超时上限解析成执行器实际用的值
      ...(step.kind === "gate"
        ? { timeoutMs: step.gate?.timeoutMs ?? GATE_DEFAULT_TIMEOUT_MS }
        : { timeoutMs: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS }),
      ...(entry?.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
      ...(entry?.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
      ...(entry?.tokens !== undefined ? { tokens: entry.tokens } : {}),
      ...(entry?.delegationId ? { delegationId: entry.delegationId } : {}),
      // journal 里的 result 已按 MAX_STEP_RESULT_CHARS(12k) 截断存好,原样投影
      ...(entry?.result ? { result: entry.result } : {}),
      ...(entry?.error ? { error: entry.error } : {}),
    },
  };
}

/**
 * 用户接管(running 时来了非注入消息):暂停 + 中止在跑步骤。
 * abort 挂钩由 runner 注册;挂钩缺席(执行器还没起)时只搬状态。
 */
export function pauseWorkflowForUserInput(run: Running): void {
  const wf = findWorkflowRun(run.threadId, run.sessionId);
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
  const wf = findWorkflowRun(run.threadId, run.sessionId);
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
 * - running → 用户接管(暂停);paused/终态 → 不动(等人/已结算;清除入口在运行卡上,
 *   常驻条对完成态不再显示——见 desktop workflow-strip 的说明)
 */
export function syncWorkflowOnUserPrompt(run: Running, rawText: string): void {
  if (run.mode !== "workflow") return;
  // 我们自己注入的交付消息也走这条路;不在这里短路会被当成用户接管
  if (isInternalInjectionText(rawText)) return;
  const current = findWorkflowRun(run.threadId, run.sessionId);
  if (!current) {
    const objective = rawText.trim();
    // 空白消息(纯附件/提示行)建不出运行:跳过,让这一轮按普通请求跑
    if (!validateObjectiveText(objective)) return;
    const created = startWorkflow(run, objective);
    // 诊断留痕:实机排查「发了消息却没有运行槽」时,这条日志是分水岭
    logAt("event", `workflow: started run ${created.id} from user prompt (thread ${run.threadId})`);
    return;
  }
  if (current.status === "proposed") {
    const rejected = rejectWorkflowPlan(run, rawText);
    if (rejected) return;
  }
  // running:用户消息**不再**接管/暂停。工作流执行是后台确定性的,一句聊天话
  // (实机里的「确认」「怎么样了?」)不该把正在跑的子代理全掐掉——用户从条上
  // 看不到推进时正会这么做,而暂停反而让「点了没反应」成真。要停有暂停按钮。
  // (goal 档「用户输入即接管」那条语义属于模型在轮次里干活的形态,不适用于执行器)
  // proposing / running / paused / complete / failed:不动(见上)
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
  // 同一会话的活槽挂在别的键下也认(按会话查找,不搬运——搬运会 flapping)
  if (findWorkflowRun(threadId, sessionId)) return;
  // 槽位已存在就什么都不做:恢复源(转录瘦身行 / 全量 run 文件)可能比活槽旧
  // 或正处在写入中间,拿它覆盖 = 把正在跑的运行写回「暂停」并把它在跑的步骤
  // 记成 interrupted(实机事故:执行器活着、槽位被水合的暂停副本替换,UI 显示
  // 已暂停而实际在跑,点「继续」得到 not resumable)。恢复只服务「进程里没有
  // 这个槽」这一种情况——那时才有信息需要从磁盘找回来。
  if (workflows.has(threadId)) return;
  const row = readWorkflowStateRow(sessionId);
  if (!row) return;
  // 瘦身行 + 全量 run 文件(结果/指纹在里面)水合;文件缺失时退回瘦身行
  // (此时历史结果不可用,resume 会重跑——审计缺陷 1 的修复点)
  const parsed = hydrateRestoredRun(row, readRunFile);
  if (!parsed) return;
  if (!parsed.steps) return;
  const hydratedResults = Object.values(parsed.steps).some((e) => e.result !== undefined);
  if (!hydratedResults && Object.values(parsed.steps).some((e) => e.status === "done")) {
    logAt("event", `workflow restore: run ${parsed.id} restored without step results (run file missing)`);
  }
  const wf: WorkflowRun =
    parsed.status === "running"
      ? {
          ...parsed,
          status: "paused",
          // 文案要诚实:走到这里只说明「转录里是 running 但没有执行器在驱动」,
          // 原因可能是进程重启,也可能是别的恢复路径(旧代码里甚至包括「槽位还活着
          // 就被水合覆盖」的误判——那次让用户以为发生了重启,实机反馈原话)
          pauseReason: "没有执行器在驱动这次运行(进程重启或槽位已回收),点继续重新拉起",
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
      // cwd 必须原样带回:它是下次恢复找到 `.kova/workflows/<runId>.json`(结果与
      // 指纹的权威副本)的唯一线索。丢一次,下一次恢复就退回瘦身行——结果全丢、
      // 已完成的步骤重跑,UI 还会如实打上「历史结果未能读回」(实机事故:每次
      // 恢复都在掉结果,因为恢复自己写回的那行没带 cwd)
      const rowCwd = (row as { cwd?: unknown }).cwd;
      appendWorkflowStateRow(sessionId, {
        ...slimRunForTranscript(settled),
        ...(typeof rowCwd === "string" ? { cwd: rowCwd } : {}),
      });
    } catch {
      // 落盘失败不阻断:内存里已经是 paused
    }
  }
}
