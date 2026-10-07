import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, sessionPath } from "../../src/storage/storage";
import { sessionInsert, sessionRename, getLocalDb } from "../../src/storage/hostdb";
import {
  readTranscript,
  removeTranscriptRow,
  toUiMessage,
  persist,
  historyToUiMessages,
  isTruncationStoppedRow,
  appendCompactionRow,
  readCompaction,
  readAllCompactions,
  titleSummarizeHook,
  maybeSummarizeSessionTitle,
  scanTranscript,
  appendModelChangeRow,
  appendThinkingLevelChangeRow,
  appendSessionInfoRow,
  setSessionName,
  STEER_PREFIX,
} from "../../src/sessions/transcript";
import { makeSummaryMessage, projectRestoreContext } from "../../src/agent/context";
import type { Message } from "@earendil-works/pi-ai";
import type { Running, SteerEntry } from "../../src/types";

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

  test("user content array: text 合并 + image 回显 file part（data URL）", () => {
    const m = {
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "xx", mimeType: "image/png" },
        { type: "text", text: "b" },
      ],
    } as unknown as Message;
    const ui = toUiMessage(m, 1)!;
    expect(ui.parts).toEqual([
      { type: "text", text: "a\nb" },
      {
        type: "file",
        mediaType: "image/png",
        filename: "image-1.png",
        url: "data:image/png;base64,xx",
      },
    ]);
  });

  test("纯图片无文字：仍产出消息（file part 兜底 mime）", () => {
    const m = {
      role: "user",
      content: [{ type: "image", data: "yy" }],
    } as unknown as Message;
    const ui = toUiMessage(m, 5)!;
    expect(ui.parts).toEqual([
      {
        type: "file",
        mediaType: "image/png",
        filename: "image-1.png",
        url: "data:image/png;base64,yy",
      },
    ]);
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
  test("工作流交付注入不进用户气泡（实机:整段内部指令以用户消息直出）", () => {
    const rows = [
      { agent: userMsg("帮我调研这个仓库") },
      { agent: userMsg("[[workflow-continue]] The workflow \"x\" has finished. <workflow_report># 报告…") },
      { agent: assistantMsg([{ type: "text", text: "调研结果如下…" }]) },
    ];
    const messages = historyToUiMessages(rows);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(messages)).not.toContain("workflow-continue");
  });

  test("用户图片行重建为 file part（与直播 UIMessage 同构）", () => {
    const imageUser = {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image", data: "zz", mimeType: "image/jpeg" },
      ],
    } as unknown as Message;
    const messages = historyToUiMessages([
      { agent: imageUser, seq: 0 },
      { agent: assistantMsg([{ type: "text", text: "好的" }]), seq: 1 },
    ]);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.parts).toEqual([
      { type: "text", text: "看图" },
      {
        type: "file",
        mediaType: "image/jpeg",
        filename: "image-1.jpg",
        url: "data:image/jpeg;base64,zz",
      },
    ]);
  });

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

  test("isError 的 toolResult 回放为 output-error（与 live 流的 tool-output-error 同构）", () => {
    const rows = [
      { agent: toolCallMsg("c1", "write", { file_path: "a.html", content: "<h1/>" }) },
      {
        agent: {
          ...toolResultMsg("c1", "write", "User rejected this tool call. Ask how to proceed."),
          isError: true,
        },
      },
    ];
    const messages = historyToUiMessages(rows);
    expect(messages[0].parts).toEqual([
      {
        type: "tool-write",
        toolCallId: "c1",
        state: "output-error",
        input: { file_path: "a.html", content: "<h1/>" },
        errorText: "User rejected this tool call. Ask how to proceed.",
      },
    ]);
  });

  test("toolResult 的 image 块重建为 data-image part（与 live 流同构，紧跟 tool part）", () => {
    const rows = [
      { agent: toolCallMsg("c1", "generate_image", { prompt: "猫" }) },
      {
        agent: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "generate_image",
          content: [
            { type: "text", text: "已生成：cat.png" },
            { type: "image", data: "aGk=", mimeType: "image/png" },
          ],
          isError: false,
        } as unknown as Message,
      },
    ];
    const messages = historyToUiMessages(rows);
    expect(messages.length).toBe(1);
    const parts = messages[0].parts as Array<Record<string, unknown>>;
    expect(parts.length).toBe(2);
    // tool part：output 文本走与 stream.ts 同一拼装（image 块贡献空段）
    expect(parts[0].type).toBe("tool-generate_image");
    expect(parts[0].output).toBe("已生成：cat.png\n");
    // data-image part：id/data 形状与 live chunk 逐字段一致（共用 projectToolResult）
    expect(parts[1]).toEqual({
      type: "data-image",
      id: "img-c1-0",
      data: {
        src: "data:image/png;base64,aGk=",
        mimeType: "image/png",
        bytes: 3,
        toolCallId: "c1",
        toolName: "generate_image",
        alt: "已生成：cat.png",
      },
    });
  });

  test("同消息多工具：图插到各自 tool part 之后（结果乱序到达亦正确）", () => {
    const msgWithImage = (toolCallId: string, b64: string): Message =>
      ({
        role: "toolResult",
        toolCallId,
        content: [
          { type: "text", text: "t" },
          { type: "image", data: b64, mimeType: "image/png" },
        ],
        isError: false,
      }) as unknown as Message;
    const rows = [
      {
        agent: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c1", name: "t1", arguments: {} },
            { type: "toolCall", id: "c2", name: "t2", arguments: {} },
          ],
        } as unknown as Message,
      },
      // 完成顺序颠倒：c2 的结果先到
      { agent: msgWithImage("c2", "aGk=") },
      { agent: msgWithImage("c1", "aGk=") },
    ];
    const messages = historyToUiMessages(rows);
    expect(messages.length).toBe(1);
    expect(
      (messages[0].parts as Array<{ type: string; id?: string }>).map(
        (p) => p.id ?? p.type,
      ),
    ).toEqual(["tool-t1", "img-c1-0", "tool-t2", "img-c2-0"]);
  });

  test("简单 user 消息重建为 text part", () => {
    const messages = historyToUiMessages([{ agent: userMsg("hello") }]);
    expect(messages).toEqual([
      { id: "msg-0", role: "user", parts: [{ type: "text", text: "hello" }] },
    ]);
  });

  test("带 timestamp 的消息：id 用转录音 seq，时间戳落 metadata.createdAt", () => {
    const rows = [
      { seq: 7, agent: { ...userMsg("q"), timestamp: 1_700_000_000_000 } as Message },
      { seq: 8, agent: { ...assistantMsg([{ type: "text", text: "a" }]), timestamp: 1_700_000_012_000 } as Message },
    ];
    const messages = historyToUiMessages(rows);
    expect(messages.map((m) => m.id)).toEqual(["msg-7", "msg-8"]);
    expect(messages[0].metadata).toEqual({ createdAt: 1_700_000_000_000 });
    expect(messages[1].metadata).toEqual({ createdAt: 1_700_000_012_000 });
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
    // 边界 seq=2 之后首条 assistant 是 a2（seq=4 → msg-4；id 基准是转录行 seq
    // 而不是行下标——分页窗里两窗下标都从 0 起，下标 id 会撞号）
    expect(messages[3].id).toBe("msg-4");
    expect(messages[3].parts[0]).toEqual({
      type: "data-compaction",
      id: "cmp-5",
      data: { phase: "complete", generation: 1, tokensBefore: 1000, summarized: true, summary: "S" },
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
          data: { phase: "complete", generation: 1, tokensBefore: 800, summarized: true, summary: "S" },
        },
      ],
    });
  });

  test("压缩 checkpoint 落盘后用户发言：线插在它之前，不越过（live 同构）", () => {
    // q1,a1 已落盘（seq 1-2）→ 压缩 checkpoint 落盘（seq=3）→ 用户发 q2（seq=4）
    const rows = [
      { seq: 1, agent: userMsg("q1") },
      { seq: 2, agent: assistantMsg([{ type: "text", text: "a1" }]) },
      { seq: 4, agent: userMsg("q2") },
    ];
    const messages = historyToUiMessages(rows, [
      { seq: 3, summary: "S", tokensBefore: 900, throughSeq: 2, createdAt: "t", details: { generation: 1, strategy: "summary" } },
    ]);
    // 线独立成条，插在压缩后发言的 q2 之前（而非越过 q2 找宿主）
    expect(messages.map((m) => m.id)).toEqual(["msg-1", "msg-2", "cmp-3", "msg-4"]);
    expect(messages[2].parts[0]).toEqual({
      type: "data-compaction",
      id: "cmp-3",
      data: { phase: "complete", generation: 1, tokensBefore: 900, summarized: true, summary: "S" },
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

  test("兜底标题剥掉指令芯片标记（first_message 保持原文）", async () => {
    const id = "persist-chips";
    await sessionInsert(id, tmp);
    writeFileSync(sessionPath(id), "", "utf8");
    const raw = ":skill[anxin-ppt]{name=skill:anxin-ppt}生成一下吧";
    const run = {
      agent: { state: { messages: [userMsg(raw)], model: {} } },
      sessionId: id,
      cwd: tmp,
      persistedSeq: 0,
      jsonlSeq: 0,
    } as unknown as Running;
    await persist(run, { earlyUser: true });
    const row = getLocalDb()!
      .query<{ title: string; first_message: string }, [string]>(
        "SELECT title, first_message FROM sessions WHERE id = ?",
      )
      .get(id)!;
    expect(row.first_message).toBe(raw);
    expect(row.title).toBe("anxin-ppt生成一下吧");
  });

  test("earlyUser 轮初补录：只落用户行、更新索引、跳过标题总结", async () => {
    const id = "persist-early";
    await sessionInsert(id, tmp);
    writeFileSync(sessionPath(id), "", "utf8");
    let titleTries = 0;
    titleSummarizeHook.fn = async () => {
      titleTries += 1;
      return "AI 标题";
    };
    try {
      const messages = [userMsg("早落盘测试")];
      const run = {
        agent: { state: { messages, model: {} } },
        sessionId: id,
        cwd: tmp,
        persistedSeq: 0,
        jsonlSeq: 0,
      } as unknown as Running;

      // 轮初（stream.ts message_end 用户分支的调用形态）：用户行进 JSONL、
      // 索引 title/first_message 就位，智能标题不得尝试（one-shot 防抖要留给轮末）
      await persist(run, { earlyUser: true });
      expect(run.persistedSeq).toBe(1);
      expect(readTranscript(id).length).toBe(1);
      expect(titleTries).toBe(0);

      // 轮末收尾：助手增量照常落盘，这一次才触发标题
      messages.push(assistantMsg([{ type: "text", text: "收到" }]));
      await persist(run);
      expect(readTranscript(id).length).toBe(2);
      // 标题总结为 fire-and-forget（不阻塞 agent_end）：让出事件循环等它完成
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(titleTries).toBe(1);
    } finally {
      titleSummarizeHook.fn = undefined;
    }
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

  test("并入注入行登记 seq（回收时按它撤回转录行）", async () => {
    const id = "persist-steer-seq";
    await sessionInsert(id, tmp);
    writeFileSync(sessionPath(id), "", "utf8");

    const injected = userMsg(`${STEER_PREFIX}插话内容`);
    const steerEntry: SteerEntry = {
      reqId: "pi-steer-1",
      msg: { text: "插话内容" },
      message: injected,
      gen: 0,
    };
    const run = {
      agent: { state: { messages: [userMsg("首轮"), injected] } },
      sessionId: id,
      cwd: tmp,
      persistedSeq: 0,
      jsonlSeq: 0,
      steerEntries: [steerEntry],
    } as unknown as Running;

    await persist(run);
    // 注入行是第 2 条 → seq = 1（身份登记，非文本匹配）
    expect(steerEntry.seq).toBe(1);

    const before = readTranscript(id);
    expect(before.length).toBe(2);
    expect(removeTranscriptRow(id, steerEntry.seq!)).toBe(1);
    const after = readTranscript(id);
    expect(after.length).toBe(1);
    expect((after[0].agent as { content?: unknown }).content).toBe("首轮");
    // 幂等：行不在（或已删）时返回 0，不误删别的行
    expect(removeTranscriptRow(id, steerEntry.seq!)).toBe(0);
    expect(readTranscript(id).length).toBe(1);
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
      // §6 M4：AI 标题与手动改名共用 setSessionName 落盘面 → 转录 session_info 行同步落
      expect(scanTranscript(id).name).toBe("重构认证模块");
    } finally {
      titleSummarizeHook.fn = undefined;
    }
  });

  test("智能标题落盘后广播 session_info_changed（前端实时改标题）", async () => {
    const id = "title-emit";
    await sessionInsert(id, tmp);
    const frames: Record<string, unknown>[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
      frames.push(JSON.parse(String(c).trim()) as Record<string, unknown>);
      return true;
    };
    titleSummarizeHook.fn = async () => "重构认证模块";
    try {
      await maybeSummarizeSessionTitle(makeRun(id, "帮我重构用户认证模块", "已完成"));
    } finally {
      titleSummarizeHook.fn = undefined;
      (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
        origWrite as unknown as (c: unknown) => boolean;
    }
    const frame = frames.find(
      (f) => f.type === "thread_event" && (f.event as { type?: string })?.type === "session_info_changed",
    );
    expect(frame?.sessionId).toBe(id);
    expect((frame?.event as { name?: string }).name).toBe("重构认证模块");
  });

  test("总结输入剥掉指令芯片标记", async () => {
    const id = "title-chips";
    await sessionInsert(id, tmp);
    let seenPrompt = "";
    titleSummarizeHook.fn = async (_s, _m, userPrompt) => {
      seenPrompt = userPrompt;
      return "用 anxin-ppt 生成 PPT";
    };
    try {
      await maybeSummarizeSessionTitle(
        makeRun(id, ":skill[anxin-ppt]{name=skill:anxin-ppt}生成一下吧svg 也放", "好的"),
      );
      expect(seenPrompt).toBe("anxin-ppt生成一下吧svg 也放");
      const row = getLocalDb()!
        .query<{ title: string }, [string]>("SELECT title FROM sessions WHERE id = ?")
        .get(id)!;
      expect(row.title).toBe("用 anxin-ppt 生成 PPT");
    } finally {
      titleSummarizeHook.fn = undefined;
    }
  });

  test("旧版未剥芯片的兜底标题仍可补总结（守卫兼容）", async () => {
    const id = "title-legacy-chips";
    await sessionInsert(id, tmp);
    const raw = ":skill[anxin-ppt]{name=skill:anxin-ppt}生成一下吧svg 也放";
    const { sessionTouch } = await import("../../src/storage/hostdb");
    await sessionTouch(id, raw.slice(0, 60), raw);
    titleSummarizeHook.fn = async () => "生成 PPT 与 SVG";
    try {
      await maybeSummarizeSessionTitle(makeRun(id, raw, "好的"));
      const row = getLocalDb()!
        .query<{ title: string }, [string]>("SELECT title FROM sessions WHERE id = ?")
        .get(id)!;
      expect(row.title).toBe("生成 PPT 与 SVG");
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
    const { sessionTouch } = await import("../../src/storage/hostdb");
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

/* ---------------- 上下文设定行（§6 M4 上游对齐） ---------------- */

/**
 * 互测样例（M4 门禁方向 b）：vendored 自上游
 * pi-main packages/coding-agent/src/core/session-manager.ts 的
 * `getSessionContextSettings`——上游把 parseSessionEntries（JSON.parse
 * 不校验）解析出的条目序列回放成 thinking/model 设定。逻辑逐行保持原样，
 * 仅把入参类型放宽成 JSONL 直读的行对象。
 */
function upstreamGetSessionContextSettings(entries: {
  type: string;
  [k: string]: unknown;
}[]): { thinkingLevel: string; model: { provider: string; modelId: string } | null } {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;

  for (const entry of entries) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel as string;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider as string, modelId: entry.modelId as string };
    } else if (entry.type === "message") {
      const m = entry.message as
        | { role?: string; provider?: string; model?: string }
        | undefined;
      if (m?.role === "assistant") {
        model = { provider: m.provider as string, modelId: m.model as string };
      }
    }
  }

  return { thinkingLevel, model };
}

describe("上下文设定行落盘与回放（§6 M4）", () => {
  test("writer 三件套往返：逐行 JSONL、ISO timestamp、不占 seq；scan 回放 last-wins", async () => {
    const id = "m4-writers";
    await sessionInsert(id, tmp);
    appendModelChangeRow(id, "anthropic", "claude-sonnet-4-5");
    appendThinkingLevelChangeRow(id, "low");
    appendSessionInfoRow(id, "首次命名");
    appendModelChangeRow(id, "openai", "gpt-4o");
    appendThinkingLevelChangeRow(id, "high");
    appendSessionInfoRow(id, "改名后");
    const scan = scanTranscript(id);
    expect(scan.model).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(scan.thinkingLevel).toBe("high");
    expect(scan.name).toBe("改名后");
    expect(scan.messages).toEqual([]);
    const rows = readFileSync(sessionPath(id), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((r) => r.type)).toEqual([
      "model_change",
      "thinking_level_change",
      "session_info",
      "model_change",
      "thinking_level_change",
      "session_info",
    ]);
    // timestamp = 上游条目同名字段的 ISO 串（读端不用，纯溯源留档）
    expect(String(rows[0].timestamp)).toMatch(
      new RegExp(`^${new Date().getFullYear()}-\\d{2}-\\d{2}T`),
    );
    // 事件溯源行不占 seq 号段（queue_state/pending_interaction 同款）
    expect(rows.every((r) => !("seq" in r))).toBe(true);
  });

  test("无设定行 = 三值全 null：旧会话恢复回落偏好行/全局的路径不受影响", async () => {
    const id = "m4-legacy";
    await sessionInsert(id, tmp);
    writeFileSync(
      sessionPath(id),
      JSON.stringify({
        type: "message",
        seq: 0,
        ui: null,
        agent: { role: "user", content: "hi" },
      }) + "\n",
    );
    const scan = scanTranscript(id);
    expect(scan).toMatchObject({ model: null, thinkingLevel: null, name: null });
    expect(scan.messages).toHaveLength(1);
  });

  test("形状不符的设定行与未知行忽略，不覆盖最后有效值", async () => {
    const id = "m4-malformed";
    await sessionInsert(id, tmp);
    writeFileSync(
      sessionPath(id),
      [
        JSON.stringify({
          type: "model_change",
          provider: "openai",
          modelId: "gpt-4o",
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({ type: "model_change", provider: "缺modelId" }),
        JSON.stringify({ type: "thinking_level_change", thinkingLevel: 42 }),
        JSON.stringify({ type: "session_info" }),
        // 上游树形态的未知行（label）：跳过不炸
        JSON.stringify({ type: "label", id: "x9y8z7w6", parentId: "d4e5f6g7", label: "标记" }),
        JSON.stringify({ type: "session_info", name: "有效名" }),
        "{ 撕裂的尾行",
      ].join("\n") + "\n",
    );
    const scan = scanTranscript(id);
    expect(scan.model).toEqual({ provider: "openai", modelId: "gpt-4o" }); // 坏行不覆盖好值
    expect(scan.thinkingLevel).toBeNull(); // 类型错的不进
    expect(scan.name).toBe("有效名"); // 最后一条有效行 wins
  });

  test("空串名 = 显式清名，与无行的 null 可区分", async () => {
    const id = "m4-clearname";
    await sessionInsert(id, tmp);
    appendSessionInfoRow(id, "A");
    expect(scanTranscript(id).name).toBe("A");
    appendSessionInfoRow(id, "");
    expect(scanTranscript(id).name).toBe("");
  });

  test("setSessionName：先落转录行（真值），再同步索引 title 列（投影）", async () => {
    const id = "m4-rename";
    await sessionInsert(id, tmp);
    await setSessionName(id, "交接命名");
    expect(scanTranscript(id).name).toBe("交接命名");
    const row = getLocalDb()!
      .query<{ title: string }, [string]>("SELECT title FROM sessions WHERE id = ?")
      .get(id)!;
    expect(row.title).toBe("交接命名");
  });
});

describe("与上游 v3 解析器互测（§10 M4 门禁）", () => {
  test("方向 a：上游文档原版 v3 条目行（树形态）我们的回放读得出", async () => {
    const id = "m4-upstream-in";
    await sessionInsert(id, tmp);
    // 逐字取自 pi-main packages/coding-agent/docs/session-format.md 的示例条目
    writeFileSync(
      sessionPath(id),
      [
        '{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}',
        '{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello","timestamp":1733234401000}}',
        '{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}',
        '{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}',
        '{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}',
      ].join("\n") + "\n",
    );
    const scan = scanTranscript(id);
    expect(scan.model).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(scan.thinkingLevel).toBe("high");
    expect(scan.name).toBe("Refactor auth module");
    // 上游 message 行无 seq 字段 → 按未知行跳过：我们的消息重建不被外来格式污染
    // （线性子集的边界，§11 决策 4：字段名抄上游保证设定行互读，树语义不采纳）
    expect(scan.messages).toEqual([]);
  });

  test("方向 b：我们 writer 写的行，上游 getSessionContextSettings 回放读得出", async () => {
    const id = "m4-upstream-out";
    await sessionInsert(id, tmp);
    appendModelChangeRow(id, "anthropic", "claude-sonnet-4-5");
    appendThinkingLevelChangeRow(id, "medium");
    appendModelChangeRow(id, "openai", "gpt-4o");
    const entries = readFileSync(sessionPath(id), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
    expect(upstreamGetSessionContextSettings(entries)).toEqual({
      thinkingLevel: "medium",
      model: { provider: "openai", modelId: "gpt-4o" },
    });
  });
});

describe("steer 哨兵前缀（并入当前轮的注入消息）", () => {
  test("historyToUiMessages：带前缀的用户行 → 文本剥前缀 + data-steeredNote 标记 part", () => {
    const messages = historyToUiMessages([
      { agent: userMsg(`${STEER_PREFIX}底部导航图标修一下`), seq: 7 },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.parts).toEqual([
      { type: "data-steeredNote", id: "steered-7", data: {} },
      { type: "text", text: "底部导航图标修一下" },
    ]);
  });

  test("toUiMessage 同口径：标记 part 带上 seq 基准 id", () => {
    const ui = toUiMessage(userMsg(`${STEER_PREFIX}并入的追问`), 11)!;
    expect(ui.parts[0]).toEqual({
      type: "data-steeredNote",
      id: "steered-11",
      data: {},
    });
  });

  test("普通用户行不受影响：无标记 part，文本原样", () => {
    const messages = historyToUiMessages([{ agent: userMsg("普通提问"), seq: 3 }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.parts).toEqual([{ type: "text", text: "普通提问" }]);
  });

  test("auto-continue 注入行在历史重建中隐藏（与 toUiMessage 同口径）", () => {
    const messages = historyToUiMessages([
      {
        agent: userMsg("[[auto-continue]] 上一条回复因达到输出 token 上限被截断"),
        seq: 9,
      },
    ]);
    expect(messages).toEqual([]);
  });
});

describe("连续截断预算耗尽的最终中止标记", () => {
  const truncatedAssistant = (): Message =>
    ({
      role: "assistant",
      stopReason: "length",
      content: [{ type: "thinking", thinking: "把整轮输出预算烧在思考上……" }],
    }) as unknown as Message;
  const sentinelUser = (): Message =>
    userMsg("[[auto-continue]] 上一条回复因达到输出 token 上限被截断");

  describe("isTruncationStoppedRow", () => {
    test("截断无 toolCall 且下一行是哨兵续跑 → 中途截断，非中止", () => {
      expect(
        isTruncationStoppedRow(
          { agent: truncatedAssistant() },
          { agent: sentinelUser() },
        ),
      ).toBe(false);
    });
    test("截断无 toolCall 且下一行是普通 user / EOF → 最终中止", () => {
      expect(
        isTruncationStoppedRow({ agent: truncatedAssistant() }, { agent: userMsg("继续") }),
      ).toBe(true);
      expect(isTruncationStoppedRow({ agent: truncatedAssistant() })).toBe(true);
    });
    test("带 toolCall 的截断轮 / 非 length 收尾 → 不是中止行", () => {
      expect(
        isTruncationStoppedRow({
          agent: {
            role: "assistant",
            stopReason: "length",
            content: [{ type: "toolCall", id: "t1", name: "write", arguments: {} }],
          } as unknown as Message,
        }),
      ).toBe(false);
      expect(
        isTruncationStoppedRow(
          { agent: { role: "assistant", stopReason: "stop", content: [] } as unknown as Message },
          { agent: userMsg("继续") },
        ),
      ).toBe(false);
    });
  });

  test("historyToUiMessages：预算耗尽的截断轮补 data-truncation-stopped part", () => {
    const rows = [
      { agent: userMsg("开始任务"), seq: 0 },
      { agent: truncatedAssistant(), seq: 1 },
      { agent: sentinelUser(), seq: 2 },
      { agent: truncatedAssistant(), seq: 3 },
      { agent: userMsg("继续吧"), seq: 4 },
    ];
    const messages = historyToUiMessages(rows);
    // 第 1 个截断轮后面跟哨兵（中途截断）不标；第 2 个后面是普通 user（预算耗尽）标
    const marked = messages
      .filter((m) =>
        m.parts.some((p) => (p as { type?: string }).type === "data-truncation-stopped"),
      )
      .map((m) => m.id);
    expect(marked).toEqual(["msg-3"]);
  });

  test("分页窗未触及会话末尾时，窗口末行不判中止（防误标）", () => {
    const messages = historyToUiMessages(
      [
        { agent: userMsg("开始任务"), seq: 0 },
        { agent: truncatedAssistant(), seq: 1 },
      ],
      [],
      { reachesSessionEnd: false },
    );
    expect(
      messages.some((m) =>
        m.parts.some((p) => (p as { type?: string }).type === "data-truncation-stopped"),
      ),
    ).toBe(false);
  });
});
