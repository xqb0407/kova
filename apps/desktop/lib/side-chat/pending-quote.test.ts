import { describe, expect, test } from "bun:test";
import {
  clearPendingSideChatQuote,
  peekPendingSideChatQuote,
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
