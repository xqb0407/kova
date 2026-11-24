/**
 * Inbox 对外的聚合门面：列表、详情、动作、用户状态。
 * 协议 handler 只做参数校验与应答；动作语义都落在这里，便于测试。
 */
import type {
  InboxAction,
  InboxCounts,
  InboxDetail,
  InboxFilter,
  InboxItem,
  InboxUpdatePatch,
} from "pi-protocol";
import type { QuestionAnswerItem } from "../tools/question-tools";
import { resume, goalStatePayload, restoreGoal } from "../goal/goal";
import {
  applyQuestionAnswer,
  applyToolConfirm,
  parseRememberScope,
} from "../permissions/interactions";
import { resolveSession } from "../sessions/sessions";
import { sessionForThread } from "../sessions/pending-interactions";
import { findInteractionRow } from "../sessions/transcript";
import { getDelegationSnapshot } from "../subagent/delegation";
import { bgTasksSnapshot } from "../tools/bg-tasks";
import {
  getInboxItem,
  getInboxCounts,
  listInbox,
  resolveInboxItem,
  updateInboxState as updateState,
  updateInboxStateForFilter,
  setInboxItemsArchivedForSession,
  InboxError,
  type InboxListResult,
} from "./store";
import { safePreview } from "./summary";

export {
  initInbox,
  isInboxEnabled,
  setInboxBroadcaster,
  upsertInboxItem,
  resolveInboxItem,
  expireInboxItem,
  expireInboxItemsForSession,
  reconcileInboxSources,
  getInboxCounts,
  getInboxItem,
  listInbox,
  syncExternalInboxItems,
  setInboxItemsArchivedForSession,
  resetInboxForTest,
  inboxSnapshotForTest,
  InboxError,
} from "./store";

export type InboxDetailResult = {
  detail?: InboxDetail;
  stale?: boolean;
};

export function listInboxPayload(
  filter?: InboxFilter,
  limit?: number,
  cursor?: string,
): InboxListResult {
  return listInbox(filter, limit, cursor);
}

/**
 * 详情按需读源；源已消失时返回 stale，前端只保留归档动作。
 * 不把完整工具输入/报告写进日志——这里才读原文。
 */
export async function getInboxDetail(item: InboxItem): Promise<InboxDetailResult> {
  switch (item.kind) {
    case "approval":
    case "question": {
      // 会话落库前发起的 MCP 审批没有 sessionId：thread 台账可能已经能解析
      const sessionId =
        item.sessionId ?? (item.threadId ? sessionForThread(item.threadId) : undefined);
      if (!sessionId) return { stale: true };
      const interaction = findInteractionRow(sessionId, item.sourceId);
      if (!interaction) return { stale: true };
      return {
        detail:
          item.kind === "approval"
            ? { kind: "approval", interaction }
            : { kind: "question", interaction },
      };
    }

    case "goal": {
      const threadId = item.threadId ?? item.sessionId ?? "";
      if (!threadId) return { stale: true };
      // 刷新/重启后内存槽可能为空：先只读回放 goal_state 行
      if (item.sessionId) restoreGoal(threadId, item.sessionId);
      const payload = goalStatePayload(threadId);
      if (!payload.goal) return { stale: true };
      return { detail: { kind: "goal", goal: payload } };
    }

    case "automation": {
      const taskId = typeof item.meta?.taskId === "string" ? item.meta.taskId : "";
      const runId = typeof item.meta?.runId === "string" ? item.meta.runId : item.sourceId;
      if (!taskId || !runId) return { stale: true };
      const { automationListPayload } = await import("../automation/commands");
      let payload: Awaited<ReturnType<typeof automationListPayload>>;
      try {
        payload = await automationListPayload();
      } catch {
        // 调度器未就绪/独立进程暂时不可达：详情按 stale 处理，不把 Inbox 详情页打成错误
        return { stale: true };
      }
      const task = payload.tasks.find((t) => t.id === taskId);
      const run = task?.runHistory?.find((r) => r.id === runId);
      if (!task || !run) return { stale: true };
      return {
        detail: {
          kind: "automation",
          task: { id: task.id, name: safePreview(task.name, 120) },
          run: {
            id: run.id,
            status: run.status,
            createdAt: run.createdAt,
            ...(run.message ? { message: safePreview(run.message) } : {}),
          },
          ...(item.sessionId ? { sessionId: item.sessionId } : {}),
        },
      };
    }

    case "subagent": {
      const delegationId =
        typeof item.meta?.delegationId === "string"
          ? item.meta.delegationId
          : item.sourceId;
      const snapshot = getDelegationSnapshot(delegationId);
      if (!snapshot) return { stale: true };
      return {
        detail: {
          kind: "subagent",
          record: {
            delegationId: snapshot.record.delegationId,
            agentName: snapshot.record.agentName,
            status: snapshot.record.status,
            startedAt: snapshot.record.startedAt,
            ...(snapshot.record.completedAt !== undefined
              ? { completedAt: snapshot.record.completedAt }
              : {}),
            turns: snapshot.record.turns,
            toolCalls: snapshot.record.toolCalls,
            canResume: snapshot.record.canResume,
          },
          ...(snapshot.record.report ? { report: snapshot.record.report } : {}),
        },
      };
    }

    case "external": {
      const external = item.external;
      if (!external) return { stale: true };
      return {
        detail: {
          kind: "external",
          external,
          title: item.title,
          ...(item.summary ? { description: item.summary } : {}),
        },
      };
    }

    case "background_task": {
      const taskId = Number(item.meta?.taskId);
      if (!item.threadId || !Number.isFinite(taskId)) return { stale: true };
      const task = bgTasksSnapshot(item.threadId).find((t) => t.taskId === taskId);
      if (!task) return { stale: true };
      return {
        detail: {
          kind: "background_task",
          task: {
            taskId: task.taskId,
            command: safePreview(task.command, 2000),
            source: task.source,
            startedAt: task.startedAt,
            exitCode: task.exitCode,
          },
        },
      };
    }

    default:
      return { stale: true };
  }
}

function requireKind(item: InboxItem, kind: InboxItem["kind"]): void {
  if (item.kind !== kind) {
    throw new InboxError(
      "INBOX_ACTION_NOT_ALLOWED",
      `inbox: action is not valid for ${item.kind}`,
    );
  }
}

function userStatePatch(
  action: InboxAction,
  payload: unknown,
): InboxUpdatePatch | null {
  switch (action) {
    case "archive":
      return { archived: true };
    case "unarchive":
      return { archived: false };
    case "delete":
      // 墓碑删除（store 里二次校验：只允许已结束/非 open 条目）
      return { deleted: true };
    case "mark_read":
      return { read: true };
    case "mark_unread":
      return { read: false };
    case "snooze": {
      const p = (payload ?? {}) as { until?: unknown };
      const until =
        typeof p.until === "string" && p.until
          ? p.until
          : new Date(Date.now() + 60 * 60 * 1000).toISOString();
      return { snoozedUntil: until };
    }
    default:
      return null;
  }
}

/**
 * 执行 Inbox 动作。用户状态动作本地结算；阻塞/终态动作复用既有领域函数，
 * 绝不直接调用协议 handler（避免同一 reqId 两条应答帧）。
 */
const inFlightActionKeys = new Set<string>();

export async function applyInboxAction(
  itemId: string,
  action: InboxAction,
  payload?: unknown,
): Promise<InboxItem> {
  // 同一 item 的同一动作串行：双击/双端同时点 retry 不能启动两次定时任务
  const key = `${itemId}:${action}`;
  if (inFlightActionKeys.has(key)) {
    throw new InboxError(
      "INBOX_ACTION_IN_PROGRESS",
      `inbox: action already in progress: ${action}`,
    );
  }
  inFlightActionKeys.add(key);
  try {
    return await applyInboxActionInner(itemId, action, payload);
  } finally {
    inFlightActionKeys.delete(key);
  }
}

async function applyInboxActionInner(
  itemId: string,
  action: InboxAction,
  payload?: unknown,
): Promise<InboxItem> {
  const item = getInboxItem(itemId);
  if (!item) {
    throw new InboxError("INBOX_ITEM_NOT_FOUND", `inbox: item not found: ${itemId}`);
  }

  const patch = userStatePatch(action, payload);
  if (patch) {
    updateState([itemId], patch);
    return getInboxItem(itemId) ?? item;
  }

  if (action === "open") return item;

  if (action !== "approve" && action !== "deny" && action !== "answer" && action !== "cancel" && action !== "resume" && action !== "retry") {
    throw new InboxError("INBOX_ACTION_NOT_ALLOWED", `inbox: unknown action: ${action}`);
  }
  if (!item.actions.includes(action)) {
    throw new InboxError(
      "INBOX_ACTION_NOT_ALLOWED",
      `inbox: action ${action} is not allowed on this item`,
    );
  }
  // 已结算条目仍可能保留旧 actions（失败自动化的 retry）；动作层再按 requiresAction
  // 闸一次，防另一端/脚本对同一件事重复批准或重复重跑。
  if (!item.requiresAction) {
    throw new InboxError(
      "INBOX_ALREADY_RESOLVED",
      `inbox: item is no longer actionable: ${itemId}`,
    );
  }

  if (action === "approve" || action === "deny") {
    requireKind(item, "approval");
    if (!item.threadId) {
      throw new InboxError("INBOX_ITEM_STALE", "inbox: approval has no thread");
    }
    const p = (payload ?? {}) as {
      remember?: unknown;
      rememberScope?: unknown;
      reason?: unknown;
    };
    const rememberScope = parseRememberScope(p.rememberScope);
    await applyToolConfirm({
      threadId: item.threadId,
      ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      approvalId: item.sourceId,
      approved: action === "approve",
      // 只有原始审批卡允许「允许并记住」时才能记住；Inbox 不能扩大授权面
      remember: p.remember === true && item.meta?.canRemember === true,
      ...(rememberScope ? { rememberScope } : {}),
      ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
    });
  } else if (action === "answer" || action === "cancel") {
    requireKind(item, "question");
    const p = (payload ?? {}) as { answers?: unknown };
    applyQuestionAnswer({
      questionId: item.sourceId,
      cancelled: action === "cancel",
      answers: Array.isArray(p.answers) ? (p.answers as QuestionAnswerItem[]) : [],
    });
  } else if (action === "resume") {
    requireKind(item, "goal");
    if (!item.threadId) {
      throw new InboxError("INBOX_ITEM_STALE", "inbox: goal has no thread");
    }
    const run = await resolveSession(item.threadId, item.sessionId);
    const goal = resume(run);
    if (!goal) {
      throw new InboxError("INBOX_ITEM_STALE", "inbox: goal is no longer resumable");
    }
    // 懒加载：sessions handler 与 protocol/stream 之间有既有模块链，放在动作
    // 触发时导入，避免 Inbox 在 protocol.ts 初始化期形成新的静态环。
    const { kickGoalLoop } = await import("../protocol/handlers/sessions");
    kickGoalLoop(run);
  } else if (action === "retry") {
    requireKind(item, "automation");
    const taskId = typeof item.meta?.taskId === "string" ? item.meta.taskId : "";
    if (!taskId) {
      throw new InboxError("INBOX_ITEM_STALE", "inbox: automation task id missing");
    }
    const { automationRunNowPayload } = await import("../automation/commands");
    await automationRunNowPayload({ type: "automation_run_now", taskId });
    // 旧失败记录收口：新 run 结算后会生成新条目，旧条目不应继续“待处理”
    resolveInboxItem(itemId, "resolved");
  }

  return getInboxItem(itemId) ?? item;
}

export function updateInboxPayload(
  itemIds: string[],
  patch: InboxUpdatePatch,
): { itemIds: string[]; counts: InboxCounts } {
  return updateState(itemIds, patch);
}

/** 「全部已读/全部归档」：按筛选条件跨分页批量更新，不受 100 条 id 上限约束 */
export function updateInboxPayloadAll(
  filter: InboxFilter | undefined,
  patch: InboxUpdatePatch,
): { itemIds: string[]; counts: InboxCounts } {
  return updateInboxStateForFilter(filter, patch);
}
