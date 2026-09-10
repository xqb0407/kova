import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, sessionPath } from "./storage";
import { sessionInsert, sessionRename, getLocalDb } from "./hostdb";
import {
  readTranscript,
  toUiMessage,
  persist,
  historyToUiMessages,
  appendCompactionRow,
  readCompaction,
  readAllCompactions,
  titleSummarizeHook,
  maybeSummarizeSessionTitle,
} from "./transcript";
import { makeSummaryMessage, projectRestoreContext } from "./context";
import type { Message } from "@earendil-works/pi-ai";
import type { Running } from "./types";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-transcript-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
});

const userMsg = (text: string): Message =>
  ({ role: "user", content: text }) as unknown as Message;
const assistantMsg = (
  parts: { type: string; text?: string; thinking?: string }[],
): Message =>
  ({ role: "assistant", content: parts }) as unknown as Message;
const toolCallMsg = (id: string, name: string, args: unknown): Message =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
  }) as unknown as Message;
const toolResultMsg = (
  toolCallId: string,
  toolName: string,
  text: string,
): Message =>
  ({
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
  }) as unknown as Message;

describe("toUiMessage", () => {
  test("user string content", () => {
    const ui = toUiMessage(userMsg("hi"), 0)!;
    expect(ui.role).toBe("user");
    expect(ui.parts).toEqual([{ type: "text", text: "hi" }]);
    expect(ui.id).toBe("msg-0");
  });

  test("user content array keeps only text parts", () => {
    const m = {
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "xx" },
        { type: "text", text: "b" },
      ],
    } as unknown as Message;
    const ui = toUiMessage(m, 1)!;
    expect(ui.parts).toEqual([{ type: "text", text: "a\nb" }]);
  });

  test("assistant text and thinking become text/reasoning parts", () => {
    const m = assistantMsg([
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "answer" },
    ]);
    const ui = toUiMessage(m, 2)!;
    expect(ui.role).toBe("assistant");
    expect(ui.parts).toEqual([
      { type: "reasoning", text: "let me think", state: "done" },
      { type: "text", text: "answer" },
    ]);
  });

  test("whitespace-only assistant content is dropped", () => {
    expect(toUiMessage(assistantMsg([{ type: "text", text: "  " }]), 3)).toBeNull();
  });

  test("toolResult messages are not rendered as their own UI message", () => {
    const m = toolResultMsg("call-1", "bash", "ok");
    expect(toUiMessage(m, 4)).toBeNull();
  });
});

describe("historyToUiMessages", () => {
  test("重建含工具部件的历史（toolCall + toolResult 配对回填）", () => {
    const rows = [
      { agent: userMsg("list files") },
      { agent: assistantMsg([{ type: "text", text: "let me check" }]) },
      { agent: toolCallMsg("c1", "bash", { cmd: "ls" }) },
      { agent: toolResultMsg("c1", "bash", "file-a\nfile-b") },
      { agent: assistantMsg([{ type: "text", text: "done" }]) },
    ];
    const messages = historyToUiMessages(rows);
    // user + assistant(text) + assistant(toolCall) + assistant(text) = 4 条
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant",
    ]);
    const toolMsg = messages[2];
    expect(toolMsg.parts).toEqual([
      {
        type: "tool-bash",
        toolCallId: "c1",
        state: "output-available",
        input: { cmd: "ls" },
        output: "file-a\nfile-b",
      },
    ]);
  });

  test("toolResult 匹配不到 toolCallId 时被忽略", () => {
    const rows = [
      { agent: toolCallMsg("c1", "bash", {}) },
      { agent: toolResultMsg("c-other", "bash", "orphan") },
    ];
    const messages = historyToUiMessages(rows);
    expect(messages.length).toBe(1);
    expect((messages[0].parts[0] as { state: string }).state).toBe(
      "input-available",
    );
  });

  test("简单 user 消息重建为 text part", () => {
    const messages = historyToUiMessages([{ agent: userMsg("hello") }]);
    expect(messages).toEqual([
      { id: "msg-0", role: "user", parts: [{ type: "text", text: "hello" }] },
    ]);
  });

  test("阈值/溢出压缩：分隔线落在边界后首条 assistant 消息顶部（与 live 一致）", () => {
    const rows = [
      { seq: 1, agent: userMsg("q1") },
      { seq: 2, agent: assistantMsg([{ type: "text", text: "a1" }]) },
      { seq: 3, agent: userMsg("q2") },
      { seq: 4, agent: assistantMsg([{ type: "text", text: "a2" }]) },
    ];
    const messages = historyToUiMessages(rows, [
      {
        seq: 5,
        summary: "S",
        tokensBefore: 1000,
        throughSeq: 2,
        createdAt: "t",
        details: { generation: 1, strategy: "summary" },
      },
    ]);
    // 边界 seq=2 之后首条 assistant 是 a2（seq=4，msg-3）
    expect(messages[3].id).toBe("msg-3");
    expect(messages[3].parts[0]).toEqual({
      type: "data-compaction",
      id: "cmp-5",
      data: { phase: "complete", generation: 1, tokensBefore: 1000, summarized: true },
    });
    // 其余消息不带分隔线
    expect(messages[2].parts[0].type).toBe("text");
    expect(messages.filter((m) => m.parts[0].type === "data-compaction").length).toBe(1);
  });

  test("手动压缩：其后无 assistant 宿主，独立成分隔线消息落在边界之后", () => {
    const rows = [
      { seq: 1, agent: userMsg("q1") },
      { seq: 2, agent: assistantMsg([{ type: "text", text: "a1" }]) },
    ];
    const messages = historyToUiMessages(rows, [
      {
        seq: 3,
        summary: "S",
        tokensBefore: 800,
        throughSeq: 2,
        createdAt: "t",
        details: { generation: 1, strategy: "summary" },
      },
    ]);
    expect(messages.length).toBe(3);
    expect(messages[2]).toEqual({
      id: "cmp-3",
      role: "assistant",
      parts: [
        {
          type: "data-compaction",
          id: "cmp-3",
          data: { phase: "complete", generation: 1, tokensBefore: 800, summarized: true },
        },
      ],
    });
  });

  test("多次压缩按 seq 升序落位，fresh_window 记 summarized:false", () => {
    const rows = [
      { seq: 1, agent: userMsg("q1") },
      { seq: 2, agent: assistantMsg([{ type: "text", text: "a1" }]) },
      { seq: 3, agent: userMsg("q2") },
      { seq: 4, agent: assistantMsg([{ type: "text", text: "a2" }]) },
    ];
    // 第二条 compaction 边界覆盖全部消息（seq throughSeq=4）→ 独立线；第一条落 a2 顶部
    const messages = historyToUiMessages(rows, [
      { seq: 10, summary: "S2", tokensBefore: 2000, throughSeq: 4, createdAt: "t", details: { generation: 2, strategy: "fresh_window" } },
      { seq: 5, summary: "S1", tokensBefore: 1000, throughSeq: 2, createdAt: "t", details: { generation: 1, strategy: "summary" } },
    ]);
    // a2 顶部带第一代分隔线
    expect(messages[3].parts[0].type).toBe("data-compaction");
    // 末尾独立第二代分隔线（fresh_window → summarized:false）
    expect(messages[4].id).toBe("cmp-10");
    expect((messages[4].parts[0] as { data: { summarized: boolean } }).data.summarized).toBe(false);
  });
});

describe("readTranscript", () => {
  test("reads message rows and skips torn tail lines", () => {
    const id = "torn-test";
    const rows = [
      JSON.stringify({ type: "header", schema: 1, id, cwd: tmp, created_at: "now" }),
      JSON.stringify({ type: "message", seq: 0, ui: { id: "msg-0", role: "user", parts: [] }, agent: userMsg("q") }),
      JSON.stringify({ type: "message", seq: 1, ui: { id: "msg-1", role: "assistant", parts: [] }, agent: assistantMsg([{ type: "text", text: "a" }]) }),
      '{"type":"mess', // 撕裂尾行
    ].join("\n");
    writeFileSync(sessionPath(id), rows + "\n", "utf8");

    const out = readTranscript(id);
    expect(out.length).toBe(2);
    expect(out[0].agent).toEqual(userMsg("q"));
    expect(out[1].agent).toEqual(assistantMsg([{ type: "text", text: "a" }]));
  });

  test("returns empty for missing sessions", () => {
    expect(readTranscript("no-such-session")).toEqual([]);
  });

  test("重复 seq 行按 seq 去重（旧持久化 bug 兼容）且重建 id 唯一", () => {
    const id = "dup-seq-test";
    const line = (seq: number, text: string) =>
      JSON.stringify({
        type: "message",
        seq,
        ui: null,
        agent: assistantMsg([{ type: "text", text }]),
      });
    // 模拟旧 bug：同一批消息被重复 append（0..2 整段重复 + 尾部重复 0）
    writeFileSync(
      sessionPath(id),
      [
        JSON.stringify({ type: "header", schema: 1, id, cwd: tmp, created_at: "now" }),
        line(0, "a"),
        line(1, "b"),
        line(2, "c"),
        line(0, "a"),
        line(1, "b"),
        line(2, "c"),
        line(0, "a"),
      ].join("\n") + "\n",
      "utf8",
    );

    const out = readTranscript(id);
    expect(out.length).toBe(3); // 去重后只剩 3 行
    expect(out.map((r) => (r.agent as { content: { text: string }[] }).content[0].text)).toEqual([
      "a",
      "b",
      "c",
    ]);

    // 重建出的前端历史 id 全部唯一（修复 relink 报错的根因）
    const ids = historyToUiMessages(out).map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("persist", () => {
  test("appends new messages and updates the index row", async () => {
    const id = "persist-test";
    await sessionInsert(id, tmp);
    writeFileSync(sessionPath(id), "", "utf8");

    const run = {
      agent: {
        state: {
          messages: [userMsg("hello world"), assistantMsg([{ type: "text", text: "hi there" }])],
        },
      },
      sessionId: id,
      cwd: tmp,
      persistedSeq: 0,
      jsonlSeq: 0,
    } as unknown as Running;

    await persist(run);
    expect(run.persistedSeq).toBe(2);

    const file = readFileSync(sessionPath(id), "utf8");
    const lines = file.trim().split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const row = JSON.parse(line);
      expect(row.type).toBe("message");
      expect(row.ui).toBeTruthy();
      expect(row.agent).toBeTruthy();
    }

    const row = getLocalDb()!
      .query<{ title: string; first_message: string; updated_at: string }, [string]>(
        "SELECT title, first_message, updated_at FROM sessions WHERE id = ?",
      )
      .get(id)!;
    expect(row.first_message).toBe("hello world");
    expect(row.title).toBe("hello world");

    // 第二次 persist 无新增消息时不追加
    const before = readFileSync(sessionPath(id), "utf8");
    await persist(run);
    expect(readFileSync(sessionPath(id), "utf8")).toBe(before);
  });

  test("toolCall 与 toolResult 消息也落盘（ui 为 null），历史可重建工具部件", async () => {
    const id = "persist-tools-test";
    await sessionInsert(id, tmp);
    writeFileSync(sessionPath(id), "", "utf8");

    const messages = [
      userMsg("run it"),
      toolCallMsg("t1", "bash", { cmd: "echo hi" }),
      toolResultMsg("t1", "bash", "hi"),
    ];
    const run = {
      agent: { state: { messages } },
      sessionId: id,
      cwd: tmp,
      persistedSeq: 0,
      jsonlSeq: 0,
    } as unknown as Running;
    await persist(run);
    expect(run.persistedSeq).toBe(3);

    const rows = readTranscript(id);
    expect(rows.length).toBe(3);
    expect(rows[1].ui).toBeNull(); // 纯工具调用没有 ui 快照
    expect(rows[2].ui).toBeNull();

    const rebuilt = historyToUiMessages(rows);
    expect(rebuilt.length).toBe(2);
    expect(rebuilt[1].parts).toEqual([
      {
        type: "tool-bash",
        toolCallId: "t1",
        state: "output-available",
        input: { cmd: "echo hi" },
        output: "hi",
      },
    ]);
  });
});

describe("compaction rows", () => {
  test("appendCompactionRow / readCompaction 读最后一条，撕裂尾行容忍，消息读端不受影响", async () => {
    const id = "cp-row-test";
    await sessionInsert(id, tmp);
    writeFileSync(sessionPath(id), "", "utf8");
    appendCompactionRow(id, {
      seq: 2,
      summary: "S1",
      tokensBefore: 100,
      throughSeq: 1,
      createdAt: "t",
      details: { generation: 1, strategy: "summary" },
    });
    appendCompactionRow(id, {
      seq: 7,
      summary: "S2",
      tokensBefore: 200,
      throughSeq: 6,
      createdAt: "t",
      details: { generation: 2, strategy: "summary" },
    });
    const file = readFileSync(sessionPath(id), "utf8");
    writeFileSync(sessionPath(id), file + '{"type":"compact', "utf8"); // 撕裂尾行

    const cp = readCompaction(id)!;
    expect(cp.summary).toBe("S2");
    expect(cp.throughSeq).toBe(6);
    expect(cp.details).toEqual({ generation: 2, strategy: "summary" });
    // 全量读：两条检查点按文件序返回（撕裂尾行同样被跳过）
    expect(readAllCompactions(id).map((r) => r.summary)).toEqual(["S1", "S2"]);
    // 检查点行不是消息行：全量历史读端与 UI 重建完全不受影响
    expect(readTranscript(id).length).toBe(0);
    expect(historyToUiMessages(readTranscript(id)).length).toBe(0);
  });

  test("压缩后 persist：seq 共用单调编号不撞号，摘要头不回写，恢复投射正确", async () => {
    const id = "cp-persist-test";
    await sessionInsert(id, tmp);
    writeFileSync(sessionPath(id), "", "utf8");

    const run = {
      agent: {
        state: {
          messages: [
            userMsg("q1"),
            assistantMsg([{ type: "text", text: "a1" }]),
          ],
        },
      },
      sessionId: id,
      cwd: tmp,
      persistedSeq: 0,
      jsonlSeq: 0,
    } as unknown as Running;
    await persist(run); // 消息行 0,1

    // 模拟 runCompaction 完成后的 run 状态：state 只剩合成摘要头 + 新一轮
    const checkpoint = {
      seq: run.jsonlSeq,
      summary: "COMPACTED",
      tokensBefore: 999,
      throughSeq: run.jsonlSeq - 1,
      createdAt: "t",
      details: { generation: 1, strategy: "summary" },
    };
    appendCompactionRow(id, checkpoint);
    run.jsonlSeq += 1;
    run.agent.state.messages = [
      makeSummaryMessage("COMPACTED") as unknown as Message,
      userMsg("q2"),
    ];
    run.persistedSeq = 1;

    await persist(run); // 只写 q2，seq 跳过检查点行占用的号

    const rows = readTranscript(id);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 3]);
    const cp = readCompaction(id)!;
    expect(cp.seq).toBe(2);
    const context = projectRestoreContext(rows, cp);
    expect(context.length).toBe(2); // 摘要头 + q2
    expect(
      (context[1] as { content: string }).content,
    ).toBe("q2");
  });
});

describe("maybeSummarizeSessionTitle", () => {
  const fakeModel = { id: "m", provider: "p" } as Running["agent"]["state"]["model"];

  const makeRun = (id: string, prompt: string, reply?: string) =>
    ({
      agent: {
        state: {
          model: fakeModel,
          messages: reply
            ? [userMsg(prompt), assistantMsg([{ type: "text", text: reply }])]
            : [userMsg(prompt)],
        },
      },
      sessionId: id,
      cwd: tmp,
      persistedSeq: 0,
      jsonlSeq: 0,
    }) as unknown as Running;

  test("兜底标题被 AI 总结替换", async () => {
    const id = "title-auto";
    await sessionInsert(id, tmp);
    titleSummarizeHook.fn = async () => "重构认证模块";
    try {
      await maybeSummarizeSessionTitle(makeRun(id, "帮我重构用户认证模块", "已完成"));
      const row = getLocalDb()!
        .query<{ title: string }, [string]>("SELECT title FROM sessions WHERE id = ?")
        .get(id)!;
      expect(row.title).toBe("重构认证模块");
    } finally {
      titleSummarizeHook.fn = undefined;
    }
  });

  test("手动改名后不覆盖（标题 ≠ 兜底串）", async () => {
    const id = "title-manual";
    await sessionInsert(id, tmp);
    await sessionRename(id, "我的自定义标题");
    let called = false;
    titleSummarizeHook.fn = async () => {
      called = true;
      return "AI 标题";
    };
    try {
      await maybeSummarizeSessionTitle(makeRun(id, "随便聊点什么", "好的"));
      expect(called).toBe(false);
      const row = getLocalDb()!
        .query<{ title: string }, [string]>("SELECT title FROM sessions WHERE id = ?")
        .get(id)!;
      expect(row.title).toBe("我的自定义标题");
    } finally {
      titleSummarizeHook.fn = undefined;
    }
  });

  test("每会话只总结一次（防抖）", async () => {
    const id = "title-debounce";
    await sessionInsert(id, tmp);
    let calls = 0;
    titleSummarizeHook.fn = async () => {
      calls += 1;
      return "首次标题";
    };
    try {
      const run = makeRun(id, "防抖测试", "ok");
      await maybeSummarizeSessionTitle(run);
      await maybeSummarizeSessionTitle(run);
      expect(calls).toBe(1);
    } finally {
      titleSummarizeHook.fn = undefined;
    }
  });

  test("总结失败保留兜底标题", async () => {
    const id = "title-fallback";
    await sessionInsert(id, tmp);
    // 生产顺序：persist 先 sessionTouch 写入兜底标题，再触发总结
    const { sessionTouch } = await import("./hostdb");
    await sessionTouch(id, "会失败的标题".slice(0, 60), "会失败的标题");
    titleSummarizeHook.fn = async () => undefined;
    try {
      await maybeSummarizeSessionTitle(makeRun(id, "会失败的标题", "回复"));
      const row = getLocalDb()!
        .query<{ title: string }, [string]>("SELECT title FROM sessions WHERE id = ?")
        .get(id)!;
      expect(row.title).toBe("会失败的标题");
    } finally {
      titleSummarizeHook.fn = undefined;
    }
  });
});
