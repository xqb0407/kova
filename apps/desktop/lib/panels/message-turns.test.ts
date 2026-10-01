import { describe, expect, test } from "bun:test";

import type { ThreadMessage } from "@assistant-ui/react";
import {
  buildTurnIndex,
  getTurnIndex,
  getTurnParts,
  messageIndexById,
  packTurnSlot,
  packTurnSlotWithKeep,
  packTurnSummary,
  parseTurnSlot,
  parseTurnSlotWithKeep,
  parseTurnSummary,
} from "./message-turns";

type Stub = { id: string; role: string; content?: unknown[]; metadata?: unknown };

/** 造消息桩：buildTurnIndex 只读 id/role，摘要打包额外读 content/metadata */
const msg = (id: string, role: string): ThreadMessage =>
  ({ id, role, content: [], metadata: {} }) as unknown as ThreadMessage;

describe("packTurnSlot / parseTurnSlot", () => {
  const message = (id: string, role: string) =>
    ({ id, role, content: [], metadata: {} }) as unknown as ThreadMessage;

  test("往返：轮首/轮中/轮末/最新轮的标记与轮次键都还原", () => {
    const messages = [
      message("u1", "user"),
      message("a1", "assistant"),
      message("a2", "assistant"),
      message("u2", "user"),
      message("a3", "assistant"),
    ];
    expect(parseTurnSlot(packTurnSlot(messages, "u1"))).toEqual({
      isTurnStart: true,
      isTurnEnd: false,
      isLastTurn: false,
      interrupted: false,
      turnRunning: false,
      anchorUserIndex: 0,
      turnKey: "u1",
    });
    expect(parseTurnSlot(packTurnSlot(messages, "a1"))).toMatchObject({
      isTurnStart: false,
      isTurnEnd: false,
      turnKey: "u1",
    });
    expect(parseTurnSlot(packTurnSlot(messages, "a2"))).toMatchObject({
      isTurnEnd: true,
      isLastTurn: false,
      turnKey: "u1",
    });
    expect(parseTurnSlot(packTurnSlot(messages, "u2"))).toMatchObject({
      isTurnStart: true,
      anchorUserIndex: 3,
      turnKey: "u2",
    });
    expect(parseTurnSlot(packTurnSlot(messages, "a3"))).toMatchObject({
      isTurnEnd: true,
      isLastTurn: true,
      turnKey: "u2",
    });
  });

  test("缺失消息 / 空串回 null（调用方按「正常渲染」兜底）", () => {
    expect(packTurnSlot([message("u1", "user")], "nope")).toBe("");
    expect(parseTurnSlot("")).toBeNull();
  });

  test("带 keep 标记的往返：槽位与标记各归各位", () => {
    const messages = [message("u1", "user"), message("a1", "assistant")];
    const packed = packTurnSlotWithKeep(messages, "a1", true);
    expect(parseTurnSlotWithKeep(packed)).toEqual({
      slot: {
        isTurnStart: false,
        isTurnEnd: true,
        isLastTurn: true,
        interrupted: false,
        turnRunning: false,
        anchorUserIndex: 0,
        turnKey: "u1",
      },
      keepsVisible: true,
    });
    expect(
      parseTurnSlotWithKeep(packTurnSlotWithKeep(messages, "u1", false)),
    ).toMatchObject({ keepsVisible: false, slot: { isTurnStart: true } });
    // 空槽位（消息不在索引里）→ null，不会退化成「全部收起」
    expect(parseTurnSlotWithKeep(packTurnSlotWithKeep(messages, "nope", true))).toBeNull();
  });

  test("running 位：轮内任一消息在流即置位，轮内所有消息读到同一个值", () => {
    const streaming = {
      id: "a2",
      role: "assistant",
      content: [{ type: "text", text: "写一半" }],
      status: { type: "running" },
      metadata: {},
    } as unknown as ThreadMessage;
    const messages = [
      message("u1", "user"),
      message("a1", "assistant"),
      streaming,
    ];
    const index = buildTurnIndex(messages);
    expect(index.turns[0].running).toBe(true);
    expect(parseTurnSlot(packTurnSlot(messages, "u1"))?.turnRunning).toBe(true);
    expect(parseTurnSlot(packTurnSlot(messages, "a1"))?.turnRunning).toBe(true);
  });

  test("中断判定：轮末消息带 data-stopped 的轮标记 interrupted，且轮内一致", () => {
    const stopped = {
      id: "a2",
      role: "assistant",
      content: [{ type: "data", name: "stopped", data: {} }],
      metadata: {},
    } as unknown as ThreadMessage;
    const messages = [
      message("u1", "user"),
      message("a1", "assistant"),
      stopped,
      message("u2", "user"),
      message("a3", "assistant"),
    ];
    const index = buildTurnIndex(messages);
    expect(index.turns[0].interrupted).toBe(true);
    expect(index.turns[1].interrupted).toBe(false);
    // 轮内所有消息都读到同一个 interrupted（面板开合必须一致）
    expect(parseTurnSlot(packTurnSlot(messages, "u1"))?.interrupted).toBe(true);
    expect(parseTurnSlot(packTurnSlot(messages, "a1"))?.interrupted).toBe(true);
    expect(parseTurnSlot(packTurnSlot(messages, "a3"))?.interrupted).toBe(false);
  });
});

describe("getTurnParts", () => {
  test("按轮次键取本轮全部 assistant parts（产物卡/检查点挂轮末用）", () => {
    const messages = [
      msg("u1", "user"),
      { id: "a1", role: "assistant", content: [{ type: "text", text: "一" }], metadata: {} },
      { id: "a2", role: "assistant", content: [{ type: "text", text: "二" }], metadata: {} },
      msg("u2", "user"),
    ] as unknown as ThreadMessage[];
    expect(getTurnParts(messages, "u1")).toHaveLength(2);
    expect(getTurnParts(messages, "u1")).toBe(getTurnParts(messages, "u1"));
    expect(getTurnParts(messages, "u2")).toHaveLength(0);
  });
});

describe("buildTurnIndex", () => {
  test("user 起新轮，其后 assistant 并入当前轮", () => {
    const messages = [
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("a2", "assistant"),
      msg("u2", "user"),
      msg("a3", "assistant"),
    ];
    const index = buildTurnIndex(messages);
    expect(index.turns).toEqual([
      { key: "u1", start: 0, end: 3, interrupted: false, running: false },
      { key: "u2", start: 3, end: 5, interrupted: false, running: false },
    ]);
    expect(index.slots.get("u1")).toEqual({ turnIndex: 0, isHeader: true });
    expect(index.slots.get("a2")).toEqual({ turnIndex: 0, isHeader: false });
    expect(index.slots.get("u2")).toEqual({ turnIndex: 1, isHeader: true });
  });

  test("开场 assistant 预置段自成第 0 轮", () => {
    const messages = [
      msg("a1", "assistant"),
      msg("u1", "user"),
      msg("a2", "assistant"),
    ];
    const index = buildTurnIndex(messages);
    expect(index.turns).toEqual([
      { key: "a1", start: 0, end: 1, interrupted: false, running: false },
      { key: "u1", start: 1, end: 3, interrupted: false, running: false },
    ]);
    expect(index.slots.get("a1")).toEqual({ turnIndex: 0, isHeader: true });
  });

  test("连续 user 消息各自成轮（排队/并入场景）", () => {
    const messages = [msg("u1", "user"), msg("u2", "user"), msg("a1", "assistant")];
    const index = buildTurnIndex(messages);
    expect(index.turns).toEqual([
      { key: "u1", start: 0, end: 1, interrupted: false, running: false },
      { key: "u2", start: 1, end: 3, interrupted: false, running: false },
    ]);
  });

  test("空列表", () => {
    expect(buildTurnIndex([]).turns).toEqual([]);
  });

  test("构建抛错时 fail-open：返回空索引（调用方退回正常渲染，不吞消息）", () => {
    // 用 getter 抛错的假消息触发构建异常
    const boom = {
      get id() {
        throw new Error("bad message");
      },
      role: "user",
      content: [],
    } as unknown as ThreadMessage;
    const index = getTurnIndex([boom]);
    expect(index.turns).toEqual([]);
    expect(index.slots.size).toBe(0);
  });

  test("getTurnIndex 按数组身份缓存", () => {
    const messages = [msg("u1", "user")];
    expect(getTurnIndex(messages)).toBe(getTurnIndex(messages));
    expect(getTurnIndex([...messages])).not.toBe(getTurnIndex(messages));
  });

  test("messageIndexById：命中返回下标，未知 id 返回 -1（对齐 findIndex 语义）", () => {
    const messages = [
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("u2", "user"),
    ];
    expect(messageIndexById(messages, "a1")).toBe(1);
    expect(messageIndexById(messages, "u2")).toBe(2);
    expect(messageIndexById(messages, "ghost")).toBe(-1);
  });
});

describe("packTurnSummary", () => {
  const message = (
    id: string,
    role: string,
    content: unknown[],
    metadata: unknown = {},
  ) => ({ id, role, content, metadata }) as unknown as ThreadMessage;

  test("统计工具数、去重文件数、提问与回答摘要", () => {
    const messages = [
      message("u1", "user", [{ type: "text", text: "帮我重构 xxx" }]),
      message("a1", "assistant", [
        { type: "tool-call", toolName: "edit", args: { file_path: "/a.ts" } },
        { type: "tool-call", toolName: "edit", args: { file_path: "/a.ts" } },
        { type: "tool-call", toolName: "bash", args: { command: "ls" } },
        { type: "text", text: "改完了" },
      ]),
    ];
    const summary = parseTurnSummary(packTurnSummary(messages, "u1"));
    expect(summary.messageCount).toBe(2);
    // 轮末带工具 part ⇒ 有过程可收（摘要行才有意义）
    expect(summary.hasProcess).toBe(true);
    // 过程块口径：collapsedCount = 轮内 reasoning + tool-call 数（本例 3 个工具调用）
    expect(summary.collapsedCount).toBe(3);
    expect(summary.toolCount).toBe(3);
    expect(summary.fileCount).toBe(1);
    expect(summary.userText).toBe("帮我重构 xxx");
    expect(summary.answerText).toBe("改完了");
    expect(summary.hasAssistant).toBe(true);
  });

  test("collapsedCount 混合口径：reasoning 与 tool-call 一并计数，text 不计", () => {
    const messages = [
      message("u1", "user", [{ type: "text", text: "查一下" }]),
      message("a1", "assistant", [
        { type: "reasoning", text: "先想" },
        { type: "tool-call", toolName: "bash", args: { command: "ls" } },
        { type: "text", text: "中间说明" },
        { type: "reasoning", text: "再想" },
        { type: "tool-call", toolName: "read", args: { path: "/a" } },
        { type: "text", text: "结果" },
      ]),
    ];
    const summary = parseTurnSummary(packTurnSummary(messages, "u1"));
    // 2 reasoning + 2 tool-call = 4，text part 不计
    expect(summary.collapsedCount).toBe(4);
    expect(summary.toolCount).toBe(2);
  });

  test("纯聊天轮（user + 纯文本回答）：hasProcess=false，行不占位", () => {
    const messages = [
      message("u1", "user", [{ type: "text", text: "你好" }]),
      message("a1", "assistant", [{ type: "text", text: "你好呀" }]),
    ];
    expect(parseTurnSummary(packTurnSummary(messages, "u1")).hasProcess).toBe(false);
    // 带思考块的同类轮：有过程可收
    const withThinking = [
      message("u1", "user", [{ type: "text", text: "你好" }]),
      message("a1", "assistant", [
        { type: "reasoning", text: "想一下" },
        { type: "text", text: "你好呀" },
      ]),
    ];
    expect(parseTurnSummary(packTurnSummary(withThinking, "u1")).hasProcess).toBe(true);
  });

  test("多消息轮：messageCount 反映轮内条数", () => {
    const messages = [
      message("u1", "user", [{ type: "text", text: "hi" }]),
      message("a1", "assistant", [{ type: "text", text: "过程" }]),
      message("a2", "assistant", [{ type: "text", text: "结论" }]),
    ];
    const summary = parseTurnSummary(packTurnSummary(messages, "u1"));
    expect(summary.messageCount).toBe(3);
    expect(summary.answerText).toBe("结论");
  });

  test("timing 存在时给出本轮结束时刻；缺省为 null", () => {
    const started = 1_700_000_000_000;
    const messages = [
      message("u1", "user", [{ type: "text", text: "hi" }]),
      message("a1", "assistant", [{ type: "text", text: "ok" }], {
        timing: { streamStartTime: started, totalStreamTime: 12_000, totalChunks: 3 },
      }),
    ];
    expect(
      parseTurnSummary(packTurnSummary(messages, "u1")).timingEnd,
    ).toBe(started + 12_000);

    const history = [
      message("u2", "user", [{ type: "text", text: "hi" }]),
      message("a2", "assistant", [{ type: "text", text: "ok" }]),
    ];
    expect(parseTurnSummary(packTurnSummary(history, "u2")).timingEnd).toBeNull();
  });

  test("轮次键不存在时返回空串", () => {
    expect(packTurnSummary([msg("u1", "user")], "missing")).toBe("");
  });

  test("摘要打包是原始值：同一轮内容未变时字符串相等", () => {
    const messages = [
      message("u1", "user", [{ type: "text", text: "hi" }]),
      message("a1", "assistant", [{ type: "text", text: "ok" }]),
    ];
    expect(packTurnSummary(messages, "u1")).toBe(packTurnSummary(messages, "u1"));
  });
});
