/**
 * VENDOR: split from the original vendored index.ts; see NOTICE.md.
 *
 * Run-history helpers shared by the scheduler and its stores.
 */
import { randomUUID } from 'node:crypto';
import type { ScheduledTaskRunHistoryEntry } from './types';

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

export function findLastRunningEntryId(history: ScheduledTaskRunHistoryEntry[] | undefined): string {
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
