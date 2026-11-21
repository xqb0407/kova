// 回归：L1 runWithContext 的触发上下文必须在异步写盘之前取走（真实 JSON
// store 每步都走 fs I/O）；同步占位保证并发触发不会双跑同一任务。
import { describe, expect, test } from "bun:test";
import {
  matchesScheduledTaskScope,
  PersistentTaskScheduler,
  type ScheduledTask,
  type ScheduledTaskStore,
  type SchedulerLock,
  type ScheduledTaskRunContext,
  type TaskSchedulerScope,
} from "../../src/automation/index";

const model = { provider: "test", model: "test-model" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class SlowStore implements ScheduledTaskStore {
  readonly tasks = new Map<string, ScheduledTask>();
  constructor(private readonly delayMs: number) {}
  async list(scope: TaskSchedulerScope = {}): Promise<ScheduledTask[]> {
    await sleep(this.delayMs);
    return [...this.tasks.values()].filter((task) => matchesScheduledTaskScope(task, scope));
  }
  async get(taskId: string, scope: TaskSchedulerScope = {}): Promise<ScheduledTask | undefined> {
    await sleep(this.delayMs);
    const task = this.tasks.get(taskId);
    return task && matchesScheduledTaskScope(task, scope) ? task : undefined;
  }
  async create(task: ScheduledTask): Promise<ScheduledTask> {
    this.tasks.set(task.id, task);
    return task;
  }
  async update(
    taskId: string,
    task: ScheduledTask,
    scope: TaskSchedulerScope = {},
  ): Promise<ScheduledTask | undefined> {
    await sleep(this.delayMs);
    if (!(await this.get(taskId, scope))) return undefined;
    this.tasks.set(taskId, task);
    return task;
  }
  async delete(taskId: string, scope: TaskSchedulerScope = {}): Promise<boolean> {
    await sleep(this.delayMs);
    if (!(await this.get(taskId, scope))) return false;
    return this.tasks.delete(taskId);
  }
}

class MemoryLock implements SchedulerLock {
  readonly path = "memory:run-with-context";
  private locked = false;
  acquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }
  release(): void {
    this.locked = false;
  }
  isAcquired(): boolean {
    return this.locked;
  }
  holderPid(): number | undefined {
    return this.locked ? process.pid : undefined;
  }
}

async function waitFor(assertion: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await sleep(10);
  }
  throw new Error("waitFor timed out");
}

async function makeScheduler(runs: ScheduledTaskRunContext[], delayMs: number) {
  const scheduler = new PersistentTaskScheduler({
    store: new SlowStore(delayMs),
    lock: new MemoryLock(),
    runner: async (_task, run) => {
      runs.push(run);
      await sleep(5);
    },
  });
  const task = await scheduler.create({
    sessionId: "scheduled-rwc",
    prompt: "check",
    type: "interval",
    schedule: "1h",
    intervalSeconds: 3600,
    enabled: true,
    model,
    toolPolicyProfile: "scheduled",
  });
  await scheduler.start();
  return { scheduler, task };
}

describe("runWithContext（L1 本地扩展）", () => {
  test("慢 store 下 trigger 仍进 run context（不能被提前清理）", async () => {
    const runs: ScheduledTaskRunContext[] = [];
    const { scheduler, task } = await makeScheduler(runs, 8);
    try {
      await scheduler.runWithContext(task.id, {
        type: "webhook",
        id: "trg-1",
        summary: "push to main",
      });
      await waitFor(() => runs.length >= 1);
      expect(runs[0]?.trigger).toEqual({
        type: "webhook",
        id: "trg-1",
        summary: "push to main",
      });
    } finally {
      await scheduler.stop();
    }
  });

  test("并发触发同一任务：只跑一次（同步占位）", async () => {
    const runs: ScheduledTaskRunContext[] = [];
    const { scheduler, task } = await makeScheduler(runs, 8);
    try {
      await Promise.all([
        scheduler.runWithContext(task.id, { type: "webhook", summary: "a" }),
        scheduler.runWithContext(task.id, { type: "file", summary: "b" }),
      ]);
      await waitFor(() => runs.length >= 1);
      // 给可能的双跑留出窗口
      await sleep(120);
      expect(runs).toHaveLength(1);
    } finally {
      await scheduler.stop();
    }
  });
});
