"use client";

import { useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  AskUserQuestions,
  type AskUserAnswer,
  type AskUserQuestion,
} from "@/components/ui/ask-user-questions";
import {
  answerQuestion,
  usePendingQuestions,
  type PendingQuestionView,
  type QuestionView,
} from "@/lib/pi-question";

/**
 * Question 提问卡片：sidecar 的 Question 工具挂起等答时**独占 composer 位**
 * （Composer 组件在有待答提问时直接渲染本卡片，输入框隐藏）。整流经 onComplete
 * 一次性把全部答案经 question_answer 回传 sidecar，execute 解开挂起、模型收到
 * 格式化答案；Stop/新 prompt 由 sidecar 按取消结算，finish chunk 清空后 composer 复原。
 */

/** 线格式 → 组件形态；id 按数组下标回落 q-<i>/o-<i>（与 sidecar 格式化端同约定） */
function toComponentQuestion(q: QuestionView, i: number): AskUserQuestion {
  return {
    id: `q-${i}`,
    title: q.title,
    options: q.options?.map((o, j) => ({
      id: `o-${j}`,
      title: o.title,
      description: o.description,
    })),
    multiSelect: q.multiSelect,
    // 选择题默认给"其它"输入行（freeText 本身就是整框 textarea，不再叠加）
    allowOther: q.freeText ? false : (q.allowOther ?? true),
    otherPlaceholder: q.otherPlaceholder,
    freeText: q.freeText,
    freeTextPlaceholder: q.freeTextPlaceholder,
    nextLabel: "继续",
  };
}

const QuestionFlow: FC<{ threadId: string; pending: PendingQuestionView }> = ({
  threadId,
  pending,
}) => {
  // onComplete 后先本地隐藏：结算回环（sidecar 恢复流式输出）期间不该再允许重复提交
  const [answered, setAnswered] = useState(false);
  if (answered) return null;

  return (
    <AskUserQuestions
      questions={pending.questions.map(toComponentQuestion)}
      skipLabel="跳过"
      onComplete={(answers: Record<string, AskUserAnswer>) => {
        setAnswered(true);
        answerQuestion(
          threadId,
          pending.questionId,
          Object.values(answers).map((a) => ({
            questionId: a.questionId,
            selectedIds: a.selectedIds ?? [],
            otherText: a.otherText,
            skipped: a.skipped,
          })),
        ).catch(() => {});
      }}
    />
  );
};

export const QuestionCard: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const pending = usePendingQuestions(threadId);

  if (!threadId || pending.length === 0) return null;

  return (
    <div
      data-slot="aui-question-card"
      className="flex w-full flex-col items-center gap-2"
    >
      {pending.map((q) => (
        <QuestionFlow key={q.questionId} threadId={threadId} pending={q} />
      ))}
    </div>
  );
};
