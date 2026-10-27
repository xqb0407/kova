/**
 * 队列消息重复 e2e（2026-10-27 报障）：走真实协议命令（dispatch → thread_snapshot
 * / prompt），覆盖三类窗口下快照的消息份数。
 *
 * 报障链路：message_end 的落盘（stream.ts 订阅在前）与 partial 台账清理
 * （thread-events 订阅在后）之间隔着 persist 的异步写库——窗口内到达的
 * thread_snapshot 同时看到「转录里刚落盘的行」和「尚未清理的 partial」，
 * 同一条消息输出两份，前端渲染成两条气泡（慢存储时几乎必中）。
 *
 * harness 与 protocol.test.ts 同款：捕获 stdout、临时存储目录、直跑 dispatch。
 * 压缩/派发等重路径不起（不依赖模型），partial 台账用 notePartial 同款写入
 * ——与 wireSessionEvents 的真实写入同函数，覆盖「落盘后未清理」的真实状态。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionInsert, sessionTouch } from "../../src/storage/hostdb";
import { initStorage, sessionPath } from "../../src/storage/storage";
import { dispatch } from "../../src/protocol/protocol";
import { notePartialForTest, peekPartial } from "../../src/protocol/thread-events";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-dup-e2e-"));

beforeAll(() => {
  initStorage(join(tmp, "state.db"), join(tmp, "sessions"));
});

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 清扫失败非致命 */
  }
});

/** 捕获协议流（send 写 process.stdout） */
const lines: string[] = [];
let origWrite: typeof process.stdout.write;

beforeAll(() => {
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

const last = (): Record<string, unknown> => JSON.parse(lines[lines.length - 1]);

/** 造一个带 user+assistant 两行的真实转录（与 persist 落盘形状一致） */
async function seedSession(id: string, userText: string, assistantText: string) {
  await sessionInsert(id, tmp);
  const now = "2026-10-27T00:00:00.000Z";
  writeFileSync(
    sessionPath(id),
    [
      JSON.stringify({ type: "header", schema: 1, id, cwd: tmp, created_at: now }),
      JSON.stringify({
        type: "message",
        seq: 0,
        ui: {},
        agent: { role: "user", content: userText, timestamp: 1_000 },
      }),
      JSON.stringify({
        type: "message",
        seq: 1,
        ui: {},
        agent: {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
          api: "x",
          provider: "p",
          model: "m",
          stopReason: "stop",
          timestamp: 2_000,
          usage: {},
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  await sessionTouch(id, "", "", 2);
}

const userRows = (snapshot: {
  messages: { role?: string; content?: unknown }[];
}): number[] => {
  const keys: number[] = [];
  for (const m of snapshot.messages) {
    if (m.role !== "user") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as { type?: string; text?: string }[])
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("\n")
          : "";
    keys.push(text.length);
  }
  return keys;
};

describe("队列消息重复 e2e：thread_snapshot 消息份数", () => {
  test("落盘后 partial 未清理的窗口：快照里同一条 user 行只有一份", async () => {
    const id = "dup-e2e-window";
    await seedSession(id, "排队的问题", "上一轮回复");
    // 模拟真实窗口状态：新一条 user 消息已 persist 进转录，但 wireSessionEvents
    // 的台账清理还没跑到（notePartial 与 wireSessionEvents 同函数写入）
    const echo = { role: "user", content: "排队的问题2", timestamp: 3_000 };
    appendFileSync(
      sessionPath(id),
      JSON.stringify({
        type: "message",
        seq: 2,
        ui: {},
        agent: echo,
      }) + "\n",
      "utf8",
    );
    await sessionTouch(id, "", "", 1);
    notePartialForTest(id, echo);
    expect(peekPartial(id)).toBeDefined();

    await dispatch("dup-e2e-1", { type: "thread_snapshot", sessionId: id });
    const snapshot = last().snapshot as {
      messages: { role?: string; content?: unknown }[];
    };
    // 修复前：转录里的行 + 台账里的 partial = 同一条消息两份
    expect(userRows(snapshot).filter((n) => n === "排队的问题2".length)).toHaveLength(1);
    expect(snapshot.messages).toHaveLength(3);
  });

  test("partial 是真正的在飞消息（转录还没有）：快照正常追加一份", async () => {
    const id = "dup-e2e-inflight";
    await seedSession(id, "问", "答");
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "正在流式输出…" }],
      timestamp: 9_000,
    };
    notePartialForTest(id, partial);
    expect(peekPartial(id)).toBeDefined();

    await dispatch("dup-e2e-2", { type: "thread_snapshot", sessionId: id });
    const snapshot = last().snapshot as { messages: unknown[] };
    // 2 条落盘 + 1 条在飞 = 3：不能因为去重误杀真实的在飞消息
    expect(snapshot.messages).toHaveLength(3);
  });

  test("台账已清（message_end 正常收尾）：快照只有转录内容", async () => {
    const id = "dup-e2e-settled";
    await seedSession(id, "问3", "答3");
    expect(peekPartial(id)).toBeUndefined();

    await dispatch("dup-e2e-3", { type: "thread_snapshot", sessionId: id });
    const snapshot = last().snapshot as { messages: unknown[] };
    expect(snapshot.messages).toHaveLength(2);
  });
});
