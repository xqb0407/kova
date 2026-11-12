/**
 * VENDOR: split from the original vendored index.ts; see NOTICE.md.
 *
 * Task scheduler data contracts.
 *
 * Split out of the original vendored index so scheduler internals, stores and
 * adapters can depend on types without pulling in the runtime class.
 */

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
  /** 任务所属项目（保存时按 workspaceDir 唯一归属解析；共享目录需显式传入） */
  projectId?: string;
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
    | 'projectId'
  >
> & {
  name?: string | undefined;
  description?: string | undefined;
  workspaceDir?: string | undefined;
  projectId?: string | undefined;
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
  /** —— 本地扩展（M4.5，见 NOTICE.md）：删除 runHistory 条目（'all' = 清空） —— */
  deleteHistory(
    taskId: string,
    entryIds: string[] | 'all',
    scope?: TaskSchedulerScope,
  ): Promise<ScheduledTask | undefined>;
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
