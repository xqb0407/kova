/**
 * VENDOR: split from the original vendored index.ts; see NOTICE.md.
 *
 * Task definition parsing, validation and next-run computation.
 */
import { Cron } from 'croner';
import { scheduleExpressionForCroner } from './schedule';
import type {
  ScheduledTask,
  ScheduledTaskRunHistoryEntry,
  ScheduledTaskType,
  TaskSchedulerScope,
} from './types';

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
  if (typeof raw.projectId === 'string' && raw.projectId.trim()) {
    task.projectId = raw.projectId.trim();
  } else {
    delete task.projectId;
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

export function withNextRun<T extends ScheduledTask>(task: T): T {
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
