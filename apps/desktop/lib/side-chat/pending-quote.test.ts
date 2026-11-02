import { describe, expect, test } from "bun:test";
import {
  clearPendingSideChatQuote,
  peekPendingSideChatQuote,
  resolvePendingQuoteTarget,
  setPendingSideChatQuote,
  subscribePendingSideChatQuote,
} from "./pending-quote";

/**
 * 待应用引用 store：同一条副屏的多次划词在写入时合并（\\n\\n 连接），
 * 来源消息 id 保留首个；订阅按 childId 精确通知；清除触发快照变化。
 */
describe("pending-quote store", () => {
  test("首段写入即快照", () => {
    setPendingSideChatQuote("c1", { text: "第一段", messageId: "m1" });
    expect(peekPendingSideChatQuote("c1")).toEqual({
      text: "第一段",
      messageId: "m1",
    });
    clearPendingSideChatQuote("c1");
  });

  test("未应用前再来一段：文本合并，消息 id 保留首个", () => {
    setPendingSideChatQuote("c2", { text: "第一段", messageId: "m1" });
    setPendingSideChatQuote("c2", { text: "第二段", messageId: "m2" });
    expect(peekPendingSideChatQuote("c2")).toEqual({
      text: "第一段\n\n第二段",
      messageId: "m1",
    });
    clearPendingSideChatQuote("c2");
  });

  test("订阅按 childId 精确通知；清除也通知", () => {
    const hits: string[] = [];
    const off = subscribePendingSideChatQuote("c3", () => hits.push("c3"));
    subscribePendingSideChatQuote("other", () => hits.push("other"));

    setPendingSideChatQuote("c3", { text: "a" });
    expect(hits).toEqual(["c3"]);

    off();
    clearPendingSideChatQuote("c3");
    expect(hits).toEqual(["c3"]); // 退订后不再通知
    expect(peekPendingSideChatQuote("c3")).toBeUndefined();
  });

  test("清除不存在的条目不通知", () => {
    const hits: string[] = [];
    subscribePendingSideChatQuote("c4", () => hits.push("c4"));
    clearPendingSideChatQuote("c4");
    expect(hits).toEqual([]);
  });
});

/**
 * 引用写入幂等：重试重入 / StrictMode 双跑 / 重复投递时 composer 里已经
 * 是同一段引用，不能再合并一次（回归：引用块文本翻倍）。
 */
describe("resolvePendingQuoteTarget（幂等合并）", () => {
  test("空引用：直接写入待应用段落", () => {
    expect(
      resolvePendingQuoteTarget(undefined, { text: "A", messageId: "m1" }),
    ).toEqual({ alreadyApplied: false, text: "A", messageId: "m1" });
  });

  test("已有不同引用：追加合并，消息 id 保留现有", () => {
    expect(
      resolvePendingQuoteTarget(
        { text: "C", messageId: "old" },
        { text: "A", messageId: "m1" },
      ),
    ).toEqual({ alreadyApplied: false, text: "C\n\nA", messageId: "old" });
  });

  test("重试重入：composer 已等于该段 → alreadyApplied，不再合并", () => {
    expect(
      resolvePendingQuoteTarget(
        { text: "A", messageId: "m1" },
        { text: "A", messageId: "m1" },
      ),
    ).toEqual({ alreadyApplied: true, text: "A", messageId: "m1" });
  });

  test("重试重入：composer 以 \n\n + 该段结尾 → alreadyApplied", () => {
    expect(
      resolvePendingQuoteTarget(
        { text: "C\n\nA", messageId: "old" },
        { text: "A", messageId: "m1" },
      ),
    ).toEqual({ alreadyApplied: true, text: "C\n\nA", messageId: "old" });
  });

  test("同文本但不是完整尾段（前一段更长）不误判：仍合并", () => {
    // 结尾是 A 但前面不是换行分隔（如 "BA"），不能当成已应用
    expect(
      resolvePendingQuoteTarget(
        { text: "BA", messageId: "old" },
        { text: "A", messageId: "m1" },
      ),
    ).toEqual({ alreadyApplied: false, text: "BA\n\nA", messageId: "old" });
  });
});
