/**
 * Question 工具：向用户提出结构化问题（单选/多选/自由输入/可跳过，多题成流），
 * 拿到澄清或决策后才继续。回路与逐工具审批同构（modes.ts approvalBeforeToolCall）：
 * execute 挂起 Promise → sendEventChunk 推 data-question chunk → composer 上方
 * AskUserQuestions 卡片作答 → protocol question_answer 结算挂起 → 答案格式化回模型。
 *
 * 问题/选项的 id 约定：schema 不带 id，两侧统一按数组下标回落 q-<i> / o-<i>
 * （与 components/ui/ask-user-questions 的 questionKey/optionKey 回落完全一致），
 * formatAnswersForLLM 据此把 selectedIds 映射回选项文案。
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sendEventChunk } from "./stream";

export type QuestionOptionDef = { title: string; description?: string };

export type QuestionDef = {
  title: string;
  options?: QuestionOptionDef[];
  multiSelect?: boolean;
  allowOther?: boolean;
  otherPlaceholder?: string;
  freeText?: boolean;
  freeTextPlaceholder?: string;
  skippable?: boolean;
};

/** 前端 AskUserAnswer 的线格式（question_answer 命令携带） */
export type QuestionAnswerItem = {
  questionId: string;
  selectedIds: string[];
  otherText?: string;
  skipped?: boolean;
};

export type QuestionAnswers = { cancelled?: boolean; answers?: QuestionAnswerItem[] };

type PendingQuestion = {
  threadId: string;
  resolve: (result: QuestionAnswers) => void;
};

/** questionId（=toolCallId）→ 挂起的 resolve（照抄 pendingToolApprovals 的形态） */
const pendingQuestions = new Map<string, PendingQuestion>();

export const hasPendingQuestion = (questionId: string) => pendingQuestions.has(questionId);

/** 结算一条挂起问题（protocol 的 question_answer 调用）；返回是否存在 */
export function resolveQuestionAnswer(
  questionId: string,
  answers: QuestionAnswerItem[],
): boolean {
  const entry = pendingQuestions.get(questionId);
  if (!entry) return false;
  pendingQuestions.delete(questionId);
  entry.resolve({ answers });
  return true;
}

/** 用户 Stop / 新 prompt 的兜底清理：按取消结算，防止 execute 永久挂起 */
export function cancelPendingQuestions(threadId: string): void {
  for (const [id, entry] of [...pendingQuestions]) {
    if (entry.threadId !== threadId) continue;
    pendingQuestions.delete(id);
    entry.resolve({ cancelled: true });
  }
}

/** 把用户答案渲染成给模型阅读的文本（q-/o- 回落 id → 选项文案） */
export function formatAnswersForLLM(
  questions: QuestionDef[],
  result: QuestionAnswers,
): string {
  if (result.cancelled) {
    return "用户取消了这次提问（中止了运行或发起了新消息）。不要原样重发；自行判断是否继续。";
  }
  const byQuestion = new Map(
    (result.answers ?? []).map((a) => [a.questionId, a]),
  );
  const blocks = questions.map((q, i) => {
    const head = `Q${i + 1}: ${q.title}`;
    const a = byQuestion.get(`q-${i}`);
    if (!a || a.skipped) return `${head}\n（跳过未答）`;
    const lines = [head];
    const labels = (a.selectedIds ?? []).map((sid) => {
      const idx = sid.startsWith("o-") ? Number(sid.slice(2)) : NaN;
      const opt = Number.isInteger(idx) ? q.options?.[idx] : undefined;
      return opt ? opt.title + (opt.description ? ` (${opt.description})` : "") : sid;
    });
    if (labels.length > 0) lines.push(`选择: ${labels.join("、")}`);
    if (a.otherText?.trim()) {
      lines.push(
        labels.length > 0 ? `补充: ${a.otherText.trim()}` : `回答: ${a.otherText.trim()}`,
      );
    }
    if (lines.length === 1) lines.push("（空回答）");
    return lines.join("\n");
  });
  return `用户回答：\n\n${blocks.join("\n\n")}`;
}

export function validateQuestions(questions: unknown): asserts questions is QuestionDef[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("questions is required (at least one)");
  }
  for (const q of questions as QuestionDef[]) {
    if (!q.title?.trim()) throw new Error("every question needs a title");
    if (!q.freeText && !(Array.isArray(q.options) && q.options.length > 0)) {
      throw new Error(`question "${q.title}" needs options (or set freeText: true)`);
    }
  }
}

const QuestionToolParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      title: Type.String({ description: "Question text — one clear ask per question" }),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String({ description: "Option label" }),
            description: Type.Optional(
              Type.String({ description: "Short explanation shown after the label" }),
            ),
          }),
          { description: "Choices (required unless freeText); keyboard shortcuts 1-9 apply, so keep it short" },
        ),
      ),
      multiSelect: Type.Optional(Type.Boolean({ description: "Allow choosing several options (default false = single)" })),
      allowOther: Type.Optional(
        Type.Boolean({ description: "Append a free-text 'other' row next to the options (default true)" }),
      ),
      otherPlaceholder: Type.Optional(Type.String({ description: "Placeholder for the other/custom input" })),
      freeText: Type.Optional(
        Type.Boolean({ description: "Open-ended question answered by a single textarea (no options)" }),
      ),
      freeTextPlaceholder: Type.Optional(Type.String({ description: "Placeholder for the free-text answer" })),
    }),
    { minItems: 1, description: "Questions to ask, shown one at a time as a flow" },
  ),
});

export function buildQuestionTool(threadId: string): AgentTool {
  return {
    name: "Question",
    label: "Question",
    description:
      "Ask the user structured questions to get clarification or a decision before continuing: " +
      "single-select, multi-select (multiSelect), or open-ended free text (freeText). " +
      "Execution pauses until the user answers; they may skip or cancel. " +
      "Use only when their input genuinely blocks your next step — not for plain confirmations.",
    parameters: QuestionToolParams,
    execute: async (toolCallId, raw) => {
      const { questions } = raw as { questions: unknown };
      validateQuestions(questions);
      sendEventChunk({
        type: "data-question",
        data: { questionId: toolCallId, questions },
      });
      const result = await new Promise<QuestionAnswers>((resolve) => {
        pendingQuestions.set(toolCallId, { threadId, resolve });
      });
      return {
        content: [{ type: "text" as const, text: formatAnswersForLLM(questions, result) }],
        details: {
          cancelled: result.cancelled === true,
          answers: result.answers ?? null,
        },
      };
    },
  };
}
