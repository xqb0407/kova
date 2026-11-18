/**
 * IM 会话来源标：侧栏「cwd 不是注册项目也要可见」完全依赖索引行 kind='im'
 * → list_sessions 投影 origin:"im"。这里钉住三条写入路径：
 * - IM 线程新建会话时直接落 kind；
 * - 普通线程不被误标；
 * - IM 恢复升级前创建（kind 为空）的会话时自愈补标。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "../../src/storage/storage";
import { dropRun, resolveSession, running } from "../../src/sessions/sessions";
import { sessionGet, sessionMetaSet, sessionTouch } from "../../src/storage/hostdb";
import { handlers } from "../../src/protocol/handlers/sessions";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-im-origin-"));
const imDir = path.join(tmp, "im-work");
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

beforeAll(() => {
  mkdirSync(imDir, { recursive: true });
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  process.env.PI_IDENTITY_DIR = path.join(tmp, "identity");
});

afterAll(() => {
  running.clear();
  if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
  else process.env.PI_IDENTITY_DIR = prevIdentityDir;
});

describe("IM 会话来源标", () => {
  test("im: 线程新建会话时落 kind='im'", async () => {
    const run = await resolveSession("im:new:wecom:channel:chat", undefined, imDir);
    const row = await sessionGet(run.sessionId);
    expect(row?.kind).toBe("im");
    expect(row?.cwd).toBe(imDir);
  });

  test("普通线程保持空 kind", async () => {
    const run = await resolveSession("plain-origin-thread");
    const row = await sessionGet(run.sessionId);
    expect(row?.kind ?? "").toBe("");
  });

  test("IM 恢复空 kind 的旧会话时自愈补标", async () => {
    const run = await resolveSession("old-origin-thread");
    await sessionMetaSet(run.sessionId, { kind: "", parentSession: "" });
    dropRun(run.threadId);

    const reborn = await resolveSession(`im:${run.sessionId}`, run.sessionId);
    const row = await sessionGet(reborn.sessionId);
    expect(row?.kind).toBe("im");
  });

  test("list_sessions 投影 origin:'im'（侧栏可见性的事实源）", async () => {
    const run = await resolveSession("im:list-origin-thread", undefined, imDir);
    // list_sessions 只投影 messageCount>0 的会话：补一条消息计数再断言
    await sessionTouch(run.sessionId, "你好", "你好", 1);
    const lines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (
      c: unknown,
    ) => {
      lines.push(String(c));
      return true;
    };
    try {
      await handlers.list_sessions!("req-list-origin", {});
    } finally {
      (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
        origWrite as unknown as (c: unknown) => boolean;
    }
    const frame = lines
      .map((line) => {
        try {
          return JSON.parse(line) as {
            type?: string;
            sessions?: Array<{ sessionId: string; origin?: string; cwd: string }>;
          };
        } catch {
          return null;
        }
      })
      .find((f) => f?.type === "sessions");
    const item = frame?.sessions?.find((s) => s.sessionId === run.sessionId);
    expect(item?.origin).toBe("im");
    expect(item?.cwd).toBe(imDir);
  });
});
