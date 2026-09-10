import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, sessionPath } from "./storage";
import { sessionInsert, getLocalDb } from "./hostdb";
import { readTranscript, toUiMessage, persist, historyToUiMessages } from "./transcript";
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
        "SELECT title, first_message, updated_at FROM pi_sessions WHERE id = ?",
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
