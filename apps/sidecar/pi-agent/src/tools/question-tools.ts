/**
 * Question 工具：向用户提出结构化问题（单选/多选/自由输入/可跳过，多题成流），
 * 拿到澄清或决策后才继续。回路与逐工具审批同构（modes.ts approvalBeforeToolCall）：
 * execute 挂起 Promise → sendEventChunk 推 data-question chunk → composer 上方
 * AskUserQuestions 卡片作答 → protocol question_answer 结算挂起 → 答案格式化回模型。
 *
 * 边界：Question 只负责「我拿不到的信息」，审批只负责「能不能做」。问答案不是
 * 授权——审批链只认审批卡。模型把两者混在一起（"要删这些文件吗？确认/取消"）时
 * 执行档下由 isPermissionSeekingQuestion 拦下，并指引它直接调用真正执行动作的工具。
 *
 * 问题/选项的 id 约定：schema 不带 id，两侧统一按数组下标回落 q-<i> / o-<i>
 * （与 components/ui/ask-user-questions 的 questionKey/optionKey 回落完全一致），
 * formatAnswersForLLM 据此把 selectedIds 映射回选项文案。
 */
import { arr, bool, map, obj, opt, str } from "@earendil-works/pi-schema";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sendEventChunk } from "../protocol/stream";
import { getAutomationPolicy } from "../automation/policy";
import { isImThread } from "../sessions/im-thread";
import { logAt } from "../log";
import type { SessionMode } from "../types";
import {
  beginInteraction,
  sessionForThread,
  settleInteraction,
} from "../sessions/pending-interactions";

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
  return settlePending(questionId, { answers });
}

/**
 * 用户关掉提问卡（不回答）：按取消结算。
 *
 * 与 resolveQuestionAnswer 分开是为了让「关掉」有一个明确的落点，而不是让宿主去
 * 猜「空答案数组算不算回答」。模型收到的是「用户取消了这次提问，不要原样重发，
 * 自行判断是否继续」——目标模式正是靠这句话继续往下跑，而不是被整轮 abort 打断。
 */
export function cancelQuestionAnswer(questionId: string): boolean {
  return settlePending(questionId, { cancelled: true });
}

function settlePending(questionId: string, result: QuestionAnswers): boolean {
  const entry = pendingQuestions.get(questionId);
  if (!entry) return false;
  pendingQuestions.delete(questionId);
  settleInteraction(questionId, result.cancelled ? "cancelled" : "answered");
  entry.resolve(result);
  return true;
}

/** 用户 Stop / 新 prompt 的兜底清理：按取消结算，防止 execute 永久挂起 */
export function cancelPendingQuestions(threadId: string): void {
  for (const [id, entry] of [...pendingQuestions]) {
    if (entry.threadId !== threadId) continue;
    pendingQuestions.delete(id);
    settleInteraction(id, "cancelled");
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

/* ------------------------------ 权限类提问拦截 ------------------------------ */

/** 破坏性动作词干。提问里出现这些词，才可能是在替审批卡要授权。 */
const DESTRUCTIVE_ACTION_WORDS = [
  "删除",
  "删掉",
  "清理",
  "清除",
  "移除",
  "抹掉",
  "清空",
  "覆盖",
  "重写",
  "重置",
  "回滚",
  "delete",
  "remove",
  "clean",
  "cleanup",
  "purge",
  "erase",
  "clear",
  "overwrite",
  "reset",
  "revert",
  "drop",
  "truncate",
  "wipe",
  "rm",
  "rmdir",
  "unlink",
  "shred",
] as const;

/** 确认/授权语义。删东西本身是任务；同时问「要不要/准不准」才是替审批卡要授权。 */
const AUTHORIZATION_WORDS = [
  "确认",
  "授权",
  "允许",
  "同意",
  "批准",
  "准许",
  "许可",
  "是否执行",
  "是否删除",
  "继续执行",
  "可以执行",
  "可以吗",
  "行吗",
  "吗",
  "要不要",
  "confirm",
  "approve",
  "approval",
  "authorize",
  "authorization",
  "permission",
  "allow",
  "proceed",
  "okay to",
  "ok to",
  "shall i",
  "should i",
  "may i",
  "do you want me to",
  "would you like me to",
] as const;

/** 选项里的肯定确认项（与否定项成对出现时，才认定为「要不要执行」）。 */
const AFFIRMATIVE_OPTION_PREFIXES = [
  "确认",
  "确定",
  "同意",
  "允许",
  "批准",
  "继续",
  "执行",
  "删除",
  "好的",
  "yes",
  "ok",
  "okay",
  "confirm",
  "approve",
  "allow",
  "proceed",
  "delete",
  "go ahead",
] as const;

/** 选项里的否定确认项。 */
const NEGATIVE_OPTION_PREFIXES = [
  "取消",
  "拒绝",
  "停止",
  "不要",
  "暂不",
  "no",
  "cancel",
  "reject",
  "stop",
  "abort",
  "don't",
  "do not",
] as const;

/** 中文按子串匹配；拉丁词按词边界匹配（否则 `rm` 会命中 confirm/form 里的字母）。 */
function containsWord(text: string, word: string): boolean {
  if (/[\u4e00-\u9fff]/.test(word)) return text.includes(word);
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "i").test(text);
}

function containsAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => containsWord(text, word));
}

/**
 * 这条提问是不是在替审批卡要授权。
 *
 * 只认两种高置信形状，避免误伤真正的范围澄清（"先删哪几个？" 这种没有确认/取消
 * 配对的题面）：
 * 1. 题面同时出现破坏性动作 + 确认/授权语义；
 * 2. 题面有破坏性动作，且选项里同时有肯定与否定确认项（确认/取消 这类配对）。
 */
export function isPermissionSeekingQuestion(questions: QuestionDef[]): boolean {
  for (const question of questions) {
    const title = question.title.trim().toLowerCase();
    if (!title || !containsAny(title, DESTRUCTIVE_ACTION_WORDS)) continue;
    if (containsAny(title, AUTHORIZATION_WORDS)) return true;
    const options = (question.options ?? []).map((option) => option.title.trim().toLowerCase());
    const hasAffirmative = options.some((option) =>
      AFFIRMATIVE_OPTION_PREFIXES.some((word) => option.startsWith(word)),
    );
    const hasNegative = options.some((option) =>
      NEGATIVE_OPTION_PREFIXES.some((word) => option.startsWith(word)),
    );
    if (hasAffirmative && hasNegative) return true;
  }
  return false;
}

/** 拦截后回给模型的纠正文案：不是错误，而是把下一步指回审批卡。 */
const PERMISSION_QUESTION_REJECTION =
  "This Question was not shown to the user: it asks for permission/confirmation of an action, " +
  "and a Question answer is not an authorization. Do not ask again. Call the tool that performs " +
  "the action directly — for shell commands, deletions and other destructive work use bash; for " +
  "file changes use write/edit. The app shows an approval card when the current approval level " +
  "requires one, and only that card authorizes execution. If you need the user to choose between " +
  "targets, ask a scope question that does not request permission.";

const QuestionToolParams = obj({
  questions: arr(
    obj({
      title: str({ description: "Question text — one clear ask per question" }),
      options: opt(
        arr(
          obj({
            title: str({ description: "Option label" }),
            description: opt(
              str({ description: "Short explanation shown after the label" }),
            ),
          }),
          { description: "Choices (required unless freeText); keyboard shortcuts 1-9 apply, so keep it short" },
        ),
      ),
      multiSelect: opt(bool({ description: "Allow choosing several options (default false = single)" })),
      allowOther: opt(
        bool({ description: "Append a free-text 'other' row next to the options (default true)" }),
      ),
      otherPlaceholder: opt(str({ description: "Placeholder for the other/custom input" })),
      freeText: opt(
        bool({ description: "Open-ended question answered by a single textarea (no options)" }),
      ),
      freeTextPlaceholder: opt(str({ description: "Placeholder for the free-text answer" })),
    }),
    { minItems: 1, description: "Questions to ask, shown one at a time as a flow" },
  ),
});

export function buildQuestionTool(
  threadId: string,
  /** 当前会话模式（闭包，运行期解引用）：plan/ask 是只读勘察档，提问本身就是
   *  计划或回答的一部分；执行档（agent/goal）才拦「替审批卡要授权」的提问。 */
  getMode?: () => SessionMode,
): AgentTool {
  return {
    name: "Question",
    // 等待用户回答不落地任何文件/进程；真正的登记（beginInteraction）崩溃后
    // 由 pending 锚点跳过 repair。崩溃在登记前 = 确实无副作用
    replay: "safe",
    label: "Question",
    description:
      "Ask the user structured questions to get clarification or a decision before continuing: " +
      "single-select, multi-select (multiSelect), or open-ended free text (freeText). " +
      "Execution pauses until the user answers; they may skip or cancel. " +
      "Use only when their input genuinely blocks your next step — not for plain confirmations, " +
      "and never to ask permission to run a tool, confirm a deletion or other destructive action, " +
      "or get an action approved: call that tool directly, the app shows an approval card and " +
      "records the authorization if the user chooses to. A question answer does not authorize " +
      "any tool call.",
    parameters: QuestionToolParams,
    execute: async (toolCallId, raw) => {
      const { questions } = raw as { questions: unknown };
      validateQuestions(questions);
      // 无人值守自动化 / IM 会话：没有在线答题人，立即返回取消说明并指引按假设
      // 继续，绝不挂起（挂起会占满 timeoutMs 才被 abort 结算）。
      // IM 的工具表里本就不注入 Question（见 tools.ts），这里是第二道闸：轮中
      // 热换工具表/旧会话恢复时模型仍可能拿着旧 schema。
      if (getAutomationPolicy(threadId) || isImThread(threadId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: isImThread(threadId)
                ? "这是 IM 对话，没有可以作答的交互卡片。不要再提问：按最合理的假设继续完成任务，并在最终输出中写明所做假设；确实需要用户决定时，把可选方案与建议直接写成正文。"
                : "这是无人值守的定时任务运行，没有用户在线回答追问。" +
                  "不要再提问：按最合理的假设继续完成任务，并在最终输出中写明所做假设。",
            },
          ],
          details: { cancelled: true },
        };
      }
      // 执行档把「批准/确认」类提问拦在卡片之前：答案不产生授权效力，放行只会
      // 让用户先答一次、随后仍要过审批卡。plan/ask 只读，提问不承担审批语义。
      const mode = getMode?.();
      const canExecute = mode === undefined || mode === "agent" || mode === "goal";
      if (canExecute && isPermissionSeekingQuestion(questions)) {
        logAt(
          "event",
          `Question rejected as a permission request: thread=${threadId} questions=${questions.length}`,
        );
        return {
          content: [{ type: "text" as const, text: PERMISSION_QUESTION_REJECTION }],
          details: { rejected: true, reason: "permission-question" },
        };
      }
      // 挂起交互登记落行（§4）：interactionId = questionId（=toolCallId）；
      // questions 进载荷，供 get_history 回放重建答题卡。带会话即进水印（§3）
      beginInteraction(threadId, {
        interactionId: toolCallId,
        kind: "question",
        anchorToolCallId: toolCallId,
        payload: {
          questionId: toolCallId,
          anchorToolCallId: toolCallId,
          questions: questions as QuestionDef[],
        },
        createdAt: new Date().toISOString(),
      });
      sendEventChunk(
        threadId,
        { type: "data-question", data: { questionId: toolCallId, questions } },
        sessionForThread(threadId),
      );
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
