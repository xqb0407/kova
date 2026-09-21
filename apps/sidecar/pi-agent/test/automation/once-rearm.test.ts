/**
 * 本地测试（非 vendored）：M4.4 过期 once 重新启用 → 排期改写到"马上"。
 * 直接驱动 scheduler.update（绕过表单保存路径"过去时刻直接拒绝"的校验），
 * 覆盖开关拨回/run_now 自动启用的同一入口。
 *
 * 注意：不启动调度器、不断言定时器实跑——PersistentTaskScheduler.start()
 * 的 FileSchedulerLock 进程级只有一份 active 槽位，bun test 按文件并发跑，
 * commands/catchup 测试会占掉它（catchup.test 同样因此不 start、改测纯函数）。
 * 改写后的近未来时刻最终由上游自家 once 定时器路径消费（schedule() 的
 * delayMs>0 分支），实跑语义另有 commands.test run_now 与线上验证兜底。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { initStorage } from "../../src/storage/storage";
import { dispatch } from "../../src/protocol/protocol";
import { getAutomationScheduler, initAutomation, stopAutomation } from "../../src/automation/runtime";
import type { ScheduledTask } from "../../src/automation/index";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-automation-rearm-"));

/** 捕获协议流（send 写 process.stdout），沿用 commands.test 的桩 */
const lines: string[] = [];
let origWrite: typeof process.stdout.write;
const last = (): Record<string, unknown> => JSON.parse(lines[lines.length - 1]);

const runnerCalls: string[] = [];

beforeAll(async () => {
  initStorage(join(tmp, "state.db"), join(tmp, "sessions"));
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
    lines.push(String(c));
    return true;
  };
  await initAutomation(join(tmp, "sessions"), async (task) => {
    runnerCalls.push(task.id);
  });
});

afterAll(async () => {
  await stopAutomation();
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
    origWrite as unknown as (c: unknown) => boolean;
});

describe("过期 once 重新启用（M4.4）", () => {
  it("改写到马上、只落 resumed 不落假失败", async () => {
    await dispatch("r-save1", {
      type: "automation_save",
      task: {
        prompt: "重跑测试",
        type: "once",
        schedule: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        name: "一次性重跑",
        enabled: false,
      },
    });
    expect(last()).toMatchObject({ id: "r-save1", type: "automation_list" });
    const created = (last().tasks as ScheduledTask[]).find(
      (t) => t.name === "一次性重跑",
    );
    expect(created).toBeTruthy();
    // 未 start（active=false）：update 落库但不武装定时器，断言全程确定性
    const scheduler = getAutomationScheduler();
    expect(scheduler).toBeTruthy();

    // 停用态先把时刻改到过去：guard 要求 enabled=true 才生效，原样落库
    const past = new Date(Date.now() - 60_000).toISOString();
    const moved = await scheduler!.update(created!.id, { schedule: past });
    expect(moved?.schedule).toBe(past);

    // 重新启用：过期时刻被改写为"马上"，历史只有 resumed、没有过去时刻假失败
    const t0 = Date.now();
    const reEnabled = await scheduler!.update(created!.id, { enabled: true });
    expect(reEnabled).toBeTruthy();
    const armed = new Date(reEnabled!.schedule).getTime();
    expect(armed).toBeGreaterThan(t0);
    expect(armed).toBeLessThanOrEqual(t0 + 5_000);
    const history = reEnabled!.runHistory ?? [];
    expect(history[history.length - 1]?.status).toBe("resumed");
    expect(
      history.some(
        (h) => h.status === "error" && String(h.message).includes("in the past"),
      ),
    ).toBe(false);
  });
});
