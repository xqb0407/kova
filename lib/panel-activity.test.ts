import { describe, expect, test } from "bun:test";
import type { ThreadMessage } from "@assistant-ui/react";
import {
  createPanelActivityStore,
  diffLines,
  type PanelActivity,
} from "@/lib/panel-activity";

/* ------------------------------ 消息构造器 ------------------------------ */

type ToolPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
};

type TextPart = { type: "text"; text: string };

type Part = ToolPart | TextPart;

function tool(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown> = {},
  result?: unknown,
  isError?: boolean,
): ToolPart {
  const p: ToolPart = { type: "tool-call", toolCallId, toolName, args };
  if (result !== undefined) p.result = result;
  if (isError !== undefined) p.isError = isError;
  return p;
}

function text(t: string): TextPart {
  return { type: "text", text: t };
}

function msg(id: string, role: "user" | "assistant", parts: Part[]): ThreadMessage {
  return { id, role, content: parts } as unknown as ThreadMessage;
}

/* ------------------------- 参照实现（全量朴素扫描） -------------------------
 * 独立复刻改造前 collect() 的语义，作为增量 store 的等价性 oracle。
 * 与 store 不共享任何代码（diffLines / parseWebSearchResults 除外——
 * 它们是两侧共用的既有导出纯函数，复刻解析规则无验证价值）。
 */

import { parseWebSearchResults } from "@/lib/web-search";

const FAILED_RE = /\[exit code: \d+\]|\[timeout\]/;

function naiveDerive(messages: readonly ThreadMessage[]): PanelActivity {
  const terminal: PanelActivity["terminal"] = [];
  const order: string[] = [];
  const groups = new Map<string, PanelActivity["files"][number]["entries"]>();
  const citations: PanelActivity["citations"] = [];
  const seenCitation = new Set<string>();
  let runningCount = 0;

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const part of m.content as Part[]) {
      if (part.type !== "tool-call") continue;
      const args = (part.args ?? {}) as Record<string, unknown>;
      const raw = part.result;
      const result =
        raw == null
          ? null
          : typeof raw === "string"
            ? raw
            : JSON.stringify(raw, null, 2);
      const err = part.isError === true;
      const running = result === null;
      const failed = err || (result !== null && FAILED_RE.test(result));

      if (part.toolName === "bash") {
        const command = args.command;
        if (typeof command !== "string" || !command) continue;
        terminal.push({
          toolCallId: part.toolCallId,
          command,
          output: result,
          running,
          failed,
        });
        if (running) runningCount += 1;
        continue;
      }

      if (part.toolName === "edit" || part.toolName === "write") {
        const path = args.file_path;
        const newText =
          part.toolName === "edit" ? args.new_string : args.content;
        if (typeof path !== "string" || !path) continue;
        if (typeof newText !== "string") continue;
        const oldText =
          part.toolName === "edit" && typeof args.old_string === "string"
            ? args.old_string
            : null;
        let added = 0;
        let removed = 0;
        if (oldText !== null) {
          for (const line of diffLines(oldText, newText)) {
            if (line.kind === "add") added += 1;
            else if (line.kind === "del") removed += 1;
          }
        } else {
          added = newText.length ? newText.split("\n").length : 0;
        }
        let g = groups.get(path);
        if (!g) {
          g = [];
          order.push(path);
          groups.set(path, g);
        }
        g.push({
          toolCallId: part.toolCallId,
          op: part.toolName as "edit" | "write",
          oldText,
          newText,
          running,
          failed,
          output: result,
          added,
          removed,
        });
        if (running) runningCount += 1;
        continue;
      }

      if (part.toolName === "WebSearch") {
        if (result === null || err) continue;
        const query = typeof args.query === "string" ? args.query : "";
        const items = parseWebSearchResults(result);
        if (!items) continue;
        for (const it of items) {
          const entry = {
            toolCallId: part.toolCallId,
            query,
            title: it.title,
            url: it.url ?? null,
            snippet: it.snippet ?? null,
          };
          const key = it.url ? `u:${it.url}` : `n:${query}\u0000${it.title}`;
          if (seenCitation.has(key)) continue;
          seenCitation.add(key);
          citations.push(entry);
        }
      }
    }
  }

  return {
    terminal,
    citations,
    files: order.map((path) => {
      const entries = groups.get(path)!;
      return {
        path,
        entries,
        added: entries.reduce((s, e) => s + e.added, 0),
        removed: entries.reduce((s, e) => s + e.removed, 0),
        running: entries.some((e) => e.running),
        failed: entries.some((e) => e.failed),
      };
    }),
    runningCount,
  };
}

/* ------------------------------ 用例 ------------------------------ */

/** sidecar renderSearchResults 固定格式（两条引用） */
const SEARCH_1 =
  'Web search results for "bun test":\n\n- bun:test overview\n  https://bun.com/docs/test\n  Fast built-in test runner\n\n- Writing tests | Bun Docs\n  https://bun.com/guides/test\n  expect + describe + it';
/** 与 SEARCH_1 共享第一个 url 的第二次搜索：应只新增第二条 */
const SEARCH_2 =
  'Web search results for "bun runtime":\n\n- bun:test overview\n  https://bun.com/docs/test\n  (duplicate of first search)\n\n- Bun (software) - Wikipedia\n  https://en.wikipedia.org/wiki/Bun_(software)\n  JavaScript runtime';

describe("createPanelActivityStore：与朴素全量扫描等价", () => {
  const messages = [
    msg("u1", "user", [text("改一下")]),
    msg("a1", "assistant", [
      text("先看眼"),
      tool("t1", "read", { file_path: "/x/a.ts" }, "内容"),
      tool("t2", "bash", { command: "ls" }, "a.ts\nb.ts"),
      tool("t3", "edit", {
        file_path: "/x/a.ts",
        old_string: "line1\nline2\nline3",
        new_string: "line1\nLINE2\nline3",
      }),
      text("中段"),
      tool("t4", "write", { file_path: "/x/new.ts", content: "l1\nl2" }, "ok"),
      tool("t5", "bash", { command: "make" }, "boom\n[exit code: 2]"),
      tool("t6", "bash", { command: "sleep 1" }),
      tool("t7", "edit", { file_path: "/x/b.ts", new_string: "no-old" }, "done"),
      tool("t8", "edit", { file_path: "", new_string: "x" }), // 无名路径：忽略
      tool("t9", "write", { file_path: "/x/c.ts" }), // 无 content：忽略
      tool("t10", "bash", {}), // 命令未成形：隐藏
      tool("t11", "edit", { file_path: "/x/d.ts", old_string: "a", new_string: "b" }, "no match", true),
      tool("t14", "WebSearch", { query: "bun test" }, SEARCH_1), // 搜索引用
    ]),
    msg("u2", "user", [text("继续")]),
    msg("a2", "assistant", [
      tool("t12", "bash", { command: "pwd" }, "/x", false),
      tool("t13", "glob", { pattern: "*.ts" }, "/x/a.ts"), // 查询噪音：忽略
      // 与 t14 部分重复的第二次搜索：已出现 url 去重，新 url 收录
      tool("t15", "WebSearch", { query: "bun runtime" }, SEARCH_2),
      tool("t16", "WebSearch", { query: "no result" }, "WebSearch API error: 429"), // 解析不出：忽略
      tool("t17", "WebSearch", { query: "running" }), // 在途：忽略
    ]),
  ];

  test("terminal / files / citations / runningCount 逐条一致", () => {
    const store = createPanelActivityStore();
    expect(store.derive(messages)).toEqual(naiveDerive(messages));
  });

  test("对象引用：entry 跨多次派生复用（增量命中的证据）", () => {
    const store = createPanelActivityStore();
    const first = store.derive(messages);
    // 数组换了但消息引用未变 ⇒ 快照引用同样稳定（比"重建"更强的保证）
    expect(store.derive([...messages])).toBe(first);
    // 追加消息后，已完成工具的 entry 仍是原对象（消息级缓存命中，零重算）
    const extended = store.derive([...messages, msg("u3", "user", [text("hi")])]);
    expect(extended.terminal[0]).toBe(first.terminal[0]);
    expect(extended.files[0].entries[0]).toBe(first.files[0].entries[0]);
  });

  test("空线程 ⇒ 空活动", () => {
    const store = createPanelActivityStore();
    expect(store.derive([])).toEqual({
      terminal: [],
      files: [],
      citations: [],
      runningCount: 0,
    });
  });

  test("引用条目：url 去重保留首查、解析失败/在途/报错不收录", () => {
    const store = createPanelActivityStore();
    const a = store.derive(messages);
    // SEARCH_1 两条 + SEARCH_2 仅新增 wiki 一条（docs/test 重复被去重）；
    // 错误文本与在途搜索不产引用
    expect(a.citations.map((c) => c.url)).toEqual([
      "https://bun.com/docs/test",
      "https://bun.com/guides/test",
      "https://en.wikipedia.org/wiki/Bun_(software)",
    ]);
    expect(a.citations[0].query).toBe("bun test");
    // 在途 t17 不计入 runningCount（查询类不进在途角标）；2 = t3(edit 无 result) + t6(bash)
    expect(a.runningCount).toBe(2);
  });
});

describe("createPanelActivityStore：快照引用稳定性", () => {
  test("同一数组引用 ⇒ 零工作直返同一对象", () => {
    const store = createPanelActivityStore();
    const messages = [
      msg("a1", "assistant", [tool("t1", "bash", { command: "ls" }, "out")]),
    ];
    const a = store.derive(messages);
    expect(store.derive(messages)).toBe(a);
  });

  test("纯文本流式（新消息对象、工具 part 值不变）⇒ 引用不变", () => {
    const store = createPanelActivityStore();
    const t = tool("t1", "edit", {
      file_path: "/x/a.ts",
      old_string: "a\nb",
      new_string: "a\nB",
    }, "ok");
    const m1 = msg("a1", "assistant", [t, text("He")]);
    const messages1 = [m1];
    const before = store.derive(messages1);

    // 流式 token：消息对象被替换，text part 变化，tool part 值不变
    const m2 = msg("a1", "assistant", [t, text("Hello wo")]);
    const after = store.derive([m2]);
    expect(after).toBe(before);
    expect(store.stats().parts).toBe(1);

    // 换 part 对象但指纹（值）一致，同样稳定
    const m3 = msg("a1", "assistant", [
      tool("t1", "edit", {
        file_path: "/x/a.ts",
        old_string: "a\nb",
        new_string: "a\nB",
      }, "ok"),
      text("Hello world"),
    ]);
    expect(store.derive([m3])).toBe(after);
  });

  test("运行中 bash 挂上参数 ⇒ 引用变化但 entry 指纹复用前的旧项不重算", () => {
    const store = createPanelActivityStore();
    const done = tool("t1", "bash", { command: "ls" }, "out");
    const first = store.derive([msg("a1", "assistant", [done])]);
    expect(first.terminal.length).toBe(1);
    // 新消息带第二个工具调用 ⇒ 活动变化
    const second = store.derive([msg("a1", "assistant", [done, tool("t2", "bash", { command: "pwd" })])]);
    expect(second).not.toBe(first);
    expect(second.terminal[0]).toBe(first.terminal[0]); // 完成项复用
    expect(second.terminal[1].running).toBe(true);
    expect(second.runningCount).toBe(1);
  });

  test("WebSearch 引用条目：part 值不变 ⇒ 整活动对象与条目引用都复用", () => {
    const store = createPanelActivityStore();
    const before = store.derive([
      msg("a1", "assistant", [tool("w1", "WebSearch", { query: "q" }, SEARCH_1), text("x")]),
    ]);
    expect(before.citations.length).toBe(2);
    // 新消息对象、搜索 part 换实例但 query/result 值不变 ⇒ 零重算
    const after = store.derive([
      msg("a1", "assistant", [tool("w1", "WebSearch", { query: "q" }, SEARCH_1), text("xy")]),
    ]);
    expect(after).toBe(before);
    expect(after.citations[0]).toBe(before.citations[0]);
  });
});

describe("createPanelActivityStore：语义细节", () => {
  test("bash 命令未成形（无/空 command）不收录，成形后收录", () => {
    const store = createPanelActivityStore();
    const partial = store.derive([
      msg("a1", "assistant", [tool("t1", "bash", { command: "" })]),
    ]);
    expect(partial.terminal).toEqual([]);
    const full = store.derive([
      msg("a1", "assistant", [tool("t1", "bash", { command: "git status" })]),
    ]);
    expect(full.terminal.length).toBe(1);
    expect(full.terminal[0].running).toBe(true);
    expect(full.runningCount).toBe(1);
  });

  test("failed：isError 或输出含 [exit code: N]/[timeout]", () => {
    const store = createPanelActivityStore();
    const a = store.derive([
      msg("a1", "assistant", [
        tool("e1", "edit", { file_path: "/f", old_string: "a", new_string: "b" }, "Error: not found", true),
        tool("b1", "bash", { command: "x" }, "…\n[timeout]"),
        b2(),
      ]),
    ]);
    function b2() {
      return tool("b2", "bash", { command: "y" }, "clean");
    }
    expect(a.terminal.find((t) => t.toolCallId === "b1")!.failed).toBe(true);
    expect(a.terminal.find((t) => t.toolCallId === "b2")!.failed).toBe(false);
    expect(a.files[0].failed).toBe(true);
    expect(a.files[0].entries[0].failed).toBe(true);
  });

  test("非字符串 result 序列化为 JSON 文本", () => {
    const store = createPanelActivityStore();
    const r = store.derive([
      msg("a1", "assistant", [tool("t1", "bash", { command: "l" }, { ok: 1 })]),
    ]);
    expect(r.terminal[0].output).toBe('{\n  "ok": 1\n}');
  });

  test("同路径多次 edit 聚合为一个 group，计数累加", () => {
    const store = createPanelActivityStore();
    const r = store.derive([
      msg("a1", "assistant", [
        tool("t1", "edit", { file_path: "/x", old_string: "a", new_string: "a\nb" }, "ok"),
        tool("t2", "edit", { file_path: "/x", old_string: "c", new_string: "" }, "ok"),
      ]),
    ]);
    expect(r.files.length).toBe(1);
    expect(r.files[0].entries.length).toBe(2);
    expect(r.files[0].added).toBe(1); // edit1: +1 行
    expect(r.files[0].removed).toBe(1); // edit2: -1 行
  });
});

describe("createPanelActivityStore：缓存驱逐", () => {
  test("切线程后旧消息与旧工具缓存即刻清空", () => {
    const store = createPanelActivityStore();
    const threadA = Array.from({ length: 10 }, (_, i) =>
      msg(`a${i}`, "assistant", [tool(`ta${i}`, "bash", { command: `c${i}` }, "o")]),
    );
    store.derive(threadA);
    expect(store.stats()).toEqual({ messages: 10, parts: 10 });

    const threadB = [msg("b1", "assistant", [tool("tb1", "bash", { command: "x" }, "o")])];
    const b = store.derive(threadB);
    expect(b.terminal.length).toBe(1);
    expect(store.stats()).toEqual({ messages: 1, parts: 1 });
  });

  test("消息被删除（分支切换）⇒ 对应缓存收缩", () => {
    const store = createPanelActivityStore();
    const m1 = msg("a1", "assistant", [tool("t1", "bash", { command: "ls" }, "o")]);
    const m2 = msg("a2", "assistant", [tool("t2", "bash", { command: "pwd" }, "o")]);
    store.derive([m1, m2]);
    expect(store.stats().messages).toBe(2);
    store.derive([m1]);
    expect(store.stats()).toEqual({ messages: 1, parts: 1 });
  });

  test("reset 清空全部状态", () => {
    const store = createPanelActivityStore();
    const messages = [msg("a1", "assistant", [tool("t1", "bash", { command: "ls" }, "o")])];
    const a = store.derive(messages);
    store.reset();
    const b = store.derive(messages);
    expect(b).not.toBe(a); // reset 后引用不再稳定，内容与指纹一致
    expect(b).toEqual(a);
    expect(store.stats()).toEqual({ messages: 1, parts: 1 });
  });
});
