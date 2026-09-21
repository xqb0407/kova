/**
 * 本地文件（非 vendored）：自动化任务触发时的执行入口（M2.1）。
 *
 * 每次运行 = 一个全新的 agent 会话（计划决策"每次新建独立会话"）：
 *  - threadId `automation:<taskId>:<historyEntryId>` 全新 → resolveSession 以
 *    sessionId=undefined 走建会话分支（显式 id 会被当作续流会话校验存在性，
 *    报 session not found）；会话随转录 JSONL 持久化，事后可回溯；
 *    真实 sessionId 记入 lastRunSessions，M2.2 通知帧/前端跳转用；
 *  - prompt 头部注入"无人值守/勿反问"指引；审批档位经 automation/policy.ts
 *    按线程键裁决（需审批工具即时裁决、Question 即答即回、MCP 非 full 拒、
 *    plan 模式不可达），无人值守永不挂起；
 *  - task.model 可用则只替换本 run 的模型（绝不走全局 set_model，那会把用户
 *    交互会话的模型一起劫持走）；
 *  - timeoutMs 超时走协议同款 abort 路径（中止代理并结算挂起项）；
 *  - 成功返回 / 失败 throw —— vendored 调度器以 runner 抛错为 error 记账。
 */
import { logErr } from "../log";
import { getModels } from "../model/model-catalog";
import { sessionRename } from "../storage/hostdb";
import {
  dispatch,
  dispatchPrompt,
  mgmtResolveSession,
  type PromptTurnOutcome,
} from "../protocol/protocol";
import type { Running } from "../types";
import {
  normalizeToolPolicyProfile,
  registerAutomationThread,
  unregisterAutomationThread,
} from "./policy";
import type { ScheduledTask, ScheduledTaskRunContext, ScheduledTaskRunner } from "./index";

/** 任务未填 timeoutMs 时的兜底运行上限（够跑分钟级长任务，防孤儿 turn 永挂） */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function cwdOf(task: ScheduledTask): string | undefined {
  const dir = task.workspaceDir?.trim();
  return dir ? dir : undefined;
}

/** 自包含 prompt：定时触发时没有人会补充上下文，指引 + 原任务文本一次到位 */
function buildPrompt(task: ScheduledTask): string {
  const name = task.name?.trim() || task.id;
  const lines = [
    "【无人值守定时任务运行】",
    `你是定时任务「${name}」在本次自动触发中的执行体。此刻没有用户在线：`,
    "- 遇到歧义按最合理的假设继续，并在最终输出中写明所做假设；",
    "- 不要向用户提问（该模式下提问与工具审批请求会被系统直接拒绝）；",
    "- 输出即交付物：把结果写清楚，需要落盘的成果按任务要求写到文件。",
    "",
    task.prompt,
  ];
  return lines.join("\n");
}

/** per-task 模型：仅替换本 run 的 state.model（systemPrompt 由 runPromptTurn
 *  轮前以 state.model 重排，无需在此重建）；解析不到/无凭据则回落默认模型并记日志 */
async function applyTaskModel(run: Running, task: ScheduledTask): Promise<void> {
  const provider = task.model?.provider?.trim();
  const modelId = task.model?.model?.trim();
  if (!provider || !modelId || modelId === "unknown") return;
  const catalog = getModels();
  const model = catalog.getModel(provider, modelId);
  const auth = model ? await catalog.getAuth(provider).catch(() => undefined) : undefined;
  if (!model || !auth) {
    logErr(`automation: task model ${provider}/${modelId} unavailable, using default model`);
    return;
  }
  run.agent.state.model = model;
}

/** 每次运行的会话标题 = 任务名 + 触发时刻。不显式命名的话，标题兜底串是
 *  首条消息截断——同一任务每次运行的 prompt 一模一样，侧边栏里全是重复标题；
 *  智能总结标题也是对同一 prompt 摘要，同样重复。建会话后立即改名，后续
 *  sessionTouch 只回填空标题、智能标题守卫（已改名 ≠ 兜底串）自动跳过。 */
export function automationRunTitle(
  task: Pick<ScheduledTask, "name" | "prompt">,
  startedAt: string,
): string {
  const name =
    task.name?.trim() || task.prompt.trim().replace(/\s+/g, " ").slice(0, 24) || "定时任务";
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return name;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${name} ${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** historyEntryId -> 本次运行真实的 agent sessionId（建会话即记，成功失败都留）。
 *  调度器 runHistory 每任务 ≤25 条，键随历史有界；不做清理以便事后回溯。 */
const lastRunSessions = new Map<string, string>();
export function getAutomationRunSession(historyEntryId: string): string | undefined {
  return lastRunSessions.get(historyEntryId);
}

export async function runAutomationTask(
  task: ScheduledTask,
  run: ScheduledTaskRunContext,
): Promise<void> {
  const threadId = `automation:${task.id}:${run.historyEntryId}`;
  const reqId = `auto-${run.historyEntryId}`;
  const profile = normalizeToolPolicyProfile(task.toolPolicyProfile);
  const timeoutMs =
    typeof task.timeoutMs === "number" && task.timeoutMs > 0 ? task.timeoutMs : DEFAULT_TIMEOUT_MS;

  registerAutomationThread(threadId, profile);
  let outcome: PromptTurnOutcome | undefined;
  let timedOut = false;
  let realSessionId: string | undefined;
  try {
    // 预建会话走管理队列（与 runPromptTurn 的会话准备段同队串行）；
    // sessionId 传 undefined 才会新建（显式 id 被当作续流校验）。随后
    // dispatchPrompt 内 resolveSession 命中 running 表 fast path 复用同一实例
    const sess = await mgmtResolveSession(threadId, undefined, cwdOf(task));
    realSessionId = sess.sessionId;
    lastRunSessions.set(run.historyEntryId, sess.sessionId);
    // 抢在轮初落盘前定名：侧边栏行从出现起就是可区分的标题；改名失败只丢
    // 个性化标题（回落 prompt 截断），绝不阻断运行
    try {
      await sessionRename(sess.sessionId, automationRunTitle(task, run.startedAt));
    } catch (err) {
      logErr(`automation: title rename failed for session ${sess.sessionId}:`, err);
    }
    await applyTaskModel(sess, task);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(() => {
        timedOut = true;
        logErr(`automation: task ${task.id} exceeded ${timeoutMs}ms, aborting run`);
        void dispatch("", { type: "abort", threadId });
      }, timeoutMs);
      timer.unref?.();
      await dispatchPrompt(
        reqId,
        {
          threadId,
          sessionId: sess.sessionId,
          cwd: cwdOf(task),
          text: buildPrompt(task),
        },
        (o) => {
          outcome = o;
        },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    unregisterAutomationThread(threadId);
  }

  if (timedOut) {
    throw new Error(`automation run timed out after ${timeoutMs}ms`);
  }
  if (!outcome) {
    throw new Error("automation run ended without an outcome (unexpected queue hand-off)");
  }
  if (!outcome.ok) {
    throw new Error(outcome.errorText ?? "automation run failed");
  }
  logErr(`automation: task ${task.id} completed (session ${realSessionId})`);
}

export const automationRunner: ScheduledTaskRunner = async (task, run) => {
  await runAutomationTask(task, run);
};
