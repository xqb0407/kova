import { describe, expect, test } from "bun:test";
import type { ThreadMessage } from "@assistant-ui/react";
import {
  createPanelActivityStore,
  diffLines,
  webFetchTitle,
  type PanelActivity,
} from "@/lib/panels/panel-activity";

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

import { parseWebSearchResults } from "@/lib/pi/web-search";

const FAILED_RE = /\[exit code: \d+\]|\[timeout\]/;

function naiveDerive(
  messages: readonly ThreadMessage[],
  isRunning = true,
): PanelActivity {
  const terminal: PanelActivity["terminal"] = [];
  const order: string[] = [];
  const groups = new Map<string, PanelActivity["files"][number]["entries"]>();
  const citations: PanelActivity["citations"] = [];
  const citationsAll: PanelActivity["citations"] = [];
  const seenCitation = new Set<string>();
  let runningCount = 0;

  const last = messages.length ? messages[messages.length - 1] : null;

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    // live = 末条消息且线程运行中：无结果工具调用只在这里才算在途
    const live = isRunning && m === last;
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
      const running = result === null && live;
      const interrupted = result === null && !live;
      const failed = err || interrupted || (result !== null && FAILED_RE.test(result));

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
          citationsAll.push(entry);
          const key = it.url ? `u:${it.url}` : `n:${query}\u0000${it.title}`;
          if (seenCitation.has(key)) continue;
          seenCitation.add(key);
          citations.push(entry);
        }
      }

      if (part.toolName === "WebFetch") {
        if (result === null || err) continue;
        const url = args.url;
        if (typeof url !== "string" || !url) continue;
        const entry = {
          toolCallId: part.toolCallId,
          query: url,
          title: webFetchTitle(result, url),
          url,
          snippet: null,
        };
        citationsAll.push(entry);
        const key = `u:${url}`;
        if (seenCitation.has(key)) continue;
        seenCitation.add(key);
        citations.push(entry);
      }
    }
  }

  return {
    terminal,
    citations,
    citationsAll,
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

  test("跨 scope 交替读取：同一消息快照的派生引用恒定（#185 回归）", () => {
    const store = createPanelActivityStore();
    // 模拟主会话 header 与辅助会话（嵌套 runtime）交替调用 getSnapshot：
    // 两套消息集合互不相干，但共用一份 store 时 lastActivity 会被来回覆盖。
    // 按 messages 身份钉住结果后，各自重复读取必须是同一引用，否则
    // useSyncExternalStore 会 forceStoreRerender 自环（Maximum update depth）。
    const main = [
      msg("u1", "user", [text("主会话")]),
      // 在途工具：isRunning=false 时分类翻成「中断」，两种运行态内容确实不同，
      // 下面 not.toBe 的断言才有语义（否则内容相同、返回旧引用也是合法的）
      msg("a1", "assistant", [tool("t1", "bash", { command: "pwd" })]),
    ];
    const side = [
      msg("u9", "user", [text("辅助会话")]),
      msg("a9", "assistant", [tool("t9", "bash", { command: "ls" }, "file")]),
    ];
    const mainFirst = store.derive(main);
    const sideFirst = store.derive(side);
    expect(sideFirst).not.toBe(mainFirst);
    expect(store.derive(main)).toBe(mainFirst);
    expect(store.derive(side)).toBe(sideFirst);
    // 运行态翻转再翻回来：同一快照 + 同一运行态仍取原引用
    expect(store.derive(main, false)).not.toBe(mainFirst);
    expect(store.derive(main, true)).toBe(mainFirst);
  });

  test("空线程 ⇒ 空活动", () => {
    const store = createPanelActivityStore();
    expect(store.derive([])).toEqual({
      terminal: [],
      files: [],
      citations: [],
      citationsAll: [],
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
    // 在途 t17 不计入 runningCount（查询类不进在途角标）；
    // t3(edit 无 result)/t6(bash 无 result) 挂在非末条消息 a1 上 ⇒ 中断态，不计
    expect(a.runningCount).toBe(0);
  });
});

describe("createPanelActivityStore：WebFetch 引用", () => {
  /** 首行 markdown 标题 → 剥 # 取正文 */
  const FETCHED_HEADING = "# Kova 桌面端\n\n正文第一段\n\n更多内容";
  /** 首个非空行是地址（跳过）→ 取下一个文本行当标题 */
  const FETCHED_URL_FIRST = "https://example.org/plain\nActual Title Here\nbody";
  const messages = [
    msg("u1", "user", [text("查一下")]),
    msg("a1", "assistant", [
      tool("t1", "WebFetch", { url: "https://example.com/kova" }, FETCHED_HEADING),
      // 与 t1 同 url 的搜索命中：首条（WebFetch）保留，搜索条目按 url 去重
      tool("t2", "WebSearch", { query: "kova" }, 'Web search results for "kova":\n\n- Kova\n  https://example.com/kova\n  snippet'),
      tool("t3", "WebFetch", { url: "https://example.org/plain" }, FETCHED_URL_FIRST),
      tool("t4", "WebFetch", { url: "https://example.net/fail" }, "boom", true),
      tool("t5", "WebFetch", { url: "https://example.net/empty" }, ""),
      tool("t6", "WebFetch", { url: "https://example.net/running" }), // 在途：忽略
      tool("t7", "WebFetch", {}), // args 未成形：忽略
      tool("t8", "WebFetch", { url: "https://example.com/long" }, "A".repeat(100)),
    ]),
  ];

  test("与朴素全量扫描等价（含 WebFetch）", () => {
    const store = createPanelActivityStore();
    expect(store.derive(messages)).toEqual(naiveDerive(messages));
  });

  test("标题提取：markdown 标题 / 跳过链接行 / 空正文回退 hostname / 超长截断", () => {
    const store = createPanelActivityStore();
    const a = store.derive(messages);
    expect(a.citations.map((c) => [c.url, c.title, c.snippet])).toEqual([
      ["https://example.com/kova", "Kova 桌面端", null],
      ["https://example.org/plain", "Actual Title Here", null],
      // 空结果取不出可读行：回退 hostname；query 记目标 url
      ["https://example.net/empty", "example.net", null],
      ["https://example.com/long", `${"A".repeat(80)}…`, null],
    ]);
    expect(a.citations.every((c) => c.query === c.url)).toBe(true);
  });

  test("失败 / 在途 / args 未成形不收录；同 url 与 WebSearch 去重保留首条", () => {
    const store = createPanelActivityStore();
    const a = store.derive(messages);
    // t2 的搜索命中（example.com/kova）被 t1 首现去重；t4/t6/t7 均无条目
    expect(a.citations.length).toBe(4);
    expect(a.citations[0].toolCallId).toBe("t1");
    expect(a.runningCount).toBe(0);
  });
  test("标题提取：markdown 链接行取链接文字，空链接文字落到下一行", () => {
    const store = createPanelActivityStore();
    const a = store.derive([
      msg("a1", "assistant", [
        tool(
          "t1",
          "WebFetch",
          { url: "https://example.com/link" },
          "[Kova 主页](https://example.com/link)\n正文",
        ),
        tool(
          "t2",
          "WebFetch",
          { url: "https://example.com/empty-link" },
          "[](https://example.com/empty-link)\n正文第二行",
        ),
      ]),
    ]);
    expect(a.citations.map((c) => [c.url, c.title])).toEqual([
      ["https://example.com/link", "Kova 主页"],
      ["https://example.com/empty-link", "正文第二行"],
    ]);
  });
});

describe("createPanelActivityStore：跨轮 url 去重的归因", () => {
  test("citations 全局去重记首现；citationsAll 保留每轮条目（来源条归因用）", () => {
    const store = createPanelActivityStore();
    const messages = [
      msg("a1", "assistant", [
        tool("t1", "WebSearch", { query: "bun" }, SEARCH_1),
      ]),
      msg("a2", "assistant", [
        // 轮 2 重抓轮 1 已列过的 url：面板列表不再收录，若全量列表也丢，
        // 轮 2 来源条按 toolCallId 过滤即为空——答案引了页却没有来源
        tool("t2", "WebFetch", { url: "https://bun.com/docs/test" }, "# Bun test\n正文"),
      ]),
    ];
    const a = store.derive(messages);
    // SEARCH_1 有两条命中：面板列表两双都记在 t1 名下，t2 重抓的 url 被去重
    expect(a.citations.map((c) => c.toolCallId)).toEqual(["t1", "t1"]);
    // 全量列表多出 t2 条目：轮 2 来源条按 toolCallId 过滤不再空手而归
    expect(a.citationsAll.map((c) => c.toolCallId)).toEqual(["t1", "t1", "t2"]);
  });
});

describe("createPanelActivityStore：在途/中断分类", () => {
  /** 无结果 bash：挂在末条消息且线程运行中 ⇒ 在途；否则一律中断 */
  const runningMsg = () => msg("a1", "assistant", [tool("t1", "bash", { command: "ls" })]);

  test("末条消息 + isRunning=false ⇒ 中断（刷新后死态）", () => {
    const store = createPanelActivityStore();
    const a = store.derive([runningMsg()], false);
    expect(a.terminal[0].running).toBe(false);
    expect(a.terminal[0].failed).toBe(true);
    expect(a.runningCount).toBe(0);
  });

  test("非末条消息 + isRunning=true ⇒ 中断（历史轮残留）", () => {
    const store = createPanelActivityStore();
    const a = store.derive([
      runningMsg(),
      msg("u2", "user", [text("继续")]),
    ]);
    expect(a.terminal[0].running).toBe(false);
    expect(a.terminal[0].failed).toBe(true);
    expect(a.runningCount).toBe(0);
  });

  test("末条消息 + isRunning=true ⇒ 在途转圈", () => {
    const store = createPanelActivityStore();
    const a = store.derive([runningMsg()]);
    expect(a.terminal[0].running).toBe(true);
    expect(a.terminal[0].failed).toBe(false);
    expect(a.runningCount).toBe(1);
  });

  test("分类翻转 ⇒ entry 重建（缓存指纹含在途分类）", () => {
    const store = createPanelActivityStore();
    const running = store.derive([runningMsg()], true);
    expect(running.terminal[0].running).toBe(true);
    const idle = store.derive([runningMsg()], false);
    expect(idle.terminal[0].running).toBe(false);
    expect(idle.terminal[0].failed).toBe(true);
    expect(idle).not.toBe(running);
  });

  test("中断的 edit/write：组级 failed 同步、diff 统计保留", () => {
    const store = createPanelActivityStore();
    const a = store.derive(
      [msg("a1", "assistant", [tool("t1", "edit", { file_path: "/f", old_string: "a", new_string: "a\nb" })])],
      false,
    );
    expect(a.files[0].failed).toBe(true);
    expect(a.files[0].running).toBe(false);
    expect(a.files[0].entries[0].added).toBe(1);
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
