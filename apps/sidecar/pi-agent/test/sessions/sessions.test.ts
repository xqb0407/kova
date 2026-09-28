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
import { initStorage } from "../../src/storage/storage";
import { dispatch } from "../../src/protocol/protocol";
import { contextInfo } from "../../src/agent/context";
import {
  dropRun,
  findRunBySession,
  MAX_RESIDENT_SESSIONS,
  noteActiveTurn,
  projectContextInfo,
  resolveSession,
  running,
  touchSession,
  trackSessionRun,
  whenThreadIdle,
} from "../../src/sessions/sessions";
import { getTodoState, replayTodoFromMessages } from "../../src/todo/todo";
import { TODO_TOOL_NAME } from "../../src/todo/todo-state";
import { isPromptActive, setActiveReqId } from "../../src/protocol/stream";
import type { Running } from "../../src/types";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-sessions-"));
// new_session 会合成提示词并实时读身份文件：钉到空目录，避免触碰开发者真实 ~/.kova/
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
    noteActiveTurn("busy-1", true);
    try {
      for (let i = 0; i < MAX_RESIDENT_SESSIONS + 4; i++) {
        await resolveSession(`flood-${i}`, undefined, tmp);
      }
      expect(running.has("busy-1")).toBe(true);
      expect(running.get("busy-1")).toBe(busy);
    } finally {
      noteActiveTurn("busy-1", false);
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

describe("sessions：刷新后 thread id 漂移（sessionId 反查索引）", () => {
  test("resolveSession 按 sessionId 找回驻留 run 并改绑新键，不物化第二个 Agent", async () => {
    const run = await resolveSession("drift-draft", undefined, tmp);
    const sid = run.sessionId;
    // 模拟刷新后：列表行 id 即 sessionId，审批结算等请求带的是新键。
    // 静默 run 直接改绑到新键（旧键摘除，全程仍只有一个驻留键）
    const again = await resolveSession(sid, sid, tmp);
    expect(again).toBe(run);
    expect(run.threadId).toBe(sid);
    expect(running.get(sid)).toBe(run);
    expect(running.has("drift-draft")).toBe(false);
    expect(findRunBySession(sid)?.threadId).toBe(sid);
    dropRun(sid);
  });

  test("findRunBySession 命中与陈旧索引自愈", () => {
    expect(findRunBySession("no-such-session")).toBeUndefined();
    const fake = { sessionId: "sess-x" } as unknown as Running;
    running.set("th-x", fake);
    trackSessionRun("sess-x", "th-x");
    expect(findRunBySession("sess-x")?.threadId).toBe("th-x");
    running.delete("th-x"); // 绕过 dropRun 的外部删除
    expect(findRunBySession("sess-x")).toBeUndefined();
    expect(findRunBySession("sess-x")).toBeUndefined(); // 索引已被一并清除
  });

  test("dropRun 同步清除反查索引", async () => {
    const run = await resolveSession("drop-1", undefined, tmp);
    const sid = run.sessionId;
    expect(findRunBySession(sid)?.threadId).toBe("drop-1");
    dropRun("drop-1");
    expect(findRunBySession(sid)).toBeUndefined();
  });

  test("abort 用行 id（=sessionId）也命中草稿键下驻留的 run", async () => {
    const run = await resolveSession("abort-draft", undefined, tmp);
    const sid = run.sessionId;
    await dispatch("ab-1", { type: "abort", threadId: sid });
    expect(run.stopRequested).toBe(true);
    dropRun("abort-draft");
  });
});

describe("sessions：刷新改绑（rebindRunThread）", () => {
  test("旧线程有活跃 turn ⇒ 跳过改绑；轮次收尾后再 resolve 即完成改绑", async () => {
    const run = await resolveSession("rb-busy", undefined, tmp);
    const sid = run.sessionId;
    noteActiveTurn("rb-busy", true, sid, "req-rb");
    try {
      const again = await resolveSession(sid, sid, tmp);
      expect(again).toBe(run);
      // 旧轮未收尾：键不动（改绑会把旧轮事件错路由进新请求）
      expect(run.threadId).toBe("rb-busy");
      expect(running.has("rb-busy")).toBe(true);
      expect(running.has(sid)).toBe(false);
    } finally {
      noteActiveTurn("rb-busy", false);
    }
    await resolveSession(sid, sid, tmp);
    expect(run.threadId).toBe(sid);
    expect(running.has("rb-busy")).toBe(false);
    dropRun(sid);
  });

  test("whenThreadIdle：活跃时挂起，noteActiveTurn(false) 唤醒；空闲立即 resolve", async () => {
    noteActiveTurn("rb-idle", true, "sess-idle");
    let resolved = false;
    const pending = whenThreadIdle("rb-idle").then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    noteActiveTurn("rb-idle", false);
    await pending;
    expect(resolved).toBe(true);
    await whenThreadIdle("rb-idle"); // 已空闲：不挂起
  });

  test("改绑迁移 todo 槽位：清单挂到新键、旧键清空", async () => {
    const run = await resolveSession("rb-todo", undefined, tmp);
    const sid = run.sessionId;
    replayTodoFromMessages("rb-todo", [
      {
        role: "toolResult",
        toolName: TODO_TOOL_NAME,
        details: {
          tasks: [{ id: 1, subject: "t", status: "pending" }],
          nextId: 2,
        },
      },
    ]);
    expect(getTodoState("rb-todo").tasks.length).toBe(1);
    await resolveSession(sid, sid, tmp);
    expect(getTodoState(sid).tasks.length).toBe(1);
    expect(getTodoState("rb-todo").tasks.length).toBe(0);
    dropRun(sid);
  });

  test("改绑后工具闭包与 run.threadId 同键（sendEventChunk 路由不再落空）", async () => {
    const run = await resolveSession("rb-tools", undefined, tmp);
    const sid = run.sessionId;
    await resolveSession(sid, sid, tmp);
    expect(run.threadId).toBe(sid);
    // question/todo 工具按 threadId 归属：重建后挂起/推送都走新键
    const names = run.baseTools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    // 新键登记活跃请求 + 旧键查无残留路由
    setActiveReqId(sid, "req-rb-tools");
    try {
      expect(isPromptActive(sid)).toBe(true);
      expect(isPromptActive("rb-tools")).toBe(false);
    } finally {
      setActiveReqId(sid, null);
    }
    dropRun(sid);
  });
});
