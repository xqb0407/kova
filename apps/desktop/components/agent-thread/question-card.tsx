"use client";

import { useState, type FC } from "react";
import {
  AskUserQuestions,
  type AskUserAnswer,
  type AskUserQuestion,
} from "@/components/ui/ask-user-questions";
import { useInteractionSessionId } from "@/lib/pi/pi-interaction-session";
import {
  answerQuestion,
  removePendingQuestion,
  usePendingQuestions,
  type PendingQuestionView,
  type QuestionView,
} from "@/lib/pi/pi-question";

/**
 * Question 提问卡片：sidecar 的 Question 工具挂起等答时**独占 composer 位**
 * （Composer 组件在有待答提问时直接渲染本卡片，输入框隐藏）。整流经 onComplete
 * 一次性把全部答案经 question_answer 回传 sidecar，execute 解开挂起、模型收到
 * 格式化答案；Stop/新 prompt 由 sidecar 按取消结算，finish chunk 清空后 composer 复原。
 *
 * 关闭（header X 或 Esc）＝ **不回答**，不是停止：按取消结算提问，模型收到
 * 「用户取消了这次提问，自行判断是否继续」后把这一轮走完。它**不能**走 cancelRun——
 * 那会 abort 整轮，而目标模式把 abort 当终局，于是「收起一张卡」把整条自治目标停了。
 * 要停整条运行，composer 上的 Stop 是明确入口，不该由 X 顺带完成。
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
  // 关闭后同样本地隐藏（结算请求自己会把条目从挂起列表里摘掉，这里只是先一步收卡）
  const [dismissed, setDismissed] = useState(false);
  if (answered || dismissed) return null;

  return (
    <AskUserQuestions
      questions={pending.questions.map(toComponentQuestion)}
      skipLabel="跳过"
      dismissLabel="关闭（不回答）"
      onDismiss={() => {
        setDismissed(true);
        removePendingQuestion(threadId, pending.questionId);
        answerQuestion(threadId, pending.questionId, [], { cancelled: true }).catch(
          () => {},
        );
      }}
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
  // 台账键 = pi sessionId（不是 mainThreadId：本会话新建的线程是 __LOCALID_
  // 草稿 id，拿它查永远 miss，卡片不上屏），作答/就地移除也用同一键
  const sessionId = useInteractionSessionId();
  const pending = usePendingQuestions(sessionId);

  if (!sessionId || pending.length === 0) return null;

  return (
    <div
      data-slot="aui-question-card"
      className="flex w-full flex-col items-center gap-2"
    >
      {pending.map((q) => (
        <QuestionFlow key={q.questionId} threadId={sessionId} pending={q} />
      ))}
    </div>
  );
};
