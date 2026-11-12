/**
 * 停机补跑判定（从 sidecar automation/runtime.ts 抽出，供独立 scheduler 进程复用）。
 */
import { Cron } from 'croner';
import { scheduleExpressionForCroner } from './schedule';
import type { ScheduledTask, TaskScheduler } from './types';

/** 补跑上限：长时间停机也最多一次性拉起 N 个（其余留待下次启动，防惊群） */
export const CATCHUP_LIMIT = 5;

function isExpiredAt(iso: string | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t <= nowMs;
}

function lastFiredAtMs(task: ScheduledTask): number {
  const entries = task.runHistory ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || (e.status !== 'running' && e.status !== 'success' && e.status !== 'error')) {
      continue;
    }
    const t = new Date(e.createdAt).getTime();
    if (Number.isFinite(t)) return t;
  }
  const lr = new Date(task.lastRunAt ?? '').getTime();
  if (Number.isFinite(lr)) return lr;
  const c = new Date(task.createdAt).getTime();
  const u = new Date(task.updatedAt ?? '').getTime();
  return Math.max(Number.isFinite(c) ? c : 0, Number.isFinite(u) ? u : 0);
}

export function missedTickDueMs(task: ScheduledTask, nowMs: number): number | undefined {
  if (!task.enabled || task.type === 'once') return undefined;
  const last = lastFiredAtMs(task);
  if (task.type === 'interval') {
    const due = last + task.intervalSeconds * 1000;
    return due <= nowMs ? due : undefined;
  }
  try {
    const cron = new Cron(scheduleExpressionForCroner(task.schedule), { paused: true });
    const next = cron.nextRun(new Date(last));
    cron.stop();
    return next && next.getTime() <= nowMs ? next.getTime() : undefined;
  } catch {
    return undefined;
  }
}

export function missedTaskIds(snapshot: ScheduledTask[], nowMs: number): string[] {
  const withDue = snapshot
    .map((task) => ({ id: task.id, due: missedTickDueMs(task, nowMs) }))
    .filter((x): x is { id: string; due: number } => x.due !== undefined);
  withDue.sort((a, b) => a.due - b.due);
  return withDue.slice(0, CATCHUP_LIMIT).map((x) => x.id);
}

const ONCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function onceTasksToPurge(
  snapshot: ScheduledTask[],
  nowMs: number,
  retentionMs: number = ONCE_RETENTION_MS,
): string[] {
  return snapshot
    .filter(
      (task) =>
        task.type === 'once' &&
        !task.enabled &&
        isExpiredAt(task.lastRunAt, nowMs - retentionMs),
    )
    .map((task) => task.id);
}

export async function repairMissedOnce(
  scheduler: TaskScheduler,
  snapshot: ScheduledTask[],
  nowMs: number,
): Promise<string[]> {
  const missed = snapshot
    .filter((task) => task.enabled && task.type === 'once' && isExpiredAt(task.schedule, nowMs))
    .sort((a, b) => new Date(a.schedule).getTime() - new Date(b.schedule).getTime())
    .slice(0, CATCHUP_LIMIT);
  for (let i = 0; i < missed.length; i++) {
    await scheduler.update(missed[i].id, {
      schedule: new Date(nowMs + 250 + i * 150).toISOString(),
    });
  }
  return missed.map((t) => t.id);
}
