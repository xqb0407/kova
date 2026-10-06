"use client";

/**
 * 挂起交互统一 store（设计文档 §4）：逐工具审批（含 MCP 网关审批与 plan_exit
 * 确认）与 Question 提问共用一个模块、一个订阅集。渲染组件经 pi-tool-approval /
 * pi-question 两个薄再导出模块取用，导入路径不变。
 *
 * 三条进卡路径，一份台账视图：
 * 1. 直播流：prompt 流的 data-toolApproval / data-question chunk（pi-transport tap）
 * 2. 刷新/重启回放：get_history 的 pending 字段 → applyHistoryPending
 * 3. 水印缺口修复：list_pending 权威拉取 → refreshPendingInteractions（整表替换，
 *    A 区快照语义；正在本地结算的 id 豁免，防与 tool_confirm 竞态复活卡片）
 *
 * 出口：用户点击 → tool_confirm / question_answer（原线形 + interactionId 寻址）
 * → 本地移除卡片；turn 结束（finish chunk）清空该线程残留，覆盖 abort/异常路径。
 *
 * ⚠ 两本台账的键是**线上 sessionId**，不是 threads.mainThreadId——本会话新建的
 * 线程 mainThreadId 恒为 __LOCALID_ 草稿 id（只有刷新恢复的线程两者同值）。
 * 渲染侧查台账一律用 useInteractionSessionId()（pi-interaction-session），
 * 直接拿 mainThreadId 查会静默 miss。
 */
import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import { piSessionIdForThread } from "@/lib/pi/pi-thread-adapter";
import { emitAgentEvent } from "@/lib/pi/agent-events";
import type { PendingInteraction } from "pi-protocol";

/* ---------------- 视图类型（原两 store 的定义原样上移） ---------------- */

export type PendingToolApprovalView = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** 「同意意味着什么」的额外说明（如：这个项目请求放行某个目录）。
   *  没有它，用户以为只放行这一次、实际可能被别的机制记住 */
  note?: string;
  /** 这条审批带可写根上下文（workspace-write 档的 write/edit）：卡上给第三个按钮
   *  「允许并记住」。其余审批（bash、配置类）没有"一条可记住的路径"，不给 */
  canRemember?: boolean;
};

export type QuestionOptionView = { title: string; description?: string };

export type QuestionView = {
  title: string;
  options?: QuestionOptionView[];
  multiSelect?: boolean;
  allowOther?: boolean;
  otherPlaceholder?: string;
  freeText?: boolean;
  freeTextPlaceholder?: string;
};

/** 与 sidecar QuestionAnswerItem 同形（question_answer 的线格式） */
export type QuestionAnswerItem = {
  questionId: string;
  selectedIds: string[];
  skipped?: boolean;
  otherText?: string;
};

export type PendingQuestionView = {
  /** = sidecar 侧的 toolCallId，结算凭据 */
  questionId: string;
  questions: QuestionView[];
};

/* ---------------- 状态与订阅 ---------------- */

/** threadId -> 挂起审批列表（先进先出展示） */
const approvals = new Map<string, PendingToolApprovalView[]>();
/** threadId -> 挂起提问列表（先进先出展示） */
const questions = new Map<string, PendingQuestionView[]>();
/** 本地结算在途的 interactionId（快照替换豁免集，见 refreshPendingInteractions） */
const settlingLocally = new Set<string>();
/** getSnapshot 必须返回稳定引用：空列表共享同一空数组，否则 useSyncExternalStore 无限循环 */
const EMPTY_APPROVALS: PendingToolApprovalView[] = [];
const EMPTY_QUESTIONS: PendingQuestionView[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/* ---------------- 直播流进卡（pi-transport tap） ---------------- */

/** 消费 prompt 流里的 data-toolApproval chunk */
export function applyToolApprovalChunk(threadId: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as Partial<PendingToolApprovalView>;
  if (typeof d.approvalId !== "string" || typeof d.toolName !== "string") return;
  const list = approvals.get(threadId) ?? [];
  if (list.some((a) => a.approvalId === d.approvalId)) return;
  const wasEmpty = list.length === 0;
  approvals.set(threadId, [
    ...list,
    {
      approvalId: d.approvalId,
      toolCallId: String(d.toolCallId ?? ""),
      toolName: d.toolName,
      input: d.input ?? null,
      ...(typeof d.note === "string" && d.note ? { note: d.note } : {}),
      ...(d.canRemember === true ? { canRemember: true } : {}),
    },
  ]);
  notify();
  // 只在 0→非0 跃迁时发事件：一次任务连推多条审批只响一声/推一条
  if (wasEmpty) {
    emitAgentEvent("agent.approval.pending", {
      threadId,
      data: { toolName: d.toolName, approvalId: d.approvalId },
    });
  }
}

/** 消费 prompt 流里的 data-question chunk */
export function applyQuestionChunk(threadId: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as { questionId?: unknown; questions?: unknown };
  if (typeof d.questionId !== "string" || !Array.isArray(d.questions)) return;
  const list = questions.get(threadId) ?? [];
  if (list.some((q) => q.questionId === d.questionId)) return;
  const wasEmpty = list.length === 0;
  questions.set(threadId, [
    ...list,
    { questionId: d.questionId, questions: d.questions as QuestionView[] },
  ]);
  notify();
  // 与审批同款：0→非0 跃迁才发事件，避免连推多条时重复提醒
  if (wasEmpty) {
    const qs = d.questions as QuestionView[];
    emitAgentEvent("agent.question.pending", {
      threadId,
      data: {
        questionId: d.questionId,
        count: qs.length,
        // 首个问题标题：弹窗通知正文用（webhook generic 信封透传，无害）
        firstTitle: qs[0]?.title?.slice(0, 80),
      },
    });
  }
}

/* ---------------- 回放/快照进卡（get_history pending 字段 / list_pending） ---------------- */

/** 转录回放载荷 → 审批视图（kind=permission；载荷缺字段弃条目） */
function approvalFromInteraction(it: PendingInteraction): PendingToolApprovalView | null {
  if (it.kind !== "permission") return null;
  const p = it.payload as Partial<PendingToolApprovalView> & { approvalId?: unknown };
  if (typeof p.approvalId !== "string" || typeof p.toolName !== "string") return null;
  return {
    approvalId: p.approvalId,
    toolCallId: typeof p.toolCallId === "string" ? p.toolCallId : it.anchorToolCallId,
    toolName: p.toolName,
    input: p.input ?? null,
    ...(typeof p.note === "string" && p.note ? { note: p.note } : {}),
    ...(p.canRemember === true ? { canRemember: true } : {}),
  };
}

/** 转录回放载荷 → 提问视图（kind=question；questions 载荷缺 = 卡片无从渲染，弃条目） */
function questionFromInteraction(it: PendingInteraction): PendingQuestionView | null {
  if (it.kind !== "question") return null;
  const p = it.payload as { questionId?: unknown; questions?: unknown };
  if (typeof p.questionId !== "string" || !Array.isArray(p.questions)) return null;
  return { questionId: p.questionId, questions: p.questions as QuestionView[] };
}

/** 幂等并入（追加缺失项，不动已有项）：get_history 回放用——此时直播流可能
 *  已先送到同一张卡（在飞轮次重挂），按 id 去重即可。 */
export function applyHistoryPending(
  threadId: string,
  items: PendingInteraction[],
): void {
  let changed = false;
  const aList = approvals.get(threadId) ?? [];
  const addApprovals = items.flatMap((it) => {
    const v = approvalFromInteraction(it);
    return v && !aList.some((a) => a.approvalId === v.approvalId) &&
      !settlingLocally.has(v.approvalId)
      ? [v]
      : [];
  });
  if (addApprovals.length) {
    approvals.set(threadId, [...aList, ...addApprovals]);
    if (aList.length === 0) {
      emitAgentEvent("agent.approval.pending", {
        threadId,
        data: {
          toolName: addApprovals[0].toolName,
          approvalId: addApprovals[0].approvalId,
        },
      });
    }
    changed = true;
  }
  const qList = questions.get(threadId) ?? [];
  const addQuestions = items.flatMap((it) => {
    const v = questionFromInteraction(it);
    return v && !qList.some((q) => q.questionId === v.questionId) &&
      !settlingLocally.has(v.questionId)
      ? [v]
      : [];
  });
  if (addQuestions.length) {
    questions.set(threadId, [...qList, ...addQuestions]);
    if (qList.length === 0) {
      emitAgentEvent("agent.question.pending", {
        threadId,
        data: {
          questionId: addQuestions[0].questionId,
          count: addQuestions[0].questions.length,
          firstTitle: addQuestions[0].questions[0]?.title?.slice(0, 80),
        },
      });
    }
    changed = true;
  }
  if (changed) notify();
}

/** 权威快照整表替换（A 区语义，禁深合并）：list_pending 回拉用。
 *  settlingLocally 在途 id 豁免——服务端结算行尚未可见时不许把刚点掉的卡拉回来。 */
function replaceFromSnapshot(threadId: string, items: PendingInteraction[]): void {
  const nextApprovals = items
    .map(approvalFromInteraction)
    .filter((v): v is PendingToolApprovalView => !!v)
    .filter((v) => !settlingLocally.has(v.approvalId));
  const nextQuestions = items
    .map(questionFromInteraction)
    .filter((v): v is PendingQuestionView => !!v)
    .filter((v) => !settlingLocally.has(v.questionId));
  const prevA = approvals.get(threadId) ?? [];
  const prevQ = questions.get(threadId) ?? [];
  const sameIds = (x: { approvalId?: string; questionId?: string }[]) =>
    x.map((e) => e.approvalId ?? e.questionId).join(",");
  const unchanged =
    sameIds(prevA) === sameIds(nextApprovals) &&
    sameIds(prevQ) === sameIds(nextQuestions);
  if (unchanged) return;
  if (prevA.length === 0 && nextApprovals.length > 0) {
    emitAgentEvent("agent.approval.pending", {
      threadId,
      data: {
        toolName: nextApprovals[0].toolName,
        approvalId: nextApprovals[0].approvalId,
      },
    });
  }
  if (nextApprovals.length) approvals.set(threadId, nextApprovals);
  else approvals.delete(threadId);
  if (nextQuestions.length) questions.set(threadId, nextQuestions);
  else questions.delete(threadId);
  notify();
}

/** list_pending 权威拉取（§3 回拉表"交互发起/结算"缺口 / 重连拉平）：失败不动现值。
 *  未发送草稿（尚无会话）跳过：不可能有挂起交互，threadId-only 请求会懒建会话（污染） */
export async function refreshPendingInteractions(
  threadId: string,
): Promise<void> {
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return;
  let items: PendingInteraction[];
  try {
    const res = await piRequest<{ type: "pending"; items: PendingInteraction[] }>({
      type: "list_pending",
      threadId,
      sessionId,
    });
    items = Array.isArray(res.items) ? res.items : [];
  } catch {
    return;
  }
  replaceFromSnapshot(threadId, items);
}

/* ---------------- 清理出口 ---------------- */

/** turn 结束清空该线程的挂起审批（abort/异常的兜底出口） */
export function clearToolApprovals(threadId: string): void {
  if (!approvals.get(threadId)?.length) return;
  approvals.delete(threadId);
  notify();
}

/** turn 结束清空该线程的挂起提问（abort/异常的兜底出口） */
export function clearQuestions(threadId: string): void {
  if (!questions.get(threadId)?.length) return;
  questions.delete(threadId);
  notify();
}

/** 本地移除单条挂起提问。关闭卡片时调用：cancelRun 会拆掉本地流，sidecar 回的
 *  finish chunk 到不了 clearQuestions——不就地移除的话挂起条目常驻，composer
 *  被互斥逻辑一直顶掉（对话框消失）。sidecar 侧由 abort 按取消结算，无碍。 */
export function removePendingQuestion(threadId: string, questionId: string): void {
  const list = questions.get(threadId);
  if (!list) return;
  const next = list.filter((q) => q.questionId !== questionId);
  if (next.length === list.length) return;
  if (next.length === 0) questions.delete(threadId);
  else questions.set(threadId, next);
  notify();
}

/** 消费结算广播 chunk（data-interactionResolved，sidecar 台账结算点统一补发）：
 *  关闭内存卡片。直播路径点卡本有就地移除，本函数专治刷新重放——发起卡的
 *  data-question/data-toolApproval 行在 Rust 重放缓冲里，重放会复活已结算卡；
 *  resolved 帧同缓冲、顺序在后，重放序列 begin→resolved 收敛为空。
 *  id 不在台账时 no-op（重复/乱序帧的幂等分支）。 */
export function removeResolvedInteraction(threadId: string, interactionId: string): void {
  let changed = false;
  const aList = approvals.get(threadId);
  if (aList?.some((a) => a.approvalId === interactionId)) {
    const next = aList.filter((a) => a.approvalId !== interactionId);
    if (next.length) approvals.set(threadId, next);
    else approvals.delete(threadId);
    changed = true;
  }
  const qList = questions.get(threadId);
  if (qList?.some((q) => q.questionId === interactionId)) {
    const next = qList.filter((q) => q.questionId !== interactionId);
    if (next.length) questions.set(threadId, next);
    else questions.delete(threadId);
    changed = true;
  }
  if (changed) notify();
}

/* ---------------- 订阅 hooks ---------------- */

/** 订阅当前线程的挂起审批列表 */
export function usePendingToolApprovals(
  threadId: string | undefined,
): PendingToolApprovalView[] {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? (approvals.get(threadId) ?? EMPTY_APPROVALS) : EMPTY_APPROVALS),
    () => EMPTY_APPROVALS,
  );
}

/** 订阅当前线程的挂起提问列表 */
export function usePendingQuestions(threadId: string | undefined): PendingQuestionView[] {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? (questions.get(threadId) ?? EMPTY_QUESTIONS) : EMPTY_QUESTIONS),
    () => EMPTY_QUESTIONS,
  );
}

/* ---------------- 侧边栏行徽标 ---------------- */

/** 行徽标的两种挂起态（与 AGENT_EVENT_REGISTRY 的审批/提问一一对应） */
export type PendingInteractionKind = "approval" | "question";

/**
 * 订阅某会话的挂起态，压成一个稳定原语（无挂起 = null）。
 * 侧边栏每行都要问「有没有在等我」，但不该为此订阅整份列表——快照返回
 * 字符串而非数组/对象：useSyncExternalStore 要求 getSnapshot 引用稳定，每次
 * 渲染新建标签对象会直接回环。
 * 审批优先于提问：两者同时挂起时审批是更靠前的阻塞关卡。
 * 键是 pi sessionId（台账键空间），与列表行的 remoteId 同值。
 */
export function usePendingInteractionKind(
  sessionId: string | undefined,
): PendingInteractionKind | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!sessionId) return null;
      if (approvals.get(sessionId)?.length) return "approval";
      if (questions.get(sessionId)?.length) return "question";
      return null;
    },
    () => null,
  );
}

/* ---------------- 测试缝 ---------------- */

/** 测试钩子：清空两本台账与在途结算集 */
export function resetInteractionsForTest(): void {
  approvals.clear();
  questions.clear();
  settlingLocally.clear();
}

/** 测试钩子：直读某线程当前视图（与 hook 同源数据，绕开渲染器） */
export const pendingApprovalsForTest = (threadId: string): PendingToolApprovalView[] =>
  approvals.get(threadId) ?? EMPTY_APPROVALS;
export const pendingQuestionsForTest = (threadId: string): PendingQuestionView[] =>
  questions.get(threadId) ?? EMPTY_QUESTIONS;

/* ---------------- 结算出口 ---------------- */

type ToolConfirmResponse = { type: "tool_confirmed"; approvalId: string };

/** 结算审批：approved = 放行执行；false = 拦截（模型收到 blocked 工具结果）。
 *  remember = 点的是「允许并记住」：sidecar 会把这次要写的目录写进本机可写根清单，
 *  之后该目录不再询问。只对带可写根上下文的审批有效，其余审批忽略它。
 *  interactionId 寻址为 §4 新增位（现值恒 = approvalId，服务端旧形不破） */
export async function confirmToolApproval(
  threadId: string,
  approvalId: string,
  approved: boolean,
  remember = false,
): Promise<void> {
  const sessionId = piSessionIdForThread(threadId);
  settlingLocally.add(approvalId);
  try {
    await piRequest<ToolConfirmResponse>({
      type: "tool_confirm",
      approvalId,
      interactionId: approvalId,
      approved,
      ...(approved && remember ? { remember: true } : {}),
      threadId,
      ...(sessionId ? { sessionId } : {}),
    });
  } finally {
    settlingLocally.delete(approvalId);
    // 请求失败（审批已被 abort 清理等）也移除卡片，避免悬挂
    const list = approvals.get(threadId);
    if (list?.some((a) => a.approvalId === approvalId)) {
      if (list.length === 1) approvals.delete(threadId);
      else
        approvals.set(
          threadId,
          list.filter((a) => a.approvalId !== approvalId),
        );
      notify();
    }
  }
}

type QuestionAnswerResponse = { type: "question_answered"; questionId: string };

/**
 * 结算提问：sidecar 的 execute 由此解开，把格式化答案回给模型。
 *
 * cancelled = 用户关掉提问卡而不作答。它与「回答」是两种结算但都**不停轮**：
 * 模型收到的是「用户取消了这次提问，自行判断是否继续」，这一轮照常走完。
 * 宿主不要拿它当停止按钮用——那是 composer 的 Stop 该干的事。
 */
export async function answerQuestion(
  threadId: string,
  questionId: string,
  answers: QuestionAnswerItem[],
  opts: { cancelled?: boolean } = {},
): Promise<void> {
  const sessionId = piSessionIdForThread(threadId);
  settlingLocally.add(questionId);
  try {
    await piRequest<QuestionAnswerResponse>({
      type: "question_answer",
      questionId,
      interactionId: questionId,
      ...(opts.cancelled ? { cancelled: true } : { answers }),
      threadId,
      ...(sessionId ? { sessionId } : {}),
    });
  } finally {
    settlingLocally.delete(questionId);
    // 请求失败（提问已被 abort 结算等）也移除卡片，避免悬挂
    const list = questions.get(threadId);
    if (list?.some((q) => q.questionId === questionId)) {
      if (list.length === 1) questions.delete(threadId);
      else
        questions.set(
          threadId,
          list.filter((q) => q.questionId !== questionId),
        );
      notify();
    }
  }
}
