/**
 * VENDOR: 本目录源码 vendored 自 @amaster.ai/pi-task-scheduler 0.1.2-beta.15
 * （github.com/TGYD-helige/pi，Apache-2.0，见同目录 LICENSE-APACHE-2.0 与 NOTICE.md）。
 *
 * 本地有意改动（与上游 diff 时保留）：
 *   - 不 vendor extension.ts（Mode 2：sidecar 自持调度器生命周期），故删除其 default 重导出；
 *   - tools.ts：pi-coding-agent 的 ExtensionContext 依赖改为 getCtx() 闭包注入（pi-agent-core
 *     的 AgentTool.execute 没有第 5 个 ctx 参数）；工具作用域从"当前会话"放宽为 app 级
 *     （自动化是应用级资产，跨会话可见）；scheduler_create 的 toolPolicyProfile 默认
 *     从 'workspace-write' 收紧为 'read-only'（无人值守安全默认）。
 *   - 相对导入去 .js 后缀，对齐本仓风格。
 */
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';

export type ScheduledTaskType = 'cron' | 'once' | 'interval';
export type ScheduledTaskStatus = 'success' | 'error' | 'running';
export type ScheduledTaskModelConfig = {
  provider: string;
  model: string;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  authProfileId?: string;
  reasoning?: boolean;
};
export type ScheduledTaskRunHistoryEntry = {
  id: string;
  /** 'queued' = 本地扩展（M4.3）：全局并发闸排队中，拿到槽位后原位升级为 running */
  status: ScheduledTaskStatus | 'paused' | 'resumed' | 'queued';
  createdAt: string;
  sessionId?: string;
  message?: string;
};

export type ScheduledTaskRunContext = {
  historyEntryId: string;
  sessionId: string;
  startedAt: string;
};

export type ScheduledTask = {
  id: string;
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  sessionId: string;
  name?: string;
  prompt: string;
  type: ScheduledTaskType;
  schedule: string;
  intervalSeconds: number;
  enabled: boolean;
  model: ScheduledTaskModelConfig;
  toolPolicyProfile: string;
  workspaceDir?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  runCount: number;
  timeoutMs?: number;
  lastStatus?: ScheduledTaskStatus;
  lastError?: string;
  runHistory?: ScheduledTaskRunHistoryEntry[];
};

export type ScheduledTaskCreateInput = Omit<
  ScheduledTask,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'nextRunAt'
  | 'runCount'
  | 'lastStatus'
  | 'lastRunAt'
  | 'lastError'
  | 'runHistory'
>;

export type ScheduledTaskUpdate = Partial<
  Omit<
    ScheduledTask,
    | 'id'
    | 'tenantId'
    | 'userId'
    | 'workspaceId'
    | 'createdAt'
    | 'updatedAt'
    | 'lastRunAt'
    | 'lastError'
    | 'nextRunAt'
    | 'runCount'
    | 'lastStatus'
    | 'runHistory'
    | 'name'
    | 'description'
    | 'workspaceDir'
  >
> & {
  name?: string | undefined;
  description?: string | undefined;
  workspaceDir?: string | undefined;
};

export type TaskSchedulerStatus = {
  active: boolean;
  pid: number;
  taskCount: number;
  scheduledTimerCount: number;
  scheduledCronCount: number;
  runningTaskIds: string[];
  lock: {
    path: string;
    acquired: boolean;
    holderPid?: number;
  };
};

export type TaskSchedulerScope = {
  tenantId?: string;
  userId?: string;
  sessionId?: string;
};

export interface TaskScheduler {
  list(scope?: TaskSchedulerScope): Promise<ScheduledTask[]>;
  get(taskId: string, scope?: TaskSchedulerScope): Promise<ScheduledTask | undefined>;
  status(): Promise<TaskSchedulerStatus>;
  isActive(): boolean;
  create(input: ScheduledTaskCreateInput): Promise<ScheduledTask>;
  update(
    taskId: string,
    input: ScheduledTaskUpdate,
    scope?: TaskSchedulerScope,
  ): Promise<ScheduledTask | undefined>;
  delete(taskId: string, scope?: TaskSchedulerScope): Promise<boolean>;
  runNow(taskId: string, scope?: TaskSchedulerScope): Promise<ScheduledTask | undefined>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ScheduledTaskStore {
  list(scope?: TaskSchedulerScope): Promise<ScheduledTask[]>;
  get(taskId: string, scope?: TaskSchedulerScope): Promise<ScheduledTask | undefined>;
  create(task: ScheduledTask): Promise<ScheduledTask>;
  update(
    taskId: string,
    task: ScheduledTask,
    scope?: TaskSchedulerScope,
  ): Promise<ScheduledTask | undefined>;
  delete(taskId: string, scope?: TaskSchedulerScope): Promise<boolean>;
}

export interface SchedulerLock {
  readonly path: string;
  acquire(): boolean | Promise<boolean>;
  release(): void | Promise<void>;
  isAcquired(): boolean;
  holderPid(): number | undefined | Promise<number | undefined>;
  extend?(): boolean | Promise<boolean>;
}

export type ScheduledTaskRunner = (
  task: ScheduledTask,
  run: ScheduledTaskRunContext,
) => Promise<void>;

export type TaskSchedulerRunEvent = {
  task: ScheduledTask;
  run: ScheduledTaskRunContext;
  timestamp: string;
};

export type TaskSchedulerFailureEvent = TaskSchedulerRunEvent & {
  error: string;
};

export type TaskSchedulerLifecycleEvent = {
  timestamp: string;
  status: TaskSchedulerStatus;
};

export type TaskSchedulerHooks = {
  onTaskStarted?: (event: TaskSchedulerRunEvent) => void | Promise<void>;
  onTaskCompleted?: (event: TaskSchedulerRunEvent) => void | Promise<void>;
  onTaskFailed?: (event: TaskSchedulerFailureEvent) => void | Promise<void>;
  onSchedulerStarted?: (event: TaskSchedulerLifecycleEvent) => void | Promise<void>;
  onSchedulerStopped?: (event: TaskSchedulerLifecycleEvent) => void | Promise<void>;
};

export type PersistentTaskSchedulerOptions = {
  store: ScheduledTaskStore;
  lock: SchedulerLock;
  runner: ScheduledTaskRunner;
  scope?: TaskSchedulerScope;
  hooks?: TaskSchedulerHooks;
  lockHeartbeatMs?: number;
  /** 本地扩展（M4.3，见 NOTICE.md）：全局并发闸。默认 Infinity = 上游行为。
   *  超出上限的触发先在 runHistory 落一条 queued，拿到槽位后升级为 running 开跑 */
  maxConcurrentRuns?: number;
  /** 本地扩展（M4.3）：任务数上限。create 超限抛错（错误文本原样透给命令/工具调用方） */
  maxTasks?: number;
};

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
      };
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

export function matchesScheduledTaskScope(
  task: Pick<ScheduledTask, 'tenantId' | 'userId' | 'sessionId'>,
  scope: TaskSchedulerScope,
): boolean {
  return (
    (scope.tenantId === undefined || task.tenantId === scope.tenantId) &&
    (scope.userId === undefined || task.userId === scope.userId) &&
    (scope.sessionId === undefined || task.sessionId === scope.sessionId)
  );
}

export function resolveScheduledTaskDefinition(input: {
  type?: ScheduledTaskType;
  schedule?: string;
}): Pick<ScheduledTask, 'type' | 'schedule' | 'intervalSeconds'> {
  const type = input.type;
  if (!isScheduledTaskType(type)) {
    throw new Error('Scheduled task type is required and must be one of: cron, once, interval');
  }
  if (!input.schedule?.trim()) {
    throw new Error(`${type} scheduled tasks require schedule`);
  }
  if (type === 'interval') {
    const intervalSeconds = parseIntervalSeconds(input.schedule);
    if (!intervalSeconds) {
      throw new Error(
        `Invalid interval schedule: ${input.schedule}. Use formats like "30s", "5m", or "1h".`,
      );
    }
    return {
      type,
      schedule: input.schedule.trim(),
      intervalSeconds,
    };
  }
  if (type === 'once') {
    const schedule = resolveOnceSchedule(input.schedule);
    const delaySeconds = Math.max(1, Math.ceil((new Date(schedule).getTime() - Date.now()) / 1000));
    return { type, schedule, intervalSeconds: delaySeconds };
  }
  validateCronSchedule(input.schedule);
  return {
    type,
    schedule: input.schedule.trim(),
    intervalSeconds: 0,
  };
}

export function normalizeScheduledTask(rawTask: ScheduledTask): ScheduledTask {
  const raw = rawTask as ScheduledTask & {
    type?: unknown;
    schedule?: unknown;
    intervalSeconds?: unknown;
    enabled?: unknown;
    workspaceDir?: unknown;
    runCount?: unknown;
    runHistory?: unknown;
    timeoutMs?: unknown;
  };
  const type = isScheduledTaskType(raw.type) ? raw.type : 'interval';
  const intervalSeconds =
    typeof raw.intervalSeconds === 'number' && Number.isFinite(raw.intervalSeconds)
      ? Math.max(5, Math.floor(raw.intervalSeconds))
      : 60;
  const schedule =
    typeof raw.schedule === 'string' && raw.schedule.trim()
      ? raw.schedule.trim()
      : type === 'interval'
        ? `${intervalSeconds}s`
        : '';
  const task: ScheduledTask = {
    ...rawTask,
    type,
    schedule,
    intervalSeconds,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    runCount:
      typeof raw.runCount === 'number' && Number.isFinite(raw.runCount)
        ? Math.max(0, Math.floor(raw.runCount))
        : 0,
    runHistory: Array.isArray(raw.runHistory)
      ? raw.runHistory.filter(isTaskHistoryEntry).slice(-25)
      : [],
  };
  if (typeof raw.workspaceDir === 'string' && raw.workspaceDir.trim()) {
    task.workspaceDir = raw.workspaceDir.trim();
  } else {
    delete task.workspaceDir;
  }
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
    task.timeoutMs = Math.floor(raw.timeoutMs);
  } else {
    delete task.timeoutMs;
  }
  const nextRunAt = computeNextRunAt(task);
  if (nextRunAt) {
    task.nextRunAt = nextRunAt;
  } else if (!task.enabled || task.type === 'once') {
    delete task.nextRunAt;
  }
  return task;
}

export function computeNextRunAt(task: ScheduledTask): string | undefined {
  if (!task.enabled) {
    return undefined;
  }
  if (task.type === 'interval') {
    return new Date(Date.now() + task.intervalSeconds * 1000).toISOString();
  }
  if (task.type === 'once') {
    const target = new Date(task.schedule);
    if (Number.isNaN(target.getTime()) || target.getTime() <= Date.now()) {
      return undefined;
    }
    return target.toISOString();
  }
  try {
    const cron = new Cron(scheduleExpressionForCroner(task.schedule), { paused: true });
    const next = cron.nextRun()?.toISOString();
    cron.stop();
    return next;
  } catch {
    return undefined;
  }
}

export function createTaskHistoryEntry(
  status: ScheduledTaskRunHistoryEntry['status'],
  message?: string,
  options: { createdAt?: string; sessionId?: string } = {},
): ScheduledTaskRunHistoryEntry {
  return {
    id: randomUUID(),
    status,
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(message ? { message } : {}),
  };
}

export function appendTaskHistory(
  history: ScheduledTaskRunHistoryEntry[] | undefined,
  entry: ScheduledTaskRunHistoryEntry,
): ScheduledTaskRunHistoryEntry[] {
  return [...(history ?? []), entry].slice(-25);
}

export function updateTaskHistoryEntry(
  history: ScheduledTaskRunHistoryEntry[] | undefined,
  entryId: string,
  patch: Pick<ScheduledTaskRunHistoryEntry, 'status'> &
    // createdAt 可改写 = 本地扩展（M4.3）：queued 条目拿到槽位后刷新为真实开始时刻
    Pick<Partial<ScheduledTaskRunHistoryEntry>, 'message' | 'createdAt'>,
): ScheduledTaskRunHistoryEntry[] {
  return (history ?? [])
    .map((entry) => (entry.id === entryId ? { ...entry, ...patch } : entry))
    .slice(-25);
}

function findLastRunningEntryId(history: ScheduledTaskRunHistoryEntry[] | undefined): string {
  const entries = history ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.status === 'running') {
      return entry.id;
    }
  }
  return '';
}

export function createScheduledTaskRunSessionId(): string {
  return `scheduled-run-${randomUUID()}`;
}

export function scheduleExpressionForCroner(value: string): string {
  const schedule = value.trim();
  return schedule.toUpperCase().startsWith('RRULE:') ? rruleToCronSchedule(schedule) : schedule;
}

function withNextRun<T extends ScheduledTask>(task: T): T {
  const nextRunAt = computeNextRunAt(task);
  const result: T = { ...task };
  if (nextRunAt) {
    result.nextRunAt = nextRunAt;
  } else {
    delete result.nextRunAt;
  }
  return result;
}

function isScheduledTaskType(value: unknown): value is ScheduledTaskType {
  return value === 'cron' || value === 'once' || value === 'interval';
}

function isTaskHistoryEntry(value: unknown): value is ScheduledTaskRunHistoryEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Partial<ScheduledTaskRunHistoryEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.createdAt === 'string' &&
    (entry.status === 'success' ||
      entry.status === 'error' ||
      entry.status === 'running' ||
      entry.status === 'queued' ||
      entry.status === 'paused' ||
      entry.status === 'resumed') &&
    (entry.sessionId === undefined || typeof entry.sessionId === 'string') &&
    (entry.message === undefined || typeof entry.message === 'string')
  );
}

function sanitizeIntervalSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('intervalSeconds must be a positive number');
  }
  return Math.max(5, Math.floor(value));
}

function parseIntervalSeconds(value: string): number | undefined {
  const match = value.trim().match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    return undefined;
  }
  const rawAmount = match[1];
  const unit = match[2];
  if (!rawAmount || !unit) {
    return undefined;
  }
  const amount = Number(rawAmount);
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
  };
  const multiplier = multipliers[unit];
  if (!Number.isFinite(amount) || !multiplier) {
    return undefined;
  }
  return sanitizeIntervalSeconds(amount * multiplier);
}

function resolveOnceSchedule(value: string): string {
  const relative = parseRelativeSchedule(value);
  if (relative) {
    return relative;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Invalid once schedule: ${value}. Use an ISO timestamp or relative time like "+10m".`,
    );
  }
  if (date.getTime() <= Date.now()) {
    throw new Error(`Scheduled time is in the past: ${date.toISOString()}`);
  }
  return date.toISOString();
}

function parseRelativeSchedule(value: string): string | undefined {
  const match = value.trim().match(/^\+(\d+)(s|m|h|d)$/);
  if (!match) {
    return undefined;
  }
  const rawAmount = match[1];
  const unit = match[2];
  if (!rawAmount || !unit) {
    return undefined;
  }
  const amount = Number(rawAmount);
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  const multiplier = multipliers[unit];
  if (!Number.isFinite(amount) || !multiplier || amount <= 0) {
    return undefined;
  }
  return new Date(Date.now() + amount * multiplier).toISOString();
}

function validateCronSchedule(value: string): void {
  const schedule = scheduleExpressionForCroner(value);
  const fields = schedule.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new Error(`Cron schedule must have 5 or 6 fields, got ${fields.length}`);
  }
  const cron = new Cron(schedule, { paused: true });
  cron.stop();
}

function rruleToCronSchedule(value: string): string {
  const body = value.trim().replace(/^RRULE:/i, '');
  const parts = Object.fromEntries(
    body.split(';').map((part) => {
      const [rawKey, rawValue = ''] = part.split('=');
      return [rawKey?.trim().toUpperCase() ?? '', rawValue.trim().toUpperCase()];
    }),
  );
  const freq = parts.FREQ;
  const hour = parseRruleNumber(parts.BYHOUR, 9, 0, 23);
  const minute = parseRruleNumber(parts.BYMINUTE, 0, 0, 59);
  if (freq === 'HOURLY') {
    return `${minute} * * * *`;
  }
  if (freq === 'DAILY') {
    return `${minute} ${hour} * * *`;
  }
  if (freq === 'WEEKLY') {
    const day = rruleDayToCron(parts.BYDAY);
    return `${minute} ${hour} * * ${day}`;
  }
  throw new Error(`Unsupported RRULE frequency: ${freq || 'missing'}`);
}

function parseRruleNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function rruleDayToCron(value: string | undefined): string {
  const days: Record<string, string> = {
    SU: '0',
    MO: '1',
    TU: '2',
    WE: '3',
    TH: '4',
    FR: '5',
    SA: '6',
  };
  if (!value) {
    return '*';
  }
  return value
    .split(',')
    .map((day) => days[day] ?? day)
    .join(',');
}

export { FileSchedulerLock, JsonScheduledTaskStore } from './stores';
export { createSchedulerTools } from './tools';
