/**
 * UHP server internal types. Wire objects live in uhp-protocol; this file is
 * host-side state and the narrow bridge to the pi-agent sidecar.
 */
import type {
  UhpResponse,
  UhpResponseStatus,
  UhpSession,
} from "uhp-protocol";

export type UhpApprovalLevel =
  | "ask"
  | "workspace-write"
  | "auto-edit"
  | "review"
  | "auto";

export type UhpHarnessProfile = {
  id: string;
  name: string;
  base: string;
  baseLabel?: string;
  defaultModel?: string | null;
  systemPrompt?: string | null;
  approvalLevel?: UhpApprovalLevel;
  /** Server-side default workspace. Not exposed as a UHP object field. */
  workspace?: string | null;
  maxStep?: number | null;
  timeoutSeconds?: number | null;
  createdAt: number;
  enabled?: boolean;
};

export type UhpResponseRecord = UhpResponse & {
  /** Kova session id (no `hsess_` prefix). */
  sessionId: string;
  /** Resolved working directory used for this task. */
  cwd: string;
  /** Kova thread id; stable for the process lifetime, recreated after restart. */
  threadId: string;
  harnessId: string;
  /** Sidecar request id used to route stream frames. */
  requestId: string;
  /** Original request input, returned by GET /v1/responses/{id}/input_items. */
  inputItems: unknown;
  /** Whether the response should survive in the store. */
  persisted: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  /** Transcript seq range covered by this response, when known. */
  seqStart?: number;
  seqEnd?: number;
};

export type UhpSessionRecord = {
  /** UHP session id (`hsess_...`). */
  id: string;
  harnessId: string;
  kovaSessionId: string;
  threadId: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type UhpFileRecord = {
  id: string;
  filename: string;
  bytes: number;
  createdAt: number;
  /** Absolute path under the UHP file/artifact root. */
  path: string;
  /** Original source path for artifacts (dedupe across turns). */
  sourcePath?: string;
  sessionId?: string;
  /** UHP response that produced this artifact (turn attribution). */
  responseId?: string;
  containerId?: string;
  source: "upload" | "artifact";
};

export type UhpServerConfig = {
  enabled: boolean;
  port: number;
  bind: "loopback";
  workspaceRoot: string;
  defaultHarnessId: string | null;
  approvalLevel: UhpApprovalLevel;
  maxConcurrentTasks: number;
  responseRetentionDays: number;
  /** AES ciphertext of the bearer token, or null before first enable. */
  apiKeyCipher: string | null;
};

export type UhpModelEntry = {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  enabled: boolean;
  authed: boolean;
};

export type UhpSessionSummary = {
  sessionId: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  modified: string;
  cwd: string;
  archived?: boolean;
};

export type UhpHistoryResult = {
  messages: unknown[];
  lastSeq?: number;
  pending?: unknown[];
};

/** Narrow host bridge so the UHP server is unit-testable without Electron. */
export interface UhpBridge {
  newSession(args: {
    threadId: string;
    cwd?: string | null;
    model?: { provider: string; modelId: string } | null;
    systemPrompt?: string | null;
    approvalLevel?: UhpApprovalLevel | null;
  }): Promise<{ sessionId: string; threadId: string }>;
  setMode(args: {
    threadId: string;
    sessionId: string;
    mode?: string;
    approvalLevel?: UhpApprovalLevel;
  }): Promise<void>;
  setModel(args: {
    sessionId: string;
    provider: string;
    modelId: string;
  }): Promise<void>;
  prompt(args: {
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
  }): Promise<void>;
  abort(args: { threadId: string }): Promise<void>;
  listModels(): Promise<UhpModelEntry[]>;
  listSessions(): Promise<UhpSessionSummary[]>;
  getHistory(args: { sessionId: string; threadId: string }): Promise<UhpHistoryResult>;
  deleteSession(sessionId: string): Promise<void>;
  addFrameTap(tap: (frame: Record<string, unknown>) => void): () => void;
}

export type UhpActiveTask = {
  record: UhpResponseRecord;
  status: UhpResponseStatus;
  cancelled: boolean;
  timedOut: boolean;
  error: UhpResponse["error"];
  incompleteReason: string | null;
  finishSeen: boolean;
  /** Resolves when the task reaches a terminal state. */
  done: Promise<void>;
  resolveDone: () => void;
  /** SSE subscribers for this response. */
  subscribers: Set<UhpSseSubscriber>;
  /** Bounded event history for Last-Event-ID resume. */
  events: { sequence: number; payload: unknown }[];
  nextSequence: number;
  /** Accumulated output items keyed by output index. */
  output: UhpResponse["output"];
  textByContent: Map<string, { itemId: string; outputIndex: number; contentIndex: number; text: string }>;
  reasoningByContent: Map<string, { itemId: string; outputIndex: number; summaryIndex: number; text: string }>;
  toolCalls: Map<string, { itemId: string; outputIndex: number; name: string; arguments: string }>;
  toolOutputs: Set<string>;
  startedAtMs: number;
  /** Budgets enforced in the adapter (approximate for output tokens). */
  maxSteps: number | null;
  maxOutputTokens: number | null;
  toolSteps: number;
  outputChars: number;
  budgetExceeded: boolean;
  timeoutTimer?: NodeJS.Timeout | null;
};

export type UhpSseSubscriber = {
  write: (chunk: string) => void;
  end: () => void;
};

export type UhpStoredSession = UhpSessionRecord & {
  /** Cached UHP object; rebuilt on read to keep timestamps consistent. */
  object?: UhpSession;
};
