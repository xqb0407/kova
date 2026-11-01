/**
 * 划词辅助会话：create_side_session 的复制/隐藏/边界提醒与列表可见性。
 *
 * 关键不变量：
 * - 父转录复制进 child 后逐行 hidden（模型可见、UI 投影为空）
 * - header/索引行 kind=side_chat、parentSession 指向父会话
 * - 边界提醒恰好一条且位于所有继承行之后
 * - goal/todo 运行态不随复制进入 child
 * - list_sessions 默认隐藏、includeSide 时连空副屏一起返回
 * - 副屏不能再次分叉
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, sessionPath } from "../../src/storage/storage";
import {
  sessionGet,
  sessionInsert,
  sessionList,
  sessionTouch,
} from "../../src/storage/hostdb";
import {
  historyToUiMessages,
  readTranscript,
} from "../../src/sessions/transcript";
import { SIDE_CHAT_BOUNDARY_TEXT } from "../../src/sessions/transcript-copy";
import { dispatch } from "../../src/protocol/protocol";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-side-chat-"));
const parentId = "parent-side-chat-1";

const lines: string[] = [];
let origWrite: typeof process.stdout.write;

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (
    c: unknown,
  ) => {
    lines.push(String(c));
    return true;
  };
});

afterAll(() => {
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
    origWrite as unknown as (c: unknown) => boolean;
});

const last = (): Record<string, unknown> =>
  JSON.parse(lines[lines.length - 1]);

beforeAll(async () => {
  await sessionInsert(parentId, tmp);
  await sessionTouch(parentId, "Parent task", "parent question", 3);
  const rows = [
    { type: "header", schema: 1, id: parentId, cwd: tmp },
    {
      type: "message",
      seq: 0,
      ui: null,
      agent: {
        role: "user",
        content: [{ type: "text", text: "parent question" }],
      },
    },
    {
      type: "message",
      seq: 1,
      ui: null,
      agent: {
        role: "assistant",
        content: [{ type: "text", text: "parent answer" }],
      },
    },
    {
      type: "compaction",
      seq: 2,
      summary: "parent summary",
      tokensBefore: 100,
      throughSeq: 1,
      createdAt: new Date().toISOString(),
    },
    // goal 状态行不占 seq：复制循环不应把它带进副屏
    { type: "goal_state", goal: { objective: "parent goal" } },
    {
      type: "message",
      seq: 3,
      ui: null,
      agent: {
        role: "toolResult",
        toolCallId: "todo-1",
        toolName: "todo",
        content: [],
        details: {
          tasks: [{ id: "1", status: "pending", content: "parent todo" }],
          nextId: 2,
        },
      },
    },
  ];
  writeFileSync(
    sessionPath(parentId),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
});

describe("create_side_session", () => {
  test("复制父转录为 hidden 上下文并建隐藏索引行", async () => {
    await dispatch("req-side-1", {
      type: "create_side_session",
      sessionId: parentId,
    });
    const reply = last();
    expect(reply.type).toBe("side_session_created");
    const childId = String(reply.sessionId);
    expect(childId).not.toBe(parentId);

    const row = (await sessionList()).find((r) => r.id === childId);
    expect(row).toBeDefined();
    expect(row!.kind).toBe("side_chat");
    expect(row!.parentSession).toBe(parentId);
    expect(row!.title).toBe("辅助会话");
    expect(row!.message_count).toBe(0);

    const prefs = await sessionGet(childId);
    expect(prefs?.kind).toBe("side_chat");
    expect(prefs?.parentSession).toBe(parentId);
    expect(prefs?.mode).toBe("agent");

    const file = readFileSync(sessionPath(childId), "utf8")
      .split("\n")
      .filter(Boolean);
    const header = JSON.parse(file[0]!) as Record<string, unknown>;
    expect(header.kind).toBe("side_chat");
    expect(header.parentSession).toBe(parentId);

    const body = file.slice(1).map((line) => JSON.parse(line) as Record<string, any>);
    expect(body.some((r) => r.type === "goal_state")).toBe(false);
    const messages = body.filter((r) => r.type === "message");
    // 父会话 3 条消息 + 1 条边界提醒
    expect(messages).toHaveLength(4);
    for (const message of messages) {
      expect(message.hidden).toBe(true);
      expect(message.ui).toBeNull();
    }
    const compaction = body.find((r) => r.type === "compaction");
    expect(compaction?.hidden).toBe(true);

    const boundaries = messages.filter(
      (m) => m.agent?.content?.[0]?.text === SIDE_CHAT_BOUNDARY_TEXT,
    );
    expect(boundaries).toHaveLength(1);
    const copiedSeqs = messages
      .filter((m) => m !== boundaries[0])
      .map((m) => Number(m.seq));
    expect(Number(boundaries[0]!.seq)).toBeGreaterThan(Math.max(...copiedSeqs));

    // UI 投影必须为空：继承历史只喂养模型
    expect(historyToUiMessages(readTranscript(childId), [])).toHaveLength(0);
  });

  test("list_sessions 默认隐藏副屏，includeSide 时含空副屏", async () => {
    const child = (await sessionList()).find((r) => r.kind === "side_chat");
    expect(child).toBeDefined();
    const childId = child!.id;

    await dispatch("req-list-main", { type: "list_sessions" });
    const mainSessions = last().sessions as Array<Record<string, unknown>>;
    expect(mainSessions.some((s) => s.sessionId === childId)).toBe(false);

    await dispatch("req-list-side", { type: "list_sessions", includeSide: true });
    const withSide = last().sessions as Array<Record<string, unknown>>;
    const sideRow = withSide.find((s) => s.sessionId === childId);
    expect(sideRow).toBeDefined();
    expect(sideRow!.kind).toBe("side_chat");
    expect(sideRow!.parentSessionId).toBe(parentId);
  });

  test("thread_snapshot / get_history 不把继承历史投给 UI", async () => {
    const child = (await sessionList()).find((r) => r.kind === "side_chat");
    await dispatch("req-snap", {
      type: "thread_snapshot",
      sessionId: child!.id,
    });
    const snapshot = last().snapshot as { messages: unknown[] };
    expect(snapshot.messages).toEqual([]);

    await dispatch("req-hist", { type: "get_history", sessionId: child!.id });
    expect(last().messages).toEqual([]);
  });

  test("kind 缺失的历史行按 header 自愈（旧宿主期间创建的子会话）", async () => {
    // 模拟：子会话行由不带 kind 的宿主写入（旧 Electron main），转录 header 有 kind
    const staleId = "stale-side-chat-1";
    await sessionInsert(staleId, tmp); // 不带 kind → 索引行 kind 为空串
    await sessionTouch(staleId, "", "", 0);
    writeFileSync(
      sessionPath(staleId),
      [
        JSON.stringify({
          type: "header",
          schema: 1,
          id: staleId,
          cwd: tmp,
          parentSession: parentId,
          kind: "side_chat",
        }),
        JSON.stringify({
          type: "message",
          seq: 0,
          hidden: true,
          ui: null,
          agent: { role: "user", content: [{ type: "text", text: "inherited" }] },
        }),
      ].join("\n") + "\n",
    );

    await dispatch("req-heal-snap", { type: "thread_snapshot", sessionId: staleId });
    const row = (await sessionList()).find((r) => r.id === staleId);
    expect(row!.kind).toBe("side_chat");
    expect(row!.parentSession).toBe(parentId);
    // 修复后的行不再泄漏进主列表
    await dispatch("req-heal-list", { type: "list_sessions" });
    const mainSessions = last().sessions as Array<Record<string, unknown>>;
    expect(mainSessions.some((s) => s.sessionId === staleId)).toBe(false);
  });

  test("副屏不能再次分叉", async () => {
    const child = (await sessionList()).find((r) => r.kind === "side_chat");
    await expect(
      dispatch("req-fork-side", {
        type: "fork_session",
        sessionId: child!.id,
      }),
    ).rejects.toThrow(/cannot be forked/);
  });

  test("副屏不能嵌套创建副屏", async () => {
    const child = (await sessionList()).find((r) => r.kind === "side_chat");
    await expect(
      dispatch("req-side-nested", {
        type: "create_side_session",
        sessionId: child!.id,
      }),
    ).rejects.toThrow(/cannot nest/);
  });
});
