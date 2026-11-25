/**
 * Narrow adapter from the UHP server to the existing pi-agent host bridge.
 *
 * Keeping this behind an interface lets the HTTP/task code be tested with a
 * fake sidecar and keeps Electron-specific imports out of the pure modules.
 */
import * as pi from "../pi-agent";
import type {
  UhpApprovalLevel,
  UhpBridge,
  UhpHistoryResult,
  UhpModelEntry,
  UhpSessionSummary,
} from "./types";

function parseReply(line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("pi-agent returned a malformed reply");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("pi-agent returned a non-object reply");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.errorText === "string" && record.type === "error") {
    throw new Error(record.errorText);
  }
  return record;
}

export class PiUhpBridge implements UhpBridge {
  async newSession(args: {
    threadId: string;
    cwd?: string | null;
    model?: { provider: string; modelId: string } | null;
    systemPrompt?: string | null;
    approvalLevel?: UhpApprovalLevel | null;
  }): Promise<{ sessionId: string; threadId: string }> {
    const reply = parseReply(
      await pi.piRequestInternal({
        payload: {
          type: "new_session",
          threadId: args.threadId,
          ...(args.cwd ? { cwd: args.cwd } : {}),
          ...(args.model ? { model: args.model } : {}),
          ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
        },
        timeoutMs: 30_000,
      }),
    );
    const sessionId = typeof reply.sessionId === "string" ? reply.sessionId : "";
    if (!sessionId) throw new Error("pi-agent new_session returned no sessionId");
    if (args.approvalLevel) {
      try {
        await this.setMode({
          threadId: args.threadId,
          sessionId,
          mode: "agent",
          approvalLevel: args.approvalLevel,
        });
      } catch (error) {
        // Do not leave a sidecar session behind when its security mode could
        // not be applied.
        await this.deleteSession(sessionId).catch(() => undefined);
        throw error;
      }
    }
    return {
      sessionId,
      threadId: typeof reply.threadId === "string" ? reply.threadId : args.threadId,
    };
  }

  async setMode(args: {
    threadId: string;
    sessionId: string;
    mode?: string;
    approvalLevel?: UhpApprovalLevel;
  }): Promise<void> {
    parseReply(
      await pi.piRequestInternal({
        payload: {
          type: "set_mode",
          threadId: args.threadId,
          sessionId: args.sessionId,
          mode: args.mode ?? "agent",
          ...(args.approvalLevel ? { approvalLevel: args.approvalLevel } : {}),
        },
        timeoutMs: 20_000,
      }),
    );
  }

  async setModel(args: {
    sessionId: string;
    provider: string;
    modelId: string;
  }): Promise<void> {
    parseReply(
      await pi.piRequestInternal({
        payload: {
          type: "set_model",
          sessionId: args.sessionId,
          provider: args.provider,
          modelId: args.modelId,
        },
        timeoutMs: 20_000,
      }),
    );
  }

  async prompt(args: {
    requestId: string;
    text: string;
    threadId: string;
    sessionId: string;
    cwd?: string | null;
    attachments?: unknown[] | null;
    instructions?: string | null;
    maxSteps?: number | null;
    timeoutSeconds?: number | null;
    maxOutputTokens?: number | null;
  }): Promise<void> {
    await pi.piPrompt({
      requestId: args.requestId,
      text: args.text,
      threadId: args.threadId,
      sessionId: args.sessionId,
      cwd: args.cwd ?? null,
      attachments: args.attachments ?? null,
      instructions: args.instructions ?? null,
      maxSteps: args.maxSteps ?? null,
      timeoutSeconds: args.timeoutSeconds ?? null,
      maxOutputTokens: args.maxOutputTokens ?? null,
    });
  }

  async abort(args: { threadId: string }): Promise<void> {
    await pi.piAbort({ threadId: args.threadId });
  }

  async listModels(): Promise<UhpModelEntry[]> {
    const reply = parseReply(
      await pi.piRequestInternal({
        payload: { type: "list_models", authedOnly: false },
        timeoutMs: 30_000,
      }),
    );
    const models = Array.isArray(reply.models) ? reply.models : [];
    const out: UhpModelEntry[] = [];
    for (const raw of models) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      if (typeof m.provider !== "string" || typeof m.id !== "string") continue;
      out.push({
        provider: m.provider,
        providerName: typeof m.providerName === "string" ? m.providerName : m.provider,
        id: m.id,
        name: typeof m.name === "string" ? m.name : m.id,
        enabled: m.enabled !== false,
        authed: m.authed === true,
      });
    }
    return out;
  }

  async listSessions(): Promise<UhpSessionSummary[]> {
    const reply = parseReply(
      await pi.piRequestInternal({
        payload: { type: "list_sessions" },
        timeoutMs: 30_000,
      }),
    );
    const sessions = Array.isArray(reply.sessions) ? reply.sessions : [];
    const out: UhpSessionSummary[] = [];
    for (const raw of sessions) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      if (typeof s.sessionId !== "string") continue;
      out.push({
        sessionId: s.sessionId,
        ...(typeof s.name === "string" ? { name: s.name } : {}),
        firstMessage: typeof s.firstMessage === "string" ? s.firstMessage : "",
        messageCount: typeof s.messageCount === "number" ? s.messageCount : 0,
        modified: typeof s.modified === "string" ? s.modified : new Date(0).toISOString(),
        cwd: typeof s.cwd === "string" ? s.cwd : "",
        ...(s.archived === true ? { archived: true } : {}),
      });
    }
    return out;
  }

  async getHistory(args: { sessionId: string; threadId: string }): Promise<UhpHistoryResult> {
    const reply = parseReply(
      await pi.piRequestInternal({
        payload: {
          type: "get_history",
          sessionId: args.sessionId,
          threadId: args.threadId,
        },
        timeoutMs: 30_000,
      }),
    );
    return {
      messages: Array.isArray(reply.messages) ? reply.messages : [],
      ...(typeof reply.lastSeq === "number" ? { lastSeq: reply.lastSeq } : {}),
      ...(Array.isArray(reply.pending) ? { pending: reply.pending } : {}),
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    parseReply(
      await pi.piRequestInternal({
        payload: { type: "delete_session", sessionId },
        timeoutMs: 30_000,
      }),
    );
  }

  addFrameTap(tap: (frame: Record<string, unknown>) => void): () => void {
    return pi.addFrameTap(tap);
  }
}

