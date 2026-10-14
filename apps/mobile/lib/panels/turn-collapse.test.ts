/**
 * 折叠面切分单测：投影把一轮合并成一条消息，正文里夹着每一步的叙述——切错的
 * 观感是"折叠后摊出一墙过程叙述"（真实回归）或"最终回答被折走"。
 */
import { describe, expect, test } from "vitest";
import { collectProcessTexts } from "./turn-collapse";

const text = (t: string) => ({ type: "text", text: t });
const tool = { type: "tool-call" };
const reasoning = { type: "reasoning" };

/** 断言哪些正文被判成「过程叙述」（按对象身份） */
const collected = (parts: unknown[]) => {
  const set = collectProcessTexts(parts as never);
  return parts
    .filter((p) => p && (p as { type?: string }).type === "text")
    .map((p) => {
      const t = (p as { text: string }).text;
      return set.has(p as object) ? `过程:${t}` : `回答:${t}`;
    });
};

describe("collectProcessTexts", () => {
  test("纯聊天轮：整条消息都是回答，没有过程叙述", () => {
    expect(collected([text("你好呀")])).toEqual(["回答:你好呀"]);
  });

  test("合并轮：最后一次工具调用之前的正文归过程，之后的归回答", () => {
    expect(
      collected([
        text("开始动工。先查参数。"),
        tool,
        text("换个词搜一下。"),
        tool,
        text("## 结论\n\n改完了，测试全绿。"),
      ]),
    ).toEqual([
      "过程:开始动工。先查参数。",
      "过程:换个词搜一下。",
      "回答:## 结论\n\n改完了，测试全绿。",
    ]);
  });

  test("思考也算「动手」：思考之后的正文才是回答", () => {
    expect(collected([text("先想一下"), reasoning, text("答案是 42")])).toEqual([
      "过程:先想一下",
      "回答:答案是 42",
    ]);
  });

  test("停在工具调用上（中断）：退回最后一次开口说的话", () => {
    expect(
      collected([text("先扫一遍依赖图。"), tool, text("正在跑扫描…"), tool]),
    ).toEqual(["过程:先扫一遍依赖图。", "回答:正在跑扫描…"]);
  });

  test("只有一段正文且停在工具上：那段正文就是回答（不会被折走）", () => {
    expect(collected([text("我先跑一下测试"), tool])).toEqual([
      "回答:我先跑一下测试",
    ]);
  });

  test("整轮没写过正文：没有过程叙述，折叠后只剩摘要行", () => {
    expect(collected([tool, tool])).toEqual([]);
  });

  test("只有空白的正文不算回答（工具间隙的换行）", () => {
    expect(collected([text("真话"), tool, text("\n\n  ")])).toEqual([
      "回答:真话",
      "过程:\n\n  ",
    ]);
  });
});
