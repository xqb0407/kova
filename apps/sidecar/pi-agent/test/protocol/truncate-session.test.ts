/**
 * 症状3（编辑重发/重新生成）：truncate_session 服务端截断单测。
 * - 顺序截止：命中第一条 seq >= beforeSeq 即整体丢弃（含其后的无 seq 设定行）
 * - 截止点前的坏行原样保留
 * - removed 只计带 agent 的消息行，索引计数按负增量回修
 * - 参数校验 / busy 拒绝 / 驻留 run 驱逐
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, sessionPath } from "../../src/storage/storage";
import { sessionInsert, sessionTouch } from "../../src/storage/hostdb";
import { dispatch } from "../../src/protocol/protocol";
import { setActiveReqId } from "../../src/protocol/stream";
import { resolveSession, running } from "../../src/sessions/sessions";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-truncate-"));
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  process.env.PI_IDENTITY_DIR = path.join(tmp, "identity");
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
  if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
  else process.env.PI_IDENTITY_DIR = prevIdentityDir;
});

const last = (): Record<string, unknown> => JSON.parse(lines[lines.length - 1]);

const header = (id: string) =>
  JSON.stringify({
    type: "header",
    schema: 1,
    id,
    cwd: tmp,
    created_at: new Date(0).toISOString(),
  });
const msgRow = (seq: number) =>
  JSON.stringify({ type: "message", seq, ui: {}, agent: {} });
/** 设定行不带 seq（transcript.ts appendSettingRow 系形状） */
const settingRow = (type: string) =>
  JSON.stringify({ type, timestamp: new Date(0).toISOString() });

/** 建会话：写索引 + JSONL + 补 touch 维持消息计数不变式（同 protocol.test.ts 先例） */
const seed = async (id: string, rows: string[], messageCount: number) => {
  await sessionInsert(id, tmp);
  writeFileSync(sessionPath(id), rows.join("\n") + "\n", "utf8");
  await sessionTouch(id, "", "", messageCount);
};

/** list_sessions 只列有消息的会话：全截断后应缺席（返回 undefined） */
const messageCountOf = async (id: string): Promise<number | undefined> => {
  await dispatch(`lc-${id}`, { type: "list_sessions" });
  const sessions = last().sessions as { sessionId: string; messageCount: number }[];
  return sessions.find((s) => s.sessionId === id)?.messageCount;
};

describe("truncate_session：顺序截止语义", () => {
  test("命中 seq >= beforeSeq 起整体丢弃（含设定行与尾坏行），计数回修", async () => {
    const id = "tr-cut";
    await seed(
      id,
      [
        header(id),
        msgRow(0),
        settingRow("model_change"),
        msgRow(1),
        msgRow(2), // 截止行
        settingRow("session_info"), // 截止点后的设定行一并回退
        msgRow(3),
        "{ 撕裂的尾行",
      ],
      4,
    );
    expect(await messageCountOf(id)).toBe(4);

    await dispatch("t1", { type: "truncate_session", sessionId: id, beforeSeq: 2 });
    expect(last()).toMatchObject({ id: "t1", type: "truncated", removed: 2 });

    const kept = readFileSync(sessionPath(id), "utf8").trim().split("\n");
    expect(kept.map((l) => JSON.parse(l).type)).toEqual([
      "header",
      "message",
      "model_change", // 截止点前保留
      "message",
    ]);
    expect(kept.map((l) => JSON.parse(l).seq).filter((s) => s != null)).toEqual([0, 1]);
    expect(await messageCountOf(id)).toBe(2);
  });

  test("beforeSeq=0 全截断：只剩 header", async () => {
    const id = "tr-all";
    await seed(id, [header(id), msgRow(0), msgRow(1)], 2);
    await dispatch("t2", { type: "truncate_session", sessionId: id, beforeSeq: 0 });
    expect(last()).toMatchObject({ type: "truncated", removed: 2 });
    const kept = readFileSync(sessionPath(id), "utf8").trim().split("\n");
    expect(kept).toHaveLength(1);
    expect(JSON.parse(kept[0]).type).toBe("header");
    expect(await messageCountOf(id)).toBeUndefined();
  });

  test("未命中 ⇒ removed=0 且文件原样", async () => {
    const id = "tr-miss";
    const rows = [header(id), msgRow(0), msgRow(1)];
    await seed(id, rows, 2);
    await dispatch("t3", { type: "truncate_session", sessionId: id, beforeSeq: 99 });
    expect(last()).toMatchObject({ type: "truncated", removed: 0 });
    expect(readFileSync(sessionPath(id), "utf8").trim().split("\n")).toEqual(rows);
    expect(await messageCountOf(id)).toBe(2);
  });

  test("截止点前的坏行原样保留", async () => {
    const id = "tr-bad";
    await seed(id, [header(id), "{ 坏行", msgRow(0), msgRow(1)], 2);
    await dispatch("t4", { type: "truncate_session", sessionId: id, beforeSeq: 1 });
    expect(last()).toMatchObject({ type: "truncated", removed: 1 });
    const kept = readFileSync(sessionPath(id), "utf8").trim().split("\n");
    expect(kept).toEqual([header(id), "{ 坏行", msgRow(0)]);
  });
});

describe("truncate_session：校验与守卫", () => {
  test("参数校验：缺 sessionId / beforeSeq 非法 / 转录不存在 都抛错", async () => {
    await expect(
      dispatch("e1", { type: "truncate_session", beforeSeq: 1 }),
    ).rejects.toThrow("sessionId required");
    await expect(
      dispatch("e2", { type: "truncate_session", sessionId: "tr-cut", beforeSeq: 1.5 }),
    ).rejects.toThrow("beforeSeq");
    await expect(
      dispatch("e3", { type: "truncate_session", sessionId: "tr-cut", beforeSeq: -1 }),
    ).rejects.toThrow("beforeSeq");
    await expect(
      dispatch("e4", { type: "truncate_session", sessionId: "no-such", beforeSeq: 0 }),
    ).rejects.toThrow("transcript not found");
  });

  test("该线程 prompt 在跑 ⇒ busy 拒绝（compact 同款守卫）", async () => {
    setActiveReqId("busy-t", "req-live");
    try {
      await expect(
        dispatch("b1", {
          type: "truncate_session",
          sessionId: "tr-cut",
          threadId: "busy-t",
          beforeSeq: 1,
        }),
      ).rejects.toThrow("session is busy");
    } finally {
      setActiveReqId("busy-t", null);
    }
    // 守卫释放后同参数可正常截断（threadId 缺省回退 sessionId 判忙）
    await dispatch("b2", {
      type: "truncate_session",
      sessionId: "tr-cut",
      threadId: "busy-t",
      beforeSeq: 1,
    });
    expect(last()).toMatchObject({ type: "truncated", removed: 1 });
  });

  test("截断驱逐该会话的驻留 run（与 delete_session 清理先例一致）", async () => {
    const run = await resolveSession("res-1", undefined, tmp);
    expect(running.has("res-1")).toBe(true);
    const file = sessionPath(run.sessionId);
    writeFileSync(file, readFileSync(file, "utf8").trimEnd() + "\n" + msgRow(0) + "\n", "utf8");
    await sessionTouch(run.sessionId, "", "", 1);

    await dispatch("r1", {
      type: "truncate_session",
      sessionId: run.sessionId,
      threadId: "res-1",
      beforeSeq: 0,
    });
    expect(last()).toMatchObject({ type: "truncated", removed: 1 });
    expect(running.has("res-1")).toBe(false);
  });
});
