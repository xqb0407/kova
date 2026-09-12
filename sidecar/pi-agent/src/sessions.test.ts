/**
 * 迭代2（P2）会话驻留治理单测：
 * - 只读投影与 live run 读数逐字段等价
 * - context_info 不再物化未加载会话（不写 running）
 * - LRU 上限软驱逐；活跃 turn 豁免；驱逐后可恢复
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "./storage";
import { dispatch } from "./protocol";
import { contextInfo } from "./context";
import {
  MAX_RESIDENT_SESSIONS,
  noteActiveTurn,
  projectContextInfo,
  resolveSession,
  running,
  touchSession,
} from "./sessions";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-sessions-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
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

const last = (): Record<string, unknown> =>
  JSON.parse(lines[lines.length - 1]);

describe("sessions：只读投影", () => {
  test("projectContextInfo 与 live run 的 contextInfo 逐字段一致", async () => {
    const run = await resolveSession("prj-1", undefined, tmp);
    const live = contextInfo(run);
    const proj = await projectContextInfo("prj-1", run.sessionId);
    expect(proj).toEqual(live);
  });

  test("投影不写 running（context_info 不再造成驻留）", async () => {
    const run = await resolveSession("prj-2", undefined, tmp);
    const sessionId = run.sessionId;
    running.delete("prj-2"); // 模拟被驱逐/未加载
    await projectContextInfo("prj-2", sessionId);
    expect(running.has("prj-2")).toBe(false);
  });

  test("协议层：未驻留会话的 context_info 走投影且不留实例", async () => {
    await dispatch("g1", { type: "new_session", threadId: "gate-1", cwd: tmp });
    const sessionId = last().sessionId as string;
    running.delete("gate-1");
    await dispatch("g2", { type: "context_info", threadId: "gate-1", sessionId });
    const res = last();
    expect(res.type).toBe("context_info");
    expect(res.messageCount).toBe(0);
    expect((res.usage as { input: number }).input).toBe(0);
    expect(running.has("gate-1")).toBe(false);
  });

  test("投影对不存在的会话报 session not found", async () => {
    await expect(
      projectContextInfo("prj-404", "no-such-session"),
    ).rejects.toThrow("session not found");
  });
});

describe("sessions：LRU 驻留上限", () => {
  test("连续 resolve 超过上限 ⇒ 常驻数收敛到 MAX", async () => {
    for (let i = 0; i < MAX_RESIDENT_SESSIONS + 2; i++) {
      await resolveSession(`lru-${i}`, undefined, tmp);
      // 每轮之后全局不变量：驻留 ≤ 上限（本环境无活跃 turn/审批挂起，全可驱逐）
      expect(running.size).toBeLessThanOrEqual(MAX_RESIDENT_SESSIONS);
    }
    // 刚 resolve 的必须还在
    expect(running.has(`lru-${MAX_RESIDENT_SESSIONS + 1}`)).toBe(true);
  });

  test("活跃 turn 的会话豁免驱逐", async () => {
    const busy = await resolveSession("busy-1", undefined, tmp);
    noteActiveTurn("busy-1");
    try {
      for (let i = 0; i < MAX_RESIDENT_SESSIONS + 4; i++) {
        await resolveSession(`flood-${i}`, undefined, tmp);
      }
      expect(running.has("busy-1")).toBe(true);
      expect(running.get("busy-1")).toBe(busy);
    } finally {
      noteActiveTurn(null);
    }
  });

  test("touchSession 续龄（LRU 排序依据）", async () => {
    const run = await resolveSession("lru-touch", undefined, tmp);
    run.lastSeenAt = 1;
    touchSession("lru-touch");
    expect(run.lastSeenAt).toBeGreaterThan(1);
  });

  test("被驱逐会话经 resolveSession(sessionId) 完整恢复", async () => {
    const run = await resolveSession("lru-restore", undefined, tmp);
    const sessionId = run.sessionId;
    running.delete("lru-restore"); // 模拟驱逐
    const restored = await resolveSession("lru-restore", sessionId, tmp);
    expect(restored.sessionId).toBe(sessionId);
    expect(running.has("lru-restore")).toBe(true);
    expect(restored.agent.state.messages.length).toBe(0);
  });
});
