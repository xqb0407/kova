"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi-bridge";
import { piSessionRegistry } from "@/lib/pi-thread-adapter";

/**
 * Question 工具的挂起提问（sidecar question-tools.ts 挂起 execute 等待作答）。
 * - 事实源在 sidecar：prompt 流里的 data-question chunk 推送问题列表（见 pi-transport 的 tap）
 * - 用户在 AskUserQuestions 卡片完成作答 → question_answer 请求-响应 → 本地移除卡片
 * - turn 结束（finish chunk）时清空该线程残留卡片，覆盖 abort/异常路径
 */

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
  otherText?: string;
  skipped?: boolean;
};

export type PendingQuestionView = {
  /** = sidecar 侧的 toolCallId，结算凭据 */
  questionId: string;
  questions: QuestionView[];
};

/** threadId -> 挂起提问列表（先进先出展示） */
const pending = new Map<string, PendingQuestionView[]>();
/** getSnapshot 必须返回稳定引用：无提问时共享同一空数组，否则 useSyncExternalStore 会无限循环 */
const EMPTY: PendingQuestionView[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/** 消费 prompt 流里的 data-question chunk（pi-transport 调用） */
export function applyQuestionChunk(threadId: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as { questionId?: unknown; questions?: unknown };
  if (typeof d.questionId !== "string" || !Array.isArray(d.questions)) return;
  const list = pending.get(threadId) ?? [];
  if (list.some((q) => q.questionId === d.questionId)) return;
  pending.set(threadId, [
    ...list,
    { questionId: d.questionId, questions: d.questions as QuestionView[] },
  ]);
  notify();
}

/** turn 结束清空该线程的挂起提问（abort/异常的兜底出口） */
export function clearQuestions(threadId: string): void {
  if (!pending.get(threadId)?.length) return;
  pending.set(threadId, []);
  notify();
}

/** 订阅当前线程的挂起提问列表 */
export function usePendingQuestions(threadId: string | undefined): PendingQuestionView[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (threadId ? (pending.get(threadId) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
}

type QuestionAnswerResponse = { type: "question_answered"; questionId: string };

/** 结算提问：sidecar 的 execute 由此解开，把格式化答案回给模型 */
export async function answerQuestion(
  threadId: string,
  questionId: string,
  answers: QuestionAnswerItem[],
): Promise<void> {
  const sessionId = piSessionRegistry.get(threadId);
  try {
    await piRequest<QuestionAnswerResponse>({
      type: "question_answer",
      questionId,
      answers,
      threadId,
      ...(sessionId ? { sessionId } : {}),
    });
  } finally {
    // 请求失败（提问已被 abort 结算等）也移除卡片，避免悬挂
    const list = pending.get(threadId);
    if (list?.some((q) => q.questionId === questionId)) {
      pending.set(
        threadId,
        list.filter((q) => q.questionId !== questionId),
      );
      notify();
    }
  }
}
