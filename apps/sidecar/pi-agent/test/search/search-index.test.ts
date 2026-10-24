import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  buildSessionIndexRows,
  extractSearchText,
  searchPreview,
  type SearchBlockRow,
} from "../../src/search/search-index";
import { windowTranscriptMessages } from "../../src/sessions/transcript";

const userMsg = (text: string): Message =>
  ({ role: "user", content: text, timestamp: 0 }) as unknown as Message;

const assistantMsg = (parts: Message["content"]): Message =>
  ({ role: "assistant", content: parts, timestamp: 0 }) as unknown as Message;

const toolResultMsg = (toolName: string, output: string): Message =>
  ({
    role: "toolResult",
    toolCallId: "call-1",
    toolName,
    content: [{ type: "text", text: output }],
    isError: false,
    timestamp: 0,
  }) as unknown as Message;

describe("extractSearchText", () => {
  test("user 文本全量进入索引", () => {
    const text = extractSearchText(userMsg("把数据库换成 sqlite"));
    expect(text).toContain("sqlite");
  });

  test("auto-continue / goal 内部注入不进索引（同 toUiMessage 隐藏口径）", () => {
    expect(extractSearchText(userMsg("[[auto-continue]] 续跑注入"))).toBe("");
    expect(extractSearchText(userMsg("[[goal-continue]] 目标续跑注入"))).toBe("");
  });

  test("assistant text 与 toolCall 名称+参数都进索引，thinking 不进", () => {
    const text = extractSearchText(
      assistantMsg([
        { type: "thinking", thinking: "内部推理草稿" } as never,
        { type: "text", text: "我先看看仓库结构" } as never,
        {
          type: "toolCall",
          id: "c1",
          name: "bash",
          arguments: { command: "git status" },
        } as never,
      ]),
    );
    expect(text).toContain("我先看看仓库结构");
    expect(text).toContain("[工具 bash]");
    expect(text).toContain("command:git status");
    expect(text).not.toContain("内部推理草稿");
  });

  test("toolResult 输出截前 1KB 并带工具名", () => {
    const long = "x".repeat(3000);
    const text = extractSearchText(toolResultMsg("read", long));
    expect(text.startsWith("[read 结果]")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(4 * 1024);
  });

  test("纯 thinking 的 assistant 消息无索引文本", () => {
    expect(
      extractSearchText(
        assistantMsg([{ type: "thinking", thinking: "只有推理" } as never]),
      ),
    ).toBe("");
  });
});

describe("searchPreview", () => {
  test("命中两侧取片段并加省略号", () => {
    const text = `${"前".repeat(100)}跑起来${"后".repeat(100)}`;
    const preview = searchPreview(text, "跑起来");
    expect(preview.startsWith("…")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview).toContain("跑起来");
  });

  test("中文不切出乱码：切点吸附字符边界", () => {
    // "部署" 每个字 3 字节：半径切在字符中间时 floor/ceil 必须兜住
    const text = "这".repeat(80) + "部署数据库" + "那".repeat(80);
    const preview = searchPreview(text, "部署");
    expect(preview).toContain("部署");
    // 无 replacement char（U+FFFD）= 没有切出半个字符
    expect(preview.includes("\uFFFD")).toBe(false);
  });

  test("未命中回退开头片段", () => {
    const preview = searchPreview("hello world", "缺席词");
    expect(preview.startsWith("hello")).toBe(true);
  });
});

describe("sessionSearch 的 LIKE 转义（%/_ 正确性）", () => {
  // 直接走 local 模式 SQL 路径：转义只在 likeNeedle 生效（配 ESCAPE '\\'），
  // 原始 needle 走 instr。曾经全局预转义 → 两条路径同时失效（见审查记录）。
  test("含 % 与 _ 的查询能命中标题、首条消息、正文", async () => {
    const { initLocalStorage, resetStorageForTest, sessionInsert, sessionTouch, searchBlocksUpsert, sessionSearch } =
      await import("../../src/storage/hostdb");
    const dir = mkdtempSync(join(tmpdir(), "search-escape-"));
    initLocalStorage(join(dir, "state.db"));
    try {
      sessionInsert("s-pct", "/tmp/p");
      sessionTouch("s-pct", "折扣 100% 完成", "折扣 100% 启动", 1);
      sessionInsert("s-underscore", "/tmp/p");
      sessionTouch("s-underscore", "my_var 定义", "my_var first", 1);
      await searchBlocksUpsert("s-pct", [
        { seq: 1, role: "user", preview: "折扣 100% 完成", searchText: "折扣 100% 完成" },
      ]);
      await searchBlocksUpsert("s-underscore", [
        { seq: 1, role: "user", preview: "my_var 定义", searchText: "my_var 定义" },
      ]);

      const pct = await sessionSearch("%100%".slice(1)); // "100%"
      expect(pct.sessions.map((r) => r.sessionId)).toContain("s-pct");
      expect(pct.messages.map((r) => r.sessionId)).toContain("s-pct");

      const us = await sessionSearch("my_var");
      expect(us.sessions.map((r) => r.sessionId)).toContain("s-underscore");
      expect(us.messages.map((r) => r.sessionId)).toContain("s-underscore");
    } finally {
      resetStorageForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSessionIndexRows", () => {
  test("无效会话返回空行集", () => {
    expect(buildSessionIndexRows("no-such-session-id")).toEqual([]);
  });
});

describe("windowTranscriptMessages aroundSeq", () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1 }));

  test("命中 seq 居中", () => {
    const { window, meta } = windowTranscriptMessages(messages, {
      aroundSeq: 50,
      tail: 10,
    });
    expect(window.length).toBe(10);
    expect(window[0]!.seq).toBe(45);
    expect(window.at(-1)!.seq).toBe(54);
    expect(meta.hasMore).toBe(true);
  });

  test("aroundSeq 落在无消息行号段时锚到前一条消息（设定行不占 seq）", () => {
    const sparse = [{ seq: 10 }, { seq: 20 }, { seq: 30 }];
    const { window } = windowTranscriptMessages(sparse, {
      aroundSeq: 25,
      tail: 2,
    });
    // 25 之前最近的消息是 seq=20，向前取 half=1 → [10, 20]
    expect(window.map((m) => m.seq)).toEqual([10, 20]);
  });

  test("aroundSeq 早于全部消息时从头取窗", () => {
    const { window } = windowTranscriptMessages(messages, {
      aroundSeq: 1,
      tail: 5,
    });
    expect(window.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test("aroundSeq 晚于全部消息时以末条为锚取尾窗", () => {
    const { window } = windowTranscriptMessages(messages, {
      aroundSeq: 999,
      tail: 5,
    });
    // 锚 = 最后一条消息（seq=100），half=2 → 窗口 [98,99,100]
    expect(window.map((m) => m.seq)).toEqual([98, 99, 100]);
  });

  test("不传任何游标 = 全量（旧端不破）", () => {
    const { window, meta } = windowTranscriptMessages(messages, {});
    expect(window.length).toBe(100);
    expect(meta.hasMore).toBe(false);
  });

  test("beforeSeq 语义不受影响（严格早于游标的尾部）", () => {
    const { window } = windowTranscriptMessages(messages, {
      beforeSeq: 50,
      tail: 3,
    });
    expect(window.map((m) => m.seq)).toEqual([47, 48, 49]);
  });
});

describe("SearchBlockRow 形状", () => {
  test("类型契约：seq/role/preview/searchText", () => {
    const row: SearchBlockRow = {
      seq: 1,
      role: "user",
      preview: "p",
      searchText: "p",
    };
    expect(row.seq).toBe(1);
  });
});
