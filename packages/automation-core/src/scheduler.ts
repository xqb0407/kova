/**
 * VENDOR: split from the original vendored index.ts; see NOTICE.md.
 *
 * Persistent scheduler runtime.
 *
 * Owns timers, the concurrency gate and durable run-state transitions. The
 * type contracts live in `types.ts`; task/history helpers live in `task.ts`
 * and `history.ts`.
 */
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { scheduleExpressionForCroner } from './schedule';
import {
  appendTaskHistory,
  createScheduledTaskRunSessionId,
  createTaskHistoryEntry,
  findLastRunningEntryId,
  updateTaskHistoryEntry,
} from './history';
import {
  matchesScheduledTaskScope,
  withNextRun,
} from './task';
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskRunContext,
  ScheduledTaskUpdate,
  TaskScheduler,
  TaskSchedulerScope,
  TaskSchedulerStatus,
  PersistentTaskSchedulerOptions,
} from './types';

export class PersistentTaskScheduler implements TaskScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly crons = new Map<string, Cron>();
  private readonly runningTaskIds = new Set<string>();
  private active = false;
  private lockHeartbeat: NodeJS.Timeout | undefined;
  private readonly scope: TaskSchedulerScope;
  // —— 本地扩展（M4.3）：全局并发闸 + 任务数帽 ——
  // （activeRuns = 在跑数；排队者不占计数，唤醒时才占位）
  private readonly maxConcurrentRuns: number;
  private readonly maxTasks: number;
  private activeRuns = 0;
  private readonly runWaiters: (() => void)[] = [];

  constructor(private readonly options: PersistentTaskSchedulerOptions) {
    this.scope = { ...options.scope };
    this.maxConcurrentRuns = Math.max(
      1,
      options.maxConcurrentRuns ?? Number.POSITIVE_INFINITY,
    );
    this.maxTasks = options.maxTasks ?? Number.POSITIVE_INFINITY;
  }

  /** 拿运行槽：有空位即时占位；满了排队等 releaseRunSlot 唤醒（唤醒即占位） */
  private acquireRunSlot(): Promise<void> {
    if (this.activeRuns < this.maxConcurrentRuns) {
      this.activeRuns += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.runWaiters.push(() => {
        this.activeRuns += 1;
        resolve();
      });
    });
  }

  /** 释放运行槽：优先转交给排队者（activeRuns 不变，槽位随唤醒转移） */
  private releaseRunSlot(): void {
    const next = this.runWaiters.shift();
    if (next) {
      next();
    } else {
      this.activeRuns -= 1;
    }
  }

  async list(scope: TaskSchedulerScope = {}): Promise<ScheduledTask[]> {
    return await this.options.store.list(this.applyScope(scope));
  }

  async get(taskId: string, scope: TaskSchedulerScope = {}): Promise<ScheduledTask | undefined> {
    return await this.options.store.get(taskId, this.applyScope(scope));
  }

  async status(): Promise<TaskSchedulerStatus> {
    const tasks = await this.options.store.list(this.scope);
    const holderPid = await this.options.lock.holderPid();
    const lock: TaskSchedulerStatus['lock'] = {
      path: this.options.lock.path,
      acquired: this.options.lock.isAcquired(),
    };
    if (holderPid !== undefined) {
      lock.holderPid = holderPid;
    }
    return {
      active: this.active,
      pid: process.pid,
      taskCount: tasks.length,
      scheduledTimerCount: this.timers.size,
      scheduledCronCount: this.crons.size,
      runningTaskIds: [...this.runningTaskIds],
      lock,
    };
  }

  isActive(): boolean {
    return this.active;
  }

  async create(input: ScheduledTaskCreateInput): Promise<ScheduledTask> {
    if (!matchesScheduledTaskScope(input, this.scope)) {
      throw new Error('Scheduled task is outside this scheduler scope.');
    }
    // 本地扩展（M4.3）：任务数帽（runtime 装配传 30）。在唯一入口 create 拦截，
    // 表单命令与对话 agent 工具（scheduler_create）共用同一道闸
    if (Number.isFinite(this.maxTasks)) {
      const existing = await this.options.store.list(this.scope);
      if (existing.length >= this.maxTasks) {
        throw new Error(`automation: task limit reached (${this.maxTasks}); delete one first`);
      }
    }
    const now = new Date().toISOString();
    const task = withNextRun({
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      runHistory:
        input.enabled === false ? [createTaskHistoryEntry('paused', 'Created paused')] : [],
    });
    const created = await this.options.store.create(task);
    if (this.active) {
      this.schedule(created);
    }
    return created;
  }

  async update(
    taskId: string,
    input: ScheduledTaskUpdate,
    scope: TaskSchedulerScope = {},
  ): Promise<ScheduledTask | undefined> {
    const effectiveScope = this.applyScope(scope);
    const existing = await this.options.store.get(taskId, effectiveScope);
    if (!existing) {
      return undefined;
    }
    const {
      name: inputName,
      description: inputDescription,
      workspaceDir: inputWorkspaceDir,
      projectId: inputProjectId,
      ...inputRest
    } = input;
    const nextTask: ScheduledTask = {
      ...existing,
      ...inputRest,
      updatedAt: new Date().toISOString(),
    };
    if (Object.hasOwn(input, 'description') && input.description === undefined) {
      delete nextTask.description;
    } else if (inputDescription !== undefined) {
      nextTask.description = inputDescription;
    }
    if (Object.hasOwn(input, 'name') && input.name === undefined) {
      delete nextTask.name;
    } else if (inputName !== undefined) {
      nextTask.name = inputName;
    }
    if (Object.hasOwn(input, 'workspaceDir') && input.workspaceDir === undefined) {
      delete nextTask.workspaceDir;
    } else if (inputWorkspaceDir !== undefined) {
      nextTask.workspaceDir = inputWorkspaceDir;
    }
    if (Object.hasOwn(input, 'projectId') && input.projectId === undefined) {
      delete nextTask.projectId;
    } else if (inputProjectId !== undefined) {
      nextTask.projectId = inputProjectId;
    }
    if (input.enabled !== undefined && input.enabled !== existing.enabled) {
      nextTask.runHistory = appendTaskHistory(
        existing.runHistory,
        input.enabled
          ? createTaskHistoryEntry('resumed', 'Task resumed')
          : createTaskHistoryEntry('paused', 'Task paused'),
      );
    }
    // —— 本地扩展（M4.4，见 NOTICE.md）：启用时过期 once 改写到"马上" ——
    // 否则 schedule() 会把过去时刻记成一条假"运行失败"（markScheduleError
    // "Scheduled time … is in the past"）。语义与启动修复 repairMissedOnce
    // 一致：重新启用已完成/过期的一次性任务 = 立即再跑一次。非法时刻（NaN）
    // 不改写，维持 schedule() 的真实排期报错。
    if (
      nextTask.type === 'once' &&
      nextTask.enabled &&
      Number.isFinite(new Date(nextTask.schedule).getTime()) &&
      new Date(nextTask.schedule).getTime() <= Date.now()
    ) {
      nextTask.schedule = new Date(Date.now() + 250).toISOString();
    }
    const task = withNextRun(nextTask);
    if (input.enabled !== false && existing.lastStatus === 'error' && existing.lastError) {
      delete task.lastError;
    }
    const updated = await this.options.store.update(taskId, task, effectiveScope);
    if (this.active && updated) {
      this.schedule(updated);
    }
    return updated;
  }

  async delete(taskId: string, scope: TaskSchedulerScope = {}): Promise<boolean> {
    const deleted = await this.options.store.delete(taskId, this.applyScope(scope));
    if (deleted) {
      this.unschedule(taskId);
    }
    return deleted;
  }

  /**
   * —— 本地扩展（M4.5，见 NOTICE.md）：删除运行历史条目（单条/多条/清空）——
   * ScheduledTaskUpdate 刻意不含 runHistory（防表单整存误覆盖历史），故历史操作
   * 走独立入口：读回既有任务 → 过滤条目 → 落盘。不回算 lastStatus/runCount
   * （统计是"任务曾发生过什么"，删日志条目不改写它）；不触发重排期。条目 id 是
   * run→会话映射的键，删条目不级联会话——会话是独立资产，删除由前端另行发起。
   */
  async deleteHistory(
    taskId: string,
    entryIds: string[] | 'all',
    scope: TaskSchedulerScope = {},
  ): Promise<ScheduledTask | undefined> {
    const effectiveScope = this.applyScope(scope);
    const existing = await this.options.store.get(taskId, effectiveScope);
    if (!existing) {
      return undefined;
    }
    const history = existing.runHistory ?? [];
    const nextHistory =
      entryIds === 'all' ? [] : history.filter((entry) => !entryIds.includes(entry.id));
    const nextTask = withNextRun({
      ...existing,
      runHistory: nextHistory,
      updatedAt: new Date().toISOString(),
    });
    return this.options.store.update(taskId, nextTask, effectiveScope);
  }

  async runNow(taskId: string, scope: TaskSchedulerScope = {}): Promise<ScheduledTask | undefined> {
    const task = await this.options.store.get(taskId, this.applyScope(scope));
    if (!task) {
      return undefined;
    }
    void this.execute(taskId);
    return task;
  }

  async start(): Promise<void> {
    if (this.active) {
      return;
    }
    if (!(await this.options.lock.acquire())) {
      return;
    }
    this.active = true;
    this.startLockHeartbeat();
    const tasks = await this.options.store.list(this.scope);
    for (const task of tasks) {
      if (task.lastStatus === 'running') {
        const fixedAt = new Date().toISOString();
        const fixedTask = withNextRun({
          ...task,
          lastStatus: 'error' as const,
          lastError: 'Process was interrupted while task was running',
          runHistory: updateTaskHistoryEntry(
            task.runHistory,
            findLastRunningEntryId(task.runHistory),
            {
              status: 'error',
              message: 'Process was interrupted while task was running',
            },
          ),
          updatedAt: fixedAt,
        });
        await this.options.store.update(task.id, fixedTask, this.scope).catch(() => undefined);
        this.schedule(fixedTask);
      } else {
        const refreshed = withNextRun(task);
        if (refreshed.nextRunAt !== task.nextRunAt) {
          await this.options.store.update(task.id, refreshed, this.scope).catch(() => undefined);
          this.schedule(refreshed);
        } else {
          this.schedule(task);
        }
      }
    }
    await this.emitSchedulerStarted();
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    for (const cron of this.crons.values()) {
      cron.stop();
    }
    this.timers.clear();
    this.crons.clear();
    this.active = false;
    if (this.lockHeartbeat) {
      clearInterval(this.lockHeartbeat);
      this.lockHeartbeat = undefined;
    }
    await this.options.lock.release();
    await this.emitSchedulerStopped();
  }

  private schedule(task: ScheduledTask): void {
    this.unschedule(task.id);
    if (!this.active || !task.enabled) {
      return;
    }
    if (task.type === 'cron') {
      try {
        const cron = new Cron(scheduleExpressionForCroner(task.schedule), { unref: true }, () => {
          void this.execute(task.id);
        });
        this.crons.set(task.id, cron);
        void this.refreshNextRun(task.id, cron.nextRun()?.toISOString(), task);
      } catch (error) {
        void this.markScheduleError(
          task.id,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    if (task.type === 'once') {
      const target = new Date(task.schedule);
      const delayMs = target.getTime() - Date.now();
      if (!Number.isFinite(delayMs) || delayMs <= 0) {
        void this.markScheduleError(task.id, `Scheduled time ${task.schedule} is in the past`);
        return;
      }
      const timer = setTimeout(() => {
        void this.execute(task.id);
      }, delayMs);
      timer.unref();
      this.timers.set(task.id, timer);
      void this.refreshNextRun(task.id, target.toISOString(), task);
      return;
    }
    const timer = setInterval(() => {
      void this.execute(task.id);
    }, task.intervalSeconds * 1000);
    timer.unref();
    this.timers.set(task.id, timer);
    void this.refreshNextRun(
      task.id,
      new Date(Date.now() + task.intervalSeconds * 1000).toISOString(),
      task,
    );
  }

  /** 本地扩展（L1，见 NOTICE.md）：挂起的触发上下文（runNow 触发的 manual 语义不在此） */
  private pendingTriggers = new Map<string, ScheduledTaskRunContext['trigger']>();

  /**
   * 本地扩展（L1，见 NOTICE.md）：带触发来源的立即运行。与 runNow 同路径
   * （并发闸/历史/hooks 全生效），仅把 trigger 透传进 run context。
   */
  async runWithContext(
    taskId: string,
    trigger: NonNullable<ScheduledTaskRunContext['trigger']>,
    scope: TaskSchedulerScope = {},
  ): Promise<ScheduledTask | undefined> {
    const task = await this.options.store.get(taskId, this.applyScope(scope));
    if (!task) {
      return undefined;
    }
    this.pendingTriggers.set(taskId, trigger);
    try {
      void this.execute(taskId);
    } finally {
      // execute 是异步的：若尚未消费（并发重入直接 return），清掉避免泄漏
      setImmediate(() => {
        if (this.pendingTriggers.get(taskId) === trigger) {
          this.pendingTriggers.delete(taskId);
        }
      });
    }
    return task;
  }

  private async execute(taskId: string): Promise<void> {
    if (!this.active || this.runningTaskIds.has(taskId)) {
      return;
    }
    const task0 = await this.options.store.get(taskId, this.scope);
    if (!task0?.enabled) {
      return;
    }
    this.runningTaskIds.add(taskId);
    // —— 本地扩展（M4.3，见 NOTICE.md）：全局并发闸 ——
    // 槽位满时先在 runHistory 落一条 queued（管理页历史可见"排队中"），
    // 拿到槽位后用同一条目原位升级为 running；后续结算/帧路径与上游一致。
    // maxConcurrentRuns 默认 Infinity：acquire 同步占位、不进排队分支，行为不变。
    const startedAt0 = new Date().toISOString();
    const runningEntry = createTaskHistoryEntry('running', 'Run started', {
      createdAt: startedAt0,
      sessionId: createScheduledTaskRunSessionId(),
    });
    let task = task0;
    let slotTaken = false;
    let wasQueued = false;
    // 整体收进 try/finally：开跑前的持久化若抛错，槽位与重入标记都必须归还
    // （上游原结构里 runningTaskIds 在 store.update 抛错时会永久泄漏）
    try {
      if (this.activeRuns >= this.maxConcurrentRuns) {
        wasQueued = true;
        await this.options.store.update(
          taskId,
          {
            ...task0,
            runHistory: appendTaskHistory(task0.runHistory, {
              ...runningEntry,
              status: 'queued',
              message: 'Queued for a free run slot',
            }),
            updatedAt: startedAt0,
          },
          this.scope,
        );
      }
      await this.acquireRunSlot();
      slotTaken = true;
      if (wasQueued) {
        const fresh = await this.options.store.get(taskId, this.scope);
        if (!this.active || !fresh?.enabled) {
          // 排队期间被停用/删除或调度器已停：作废这次运行（历史留痕，不静默吞）
          if (fresh) {
            await this.options.store.update(
              taskId,
              {
                ...fresh,
                runHistory: updateTaskHistoryEntry(fresh.runHistory, runningEntry.id, {
                  status: 'error',
                  message: 'Cancelled before start (task disabled or scheduler stopped)',
                }),
              },
              this.scope,
            );
          }
          return;
        }
        task = fresh;
      }
      const startedAt = wasQueued ? new Date().toISOString() : startedAt0;
      const runningTask: ScheduledTask = {
        ...task,
        lastStatus: 'running',
        runHistory: wasQueued
          ? updateTaskHistoryEntry(task.runHistory, runningEntry.id, {
              status: 'running',
              message: 'Run started',
              createdAt: startedAt,
            })
          : appendTaskHistory(task.runHistory, { ...runningEntry, createdAt: startedAt }),
        updatedAt: startedAt,
      };
      await this.options.store.update(taskId, runningTask, this.scope);
      const run: ScheduledTaskRunContext = {
        historyEntryId: runningEntry.id,
        sessionId: runningEntry.sessionId ?? task.sessionId,
        startedAt,
        ...(this.pendingTriggers.get(taskId)
          ? { trigger: this.pendingTriggers.get(taskId) }
          : {}),
      };
      this.pendingTriggers.delete(taskId);
      await this.emitHook(() =>
        this.options.hooks?.onTaskStarted?.({ task, run, timestamp: startedAt }),
      );
      try {
        await this.options.runner(task, run);
        const latest = (await this.options.store.get(taskId, this.scope)) ?? runningTask;
        const completedAt = new Date().toISOString();
        const updated = withNextRun({
          ...latest,
          enabled: latest.type === 'once' ? false : latest.enabled,
          lastRunAt: completedAt,
          lastStatus: 'success',
          runHistory: updateTaskHistoryEntry(latest.runHistory, runningEntry.id, {
            status: 'success',
            message: 'Run completed',
          }),
          runCount: latest.runCount + 1,
          updatedAt: completedAt,
        });
        delete updated.lastError;
        const stored = (await this.options.store.update(taskId, updated, this.scope)) ?? updated;
        if (updated.type === 'once') {
          this.unschedule(taskId);
        }
        await this.emitHook(() =>
          this.options.hooks?.onTaskCompleted?.({ task: stored, run, timestamp: completedAt }),
        );
      } catch (error) {
        const latest = (await this.options.store.get(taskId, this.scope)) ?? runningTask;
        const failedAt = new Date().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        const updated = withNextRun({
          ...latest,
          lastStatus: 'error',
          lastError: message,
          runHistory: updateTaskHistoryEntry(latest.runHistory, runningEntry.id, {
            status: 'error',
            message,
          }),
          updatedAt: failedAt,
        });
        const stored = (await this.options.store.update(taskId, updated, this.scope)) ?? updated;
        await this.emitHook(() =>
          this.options.hooks?.onTaskFailed?.({
            task: stored,
            run,
            timestamp: failedAt,
            error: message,
          }),
        );
      }
    } finally {
      this.runningTaskIds.delete(taskId);
      if (slotTaken) {
        this.releaseRunSlot();
      }
    }
  }

  private unschedule(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
    const cron = this.crons.get(taskId);
    if (cron) {
      cron.stop();
      this.crons.delete(taskId);
    }
  }

  private async refreshNextRun(
    taskId: string,
    nextRunAt: string | undefined,
    knownTask?: ScheduledTask,
  ): Promise<void> {
    const task = knownTask ?? (await this.options.store.get(taskId, this.scope));
    if (!task || nextRunAt === task.nextRunAt) {
      return;
    }
    const updated = { ...task, updatedAt: new Date().toISOString() };
    if (nextRunAt) {
      updated.nextRunAt = nextRunAt;
    } else {
      delete updated.nextRunAt;
    }
    await this.options.store.update(taskId, updated, this.scope);
  }

  private async markScheduleError(taskId: string, error: string): Promise<void> {
    const task = await this.options.store.get(taskId, this.scope);
    if (!task) {
      return;
    }
    const updated = {
      ...task,
      enabled: false,
      lastStatus: 'error' as const,
      lastError: error,
      runHistory: appendTaskHistory(task.runHistory, createTaskHistoryEntry('error', error)),
      updatedAt: new Date().toISOString(),
    };
    delete updated.nextRunAt;
    const stored = (await this.options.store.update(taskId, updated, this.scope)) ?? updated;
    await this.emitHook(() =>
      this.options.hooks?.onTaskFailed?.({
        task: stored,
        run: {
          historyEntryId: stored.runHistory?.at(-1)?.id ?? taskId,
          sessionId: stored.sessionId,
          startedAt: stored.updatedAt,
        },
        timestamp: stored.updatedAt,
        error,
      }),
    );
  }

  private startLockHeartbeat(): void {
    if (!this.options.lock.extend) {
      return;
    }
    const lockHeartbeatMs = this.options.lockHeartbeatMs ?? 10_000;
    this.lockHeartbeat = setInterval(() => {
      void (async () => {
        if (!(await this.options.lock.extend?.())) {
          await this.stop();
        }
      })();
    }, lockHeartbeatMs);
    this.lockHeartbeat.unref();
  }

  private async emitSchedulerStarted(): Promise<void> {
    const status = await this.status();
    await this.emitHook(() =>
      this.options.hooks?.onSchedulerStarted?.({
        timestamp: new Date().toISOString(),
        status,
      }),
    );
  }

  private async emitSchedulerStopped(): Promise<void> {
    const status = await this.status();
    await this.emitHook(() =>
      this.options.hooks?.onSchedulerStopped?.({
        timestamp: new Date().toISOString(),
        status,
      }),
    );
  }

  private async emitHook(callback: () => void | Promise<void>): Promise<void> {
    try {
      await callback();
    } catch {
      // Hooks are observability side effects; scheduler state must not depend on them.
    }
  }

  private applyScope(scope: TaskSchedulerScope): TaskSchedulerScope {
    return { ...scope, ...this.scope };
  }
}
