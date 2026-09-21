import { describe, expect, test } from "bun:test";
import {
  formatAnswersForLLM,
  resolveQuestionAnswer,
  validateQuestions,
  type QuestionDef,
} from "../../src/tools/question-tools";

const qs: QuestionDef[] = [
  {
    title: "选哪种存储？",
    options: [
      { title: "SQLite", description: "零运维" },
      { title: "Postgres" },
    ],
  },
  { title: "目标上线时间？", freeText: true },
];

describe("formatAnswersForLLM", () => {
  test("q-/o- 回落 id 映射回选项文案（含 description）", () => {
    const text = formatAnswersForLLM(qs, {
      answers: [
        { questionId: "q-0", selectedIds: ["o-0"], otherText: "要能水平扩展" },
        { questionId: "q-1", selectedIds: [], otherText: "下周五" },
      ],
    });
    expect(text).toContain("Q1: 选哪种存储？");
    expect(text).toContain("SQLite (零运维)");
    expect(text).toContain("补充: 要能水平扩展");
    // freeText 无选择时 otherText 走「回答:」
    expect(text).toContain("回答: 下周五");
  });

  test("多选合并、未知 id 原样、空回答与跳过标注", () => {
    const text = formatAnswersForLLM(
      [qs[0], { title: "补充要求？", options: [{ title: "x" }] }],
      {
        answers: [
          { questionId: "q-0", selectedIds: ["o-0", "o-1", "weird-id"] },
          { questionId: "q-1", selectedIds: [], skipped: true },
        ],
      },
    );
    expect(text).toContain("SQLite (零运维)、Postgres、weird-id");
    expect(text).toContain("（跳过未答）");
    const missing = formatAnswersForLLM([qs[0]], { answers: [] });
    expect(missing).toContain("（跳过未答）");
    const empty = formatAnswersForLLM([qs[0]], {
      answers: [{ questionId: "q-0", selectedIds: [], otherText: "  " }],
    });
    expect(empty).toContain("（空回答）");
  });

  test("取消结算给出不可重试原问题的指引", () => {
    const text = formatAnswersForLLM(qs, { cancelled: true });
    expect(text).toContain("取消");
    expect(text).toContain("不要原样重发");
  });
});

describe("validateQuestions", () => {
  test("非 freeText 缺 options 报错；freeText / 带 options 通过", () => {
    expect(() => validateQuestions([])).toThrow("at least one");
    expect(() =>
      validateQuestions([{ title: "选一个", multiSelect: true }]),
    ).toThrow("needs options");
    expect(() => validateQuestions([{ title: "随便说", freeText: true }])).not.toThrow();
    expect(() =>
      validateQuestions([{ title: "t", options: [{ title: "a" }] }]),
    ).not.toThrow();
  });
});

describe("resolveQuestionAnswer", () => {
  test("无挂起项返回 false（协议层据此报错）", () => {
    expect(resolveQuestionAnswer("no-such-id", [])).toBe(false);
  });
});
