/**
 * UHP task lifecycle: POST /v1/responses → Kova session/turn → SSE events.
 *
 * The service owns the response state machine and is deliberately independent
 * of node:http so it can be unit-tested with a fake bridge.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { appDataDir } from "../paths";
import { logError } from "../logging";
import {
  collectInputText,
  isUhpRecord,
  kovaSessionIdFrom,
  newResponseId,
  terminalEventFor,
  uhpSessionIdFor,
} from "uhp-protocol";
import type {
  UhpCreateResponseRequest,
  UhpMessageItem,
  UhpOutputItem,
  UhpResponse,
  UhpResponseError,
  UhpResponseMetadata,
  UhpResponseStatus,
  UhpStreamEvent,
} from "uhp-protocol";
import { loadUhpConfig } from "./settings";
import type {
  UhpActiveTask,
  UhpBridge,
  UhpFileRecord,
  UhpHarnessProfile,
  UhpModelEntry,
  UhpResponseRecord,
  UhpSessionRecord,
  UhpSseSubscriber,
} from "./types";
import {
  canonicalModelId,
  isModelAvailable,
  loadModels,
  parseModelId,
  resolveModelEntry,
} from "./model";
import { harnessDefaultModel, resolveHarness } from "./harness-registry";
import { recordArtifactsFromOutput, recordRecentWorkspaceArtifacts } from "./files";
import { usageFromTranscript } from "./usage";
import {
  deleteResponse as deleteStoredResponse,
  deleteSession as deleteStoredSession,
  listResponsesForSession,
  loadResponse,
  loadSession,
  saveResponse,
  saveSession,
} from "./store";

const MAX_EVENT_BUFFER = 4096;
const CANCEL_GRACE_MS = 10_000;
const ERROR_FINISH_GRACE_MS = 2_000;

/** Distributive omit: keeps each union member's discriminant-specific fields. */
type UhpEventDraft = UhpStreamEvent extends infer T
  ? T extends UhpStreamEvent
    ? Omit<T, "sequence_number">
    : never
  : never;

export class UhpTaskError extends Error {
  status: number;
  code: string;
  param: string | null;
  detail: Record<string, unknown> | null;
  constructor(
    status: number,
    code: string,
    message: string,
    param: string | null = null,
    detail: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
    this.detail = detail;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isTerminal(status: UhpResponseStatus): boolean {
  return status !== "in_progress";
}

function clampNumber(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeCwd(
  requested: unknown,
  harness: UhpHarnessProfile,
  workspaceRoot: string,
): string {
  const root = resolve(harness.workspace || workspaceRoot);
  const raw = typeof requested === "string" ? requested.trim() : "";
  const reject = (): never => {
    throw new UhpTaskError(
      400,
      "invalid_input",
      "metadata.cwd must stay inside the configured harness workspace.",
      "metadata.cwd",
      { workspace: root },
    );
  };
  try {
    mkdirSync(root, { recursive: true });
    const rootReal = realpathSync(root);
    if (!raw) return rootReal;
    const candidate = isAbsolute(raw) ? resolve(raw) : resolve(rootReal, raw);
    // Check the lexical path before touching the filesystem. Without this,
    // `cwd: "/tmp/outside"` would create that directory and only then fail
    // containment, letting an authenticated client write outside the workspace.
    if (!isPathWithin(rootReal, candidate)) reject();
    // A symlink inside the workspace can still escape. Verify the nearest
    // existing ancestor before creating the requested directory, then verify
    // the final real path. This avoids mkdir following a symlink outside.
    let ancestor = candidate;
    for (;;) {
      try {
        const ancestorReal = realpathSync(ancestor);
        if (!isPathWithin(rootReal, ancestorReal)) reject();
        break;
      } catch (error) {
        if (error instanceof UhpTaskError) throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) reject();
        ancestor = parent;
      }
    }
    mkdirSync(candidate, { recursive: true });
    const candidateReal = realpathSync(candidate);
    if (!isPathWithin(rootReal, candidateReal)) reject();
    return candidateReal;
  } catch (error) {
    if (error instanceof UhpTaskError) throw error;
    return reject();
  }
}

function summarizeTitle(input: string): string {
  const text = input.replace(/\s+/g, " ").trim();
  if (!text) return "UHP task";
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function sanitizeHarnessError(text: string): string {
  let out = text.trim();
  if (!out) return "The harness reported an error.";
  out = out
    .replace(/\b(?:sk|gsk|xai|hf)[-_][A-Za-z0-9_-]{10,}/g, (match) => {
      const prefix = match.split(/[-_]/, 1)[0];
      return `${prefix}-***`;
    })
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***");
  const home = homedir();
  if (home) out = out.split(home).join("~");
  try {
    const data = appDataDir();
    if (data && data.length > 1) out = out.split(data).join("<appData>");
  } catch {
    /* path helper unavailable in tests */
  }
  return out.length > 2_000 ? `${out.slice(0, 2_000)}…` : out;
}

function errorFromChunk(text: string): UhpResponseError {
  return {
    type: "harness_error",
    code: "harness_error",
    message: sanitizeHarnessError(text),
    param: null,
    detail: null,
  };
}

/** Remove client-supplied `path` fields before echoing input back to clients. */
function stripInputPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInputPaths);
  if (!isUhpRecord(value)) return value;
  const { path: _path, ...rest } = value;
  if (Array.isArray(rest.content)) {
    rest.content = rest.content.map(stripInputPaths);
  }
  return rest;
}

/** Extract text + attachments for the sidecar prompt. */
function extractPromptInput(
  input: UhpCreateResponseRequest["input"],
): {
  text: string;
  attachments: { name: string; mimeType: string; data?: string; path?: string }[];
} {
  const text = collectInputText(input);
  const attachments: {
    name: string;
    mimeType: string;
    data?: string;
    path?: string;
  }[] = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!isUhpRecord(item)) continue;
      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!isUhpRecord(part)) continue;
        if (part.type !== "input_image" && part.type !== "input_file") continue;
        const data =
          typeof part.file_data === "string"
            ? part.file_data
            : part.type === "input_image" && typeof part.image_url === "string"
              ? part.image_url
              : "";
        // Only trust a path that the file service attached alongside a file_id;
        // a client-supplied `path` without file_id would read arbitrary files.
        const path =
          typeof part.file_id === "string" && typeof part.path === "string"
            ? part.path
            : "";
        if (!data && !path) continue;
        const dataUrlMime = /^data:([^;,]+)/.exec(data)?.[1];
        const mimeType =
          typeof part.mime_type === "string"
            ? part.mime_type
            : dataUrlMime ??
              (part.type === "input_image" ? "image/png" : "application/octet-stream");
        const name =
          typeof part.filename === "string" && part.filename
            ? part.filename
            : part.type === "input_image"
              ? "image.png"
              : "file";
        attachments.push({
          name,
          mimeType,
          ...(data ? { data } : {}),
          ...(path ? { path } : {}),
        });
      }
    }
  }
  return { text, attachments };
}

export type UhpTaskServiceOptions = {
  bridge: UhpBridge;
  /** Override for tests; defaults to the SQLite-backed settings. */
  config?: () => ReturnType<typeof loadUhpConfig>;
  onPersist?: (record: UhpResponseRecord) => void;
};

export class UhpTaskService {
  private readonly bridge: UhpBridge;
  private readonly config: () => ReturnType<typeof loadUhpConfig>;
  private readonly activeByResponse = new Map<string, UhpActiveTask>();
  private readonly activeByRequest = new Map<string, UhpActiveTask>();
  private readonly activeBySession = new Map<string, UhpActiveTask>();
  private removeTap: (() => void) | null = null;
  private stopping = false;

  constructor(options: UhpTaskServiceOptions) {
    this.bridge = options.bridge;
    this.config = options.config ?? loadUhpConfig;
  }

  attach(): void {
    this.stopping = false;
    if (this.removeTap) return;
    this.removeTap = this.bridge.addFrameTap((frame) => this.handleFrame(frame));
  }

  detach(): void {
    this.removeTap?.();
    this.removeTap = null;
  }

  /** Stop the server: cancel in-flight tasks and close their SSE streams. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const tasks = [...this.activeByResponse.values()];
    await Promise.all(
      tasks.map(async (task) => {
        task.cancelled = true;
        const abortTimeout = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          timer.unref?.();
        });
        await Promise.race([
          this.bridge.abort({ threadId: task.record.threadId }).catch(() => undefined),
          abortTimeout,
        ]);
        if (!task.finishSeen) this.finalize(task, "cancelled");
      }),
    );
    this.detach();
  }

  activeCount(): number {
    return this.activeByResponse.size;
  }

  isSessionBusy(sessionId: string): boolean {
    return this.activeBySession.has(sessionId);
  }

  /** Validate + create the response/session records. Does not submit the prompt yet. */
  async prepare(body: unknown): Promise<UhpActiveTask> {
    if (this.stopping) {
      throw new UhpTaskError(503, "server_unavailable", "The UHP server is stopping.", null);
    }
    const request = this.parseRequest(body);
    const config = this.config();
    const concurrencyLimit = (): number => Math.max(1, this.config().maxConcurrentTasks);
    if (this.activeByResponse.size >= concurrencyLimit()) {
      throw new UhpTaskError(
        429,
        "rate_limit_error",
        "Too many UHP tasks are already running.",
        null,
        { max_concurrent_tasks: concurrencyLimit() },
      );
    }
    // Reject malformed input before touching the model catalog / sidecar.
    const inputError = this.validateInput(request);
    if (inputError) throw inputError;
    if (request.branch === true) {
      throw new UhpTaskError(
        400,
        "invalid_input",
        "session_branching is not enabled on this server.",
        "branch",
      );
    }
    if (request.environment !== undefined) {
      throw new UhpTaskError(
        400,
        "invalid_input",
        "environments are not enabled on this server.",
        "environment",
      );
    }

    // Load the previous response before choosing the harness/model. A
    // continuation without metadata.harness_id must inherit the previous
    // harness; otherwise a non-default harness would spuriously 409.
    let previous: UhpResponseRecord | null = null;
    if (typeof request.previous_response_id === "string") {
      previous = loadResponse(request.previous_response_id);
      if (!previous) {
        throw new UhpTaskError(
          404,
          "response_not_found",
          `Response "${request.previous_response_id}" was not found.`,
          "previous_response_id",
        );
      }
    }
    const explicitHarnessId =
      typeof request.metadata?.harness_id === "string"
        ? request.metadata.harness_id.trim()
        : "";
    const harness = explicitHarnessId
      ? resolveHarness(explicitHarnessId)
      : previous
        ? resolveHarness(previous.harnessId)
        : resolveHarness(undefined);
    if (!harness) {
      throw new UhpTaskError(404, "harness_not_found", "No matching harness was found.", "metadata.harness_id");
    }
    if (previous && previous.harnessId !== harness.id) {
      throw new UhpTaskError(
        409,
        "harness_mismatch",
        "previous_response_id belongs to a different harness.",
        "metadata.harness_id",
        { expected: previous.harnessId },
      );
    }

    const models = await loadModels(() => this.bridge.listModels());
    // A continuation keeps the model it was using when that model is still
    // available; changing the harness default must not silently switch it.
    const inheritedModel = previous
      ? resolveModelEntry(models, previous.model)
      : null;
    const requestedModel = typeof request.model === "string" ? request.model.trim() : "";
    let modelEntry: UhpModelEntry | null = null;
    if (requestedModel) {
      modelEntry = resolveModelEntry(models, requestedModel);
      if (!modelEntry || !isModelAvailable(modelEntry)) {
        throw new UhpTaskError(
          422,
          "model_unavailable",
          `Model "${requestedModel}" is not available for this harness.`,
          "model",
          { available: models.filter(isModelAvailable).map(canonicalModelId) },
        );
      }
    } else if (inheritedModel && isModelAvailable(inheritedModel)) {
      modelEntry = inheritedModel;
    } else {
      const fallback = harnessDefaultModel(harness, models);
      if (fallback) modelEntry = resolveModelEntry(models, fallback);
    }
    if (!modelEntry) {
      throw new UhpTaskError(
        422,
        "model_unavailable",
        "No model is configured or available for this harness.",
        "model",
      );
    }
    const model = canonicalModelId(modelEntry);

    if (previous) {
      if (isTerminal(previous.status) === false) {
        throw new UhpTaskError(409, "session_busy", "The session is still running.", null);
      }
      if (this.activeBySession.has(previous.sessionId)) {
        throw new UhpTaskError(409, "session_busy", "The session is busy.", null);
      }
    }

    const responseId = newResponseId();
    const threadId = `uhp-${responseId}`;
    const previousSession = previous ? loadSession(uhpSessionIdFor(previous.sessionId)) : null;
    const resolvedCwd = previous
      ? previous.cwd || previousSession?.cwd || normalizeCwd(request.metadata?.cwd, harness, config.workspaceRoot)
      : normalizeCwd(request.metadata?.cwd, harness, config.workspaceRoot);
    const session: UhpSessionRecord = previous
      ? {
          id: uhpSessionIdFor(previous.sessionId),
          harnessId: previous.harnessId,
          kovaSessionId: previous.sessionId,
          threadId: previous.threadId,
          cwd: resolvedCwd,
          title: previousSession?.title ?? "UHP task",
          createdAt: previousSession?.createdAt ?? nowSeconds(),
          updatedAt: nowSeconds(),
        }
      : await this.createSession({
          responseId,
          harness,
          model,
          threadId,
          cwd: resolvedCwd,
          request,
        });
    const createdSession = previous === null;
    const discardPreparedSession = async (): Promise<void> => {
      if (!createdSession) return;
      try {
        deleteStoredSession(session.id);
      } catch (error) {
        logError(`[uhp] failed to discard session ${session.id}: ${String(error)}`);
      }
      await this.bridge.deleteSession(session.kovaSessionId).catch(() => undefined);
    };

    const sessionId = session.kovaSessionId;
    if (this.activeBySession.has(sessionId)) {
      await discardPreparedSession();
      throw new UhpTaskError(409, "session_busy", "The session is busy.", null);
    }
    // Re-check after the awaited model/session setup: stop() may have started
    // while this request was resolving, and a task added after its snapshot
    // would never be finalized.
    if (this.stopping) {
      await discardPreparedSession();
      throw new UhpTaskError(503, "server_unavailable", "The UHP server is stopping.", null);
    }

    const promptInput = extractPromptInput(request.input);
    const text = promptInput.text;
    if (!text && promptInput.attachments.length === 0) {
      await discardPreparedSession();
      throw new UhpTaskError(
        400,
        "invalid_input",
        "input must contain text, an input_file, or an input_image.",
        "input",
      );
    }
    const title = session.title || summarizeTitle(text);
    if (previous) {
      session.updatedAt = nowSeconds();
      session.title = title;
      saveSession(session);
    }

    const ignoredFields: string[] = [];
    if (request.tools !== undefined) ignoredFields.push("tools");
    if (request.include !== undefined) ignoredFields.push("include");
    if (request.metadata?.memory !== undefined) ignoredFields.push("metadata.memory");
    // Unknown top-level fields are ignored (never rejected) and reported so a
    // client can tell the server did not act on them.
    const knownRequestFields = new Set([
      "input",
      "model",
      "metadata",
      "stream",
      "previous_response_id",
      "branch",
      "instructions",
      "store",
      "max_output_tokens",
      "max_step",
      "timeout_seconds",
      "environment",
      "tools",
      "include",
      "background",
    ]);
    for (const key of Object.keys(request as Record<string, unknown>)) {
      if (!knownRequestFields.has(key) && !ignoredFields.includes(key)) {
        ignoredFields.push(key);
      }
    }

    const metadata: UhpResponseMetadata = {
      session_id: session.id,
      harness_id: harness.id,
      ignored_fields: ignoredFields,
      ...(requestedModel && requestedModel !== model ? { requested_model: requestedModel } : {}),
    };
    const record: UhpResponseRecord = {
      id: responseId,
      object: "response",
      created_at: nowSeconds(),
      status: "in_progress",
      error: null,
      incomplete_details: null,
      previous_response_id: previous?.id ?? null,
      model,
      output: [],
      store: request.store !== false,
      usage: null,
      metadata,
      sessionId,
      cwd: resolvedCwd,
      threadId: session.threadId,
      harnessId: harness.id,
      requestId: `uhp-${responseId}`,
      // Store a path-free copy even before the HTTP layer replaces it with the
      // caller's original body; input_items must never expose server paths.
      inputItems: stripInputPaths(request.input),
      persisted: request.store !== false,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const task: UhpActiveTask = {
      record,
      status: "in_progress",
      cancelled: false,
      timedOut: false,
      error: null,
      incompleteReason: null,
      finishSeen: false,
      done,
      resolveDone,
      subscribers: new Set(),
      events: [],
      nextSequence: 0,
      output: [],
      textByContent: new Map(),
      reasoningByContent: new Map(),
      toolCalls: new Map(),
      toolOutputs: new Set(),
      startedAtMs: Date.now(),
      maxSteps: null,
      maxOutputTokens: null,
      toolSteps: 0,
      outputChars: 0,
      budgetExceeded: false,
      timeoutTimer: null,
    };
    // Re-check after all awaits: concurrent prepares can all pass the early
    // limit check while waiting for models/the sidecar. This check and the
    // map insert below are synchronous, so it is the authoritative gate.
    if (this.activeByResponse.size >= concurrencyLimit()) {
      await discardPreparedSession();
      throw new UhpTaskError(
        429,
        "rate_limit_error",
        "Too many UHP tasks are already running.",
        null,
        { max_concurrent_tasks: concurrencyLimit() },
      );
    }
    // Persist before publishing the task. A failed write must not leave an
    // active task that no later request can reach or cancel.
    if (record.persisted) {
      try {
        saveResponse(record);
      } catch (error) {
        await discardPreparedSession();
        throw error;
      }
    }
    this.activeByResponse.set(record.id, task);
    this.activeByRequest.set(record.requestId, task);
    this.activeBySession.set(sessionId, task);

    return task;
  }

  /** Submit the prepared task to the sidecar. Safe to call once. */
  async start(task: UhpActiveTask, body: unknown): Promise<void> {
    if (task.finishSeen || this.stopping) return;
    const request = this.parseRequest(body);
    const harness = resolveHarness(task.record.harnessId);
    const { text, attachments } = extractPromptInput(request.input);

    const created = this.toWireResponse(task);
    this.emit(task, {
      type: "response.created",
      sequence_number: task.nextSequence++,
      // Snapshot the empty output; `task.output` is mutated as the turn runs
      // and replaying the buffered event must not show later items.
      response: { ...created, output: [] },
    } as UhpStreamEvent);

    task.maxSteps =
      clampNumber(request.max_step, 1, 10_000) ??
      clampNumber(harness?.maxStep, 1, 10_000) ??
      null;
    task.maxOutputTokens = clampNumber(request.max_output_tokens, 1, 1_000_000);

    const timeoutSeconds =
      clampNumber(request.timeout_seconds, 1, 24 * 60 * 60) ??
      clampNumber(harness?.timeoutSeconds, 1, 24 * 60 * 60) ??
      null;
    if (timeoutSeconds) {
      task.timeoutTimer = setTimeout(() => {
        if (task.finishSeen) return;
        task.timedOut = true;
        task.incompleteReason = "timeout";
        void this.bridge.abort({ threadId: task.record.threadId }).catch(() => undefined);
        // Sidecar normally sends finish after abort; force a terminal state if
        // it is wedged so UHP clients never hang on a timed-out task.
        setTimeout(() => {
          if (!task.finishSeen) {
            this.finalize(task, task.cancelled ? "cancelled" : "incomplete");
          }
        }, 5_000).unref?.();
      }, timeoutSeconds * 1000);
      task.timeoutTimer.unref?.();
    }

    try {
      // Continuation may change model; new sessions already pinned it.
      if (task.record.previous_response_id) {
        const parsed = parseModelId(task.record.model);
        if (parsed) {
          await this.bridge.setModel({
            sessionId: task.record.sessionId,
            provider: parsed.provider,
            modelId: parsed.modelId,
          });
        }
      }
      if (this.stopping || task.finishSeen || task.timedOut) return;
      await this.bridge.prompt({
        requestId: task.record.requestId,
        text,
        threadId: task.record.threadId,
        sessionId: task.record.sessionId,
        cwd: this.cwdForTask(task),
        attachments: attachments.length > 0 ? attachments : null,
        instructions: typeof request.instructions === "string" ? request.instructions : null,
        maxSteps: clampNumber(request.max_step, 1, 10_000),
        timeoutSeconds,
        maxOutputTokens: clampNumber(request.max_output_tokens, 1, 1_000_000),
      });
    } catch (error) {
      this.failTask(
        task,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private cwdForTask(task: UhpActiveTask): string {
    const harness = resolveHarness(task.record.harnessId);
    const config = this.config();
    return task.record.cwd || resolve(harness?.workspace || config.workspaceRoot);
  }

  private async createSession(input: {
    responseId: string;
    harness: UhpHarnessProfile;
    model: string;
    threadId: string;
    cwd: string;
    request: UhpCreateResponseRequest;
  }): Promise<UhpSessionRecord> {
    const parsed = parseModelId(input.model);
    const created = await this.bridge.newSession({
      threadId: input.threadId,
      cwd: input.cwd,
      model: parsed,
      systemPrompt: input.harness.systemPrompt ?? null,
      approvalLevel: input.harness.approvalLevel ?? this.config().approvalLevel,
    });
    const session: UhpSessionRecord = {
      id: uhpSessionIdFor(created.sessionId),
      harnessId: input.harness.id,
      kovaSessionId: created.sessionId,
      threadId: created.threadId,
      cwd: input.cwd,
      title: summarizeTitle(extractPromptInput(input.request.input).text),
      createdAt: nowSeconds(),
      updatedAt: nowSeconds(),
    };
    try {
      saveSession(session);
    } catch (error) {
      await this.bridge.deleteSession(created.sessionId).catch(() => undefined);
      throw error;
    }
    return session;
  }

  private parseRequest(body: unknown): UhpCreateResponseRequest {
    if (!isUhpRecord(body)) {
      throw new UhpTaskError(400, "invalid_input", "Request body must be a JSON object.", null);
    }
    const record = body as Record<string, unknown>;
    if (!("input" in record)) {
      throw new UhpTaskError(400, "invalid_input", "input is required.", "input");
    }
    return record as unknown as UhpCreateResponseRequest;
  }

  private validateInput(request: UhpCreateResponseRequest): UhpTaskError | null {
    const raw = request as Record<string, unknown>;
    if (raw.metadata !== undefined && !isUhpRecord(raw.metadata)) {
      return new UhpTaskError(400, "invalid_input", "metadata must be an object.", "metadata");
    }
    if (isUhpRecord(raw.metadata)) {
      for (const key of ["harness_id", "cwd", "memory"]) {
        if (raw.metadata[key] !== undefined && typeof raw.metadata[key] !== "string") {
          return new UhpTaskError(400, "invalid_input", `metadata.${key} must be a string.`, `metadata.${key}`);
        }
      }
    }
    for (const key of ["model", "previous_response_id", "instructions", "environment"]) {
      if (raw[key] !== undefined && typeof raw[key] !== "string") {
        return new UhpTaskError(400, "invalid_input", `${key} must be a string.`, key);
      }
    }
    for (const key of ["stream", "store", "branch", "background"]) {
      if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
        return new UhpTaskError(400, "invalid_input", `${key} must be a boolean.`, key);
      }
    }
    for (const key of ["max_output_tokens", "max_step", "timeout_seconds"]) {
      if (raw[key] === undefined) continue;
      const n = typeof raw[key] === "number" ? raw[key] : Number(raw[key]);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        return new UhpTaskError(400, "invalid_input", `${key} must be a positive integer.`, key);
      }
    }
    const input = request.input;
    if (typeof input !== "string" && !Array.isArray(input)) {
      return new UhpTaskError(400, "invalid_input", "input must be a string or an array.", "input");
    }
    if (typeof input === "string" && !input.trim()) {
      return new UhpTaskError(400, "invalid_input", "input must not be empty.", "input");
    }
    if (Array.isArray(input)) {
      if (input.length === 0) {
        return new UhpTaskError(400, "invalid_input", "input must not be empty.", "input");
      }
      if (input.some((item) => !isUhpRecord(item))) {
        return new UhpTaskError(
          400,
          "invalid_input",
          "input items must be objects.",
          "input",
        );
      }
      const records = input.filter(isUhpRecord) as Record<string, unknown>[];
      const special = records.filter(
        (item) => item.type === "input_response" || item.type === "resume",
      );
      if (special.length > 0) {
        return new UhpTaskError(
          400,
          "invalid_input",
          "input_response/resume are not enabled on this server.",
          "input",
        );
      }
      if (request.previous_response_id === undefined) {
        const userMessages = records.filter((item) => item.role === "user");
        const assistantHistory = records.filter((item) => item.role === "assistant");
        // system/developer messages are instructions, not conversation history.
        if (userMessages.length > 1 || assistantHistory.length > 0) {
          return new UhpTaskError(
            400,
            "invalid_input",
            "input_history is not enabled; continue with previous_response_id.",
            "input",
          );
        }
      }
    }
    const parsedInput = extractPromptInput(request.input);
    if (!parsedInput.text && parsedInput.attachments.length === 0) {
      return new UhpTaskError(
        400,
        "invalid_input",
        "input must contain text, an input_file, or an input_image.",
        "input",
      );
    }
    return null;
  }

  private toWireResponse(task: UhpActiveTask): UhpResponse {
    const record = task.record;
    return {
      id: record.id,
      object: "response",
      created_at: record.created_at,
      status: task.status,
      error: task.error,
      incomplete_details: task.incompleteReason
        ? { reason: task.incompleteReason }
        : null,
      previous_response_id: record.previous_response_id,
      model: record.model,
      output: task.output,
      store: record.store,
      usage: record.usage,
      metadata: record.metadata,
    };
  }

  /** Append an event to the buffer and fan it out to SSE subscribers. */
  private emit(task: UhpActiveTask, event: UhpStreamEvent): void {
    task.events.push({ sequence: event.sequence_number, payload: event });
    if (task.events.length > MAX_EVENT_BUFFER) {
      task.events.splice(0, task.events.length - MAX_EVENT_BUFFER);
    }
    for (const subscriber of task.subscribers) {
      try {
        subscriber.write(`id: ${event.sequence_number}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        task.subscribers.delete(subscriber);
      }
    }
  }

  private nextEvent(task: UhpActiveTask, event: UhpEventDraft): UhpStreamEvent {
    return { ...event, sequence_number: task.nextSequence++ } as UhpStreamEvent;
  }

  attachSse(task: UhpActiveTask, subscriber: UhpSseSubscriber, lastEventId?: string): void {
    task.subscribers.add(subscriber);
    const last = lastEventId !== undefined ? Number(lastEventId) : NaN;
    if (Number.isFinite(last)) {
      for (const entry of task.events) {
        if (entry.sequence <= last) continue;
        try {
          subscriber.write(`id: ${entry.sequence}\ndata: ${JSON.stringify(entry.payload)}\n\n`);
        } catch {
          task.subscribers.delete(subscriber);
          return;
        }
      }
    } else if (task.events.length > 0) {
      // New subscriber: replay the full buffer so it can render the response.
      for (const entry of task.events) {
        try {
          subscriber.write(`id: ${entry.sequence}\ndata: ${JSON.stringify(entry.payload)}\n\n`);
        } catch {
          task.subscribers.delete(subscriber);
          return;
        }
      }
    }
  }

  detachSse(task: UhpActiveTask, subscriber: UhpSseSubscriber): void {
    task.subscribers.delete(subscriber);
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const id = typeof frame.id === "string" ? frame.id : null;
    if (!id) return;
    const task = this.activeByRequest.get(id);
    if (!task || task.finishSeen) return;
    const chunk = frame.chunk;
    if (!isUhpRecord(chunk)) return;
    this.handleChunk(task, chunk);
  }

  private handleChunk(task: UhpActiveTask, chunk: Record<string, unknown>): void {
    const type = typeof chunk.type === "string" ? chunk.type : "";
    switch (type) {
      case "text-start":
        this.startText(task, chunk);
        break;
      case "text-delta":
        this.deltaText(task, chunk);
        break;
      case "text-end":
        this.endText(task, chunk);
        break;
      case "reasoning-start":
        this.startReasoning(task, chunk);
        break;
      case "reasoning-delta":
        this.deltaReasoning(task, chunk);
        break;
      case "reasoning-end":
        this.endReasoning(task, chunk);
        break;
      case "tool-input-start":
        this.startToolCall(task, chunk);
        break;
      case "tool-input-delta":
        this.deltaToolCall(task, chunk);
        break;
      case "tool-input-available":
        task.toolSteps += 1;
        if (task.maxSteps !== null && task.toolSteps > task.maxSteps) {
          this.exceedBudget(task, "max_steps");
        }
        this.completeToolCall(task, chunk);
        break;
      case "tool-output-available":
      case "tool-output-error":
        this.toolOutput(task, chunk);
        break;
      case "data-truncation-stopped":
        task.incompleteReason = "max_output_tokens";
        break;
      case "error": {
        // Abort-induced errors are not user-visible harness failures.
        if (task.cancelled || task.timedOut || task.budgetExceeded) break;
        const message = typeof chunk.errorText === "string" ? chunk.errorText : "harness error";
        task.error = errorFromChunk(message);
        this.emit(
          task,
          this.nextEvent(task, {
            type: "error",
            code: task.error.code,
            message: task.error.message,
            param: null,
          }),
        );
        setTimeout(() => {
          if (!task.finishSeen) {
            this.finalize(task, task.cancelled ? "cancelled" : "failed");
          }
        }, ERROR_FINISH_GRACE_MS).unref?.();
        break;
      }
      case "finish":
        this.finalize(task, this.statusForFinish(task));
        break;
      default:
        // data-* / metadata chunks are additive; ignore unknown types.
        break;
    }
  }

  /** Approximate output-token budget: ~4 chars/token across text + reasoning. */
  private noteOutputChars(task: UhpActiveTask, chars: number): void {
    if (chars <= 0) return;
    task.outputChars += chars;
    if (
      task.maxOutputTokens !== null &&
      task.outputChars > task.maxOutputTokens * 4
    ) {
      this.exceedBudget(task, "max_output_tokens");
    }
  }

  private exceedBudget(task: UhpActiveTask, reason: string): void {
    if (task.budgetExceeded) return;
    task.budgetExceeded = true;
    task.incompleteReason = reason;
    void this.bridge.abort({ threadId: task.record.threadId }).catch(() => undefined);
    setTimeout(() => {
      if (!task.finishSeen) {
        this.finalize(task, task.cancelled ? "cancelled" : "incomplete");
      }
    }, 5_000).unref?.();
  }

  private textState(task: UhpActiveTask, contentId: string) {
    return task.textByContent.get(contentId) ?? null;
  }

  private startText(task: UhpActiveTask, chunk: Record<string, unknown>): void {
    const contentId = typeof chunk.id === "string" ? chunk.id : `text-${task.output.length}`;
    if (task.textByContent.has(contentId)) return;
    const outputIndex = task.output.length;
    const itemId = `msg_${contentId}`;
    const item = {
      id: itemId,
      type: "message" as const,
      role: "assistant" as const,
      status: "in_progress" as const,
      content: [{ type: "output_text" as const, text: "", annotations: [] }],
    };
    task.output.push(item);
    task.textByContent.set(contentId, { itemId, outputIndex, contentIndex: 0, text: "" });
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.output_item.added",
        output_index: outputIndex,
        // Shell item: the content part is opened by content_part.added next.
        item: { ...item, content: [] },
      }),
    );
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.content_part.added",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
    );
  }

  private deltaText(task: UhpActiveTask, chunk: Record<string, unknown>): void {
    const contentId = typeof chunk.id === "string" ? chunk.id : "";
    const delta = typeof chunk.delta === "string" ? chunk.delta : "";
    if (!contentId || !delta) return;
    let state = task.textByContent.get(contentId);
    if (!state) {
      this.startText(task, chunk);
      state = task.textByContent.get(contentId);
      if (!state) return;
    }
    state.text += delta;
    this.noteOutputChars(task, delta.length);
    const item = task.output[state.outputIndex] as { content?: { text?: string }[] } | undefined;
    if (item?.content?.[0]) item.content[0].text = state.text;
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.output_text.delta",
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: state.contentIndex,
        delta,
      }),
    );
  }

  private endText(task: UhpActiveTask, chunk: Record<string, unknown>): void {
    const contentId = typeof chunk.id === "string" ? chunk.id : "";
    const state = contentId ? task.textByContent.get(contentId) : null;
    if (!state) return;
    const item = task.output[state.outputIndex] as
      | { status?: string; content?: { type: string; text: string; annotations: unknown[] }[] }
      | undefined;
    if (item) item.status = "completed";
    const part = { type: "output_text" as const, text: state.text, annotations: [] };
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.output_text.done",
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: state.contentIndex,
        text: state.text,
      }),
    );
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.content_part.done",
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: state.contentIndex,
        part,
      }),
    );
    if (item) {
      this.emit(
        task,
        this.nextEvent(task, {
          type: "response.output_item.done",
          output_index: state.outputIndex,
          item: item as unknown as UhpOutputItem,
        }),
      );
    }
  }

  private startReasoning(task: UhpActiveTask, chunk: Record<string, unknown>): void {
    const contentId = typeof chunk.id === "string" ? chunk.id : `reasoning-${task.output.length}`;
    if (task.reasoningByContent.has(contentId)) return;
    const outputIndex = task.output.length;
    const itemId = `rs_${contentId}`;
    const item = {
      id: itemId,
      type: "reasoning" as const,
      status: "in_progress" as const,
      summary: [{ type: "summary_text" as const, text: "" }],
    };
    task.output.push(item);
    task.reasoningByContent.set(contentId, {
      itemId,
      outputIndex,
      summaryIndex: 0,
      text: "",
    });
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.output_item.added",
        output_index: outputIndex,
        // Shell item: the summary part is opened by the next event.
        item: { ...item, summary: [] },
      }),
    );
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.reasoning_summary_part.added",
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
    );
  }

  private deltaReasoning(task: UhpActiveTask, chunk: Record<string, unknown>): void {
    const contentId = typeof chunk.id === "string" ? chunk.id : "";
    const delta = typeof chunk.delta === "string" ? chunk.delta : "";
    if (!contentId || !delta) return;
    let state = task.reasoningByContent.get(contentId);
    if (!state) {
      this.startReasoning(task, chunk);
      state = task.reasoningByContent.get(contentId);
      if (!state) return;
    }
    state.text += delta;
    this.noteOutputChars(task, delta.length);
    const item = task.output[state.outputIndex] as
      | { summary?: { text?: string }[] }
      | undefined;
    if (item?.summary?.[0]) item.summary[0].text = state.text;
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.reasoning_summary_text.delta",
        item_id: state.itemId,
        output_index: state.outputIndex,
        summary_index: state.summaryIndex,
        delta,
      }),
    );
  }

  private endReasoning(task: UhpActiveTask, chunk: Record<string, unknown>): void {
    const contentId = typeof chunk.id === "string" ? chunk.id : "";
    const state = contentId ? task.reasoningByContent.get(contentId) : null;
    if (!state) return;
    const item = task.output[state.outputIndex] as
      | { status?: string; summary?: { type: string; text: string }[] }
      | undefined;
    if (item) item.status = "completed";
    const part = { type: "summary_text" as const, text: state.text };
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.reasoning_summary_part.done",
        item_id: state.itemId,
        output_index: state.outputIndex,
        summary_index: state.summaryIndex,
        part,
      }),
    );
    if (item) {
      this.emit(
        task,
        this.nextEvent(task, {
          type: "response.output_item.done",
          output_index: state.outputIndex,
          item: item as unknown as UhpOutputItem,
        }),
      );
    }
  }

  private startToolCall(task: UhpActiveTask, chunk: Record<string, unknown>): void {
    const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : "";
    if (!toolCallId || task.toolCalls.has(toolCallId)) return;
    const outputIndex = task.output.length;
    const itemId = `fc_${toolCallId}`;
    const name = typeof chunk.toolName === "string" ? chunk.toolName : "tool";
    const item = {
      id: itemId,
      type: "function_call" as const,
      call_id: toolCallId,
      name,
      arguments: "",
      status: "in_progress" as const,
    };
    task.output.push(item);
    task.toolCalls.set(toolCallId, { itemId, outputIndex, name, arguments: "" });
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      }),
    );
  }

  private deltaToolCall(task: UhpActiveTask, chunk: Record<string, unknown>): void {
    const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : "";
    const delta = typeof chunk.inputTextDelta === "string" ? chunk.inputTextDelta : "";
    if (!toolCallId || !delta) return;
    let state = task.toolCalls.get(toolCallId);
    if (!state) {
      this.startToolCall(task, chunk);
      state = task.toolCalls.get(toolCallId);
      if (!state) return;
    }
    state.arguments += delta;
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.function_call_arguments.delta",
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta,
      }),
    );
  }

  private completeToolCall(task: UhpActiveTask, chunk: Record<string, unknown>): void {
    const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : "";
    if (!toolCallId) return;
    let state = task.toolCalls.get(toolCallId);
    if (!state) {
      this.startToolCall(task, chunk);
      state = task.toolCalls.get(toolCallId);
      if (!state) return;
    }
    const args =
      typeof chunk.input === "string"
        ? chunk.input
        : JSON.stringify(chunk.input ?? state.arguments ?? {});
    state.arguments = args;
    const item = task.output[state.outputIndex] as
      | { arguments?: string; status?: string }
      | undefined;
    if (item) {
      item.arguments = args;
      item.status = "completed";
    }
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.function_call_arguments.done",
        item_id: state.itemId,
        output_index: state.outputIndex,
        arguments: args,
      }),
    );
    if (item) {
      this.emit(
        task,
        this.nextEvent(task, {
          type: "response.output_item.done",
          output_index: state.outputIndex,
          item: item as unknown as UhpOutputItem,
        }),
      );
    }
  }

  private toolOutput(task: UhpActiveTask, chunk: Record<string, unknown>): void {
    const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : "";
    if (!toolCallId || task.toolOutputs.has(toolCallId)) return;
    task.toolOutputs.add(toolCallId);
    const outputIndex = task.output.length;
    const itemId = `fco_${toolCallId}`;
    const isError = chunk.type === "tool-output-error";
    const raw = isError ? chunk.errorText : chunk.output;
    const output = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
    const item = {
      id: itemId,
      type: "function_call_output" as const,
      call_id: toolCallId,
      output,
      status: "completed" as const,
    };
    task.output.push(item);
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      }),
    );
    this.emit(
      task,
      this.nextEvent(task, {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      }),
    );
  }

  private statusForFinish(task: UhpActiveTask): UhpResponseStatus {
    if (task.cancelled) return "cancelled";
    // Budget/timeout aborts can make the sidecar emit an error chunk; the
    // user-visible outcome is still `incomplete`, not a harness failure.
    if (task.timedOut || task.budgetExceeded) return "incomplete";
    if (task.error) return "failed";
    if (task.incompleteReason) return "incomplete";
    return "completed";
  }

  private finalize(task: UhpActiveTask, status: UhpResponseStatus): void {
    if (task.finishSeen) return;
    task.finishSeen = true;
    task.status = status;
    if (task.timeoutTimer) {
      clearTimeout(task.timeoutTimer);
      task.timeoutTimer = null;
    }
    if (status === "failed" && !task.error) {
      task.error = {
        type: "harness_error",
        code: "harness_error",
        message: "The harness ended without a result.",
        param: null,
        detail: null,
      };
    }
    if (status === "cancelled") task.error = null;
    if (status === "incomplete" && (task.timedOut || task.budgetExceeded)) {
      task.error = null;
    }
    if (status !== "incomplete") task.incompleteReason = null;

    // Close any text/reasoning items left open by an abrupt end.
    for (const item of task.output) {
      if (
        (item.type === "message" || item.type === "reasoning" || item.type === "function_call") &&
        "status" in item &&
        item.status === "in_progress"
      ) {
        item.status = status === "completed" ? "completed" : "incomplete";
      }
    }

    // Artifacts: copy files created by write/edit into the UHP artifact store
    // and attach container_file_citation annotations to the final message.
    try {
      const artifacts = recordArtifactsFromOutput({
        sessionId: task.record.sessionId,
        responseId: task.record.id,
        cwd: task.record.cwd,
        output: task.output,
      });
      // Fallback for files created by bash/build tools rather than write/edit.
      artifacts.push(
        ...recordRecentWorkspaceArtifacts({
          sessionId: task.record.sessionId,
          responseId: task.record.id,
          cwd: task.record.cwd,
          sinceMs: task.startedAtMs,
        }),
      );
      if (artifacts.length > 0) attachArtifactAnnotations(task.output, artifacts);
    } catch {
      /* artifact capture must not fail the task */
    }

    task.record.status = status;
    task.record.error = task.error;
    task.record.incomplete_details = task.incompleteReason
      ? ({ reason: task.incompleteReason } as UhpResponse["incomplete_details"])
      : null;
    task.record.output = task.output;
    task.record.updatedAtMs = Date.now();
    try {
      const usage = usageFromTranscript(task.record.sessionId, task.startedAtMs);
      if (usage) task.record.usage = usage;
    } catch {
      /* usage accounting must not fail the task */
    }
    if (task.record.persisted) {
      try {
        saveResponse(task.record);
      } catch (error) {
        // A storage failure must not keep the SSE stream open forever.
        logError(`[uhp] failed to persist response ${task.record.id}: ${String(error)}`);
      }
    }

    const response = this.toWireResponse(task);
    this.emit(task, {
      type: terminalEventFor(response),
      sequence_number: task.nextSequence++,
      response,
    } as UhpStreamEvent);

    try {
      const session = loadSession(task.record.metadata.session_id);
      if (session) {
        session.updatedAt = nowSeconds();
        saveSession(session);
      }
    } catch (error) {
      logError(`[uhp] failed to touch session ${task.record.metadata.session_id}: ${String(error)}`);
    }

    for (const subscriber of task.subscribers) {
      try {
        subscriber.end();
      } catch {
        /* ignore */
      }
    }
    task.subscribers.clear();
    this.activeByResponse.delete(task.record.id);
    this.activeByRequest.delete(task.record.requestId);
    this.activeBySession.delete(task.record.sessionId);
    task.resolveDone();
  }

  private failTask(task: UhpActiveTask, message: string): void {
    task.error = errorFromChunk(message);
    this.finalize(task, "failed");
  }

  /** Replace the stored input with the caller's original body (before file_id
   *  resolution) so `input_items` never exposes server-local attachment paths.
   *  Client-supplied `path` fields are stripped as well; they are never part of
   *  the UHP input contract. */
  setInputItems(task: UhpActiveTask, input: unknown): void {
    task.record.inputItems = stripInputPaths(input);
    if (task.record.persisted) {
      try {
        saveResponse(task.record);
      } catch (error) {
        logError(`[uhp] failed to persist input items for ${task.record.id}: ${String(error)}`);
      }
    }
  }

  /** Snapshot for a task handle; valid even after store:false completes. */
  snapshot(task: UhpActiveTask): UhpResponse {
    return this.toWireResponse(task);
  }

  getResponse(id: string): UhpResponse | null {
    const active = this.activeByResponse.get(id);
    if (active) return this.toWireResponse(active);
    const record = loadResponse(id);
    if (!record || !record.persisted) return null;
    return toPublicResponse(record);
  }

  getInputItems(id: string): unknown[] | null {
    const active = this.activeByResponse.get(id);
    const record = active?.record ?? loadResponse(id);
    if (!record || (!active && !record.persisted)) return null;
    const input = record.inputItems;
    if (typeof input === "string") {
      return [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: input }],
        },
      ];
    }
    if (!Array.isArray(input)) return [];
    // Older records / alternate clients may omit the `message` discriminant.
    // input_items is a Responses-style list, so normalize plain role items.
    return input.map((item) =>
      isUhpRecord(item) && item.type === undefined && typeof item.role === "string"
        ? { type: "message", ...item }
        : item,
    );
  }

  async cancelResponse(id: string): Promise<UhpResponse | null> {
    const active = this.activeByResponse.get(id);
    if (!active) {
      const record = loadResponse(id);
      return record ? toPublicResponse(record) : null;
    }
    if (active.finishSeen) return this.toWireResponse(active);
    active.cancelled = true;
    // Bound the abort RPC itself: a wedged sidecar must not hang the cancel
    // endpoint forever. The task is still finalized below even if it does.
    const abortTimeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref?.();
    });
    await Promise.race([
      this.bridge.abort({ threadId: active.record.threadId }).catch(() => undefined),
      abortTimeout,
    ]);
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CANCEL_GRACE_MS);
      timer.unref?.();
    });
    await Promise.race([active.done, timeout]);
    if (!active.finishSeen) this.finalize(active, "cancelled");
    return this.toWireResponse(active);
  }

  async cancelSession(sessionId: string): Promise<boolean> {
    const uhpSessionId = sessionId.startsWith("hsess_") ? sessionId : uhpSessionIdFor(sessionId);
    const active = [...this.activeByResponse.values()].find(
      (task) => task.record.metadata.session_id === uhpSessionId,
    );
    if (!active) return false;
    await this.cancelResponse(active.record.id);
    return true;
  }

  deleteResponse(id: string): boolean {
    if (this.activeByResponse.has(id)) {
      throw new UhpTaskError(409, "response_busy", "The response is still running.", null);
    }
    const record = loadResponse(id);
    if (!record) return false;
    deleteStoredResponse(id);
    return true;
  }

  listSessionTurns(sessionId: string): UhpResponse[] {
    const uhp = sessionId.startsWith("hsess_") ? sessionId : uhpSessionIdFor(sessionId);
    const kova = loadSession(uhp)?.kovaSessionId ?? kovaSessionIdFrom(uhp) ?? uhp;
    return listResponsesForSession(kova)
      .filter((record) => record.persisted)
      .sort(
        (a, b) =>
          (a.createdAtMs ?? a.created_at * 1000) -
            (b.createdAtMs ?? b.created_at * 1000) || a.id.localeCompare(b.id),
      )
      .map(toPublicResponse);
  }
}

/** Strip host-only fields (cwd/threadId/requestId/inputItems) from stored records. */
function toPublicResponse(record: UhpResponseRecord): UhpResponse {
  return {
    id: record.id,
    object: "response",
    created_at: record.created_at,
    status: record.status,
    error: record.error,
    incomplete_details: record.incomplete_details,
    previous_response_id: record.previous_response_id,
    model: record.model,
    output: record.output,
    store: record.store,
    usage: record.usage,
    metadata: record.metadata,
  };
}

/** Attach container_file_citation annotations to the final assistant message. */
function attachArtifactAnnotations(
  output: UhpOutputItem[],
  artifacts: UhpFileRecord[],
): void {
  const message = [...output]
    .reverse()
    .find((item) => item.type === "message") as UhpMessageItem | undefined;
  if (!message || !Array.isArray(message.content)) return;
  const text = message.content.find((part) => part.type === "output_text") as
    | { type: "output_text"; text: string; annotations: unknown[] }
    | undefined;
  if (!text) return;
  for (const artifact of artifacts) {
    const containerId = artifact.containerId ?? `cntr_${artifact.sessionId ?? "unknown"}`;
    text.annotations.push({
      type: "container_file_citation",
      container_id: containerId,
      file_id: artifact.id,
      filename: artifact.filename,
      download_url: `/v1/containers/${containerId}/files/${artifact.id}/content`,
      start_index: 0,
      end_index: text.text.length,
    });
  }
}
