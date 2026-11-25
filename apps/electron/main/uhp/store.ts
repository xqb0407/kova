/**
 * UHP persistent state, backed by the host SQLite kv table.
 *
 * We intentionally use a prefix-scoped kv namespace instead of new tables:
 * values are small JSON documents, the desktop already backs up kv, and it
 * keeps migration risk near zero. Each record is written atomically by kvSet.
 */
import { kvDelete, kvGet, kvList, kvSet } from "../store";
import type {
  UhpFileRecord,
  UhpHarnessProfile,
  UhpResponseRecord,
  UhpSessionRecord,
} from "./types";

const RESPONSE_PREFIX = "uhp.response.";
const SESSION_PREFIX = "uhp.session.";
const FILE_PREFIX = "uhp.file.";
const HARNESS_PREFIX = "uhp.harness.";

function readJson<T>(key: string): T | null {
  const raw = kvGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  kvSet(key, JSON.stringify(value));
}

/* ------------------------------ responses ------------------------------ */

export function responseKey(id: string): string {
  return `${RESPONSE_PREFIX}${id}`;
}

export function loadResponse(id: string): UhpResponseRecord | null {
  return readJson<UhpResponseRecord>(responseKey(id));
}

export function saveResponse(record: UhpResponseRecord): void {
  writeJson(responseKey(record.id), record);
}

export function deleteResponse(id: string): void {
  kvDelete(responseKey(id));
}

export function listResponses(): UhpResponseRecord[] {
  return kvList(RESPONSE_PREFIX)
    .map((row) => {
      try {
        return JSON.parse(row.value) as UhpResponseRecord;
      } catch {
        return null;
      }
    })
    .filter((row): row is UhpResponseRecord => row !== null);
}

export function listResponsesForSession(sessionId: string): UhpResponseRecord[] {
  return listResponses()
    .filter((row) => row.sessionId === sessionId)
    .sort(
      (a, b) =>
        (a.createdAtMs ?? a.created_at * 1000) -
          (b.createdAtMs ?? b.created_at * 1000) || a.id.localeCompare(b.id),
    );
}

/* ------------------------------ sessions ------------------------------ */

export function sessionKey(id: string): string {
  return `${SESSION_PREFIX}${id}`;
}

export function loadSession(id: string): UhpSessionRecord | null {
  return readJson<UhpSessionRecord>(sessionKey(id));
}

export function saveSession(record: UhpSessionRecord): void {
  writeJson(sessionKey(record.id), record);
}

export function deleteSession(id: string): void {
  kvDelete(sessionKey(id));
}

export function listSessions(): UhpSessionRecord[] {
  return kvList(SESSION_PREFIX)
    .map((row) => {
      try {
        return JSON.parse(row.value) as UhpSessionRecord;
      } catch {
        return null;
      }
    })
    .filter((row): row is UhpSessionRecord => row !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ------------------------------ harnesses ------------------------------ */

export function harnessKey(id: string): string {
  return `${HARNESS_PREFIX}${id}`;
}

export function loadHarness(id: string): UhpHarnessProfile | null {
  return readJson<UhpHarnessProfile>(harnessKey(id));
}

export function saveHarness(profile: UhpHarnessProfile): void {
  writeJson(harnessKey(profile.id), profile);
}

export function deleteHarness(id: string): void {
  kvDelete(harnessKey(id));
}

export function listHarnesses(): UhpHarnessProfile[] {
  return kvList(HARNESS_PREFIX)
    .map((row) => {
      try {
        return JSON.parse(row.value) as UhpHarnessProfile;
      } catch {
        return null;
      }
    })
    .filter((row): row is UhpHarnessProfile => row !== null)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/* ------------------------------ files ------------------------------ */

export function fileKey(id: string): string {
  return `${FILE_PREFIX}${id}`;
}

export function loadFile(id: string): UhpFileRecord | null {
  return readJson<UhpFileRecord>(fileKey(id));
}

export function saveFile(record: UhpFileRecord): void {
  writeJson(fileKey(record.id), record);
}

export function deleteFile(id: string): void {
  kvDelete(fileKey(id));
}

export function listFiles(): UhpFileRecord[] {
  return kvList(FILE_PREFIX)
    .map((row) => {
      try {
        return JSON.parse(row.value) as UhpFileRecord;
      } catch {
        return null;
      }
    })
    .filter((row): row is UhpFileRecord => row !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function listFilesForSession(sessionId: string): UhpFileRecord[] {
  return listFiles().filter((row) => row.sessionId === sessionId);
}

/* ------------------------------ retention ------------------------------ */

/**
 * Mark responses left `in_progress` by a previous process as failed.
 * Without this, a restart leaves a permanently pollable in_progress record
 * and retention never removes it.
 */
export function markInterruptedResponses(now = Date.now()): number {
  let changed = 0;
  for (const record of listResponses()) {
    if (record.status !== "in_progress") continue;
    record.status = "failed";
    record.error = {
      type: "harness_error",
      code: "interrupted",
      message: "The UHP server restarted before the task finished.",
      param: null,
      detail: { reason: "interrupted" },
    };
    record.incomplete_details = null;
    record.updatedAtMs = now;
    saveResponse(record);
    changed += 1;
  }
  return changed;
}

/** Remove stored responses older than the retention window. Active tasks are skipped. */
export function pruneOldResponses(retentionDays: number, now = Date.now()): number {
  const cutoff = now - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const record of listResponses()) {
    if (record.status === "in_progress") continue;
    if (record.createdAtMs >= cutoff) continue;
    deleteResponse(record.id);
    removed += 1;
  }
  return removed;
}
