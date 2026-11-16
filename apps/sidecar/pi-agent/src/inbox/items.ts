/**
 * Inbox item 构造器：把各源的结构化事实映射成统一的 InboxItem。
 * 这里只做纯映射，不落盘、不广播；summary 一律经 safePreview。
 */
import type {
  InboxItem,
  InboxPriority,
  PendingInteraction,
  SubagentRunStatus,
} from "pi-protocol";
import type { Goal } from "../goal/goal-state";
import { safePreview } from "./summary";

const nowIso = () => new Date().toISOString();

/** 外部 adapter/源时间可能坏掉；坏时间回落当前时刻，避免排序 NaN/落盘后无法解析 */
function safeIso(value: string | undefined): string {
  if (value && Number.isFinite(Date.parse(value))) return value;
  return nowIso();
}

function safeIsoFromMs(value: number | undefined): string {
  return Number.isFinite(value) ? new Date(value!).toISOString() : nowIso();
}

function baseItem(input: {
  id: string;
  kind: InboxItem["kind"];
  title: string;
  summary?: string;
  sourceId: string;
  sessionId?: string;
  threadId?: string;
  projectId?: string;
  createdAt?: string;
  priority: InboxPriority;
  requiresAction: boolean;
  actions: InboxItem["actions"];
  deepLink?: InboxItem["deepLink"];
  external?: InboxItem["external"];
  meta?: Record<string, unknown>;
  hasDetail?: boolean;
}): InboxItem {
  const at = safeIso(input.createdAt);
  return {
    id: input.id,
    kind: input.kind,
    state: "open",
    priority: input.priority,
    requiresAction: input.requiresAction,
    title: input.title,
    ...(input.summary ? { summary: input.summary } : {}),
    sourceId: input.sourceId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    createdAt: at,
    updatedAt: nowIso(),
    actions: input.actions,
    ...(input.deepLink ? { deepLink: input.deepLink } : {}),
    ...(input.external ? { external: input.external } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
    hasDetail: input.hasDetail ?? true,
  };
}

/** 审批/提问条目 ID（结算侧不用重新解析载荷） */
export function interactionInboxId(
  kind: "approval" | "question",
  interactionId: string,
): string {
  return `${kind}:${interactionId}`;
}

/** 审批/提问：两者共用 PendingInteraction 形状，按 kind 收窄 */
export function buildInteractionItem(
  interaction: PendingInteraction,
  ctx: { threadId: string; sessionId?: string },
): InboxItem | null {
  if (interaction.kind === "permission") {
    const p = interaction.payload as {
      approvalId?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      input?: unknown;
      note?: unknown;
      canRemember?: unknown;
    };
    if (typeof p.approvalId !== "string" || typeof p.toolName !== "string") return null;
    const summary =
      typeof p.note === "string" && p.note.trim()
        ? safePreview(p.note)
        : safePreview(p.input);
    return baseItem({
      id: `approval:${interaction.interactionId}`,
      kind: "approval",
      title: `需要批准：${safePreview(p.toolName, 80)}`,
      summary: summary || "工具执行前等待你批准",
      sourceId: interaction.interactionId,
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      createdAt: interaction.createdAt,
      priority: 0,
      requiresAction: true,
      actions: ["open", "approve", "deny", "mark_read"],
      deepLink: {
        threadId: ctx.threadId,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        anchorToolCallId:
          typeof p.toolCallId === "string" ? p.toolCallId : interaction.anchorToolCallId,
      },
      meta: {
        approvalId: p.approvalId,
        toolCallId: typeof p.toolCallId === "string" ? p.toolCallId : "",
        toolName: p.toolName,
        canRemember: p.canRemember === true,
      },
    });
  }

  const p = interaction.payload as { questionId?: unknown; questions?: unknown };
  if (typeof p.questionId !== "string") return null;
  const questions = Array.isArray(p.questions) ? p.questions : [];
  const first = questions[0] as { title?: unknown } | undefined;
  const firstTitle = typeof first?.title === "string" ? first.title : "";
  const count = questions.length;
  const summary = firstTitle
    ? `${safePreview(firstTitle, 180)}${count > 1 ? ` · 共 ${count} 个问题` : ""}`
    : count > 0
      ? `共 ${count} 个问题`
      : "Agent 等待你作答";
  return baseItem({
    id: `question:${interaction.interactionId}`,
    kind: "question",
    title: "Agent 提问",
    summary,
    sourceId: interaction.interactionId,
    sessionId: ctx.sessionId,
    threadId: ctx.threadId,
    createdAt: interaction.createdAt,
    priority: 0,
    requiresAction: true,
    actions: ["open", "answer", "cancel", "mark_read"],
    deepLink: {
      threadId: ctx.threadId,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      anchorToolCallId: interaction.anchorToolCallId,
    },
    meta: { questionId: p.questionId, count },
  });
}

/** 目标状态：active 普通续跑返回 null（调用方据此 resolve 旧条目） */
export function buildGoalInboxItem(args: {
  goal: Goal;
  threadId: string;
  sessionId?: string;
}): InboxItem | null {
  const { goal, threadId, sessionId } = args;
  const scope = sessionId || threadId;
  const id = `goal:${scope}:${goal.id}`;
  const base = {
    id,
    kind: "goal" as const,
    sourceId: goal.id,
    sessionId,
    threadId,
    createdAt: safeIsoFromMs(goal.updatedAt),
    hasDetail: true,
  };

  if (goal.status === "complete") {
    return {
      ...baseItem({
        ...base,
        title: "目标完成",
        summary: safePreview(goal.completionSummary || goal.objective),
        priority: 2,
        requiresAction: false,
        actions: ["open", "mark_read", "archive"],
        deepLink: { ...(sessionId ? { sessionId } : {}), threadId },
        meta: {
          goalId: goal.id,
          status: goal.status,
          acceptanceStatus: goal.acceptance?.status,
        },
      }),
      state: "done",
      outcome: "completed",
    };
  }

  // 自动验收标准会在同一轮立刻 confirmed，不为瞬时 proposed 建条目
  if (
    goal.status === "active" &&
    goal.acceptance?.status === "proposed" &&
    goal.acceptanceMode === "manual"
  ) {
    return baseItem({
      ...base,
      title: "待确认验收标准",
      summary: safePreview(goal.objective),
      priority: 0,
      requiresAction: true,
      actions: ["open", "mark_read"],
      deepLink: { ...(sessionId ? { sessionId } : {}), threadId },
      meta: {
        goalId: goal.id,
        status: goal.status,
        acceptanceStatus: goal.acceptance.status,
      },
    });
  }

  if (goal.status === "blocked") {
    return baseItem({
      ...base,
      title: "目标受阻",
      summary: safePreview(goal.pauseReason || goal.objective),
      priority: 0,
      requiresAction: true,
      actions: ["open", "resume", "mark_read"],
      deepLink: { ...(sessionId ? { sessionId } : {}), threadId },
      meta: { goalId: goal.id, status: goal.status },
    });
  }

  if (goal.status === "paused") {
    const reason = goal.pauseReason ?? "";
    const userSelfPaused =
      reason.includes("user left goal mode") ||
      reason.includes("user sent a message") ||
      reason.includes("sidecar restarted");
    return baseItem({
      ...base,
      title: "目标已暂停",
      summary: safePreview(reason || goal.objective),
      priority: userSelfPaused ? 2 : 1,
      // 任何 paused 都是「还没结束、需要人决定继续还是放着」；userSelfPaused
      // 只是优先级低，不应从待处理 Tab 消失（open + requiresAction=false 会两边都不收）。
      requiresAction: true,
      actions: ["open", "resume", "mark_read"],
      deepLink: { ...(sessionId ? { sessionId } : {}), threadId },
      meta: { goalId: goal.id, status: goal.status, pauseReason: reason },
    });
  }

  return null;
}

export function goalInboxId(args: {
  goalId: string;
  threadId: string;
  sessionId?: string;
}): string {
  return `goal:${args.sessionId || args.threadId}:${args.goalId}`;
}

/** 自动化一次运行终态 */
export function buildAutomationItem(args: {
  taskId: string;
  taskName?: string;
  runId: string;
  ok: boolean;
  /** 用户主动 Stop / 取消：已处理，不进待关注、不提供重跑 */
  stopped?: boolean;
  error?: string;
  sessionId?: string;
  projectId?: string;
  finishedAt?: string;
  /** 事件触发来源（L1）；cron/interval/once 触发不带 */
  trigger?: { type: string; id?: string; summary?: string };
}): InboxItem {
  const name = safePreview(args.taskName || args.taskId, 100);
  const stopped = !args.ok && args.stopped === true;
  const triggerTag = args.trigger?.type ? `[${args.trigger.type}] ` : "";
  const item = baseItem({
    id: `automation:${args.taskId}:${args.runId}`,
    kind: "automation",
    title: stopped
      ? `自动化已停止：${name}`
      : args.ok
        ? `自动化完成：${triggerTag}${name}`
        : `自动化失败：${triggerTag}${name}`,
    // Stop 是用户已知动作，不把内部错误文案（run aborted by stop request）当摘要
    summary: stopped
      ? "运行被手动停止"
      : args.ok
        ? "运行成功"
        : safePreview(args.error || "运行失败"),
    sourceId: args.runId,
    sessionId: args.sessionId,
    projectId: args.projectId,
    createdAt: args.finishedAt,
    priority: stopped ? 2 : args.ok ? 2 : 1,
    requiresAction: !args.ok && !stopped,
    actions: stopped
      ? ["open", "mark_read", "archive"]
      : args.ok
        ? ["open", "mark_read", "archive"]
        : ["open", "retry", "mark_read", "archive"],
    deepLink: args.sessionId ? { sessionId: args.sessionId } : undefined,
    meta: {
      taskId: args.taskId,
      // 供任务聚合行标题使用；与 title 一样过脱敏，避免原始任务名带密钥/控制字符
      taskName: name,
      runId: args.runId,
      ok: args.ok,
      ...(stopped ? { stopped: true } : {}),
      ...(args.trigger
        ? {
            trigger: {
              type: args.trigger.type,
              ...(args.trigger.id ? { id: args.trigger.id } : {}),
              ...(args.trigger.summary
                ? { summary: safePreview(args.trigger.summary, 200) }
                : {}),
            },
          }
        : {}),
    },
  });
  return {
    ...item,
    state: "done",
    outcome: stopped ? "stopped" : args.ok ? "success" : "failed",
  };
}

/** 子代理终态；running 不产生条目 */
export function buildSubagentItem(args: {
  delegationId: string;
  agentName: string;
  status: SubagentRunStatus;
  report?: string;
  turns: number;
  toolCalls: number;
  completedAt: number;
  sessionId?: string;
  threadId?: string;
}): InboxItem | null {
  if (args.status === "running") return null;
  const failed =
    args.status === "failed" ||
    args.status === "truncated" ||
    args.status === "interrupted";
  const stopped = args.status === "stopped" || args.status === "aborted";
  const completed = args.status === "completed";
  const title = completed
    ? `子代理完成：${safePreview(args.agentName, 80)}`
    : stopped
      ? `子代理已停止：${safePreview(args.agentName, 80)}`
      : `子代理失败：${safePreview(args.agentName, 80)}`;
  const item = baseItem({
    id: `subagent:${args.delegationId}:${args.completedAt}`,
    kind: "subagent",
    title,
    summary: args.report
      ? safePreview(args.report)
      : completed
        ? "报告已生成"
        : `状态：${args.status}`,
    sourceId: args.delegationId,
    sessionId: args.sessionId,
    threadId: args.threadId,
    createdAt: safeIsoFromMs(args.completedAt),
    priority: failed ? 1 : 2,
    requiresAction: failed,
    actions: ["open", "mark_read", "archive"],
    deepLink: {
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(args.threadId ? { threadId: args.threadId } : {}),
      panel: "subagents",
    },
    meta: {
      delegationId: args.delegationId,
      agentName: args.agentName,
      status: args.status,
      turns: args.turns,
      toolCalls: args.toolCalls,
    },
  });
  return {
    ...item,
    state: "done",
    outcome: completed ? "completed" : stopped ? "stopped" : failed ? "failed" : "interrupted",
  };
}

/**
 * 外部工作项（预留）：GitHub Issue/PR、Jira/Linear issue 等由后续 adapter
 * 调用；v1 只支持「打开外部链接」，不提供就地写入动作。
 */
function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function buildExternalInboxItem(args: {
  provider: string;
  type?: string;
  key?: string;
  title: string;
  summary?: string;
  url?: string;
  status?: string;
  sourceName?: string;
  createdAt?: string;
  requiresAction?: boolean;
  priority?: InboxPriority;
}): InboxItem {
  const provider = safePreview(args.provider, 40) || "external";
  const url = safeHttpUrl(args.url);
  const idKey = args.key || url || args.title;
  return baseItem({
    id: `external:${provider}:${idKey}`,
    kind: "external",
    title: safePreview(args.title, 160),
    ...(args.summary ? { summary: safePreview(args.summary) } : {}),
    sourceId: idKey,
    createdAt: args.createdAt,
    priority: args.priority ?? (args.requiresAction ? 1 : 2),
    requiresAction: args.requiresAction === true,
    actions: ["open", "mark_read", "archive"],
    ...(url ? { deepLink: { url } } : {}),
    external: {
      provider,
      ...(args.type ? { type: args.type } : {}),
      ...(args.key ? { key: args.key } : {}),
      ...(url ? { url } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.sourceName ? { sourceName: args.sourceName } : {}),
    },
    meta: {
      provider,
      ...(args.type ? { type: args.type } : {}),
      ...(args.key ? { key: args.key } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.sourceName ? { sourceName: args.sourceName } : {}),
    },
  });
}

/** 后台 bash 任务终态 */
export function buildBackgroundTaskItem(args: {
  taskId: number;
  command: string;
  source: string;
  startedAt: number;
  exitCode: number | null;
  stopped?: boolean;
  sessionId?: string;
  threadId: string;
}): InboxItem {
  const failed = !args.stopped && typeof args.exitCode === "number" && args.exitCode !== 0;
  const item = baseItem({
    id: `bg:${args.sessionId || args.threadId}:${args.taskId}`,
    kind: "background_task",
    title: failed ? "后台命令失败" : args.stopped ? "后台命令已停止" : "后台命令完成",
    summary: safePreview(args.command),
    sourceId: String(args.taskId),
    sessionId: args.sessionId,
    threadId: args.threadId,
    createdAt: safeIsoFromMs(args.startedAt),
    priority: failed ? 1 : 2,
    requiresAction: failed,
    actions: ["open", "mark_read", "archive"],
    deepLink: {
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      threadId: args.threadId,
    },
    meta: {
      taskId: args.taskId,
      exitCode: args.exitCode,
      source: args.source,
    },
  });
  return {
    ...item,
    state: "done",
    outcome: failed ? "failed" : args.stopped ? "stopped" : "success",
  };
}
