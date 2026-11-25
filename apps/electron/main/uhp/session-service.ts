/**
 * UHP session listing/inspection. Only sessions created through UHP are
 * exposed; desktop chat sessions stay private unless a future setting opts in.
 */
import type { UhpInputItem, UhpSession, UhpSessionTurn } from "uhp-protocol";
import { collectInputText, uhpSessionIdFor } from "uhp-protocol";
import type { UhpBridge, UhpSessionRecord } from "./types";
import {
  listFilesForSession,
  listResponsesForSession,
  listSessions,
  loadSession,
  saveSession,
  deleteResponse as deleteStoredResponse,
} from "./store";
import { deleteSession as deleteStoredSession } from "./store";
import type { UhpTaskService } from "./task-service";
import { deleteSessionArtifacts, fileToWire } from "./files";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function toWireSession(
  record: UhpSessionRecord,
  status = "completed",
): UhpSession {
  return {
    id: record.id,
    object: "session",
    harness_id: record.harnessId,
    title: record.title,
    status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function assistantText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const value = item as { type?: string; content?: unknown[] };
    if (value.type !== "message") continue;
    for (const part of value.content ?? []) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: string; text?: string };
      if (p.type === "output_text" && typeof p.text === "string") parts.push(p.text);
    }
  }
  return parts.join("\n").trim();
}

function toolSummaries(output: unknown[]): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const value = item as {
      type?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      output?: string;
    };
    if (value.type === "function_call") {
      tools.push({
        call_id: value.call_id,
        name: value.name,
        arguments: value.arguments,
      });
    } else if (value.type === "function_call_output") {
      tools.push({ call_id: value.call_id, output: value.output });
    }
  }
  return tools;
}

export class UhpSessionService {
  constructor(
    private readonly bridge: UhpBridge,
    private readonly tasks: UhpTaskService,
  ) {}

  list(options: { limit: number; cursor?: string | null; harness?: string | null }): {
    data: UhpSession[];
    next_cursor: string | null;
  } {
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit) || 20));
    let rows = listSessions();
    if (options.harness) rows = rows.filter((row) => row.harnessId === options.harness);
    rows.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));

    let start = 0;
    if (options.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (decoded) {
        const index = rows.findIndex(
          (row) => row.updatedAt < decoded.updatedAt ||
            (row.updatedAt === decoded.updatedAt && row.id < decoded.id),
        );
        start = index === -1 ? rows.length : index;
      }
    }
    const slice = rows.slice(start, start + limit);
    const last = slice[slice.length - 1];
    const hasMore = start + limit < rows.length;
    return {
      data: slice.map((row) =>
        toWireSession(row, this.tasks.isSessionBusy(row.kovaSessionId) ? "in_progress" : "completed"),
      ),
      next_cursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  get(id: string): UhpSession | null {
    const record = loadSession(id);
    if (!record) return null;
    return toWireSession(
      record,
      this.tasks.isSessionBusy(record.kovaSessionId) ? "in_progress" : "completed",
    );
  }

  turns(id: string): UhpSessionTurn[] {
    const record = loadSession(id);
    if (!record) return [];
    const responses = listResponsesForSession(record.kovaSessionId);
    const files = listFilesForSession(record.kovaSessionId);
    return responses
      .filter((response) => response.persisted)
      .map((response) => {
        const input = response.inputItems;
        const text =
          typeof input === "string"
            ? input
            : Array.isArray(input)
              ? collectInputText(input as UhpInputItem[])
              : "";
        return {
          id: response.id,
          status: response.status,
          user: { text },
          assistant: { text: assistantText(response.output) },
          tools: toolSummaries(response.output),
          files: files
            .filter((file) => !file.responseId || file.responseId === response.id)
            .map(fileToWire),
          created_at: response.created_at,
          completed_at: response.status === "in_progress" ? null : Math.floor(response.updatedAtMs / 1000),
        } satisfies UhpSessionTurn;
      });
  }

  /** Delete the UHP view and the underlying Kova session/transcript. */
  async delete(id: string): Promise<boolean> {
    const record = loadSession(id);
    if (!record) return false;
    await this.tasks.cancelSession(id).catch(() => undefined);
    // If the sidecar cannot delete the transcript, keep the UHP record so the
    // client can retry instead of showing a deleted session whose data remains.
    await this.bridge.deleteSession(record.kovaSessionId);
    for (const response of listResponsesForSession(record.kovaSessionId)) {
      deleteStoredResponse(response.id);
    }
    deleteSessionArtifacts(record.kovaSessionId);
    deleteStoredSession(id);
    return true;
  }

  /** Touch a session after a turn; keeps `updated_at` authoritative. */
  touch(id: string): void {
    const record = loadSession(id);
    if (!record) return;
    record.updatedAt = nowSeconds();
    saveSession(record);
  }

  /** Kova session id backing a UHP session (not derived by stripping a prefix). */
  kovaId(id: string): string | null {
    return loadSession(id)?.kovaSessionId ?? null;
  }

  /** Resolve either a UHP session id or a Kova session id. */
  resolveId(value: string): string | null {
    if (value.startsWith("hsess_")) return loadSession(value) ? value : null;
    const candidate = uhpSessionIdFor(value);
    return loadSession(candidate) ? candidate : null;
  }
}

function encodeCursor(row: UhpSessionRecord): string {
  return Buffer.from(`${row.updatedAt}:${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(value: string): { updatedAt: number; id: string } | null {
  try {
    const raw = Buffer.from(value, "base64url").toString("utf8");
    const index = raw.indexOf(":");
    if (index <= 0) return null;
    const updatedAt = Number(raw.slice(0, index));
    const id = raw.slice(index + 1);
    if (!Number.isFinite(updatedAt) || !id) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}
