# NOTICE — third-party derived code

This directory (`sidecar/pi-agent/src/automation/`) contains source code derived from:

- **@amaster.ai/pi-task-scheduler** v0.1.2-beta.15
  - Repository: https://github.com/TGYD-helige/pi (packages/pi-task-scheduler)
  - License: Apache License 2.0 (full text: `LICENSE-APACHE-2.0` in this directory)
  - Copyright: the original authors of the pi monorepo (TGYD-helige/pi)

Modifications (marked with "VENDOR" headers in each file):

- `extension.ts` was not vendored (the sidecar owns scheduler lifecycle, upstream "Mode 2").
- `tools.ts`: `ExtensionContext` replaced by injected `getCtx()` closure; tool scope widened from
  per-session to app-level; `toolPolicyProfile` default tightened from `workspace-write` to
  `read-only`; `promptSnippet` fields removed (not part of `AgentTool` in pi-agent-core).
- Relative imports normalized to extensionless style.
- `index.ts` (M4.3 boundaries, all opt-in via scheduler options — defaults keep upstream behavior):
  - `maxConcurrentRuns` global concurrency gate: when all slots are busy a trigger first appends a
    `runHistory` entry with the new `'queued'` status (added to the history-entry status union and
    the `isTaskHistoryEntry` validator), then upgrades that same entry in place to `'running'` once
    a slot frees up. `updateTaskHistoryEntry`'s patch now also accepts `createdAt` so the promoted
    entry stamps its real start time.
  - `maxTasks` cap enforced at the single `create()` entry (shared by form commands and the
    `scheduler_create` agent tool).
  - `execute()` restructured to run the pre-start bookkeeping inside one try/finally that releases
    both `runningTaskIds` and the slot — this also fixes an upstream leak where a throwing
    `store.update` before the runner call would strand the task's running marker forever.
- `index.ts` (M4.4, behavior fix, not opt-in): `update()` rewrites an expired `once` schedule to
  "now + 250ms" whenever the merged result is enabled, so re-enabling a finished/past one-off task
  runs it again instead of having `schedule()` record a false "Scheduled time … is in the past"
  run failure in history (same semantics as the startup `repairMissedOnce`; invalid timestamps are
  left untouched so genuine schedule errors still surface). Covered by `once-rearm.test.ts`.
- `index.ts` (M4.5, additive, not opt-in): new `deleteHistory(taskId, entryIds | 'all')` scheduler
  method (on the `TaskScheduler` interface + `PersistentTaskScheduler`) so the management UI can
  delete individual/clear `runHistory` entries — `ScheduledTaskUpdate` deliberately excludes
  `runHistory`, so history can't be mutated through `update()` without a form overwrite clobbering
  it. Purely log deletion: does not recompute `lastStatus`/`runCount` and does not cascade-delete the
  run's session (sessions are independent assets removed via a separate `delete_session` request).
  Wired as the `automation_history_delete` protocol command.

Local extensions layered on top of the vendored code (no vendored file behavior changed;
implemented against its public API from new, clearly-marked non-vendored files):

- **Startup catch-up** (`runtime.ts`, `catchup.test.ts`): upstream does not compensate for runs
  missed while the process was down (cron only schedules future ticks; an expired `once` task is
  disabled via `markScheduleError` at `start()`). Here, before `start()` we detect cron/interval
  tasks that missed a tick since their last fire (using `runHistory`/`lastRunAt`/`createdAt` —
  *not* the persisted `nextRunAt`, which `normalizeScheduledTask` recomputes to a future time on
  every store read/write) and fire each once through `runNow()`; expired enabled `once` tasks are
  re-armed to "now" via `update()` so the upstream timer runs them instead of false-failing them.
  Catch-up runs are capped per startup (`CATCHUP_LIMIT`) and merged (multiple missed ticks → one run).
- **Dead `once` task GC** (M4.2, `runtime.ts`): at startup, completed `once` tasks (auto-disabled by
  the scheduler on success) older than a 30-day retention window (measured from `lastRunAt`) are
  deleted, so the task list never fills up with finished one-offs.

This NOTICE is provided in accordance with Apache-2.0 §4(d).
