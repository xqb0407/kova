/**
 * 本地测试（非 vendored）：协议 automation_* 命令全链路（dispatch → commands
 * → 真调度器/临时 store）。覆盖：建/改/删/开关/立即运行/预览、错误经
 * handleLine 语义（这里直接断言 dispatch 的 rejection 文案）、run_now 触发的
 * 自发帧对（automation_fired + automation_run_done）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { initStorage } from "../storage";
import { dispatch } from "../protocol";
import { initAutomation, stopAutomation } from "./runtime";
import { registerAutomationThread, unregisterAutomationThread } from "./policy";
import { buildSchedulerTools } from "./mgmt-tools";
import type { ScheduledTask } from "./index";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-automation-cmds-"));

/** 捕获协议流（send 写 process.stdout） */
const lines: string[] = [];
let origWrite: typeof process.stdout.write;
const last = (): Record<string, unknown> => JSON.parse(lines[lines.length - 1]);
const frameOfType = (t: string) =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((o) => o.type === t);

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

let probeSeq = 0;
const tasks = async (): Promise<ScheduledTask[]> => {
  await dispatch(`a-probe-${probeSeq++}`, { type: "automation_list" });
  return last().tasks as ScheduledTask[];
};

describe("automation_* 命令", () => {
  it("save 新建：默认档位/来源/排期换算，清单回全量", async () => {
    await dispatch("a-save1", {
      type: "automation_save",
      task: { prompt: "汇总今天的日报", type: "interval", schedule: "1h", name: "日报" },
    });
    expect(last()).toMatchObject({ id: "a-save1", type: "automation_list" });
    const [t] = await tasks();
    expect(t).toMatchObject({
      name: "日报",
      prompt: "汇总今天的日报",
      type: "interval",
      intervalSeconds: 3600,
      enabled: true,
      sessionId: "automation-manual",
      toolPolicyProfile: "read-only",
      model: { provider: "", model: "" },
    });
    expect(new Date(t.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("save 带 id 全量覆盖；未知 id 报错；空 prompt 报错", async () => {
    const id = (await tasks())[0].id;
    await dispatch("a-save2", {
      type: "automation_save",
      task: {
        id,
        prompt: "改后的提示词",
        name: "新名字",
        type: "cron",
        schedule: "0 9 * * 1-5",
        toolPolicyProfile: "workspace-write",
        enabled: false,
      },
    });
    const [t] = await tasks();
    expect(t).toMatchObject({
      prompt: "改后的提示词",
      name: "新名字",
      type: "cron",
      schedule: "0 9 * * 1-5",
      toolPolicyProfile: "workspace-write",
      enabled: false,
    });
    expect(t.nextRunAt).toBeUndefined(); // 停用任务不排下次
    await expect(
      dispatch("a-save3", {
        type: "automation_save",
        task: { id: "nope", prompt: "x", type: "interval", schedule: "5m" },
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      dispatch("a-save4", { type: "automation_save", task: { type: "interval", schedule: "5m" } }),
    ).rejects.toThrow(/prompt is required/);
  });

  it("set_enabled 开关；未知 id 报错", async () => {
    const id = (await tasks())[0].id;
    await dispatch("a-en1", { type: "automation_set_enabled", taskId: id, enabled: true });
    expect((await tasks())[0]).toMatchObject({ enabled: true });
    expect(new Date((await tasks())[0].nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    await expect(
      dispatch("a-en2", { type: "automation_set_enabled", taskId: "ghost", enabled: true }),
    ).rejects.toThrow(/not found/);
  });

  it("preview：合法回 runs，非法回 error（排期类型走 scheduleType 字段）", async () => {
    await dispatch("a-prev1", {
      type: "automation_preview",
      scheduleType: "cron",
      schedule: "* * * * *",
      count: 2,
    });
    expect(last()).toMatchObject({ id: "a-prev1", type: "automation_preview" });
    expect(last().runs as string[]).toHaveLength(2);
    await dispatch("a-prev2", {
      type: "automation_preview",
      scheduleType: "cron",
      schedule: "nope",
    });
    expect(last().error as string).toBeTruthy();
  });

  it("run_now：触发 runner 且自发帧对完整", async () => {
    const id = (await tasks())[0].id;
    lines.length = 0;
    await dispatch("a-run1", { type: "automation_run_now", taskId: id });
    expect(last()).toMatchObject({ id: "a-run1", type: "automation_list" });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !runnerCalls.includes(id)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(runnerCalls).toContain(id);
    expect(frameOfType("automation_fired")).toMatchObject({ taskId: id, taskName: "新名字" });
    const done = frameOfType("automation_run_done");
    expect(done).toMatchObject({ taskId: id, ok: true });
    expect(done?.sessionId ?? "").toBe(""); // stub runner 不建会话：无真实 sessionId
  });

  it("history_delete：单条剔除其余保留、all 清空、未知 id/缺参报错", async () => {
    const withHistory = (await tasks()).find((t) => (t.runHistory?.length ?? 0) > 0);
    expect(withHistory).toBeDefined();
    const id = withHistory!.id;
    const before = withHistory!.runHistory!;

    // 删最早一条：其余保留
    const victim = before[0];
    await dispatch("a-hd1", {
      type: "automation_history_delete",
      taskId: id,
      entryIds: [victim.id],
    });
    let after = (await tasks()).find((t) => t.id === id)!.runHistory!;
    expect(after.some((e) => e.id === victim.id)).toBe(false);
    expect(after.length).toBe(before.length - 1);

    // all:true 清空
    await dispatch("a-hd2", { type: "automation_history_delete", taskId: id, all: true });
    after = (await tasks()).find((t) => t.id === id)!.runHistory!;
    expect(after).toHaveLength(0);

    await expect(
      dispatch("a-hd3", { type: "automation_history_delete", taskId: "ghost", all: true }),
    ).rejects.toThrow(/not found/);
    await expect(
      dispatch("a-hd4", { type: "automation_history_delete", taskId: id }),
    ).rejects.toThrow(/entryIds or all=true is required/);
    await expect(dispatch("a-hd5", { type: "automation_history_delete" })).rejects.toThrow(
      /taskId is required/,
    );
  });

  it("delete 后清单为空；未知 id 报错", async () => {
    const id = (await tasks())[0].id;
    await dispatch("a-del1", { type: "automation_delete", taskId: id });
    expect(await tasks()).toHaveLength(0);
    await expect(dispatch("a-del2", { type: "automation_delete", taskId: id })).rejects.toThrow(
      /not found/,
    );
    await expect(dispatch("a-del3", { type: "automation_delete" })).rejects.toThrow(
      /taskId is required/,
    );
  });
});

describe("scheduler LLM 工具挂载（mgmt-tools）", () => {
  const fakeRun = (threadId: string) =>
    ({
      threadId,
      sessionId: "s-fake",
      agent: { state: { model: { provider: "anthropic", id: "claude-test" } } },
    }) as never;

  it("普通会话挂 6 件套；无人值守 run 不挂", () => {
    const tools = buildSchedulerTools(fakeRun("th-user"));
    expect(tools.map((t) => t.name)).toEqual([
      "scheduler_create",
      "scheduler_list",
      "scheduler_get",
      "scheduler_update",
      "scheduler_delete",
      "scheduler_run_now",
    ]);
    registerAutomationThread("automation:t:r", "read-only");
    try {
      expect(buildSchedulerTools(fakeRun("automation:t:r"))).toEqual([]);
    } finally {
      unregisterAutomationThread("automation:t:r");
    }
  });
});
