"use client";

/**
 * Question 提问的兼容再导出层（设计文档 §4）：实现已并入 pi-interactions
 * 统一 store，本模块只保住既有导入路径（question-card / composer / pi-transport）。
 * 新代码请直接 import pi-interactions。
 */
export {
  type QuestionOptionView,
  type QuestionView,
  type QuestionAnswerItem,
  type PendingQuestionView,
  applyQuestionChunk,
  clearQuestions,
  removePendingQuestion,
  usePendingQuestions,
  answerQuestion,
} from "@/lib/pi/pi-interactions";
