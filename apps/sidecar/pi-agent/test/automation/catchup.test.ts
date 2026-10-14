/**
 * 本地测试（非 vendored）：启动补跑（M2.3 本地扩展）。
 * - 纯函数：错过判定（lastFired vs 排期）/once 修复选择的边界
 * - e2e：错过的 cron 经 runNow 补跑一次、过期 once 被 re-arm 后
 *   经自家定时器跑掉并自动停用
 *
 * 关键约束（曾因忽略而设计错误）：nextRunAt 不能作为错过证据 ——
 * normalizeScheduledTask 在 store 每次读写都把它重算到未来，测试若经
 * store 播种"过期 nextRunAt"会立刻被抹平。错过判定只用活得过 normalize
 * 的字段：runHistory 最新条 / lastRunAt / createdAt。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  JsonScheduledTaskStore,
  type ScheduledTask,
} from "../../src/automation/index";
import { missedTaskIds, onceTasksToPurge, repairMissedOnce } from "../../src/automation/runtime";

const HOUR = 3_600_000;

function task(over: Partial<ScheduledTask> & Pick<ScheduledTask, "id" | "type">): ScheduledTask {
  const now = new Date().toISOString();
  return {
    sessionId: "seed",
    prompt: "p",
    schedule: "",
    intervalSeconds: 60,
    enabled: true,
    model: { provider: "", model: "" },
    toolPolicyProfile: "read-only",
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    ...over,
  };
}

/** 以 runHistory 最新条表达"上次触发时刻"（execute 成败都会留条目） */
function firedAt(iso: string): Pick<ScheduledTask, "runHistory"> {
  return { runHistory: [{ id: "h-" + iso, status: "success", createdAt: iso }] };
}

describe("missedTaskIds", () => {
  // 每 5 分钟 / 每日 03:00 表达式在整点偏移时区下按分钟对齐，判定与本地时区无关
  const now = Date.UTC(2026, 8, 15, 12);

  it("按 lastFired vs 排期收错过项，按错过时刻升序、封顶 5", () => {
    const snapshot = [
      // */5 每 5 分钟：上次触发(now-60m) 之后的格子 now-55m 已过 → 错过
      task({ id: "cron-55", type: "cron", schedule: "*/5 * * * *", ...firedAt(new Date(now - HOUR).toISOString()) }),
      // 上次触发 10 分钟前 → 下一格 now-5m 已过 → 错过（比 cron-55 新）
      task({ id: "cron-10", type: "cron", schedule: "*/5 * * * *", ...firedAt(new Date(now - 10 * 60_000).toISOString()) }),
      // 刚跑过（now）→ 下一格在未来 → 不补
      task({ id: "cron-fresh", type: "cron", schedule: "*/5 * * * *", ...firedAt(new Date(now).toISOString()) }),
      // 从未跑过的新任务：lastFired 落到 createdAt=now → 不补
      task({ id: "cron-new", type: "cron", schedule: "0 3 * * *", createdAt: new Date(now).toISOString() }),
      // interval：上次触发(now-200m) + 周期 60s 早已过去 → 错过（due=now-199m 最陈旧）
      task({ id: "interval-past", type: "interval", intervalSeconds: 60, ...firedAt(new Date(now - 200 * 60_000).toISOString()) }),
      // interval：上次触发 30s 前、周期 60s → 未到格 → 不补
      task({ id: "interval-ok", type: "interval", intervalSeconds: 60, ...firedAt(new Date(now - 30_000).toISOString()) }),
      // 排除项：once / disabled / 非法表达式
      task({ id: "once-past", type: "once", schedule: new Date(now - HOUR).toISOString() }),
      task({ id: "cron-disabled", type: "cron", schedule: "*/5 * * * *", enabled: false, ...firedAt(new Date(now - 2 * HOUR).toISOString()) }),
      task({ id: "cron-bogus", type: "cron", schedule: "not a cron", ...firedAt(new Date(now - 2 * HOUR).toISOString()) }),
    ];
    expect(missedTaskIds(snapshot, now)).toEqual(["interval-past", "cron-55", "cron-10"]);

    // 超上限截断：错过最久的先补，其余留到下次启动
    const many = Array.from({ length: 8 }, (_, i) =>
      task({
        id: `c${i}`,
        type: "interval",
        intervalSeconds: 60,
        ...firedAt(new Date(now - (i + 1) * HOUR).toISOString()),
      }),
    );
    expect(missedTaskIds(many, now)).toEqual(["c7", "c6", "c5", "c4", "c3"]);
  });
});

describe("repairMissedOnce + 补跑 e2e", () => {
  it("错过的 cron 补跑一次；过期 once re-arm 后跑掉并停用", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "catchup-e2e-"));
    const store = new JsonScheduledTaskStore(join(sessionsDir, "automation", "tasks.json"));
    const now = Date.now();
    await store.create(
      task({
        id: "missed-cron",
        type: "cron",
        schedule: "0 3 * * *", // 每日 03:00：上次触发 25h 前 → 必有一格已过，下一格在测试窗口外
        ...firedAt(new Date(now - 25 * HOUR).toISOString()),
      }),
    );
    await store.create(
      task({
        id: "missed-once",
        type: "once",
        schedule: new Date(now - 2 * HOUR).toISOString(),
      }),
    );

    // 直接驱动 vendored 调度器（initAutomation 单例留给真进程；
    // 与 initAutomation 等价的错过处理序列在下方手工复用导出的判定/修复）
    const { PersistentTaskScheduler } = await import("../../src/automation/index");
    const { FileSchedulerLock } = await import("../../src/automation/stores");
    const calls = new Map<string, number>();
    const scheduler = new PersistentTaskScheduler({
      store,
      lock: new FileSchedulerLock(join(sessionsDir, "automation", "scheduler.lock")),
      runner: async (t) => {
        calls.set(t.id, (calls.get(t.id) ?? 0) + 1);
      },
      scope: {},
    });
    const preStart = await scheduler.list();
    await repairMissedOnce(scheduler, preStart, now);
    const missed = missedTaskIds(preStart, now);
    await scheduler.start();
    expect(missed).toEqual(["missed-cron"]);
    for (const id of missed) await scheduler.runNow(id);

    // once re-arm 到 ~250ms 后自家触发；轮询到两个任务都有结算
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (calls.get("missed-cron") ?? 0) + (calls.get("missed-once") ?? 0) < 2) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(calls.get("missed-cron")).toBe(1);
    expect(calls.get("missed-once")).toBe(1);

    const cron = await scheduler.get("missed-cron");
    expect(cron?.lastStatus).toBe("success");
    expect(cron?.runCount).toBe(1);
    expect(new Date(cron!.nextRunAt!).getTime()).toBeGreaterThan(Date.now()); // 排到未来
    // 补跑结算后 lastFired 刷新 → 快照重算不再判为错过（不会连环补）
    expect(missedTaskIds([cron!], Date.now())).toEqual([]);

    const once = await scheduler.get("missed-once");
    expect(once?.enabled).toBe(false); // 成功后 once 自动停用
    expect(once?.lastStatus).toBe("success");
    // 无假失败：re-arm 路径不该留下 markScheduleError 的痕迹
    expect((once?.lastError ?? "")).not.toContain("in the past");
    expect((once?.runHistory ?? []).some((h) => h.message?.includes("in the past"))).toBe(false);

    await scheduler.stop();
  }, 15_000);
});

describe("once 死任务 GC（M4.2）", () => {
  const DAY = 24 * HOUR;
  const NOW = Date.UTC(2026, 8, 15, 12);
  const doneAt = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it("删除超保留期的已完成 once；近期完成/从未跑过/仍启用/非 once 全保留", () => {
    const snapshot = [
      task({ id: "once-31d", type: "once", enabled: false, lastRunAt: doneAt(31 * DAY) }),
      task({ id: "once-29d", type: "once", enabled: false, lastRunAt: doneAt(29 * DAY) }),
      // 创建后未启用/未跑过：没有 lastRunAt，不动（用户的显式意图）
      task({ id: "once-never", type: "once", enabled: false }),
      // 仍在排的 once（哪怕曾经跑过）不归 GC 管
      task({ id: "once-live", type: "once", enabled: true, lastRunAt: doneAt(90 * DAY) }),
      task({ id: "cron-old", type: "cron", schedule: "0 3 * * *", enabled: false, lastRunAt: doneAt(90 * DAY) }),
    ];
    expect(onceTasksToPurge(snapshot, NOW)).toEqual(["once-31d"]);
  });

  it("保留期可注入（默认 30 天）", () => {
    const t = task({ id: "x", type: "once", enabled: false, lastRunAt: doneAt(5 * DAY) });
    expect(onceTasksToPurge([t], NOW)).toEqual([]);
    expect(onceTasksToPurge([t], NOW, 3 * DAY)).toEqual(["x"]);
  });
});
