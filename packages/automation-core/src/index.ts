/**
 * VENDOR: scheduler source was vendored from @amaster.ai/pi-task-scheduler
 * 0.1.2-beta.15 (github.com/TGYD-helige/pi, Apache-2.0; see LICENSE-APACHE-2.0
 * and NOTICE.md).
 *
 * The original single-file module is split for reviewability:
 * - `types.ts` — durable data contracts;
 * - `scheduler.ts` — timer/lock/run-state runtime;
 * - `task.ts` — task validation and next-run computation;
 * - `history.ts` — bounded run-history mutations;
 * - `stores.ts` — JSON store + PID lock;
 * - `schedule.ts` / `catchup.ts` / `preview.ts` — schedule utilities.
 *
 * Local intentional changes are documented in NOTICE.md.
 */
export * from './types';
export { PersistentTaskScheduler } from './scheduler';
export {
  matchesScheduledTaskScope,
  resolveScheduledTaskDefinition,
  normalizeScheduledTask,
  computeNextRunAt,
} from './task';
export {
  createTaskHistoryEntry,
  appendTaskHistory,
  updateTaskHistoryEntry,
  createScheduledTaskRunSessionId,
} from './history';
export { scheduleExpressionForCroner } from './schedule';
export { FileSchedulerLock, JsonScheduledTaskStore } from './stores';
export { previewSchedule, type PreviewInput, type PreviewResult } from './preview';
export { AUTOMATION_TEMPLATES, type AutomationTemplate } from './templates';
export {
  CATCHUP_LIMIT,
  missedTaskIds,
  missedTickDueMs,
  onceTasksToPurge,
  repairMissedOnce,
} from './catchup';
