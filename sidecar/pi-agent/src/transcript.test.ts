import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, db, sessionPath } from "./storage";
import { readTranscript, toUiMessage, persist } from "./transcript";
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

  test("toolResult messages are not rendered", () => {
    const m = { role: "toolResult", content: [] } as unknown as Message;
    expect(toUiMessage(m, 4)).toBeNull();
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
});

describe("persist", () => {
  test("appends new messages and updates the index row", () => {
    const id = "persist-test";
    const now = new Date().toISOString();
    db.query(
      "INSERT INTO pi_sessions (id, title, first_message, cwd, created_at, updated_at) VALUES (?, '', '', ?, ?, ?)",
    ).run(id, tmp, now, now);
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

    persist(run);
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

    const row = db
      .query<{ title: string; first_message: string; updated_at: string }, [string]>(
        "SELECT title, first_message, updated_at FROM pi_sessions WHERE id = ?",
      )
      .get(id)!;
    expect(row.first_message).toBe("hello world");
    expect(row.title).toBe("hello world");

    // 第二次 persist 无新增消息时不追加
    const before = readFileSync(sessionPath(id), "utf8");
    persist(run);
    expect(readFileSync(sessionPath(id), "utf8")).toBe(before);
  });
});
