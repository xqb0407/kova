import { describe, expect, test } from "bun:test";
import {
  collectPromptHistory,
  createPromptHistoryCursor,
  promptHistoryText,
} from "./composer-history";

const user = (...texts: string[]) => ({
  role: "user",
  content: texts.map((text) => ({ type: "text", text })),
});

describe("promptHistoryText", () => {
  test("多段文本以换行连接，非用户消息不产生条目", () => {
    expect(promptHistoryText(user("第一段", "第二段"))).toBe("第一段\n第二段");
    expect(
      promptHistoryText({ role: "assistant", content: [{ type: "text", text: "回答" }] }),
    ).toBeNull();
  });

  test("剥掉给模型看的注记与附件说明行", () => {
    const text = [
      "看看这张图",
      "[图片已缩放：原始 2400×1600，坐标乘以 0.83]",
      "[用户附件：spec.pdf（PDF，12KB）位于 /tmp/spec.pdf，请用文件工具读取处理]",
    ].join("\n");
    expect(promptHistoryText(user(text))).toBe("看看这张图");
  });

  test("剥掉资料库上下文隐藏块（投影层之外的兜底）", () => {
    const text = "解释这个\n[[library-refs]]\n- /abs/note.md\n[[/library-refs]]";
    expect(promptHistoryText(user(text))).toBe("解释这个");
  });

  test("纯附件消息 / 空文本不产生条目", () => {
    expect(promptHistoryText(user())).toBeNull();
    expect(promptHistoryText(user("   "))).toBeNull();
    expect(
      promptHistoryText({
        role: "user",
        content: [{ type: "image", image: "data:image/png;base64,xxx" }],
      }),
    ).toBeNull();
  });
});

describe("collectPromptHistory", () => {
  test("最新在前，跳过助手消息", () => {
    const history = collectPromptHistory([
      user("第一句"),
      { role: "assistant", content: [{ type: "text", text: "回答" }] },
      user("第二句"),
    ]);
    expect(history).toEqual(["第二句", "第一句"]);
  });

  test("连续重复只留一条，中间夹了别的消息则保留", () => {
    expect(
      collectPromptHistory([user("重复"), user("重复"), user("别的"), user("重复")]),
    ).toEqual(["重复", "别的", "重复"]);
  });

  test("按上限截断（取最近的）", () => {
    const messages = Array.from({ length: 5 }, (_, i) => user(`第${i}条`));
    expect(collectPromptHistory(messages, 2)).toEqual(["第4条", "第3条"]);
  });
});

describe("createPromptHistoryCursor", () => {
  const cursorWith = (entries: string[]) => {
    const reads: number[] = [];
    const cursor = createPromptHistoryCursor(() => {
      reads.push(1);
      return entries;
    });
    return { cursor, reads };
  };

  test("↑ 从最新一条往回翻，到最旧停住；↓ 翻回草稿并退出浏览", () => {
    const { cursor, reads } = cursorWith(["最新", "较早", "最旧"]);
    expect(cursor.browsing).toBe(false);

    expect(cursor.prev("草稿")).toBe("最新");
    expect(cursor.prev("最新")).toBe("较早");
    expect(cursor.prev("较早")).toBe("最旧");
    expect(cursor.prev("最旧")).toBe("最旧");

    expect(cursor.next()).toBe("较早");
    expect(cursor.next()).toBe("最新");
    expect(cursor.next()).toBe("草稿");
    expect(cursor.browsing).toBe(false);
    // 只在首次 ↑ 时读一次快照
    expect(reads).toHaveLength(1);
  });

  test("没有历史时 ↑ 返回 null，不进入浏览态", () => {
    const { cursor } = cursorWith([]);
    expect(cursor.prev("草稿")).toBeNull();
    expect(cursor.browsing).toBe(false);
    expect(cursor.next()).toBeNull();
  });

  test("未浏览时 ↓ 不接管（null 交还默认光标移动）", () => {
    const { cursor } = cursorWith(["历史"]);
    expect(cursor.next()).toBeNull();
  });

  test("reset 丢弃浏览态，下次 ↑ 重新取快照", () => {
    const { cursor, reads } = cursorWith(["最新"]);
    cursor.prev("草稿");
    cursor.reset();
    expect(cursor.browsing).toBe(false);
    cursor.prev("草稿");
    expect(reads).toHaveLength(2);
  });
});
