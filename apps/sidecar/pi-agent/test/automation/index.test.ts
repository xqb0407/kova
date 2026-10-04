// VENDOR: 上游 vitest 测试移植为 bun:test（见本目录 index.ts 溯源头）。
import { describe, expect, it } from 'bun:test';
import {
  matchesScheduledTaskScope,
  PersistentTaskScheduler,
  resolveScheduledTaskDefinition,
  type ScheduledTask,
  type ScheduledTaskStore,
  type SchedulerLock,
  scheduleExpressionForCroner,
  type TaskSchedulerScope,
} from '../../src/automation/index';

const model = { provider: 'test', model: 'test-model' };

describe('task scheduler', () => {
  it('normalizes interval, once, cron, and RRULE schedules', () => {
    expect(resolveScheduledTaskDefinition({ type: 'interval', schedule: '10m' })).toMatchObject({
      type: 'interval',
      schedule: '10m',
      intervalSeconds: 600,
    });
    expect(resolveScheduledTaskDefinition({ type: 'cron', schedule: '0 9 * * *' })).toMatchObject({
      type: 'cron',
      schedule: '0 9 * * *',
      intervalSeconds: 0,
    });
    expect(resolveScheduledTaskDefinition({ type: 'once', schedule: '+5m' }).schedule).toEqual(
      expect.stringMatching(/T.*Z$/),
    );
    expect(scheduleExpressionForCroner('RRULE:FREQ=WEEKLY;BYHOUR=7;BYMINUTE=30;BYDAY=FR')).toBe(
      '30 7 * * 5',
    );
  });

  it('runs tasks through the injected runner and emits lifecycle hooks', async () => {
    const events: string[] = [];
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async (task, run) => {
        events.push(`runner:${task.prompt}:${run.sessionId.startsWith('scheduled-run-')}`);
      },
      hooks: {
        onSchedulerStarted: () => {
          events.push('scheduler:start');
        },
        onTaskStarted: ({ task }) => {
          events.push(`task:start:${task.prompt}`);
        },
        onTaskCompleted: ({ task }) => {
          events.push(`task:done:${task.runCount}`);
        },
      },
    });

    const task = await scheduler.create({
      sessionId: 'scheduled-1',
      prompt: 'check things',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await scheduler.runNow(task.id);
    await waitFor(async () => (await scheduler.get(task.id))?.runCount === 1);
    await scheduler.stop();

    expect(events).toEqual([
      'scheduler:start',
      'task:start:check things',
      'runner:check things:true',
      'task:done:1',
    ]);
    expect((await scheduler.get(task.id))?.lastStatus).toBe('success');
  });

  it('does not run the same task concurrently', async () => {
    let starts = 0;
    let release: (() => void) | undefined;
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async () => {
        starts += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const task = await scheduler.create({
      sessionId: 'scheduled-1',
      prompt: 'slow check',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await scheduler.runNow(task.id);
    await waitFor(() => starts === 1);
    await scheduler.runNow(task.id);
    await delay(20);
    expect(starts).toBe(1);
    release?.();
    await waitFor(async () => (await scheduler.get(task.id))?.runCount === 1);
    await scheduler.stop();
  });

  it('records failed task runs and emits failure hooks', async () => {
    const failures: string[] = [];
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async () => {
        throw new Error('nope');
      },
      hooks: {
        onTaskFailed: ({ error }) => {
          failures.push(error);
        },
      },
    });
    const task = await scheduler.create({
      sessionId: 'scheduled-1',
      prompt: 'bad check',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await scheduler.runNow(task.id);
    await waitFor(async () => (await scheduler.get(task.id))?.lastStatus === 'error');

    const failed = await scheduler.get(task.id);
    expect(failed?.lastError).toBe('nope');
    expect(failed?.runHistory?.at(-1)).toMatchObject({ status: 'error', message: 'nope' });
    expect(failures).toEqual(['nope']);
    await scheduler.stop();
  });

  it('keeps task execution isolated from hook failures', async () => {
    let ran = false;
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async () => {
        ran = true;
      },
      hooks: {
        onTaskStarted: () => {
          throw new Error('hook failed');
        },
        onTaskCompleted: () => {
          throw new Error('hook failed too');
        },
      },
    });
    const task = await scheduler.create({
      sessionId: 'scheduled-1',
      prompt: 'hook check',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await scheduler.runNow(task.id);
    await waitFor(async () => (await scheduler.get(task.id))?.runCount === 1);

    const completed = await scheduler.get(task.id);
    expect(ran).toBe(true);
    expect(completed?.lastStatus).toBe('success');
    expect(completed?.lastError).toBeUndefined();
    await scheduler.stop();
  });

  it('does not unschedule a task when scoped deletion is denied', async () => {
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async () => {},
    });
    const task = await scheduler.create({
      sessionId: 'session-a',
      prompt: 'owned task',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await expect(scheduler.delete(task.id, { sessionId: 'session-b' })).resolves.toBe(false);
    await expect(scheduler.get(task.id, { sessionId: 'session-a' })).resolves.toBeDefined();
    await expect(scheduler.status()).resolves.toMatchObject({ scheduledTimerCount: 1 });
    await scheduler.stop();
  });

  it('starts only tasks owned by the configured session', async () => {
    const store = new MemoryScheduledTaskStore();
    const bootstrap = new PersistentTaskScheduler({
      store,
      lock: new MemorySchedulerLock(),
      runner: async () => {},
    });
    for (const sessionId of ['session-a', 'session-b']) {
      await bootstrap.create({
        sessionId,
        prompt: `${sessionId} task`,
        type: 'interval',
        schedule: '1h',
        intervalSeconds: 3600,
        enabled: true,
        model,
        toolPolicyProfile: 'scheduled',
      });
    }
    const scheduler = new PersistentTaskScheduler({
      store,
      lock: new MemorySchedulerLock(),
      runner: async () => {},
      scope: { sessionId: 'session-a' },
    });

    await scheduler.start();
    await expect(scheduler.status()).resolves.toMatchObject({
      taskCount: 1,
      scheduledTimerCount: 1,
    });
    await scheduler.stop();
  });
});

class MemoryScheduledTaskStore implements ScheduledTaskStore {
  readonly tasks = new Map<string, ScheduledTask>();

  async list(scope: TaskSchedulerScope = {}): Promise<ScheduledTask[]> {
    return [...this.tasks.values()].filter((task) => matchesScheduledTaskScope(task, scope));
  }

  async get(taskId: string, scope: TaskSchedulerScope = {}): Promise<ScheduledTask | undefined> {
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
    if (!(await this.get(taskId, scope))) {
      return undefined;
    }
    this.tasks.set(taskId, task);
    return task;
  }

  async delete(taskId: string, scope: TaskSchedulerScope = {}): Promise<boolean> {
    if (!(await this.get(taskId, scope))) {
      return false;
    }
    return this.tasks.delete(taskId);
  }
}

class MemorySchedulerLock implements SchedulerLock {
  readonly path = 'memory:scheduler';
  private locked = false;

  acquire(): boolean {
    if (this.locked) {
      return false;
    }
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
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (await assertion()) {
      return;
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for assertion');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('全局并发闸与任务数帽（本地扩展 M4.3）', () => {
  const mkInput = (prompt: string) => ({
    sessionId: 'scheduled-1',
    prompt,
    type: 'interval' as const,
    schedule: '1h',
    intervalSeconds: 3600,
    enabled: true,
    model,
    toolPolicyProfile: 'scheduled',
  });

  it('槽位占满时 runHistory 先记 queued，槽位释放后原位升级为 running 开跑', async () => {
    const makeDeferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const gateA = makeDeferred();
    const gateB = makeDeferred();
    let active = 0;
    let peak = 0;
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      maxConcurrentRuns: 2,
      runner: async (task) => {
        active += 1;
        peak = Math.max(peak, active);
        if (task.prompt === 'A') await gateA.promise;
        else if (task.prompt === 'B') await gateB.promise;
        active -= 1;
      },
    });
    const a = await scheduler.create(mkInput('A'));
    const b = await scheduler.create(mkInput('B'));
    const c = await scheduler.create(mkInput('C'));
    await scheduler.start();
    // 逐个开跑并等 running 落库，确保 C 的排队判定确定发生
    await scheduler.runNow(a.id);
    await waitFor(async () => (await scheduler.get(a.id))?.lastStatus === 'running');
    await scheduler.runNow(b.id);
    await waitFor(async () => (await scheduler.get(b.id))?.lastStatus === 'running');
    await scheduler.runNow(c.id);
    await waitFor(async () => (await scheduler.get(c.id))?.runHistory?.at(-1)?.status === 'queued');
    expect(peak).toBe(2);
    // 排队中的任务不会被标成 running
    expect((await scheduler.get(c.id))?.lastStatus).not.toBe('running');
    // 释放 A 的槽位：C 顶上来跑完（queued 同一条目升级→成功结算）
    gateA.resolve();
    await waitFor(async () => (await scheduler.get(c.id))?.lastStatus === 'success');
    gateB.resolve();
    await waitFor(async () => (await scheduler.get(b.id))?.lastStatus === 'success');
    expect(peak).toBe(2);
    const histC = (await scheduler.get(c.id))?.runHistory ?? [];
    expect(histC.length).toBe(1);
    expect(histC[0]?.message).toBe('Run completed');
    await scheduler.stop();
  });

  it('排队期间被停用的任务：拿到槽位也不开跑，条目作废留痕', async () => {
    const gateA = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      maxConcurrentRuns: 1,
      runner: async (task) => {
        if (task.prompt === 'A') await gateA.promise;
      },
    });
    const a = await scheduler.create(mkInput('A'));
    const b = await scheduler.create(mkInput('B'));
    await scheduler.start();
    await scheduler.runNow(a.id);
    await waitFor(async () => (await scheduler.get(a.id))?.lastStatus === 'running');
    await scheduler.runNow(b.id);
    await waitFor(async () => (await scheduler.get(b.id))?.runHistory?.at(-1)?.status === 'queued');
    await scheduler.update(b.id, { enabled: false });
    gateA.resolve();
    // 停用会另追加一条 paused 记账条，作废条按内容匹配而非"最后一条"
    await waitFor(async () =>
      ((await scheduler.get(b.id))?.runHistory ?? []).some(
        (h) => h.status === 'error' && h.message?.startsWith('Cancelled before start'),
      ),
    );
    expect((await scheduler.get(b.id))?.runCount).toBe(0);
    await scheduler.stop();
  });

  it('maxTasks 上限：超限 create 拒绝（表单命令与 scheduler_create 工具同一道闸）', async () => {
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async () => {},
      maxTasks: 2,
    });
    await scheduler.create(mkInput('one'));
    await scheduler.create(mkInput('two'));
    await expect(scheduler.create(mkInput('three'))).rejects.toThrow(/task limit reached \(2\)/);
    // 删除一个后腾出名额
    await scheduler.delete('does-not-exist');
    const existing = await scheduler.list();
    await scheduler.delete(existing[0]!.id);
    await expect(scheduler.create(mkInput('three'))).resolves.toBeDefined();
  });
});
