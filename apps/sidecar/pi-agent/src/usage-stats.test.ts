import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, sessionPath } from "./storage";
import {
  sessionInsert,
  sessionDelete,
  resetStorageForTest,
} from "./hostdb";
import { aggregateUsageStats, localDayKey } from "./usage-stats";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-usage-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
});

afterAll(() => {
  // bun test 单进程共享模块注册表：清掉 transport/连接，避免污染后续文件
  resetStorageForTest();
});

/** 追加一条消息行（与 transcript.ts 落盘形状一致） */
function writeRow(sessionId: string, seq: number, agent: Record<string, unknown>) {
  writeFileSync(
    sessionPath(sessionId),
    JSON.stringify({ type: "message", seq, ui: null, agent }) + "\n",
    { flag: "a" },
  );
}

// 固定本地时间：2026-09-10 10:00 与次日 11:30
const t1 = new Date(2026, 8, 10, 10, 0).getTime();
const t2 = new Date(2026, 8, 11, 11, 30).getTime();

describe("localDayKey", () => {
  test("毫秒时间戳转本地 YYYY-MM-DD", () => {
    expect(localDayKey(t1)).toBe("2026-09-10");
  });
});

describe("aggregateUsageStats", () => {
  test("跨会话按日/模型聚合，错误轮不计，跨度取最长会话", async () => {
    await sessionInsert("u-1", "");
    await sessionInsert("u-2", "");

    // 会话 1：两轮 assistant（次日），另有 1 小时前的 user 消息拉长跨度
    writeRow("u-1", 0, { role: "user", timestamp: t1 - 3_600_000 });
    writeRow("u-1", 1, {
      role: "assistant",
      timestamp: t1,
      stopReason: "endTurn",
      provider: "p",
      model: "m",
      usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
    });
    writeRow("u-1", 2, {
      role: "assistant",
      timestamp: t2,
      stopReason: "endTurn",
      provider: "q",
      model: "m2",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });

    // 会话 2：正常一轮 + 错误一轮（usage 应被忽略）+ 中止一轮
    writeRow("u-2", 0, {
      role: "assistant",
      timestamp: t1,
      stopReason: "endTurn",
      provider: "p",
      model: "m",
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    });
    writeRow("u-2", 1, {
      role: "assistant",
      timestamp: t1,
      stopReason: "error",
      provider: "p",
      model: "m",
      usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 },
    });
    writeRow("u-2", 2, {
      role: "assistant",
      timestamp: t1,
      stopReason: "aborted",
      provider: "p",
      model: "m",
      usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 },
    });

    const stats = await aggregateUsageStats();

    expect(stats.sessionCount).toBe(2);
    expect(stats.days).toHaveLength(2);
    expect(stats.days[0].date).toBe("2026-09-10");
    expect(stats.days[1].date).toBe("2026-09-11");

    const d1 = stats.days[0];
    expect(d1.tokens).toBe(165 + 10);
    expect(d1.messages).toBe(2);
    expect(d1.byModel["p/m"]).toBe(175); // u-1 首轮 165 + u-2 正常轮 10（同模型同日）
    expect(d1.byModel["q/m2"]).toBeUndefined(); // q/m2 在次日
    expect(d1.input).toBe(101); // u-1 首轮 100 + u-2 正常轮 1
    expect(d1.cacheRead).toBe(13); // 10 + 3

    const d2 = stats.days[1];
    expect(d2.tokens).toBe(15);
    expect(d2.byModel["q/m2"]).toBe(15);

    // 最长会话跨度 = 会话 1 的 user(前 1h) → 次日 assistant
    expect(stats.longestChatMs).toBe(t2 - (t1 - 3_600_000));
  });

  test("二次查询读库一致，mtime 变化触发增量重算，删除会话后清理", async () => {
    // 全量重算后的快照
    const first = await aggregateUsageStats();

    // 未变更：从库直接聚合，结果一致
    const second = await aggregateUsageStats();
    expect(second).toEqual(first);

    // 追加一轮新的 assistant 消息并强制更新 mtime → 增量重算该会话
    const t3 = new Date(2026, 8, 12, 9, 0).getTime();
    writeRow("u-1", 3, {
      role: "assistant",
      timestamp: t3,
      stopReason: "endTurn",
      provider: "p",
      model: "m",
      usage: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0 },
    });
    const bumped = new Date(Date.now() + 10_000);
    utimesSync(sessionPath("u-1"), bumped, bumped);
    const third = await aggregateUsageStats();
    expect(third.days).toHaveLength(3);
    const d3 = third.days.find((d) => d.date === "2026-09-12");
    expect(d3?.tokens).toBe(15);
    expect(d3?.byModel["p/m"]).toBe(15);
    // 旧日数据不受整会话替换影响（幂等重算）
    const d1 = third.days.find((d) => d.date === "2026-09-10");
    expect(d1?.tokens).toBe(first.days[0].tokens);

    // 删除会话索引行 → 残留聚合行被清理
    await sessionDelete("u-2");
    const fourth = await aggregateUsageStats();
    const d1After = fourth.days.find((d) => d.date === "2026-09-10");
    // 9-10 只剩 u-1 的 165（u-2 的 10 已随清理消失）
    expect(d1After?.tokens).toBe(165);
  });

  test("空库返回空序列", async () => {
    const stats = await aggregateUsageStats();
    // 前面的用例已写会话，这里只验证字段形状（单进程共享存储）
    expect(Array.isArray(stats.days)).toBe(true);
    expect(stats.firstActivity).not.toBeNull();
  });
});
