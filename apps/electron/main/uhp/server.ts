/**
 * UHP HTTP + SSE server.
 *
 * Runs in the Electron main process next to the existing remote gateway. It is
 * deliberately a separate listener: the remote gateway is a paired-device UX,
 * while UHP is an API with its own bearer token and version negotiation.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename } from "node:path";
import {
  UHP_PROTOCOL_VERSION,
  UHP_SUPPORTED_VERSIONS,
  discoveryDocument,
  extendedCapabilities,
  uhpError,
} from "uhp-protocol";
import type { UhpCapabilities, UhpFile } from "uhp-protocol";
import { logError, logInfo } from "../logging";
import { isAuthorized } from "./auth";
import {
  HttpBodyError,
  UHP_VERSION_HEADER,
  baseHeaders,
  decodeSegment,
  methodNotAllowed,
  notFound,
  pathnameOf,
  queryOf,
  readJsonBody,
  readRawBody,
  sendError,
  sendJson,
  sendNoContent,
} from "./http";
import { loadUhpConfig } from "./settings";
import type { UhpServerConfig } from "./types";
import { UhpTaskError, UhpTaskService } from "./task-service";
import { UhpSessionService } from "./session-service";
import type { UhpBridge, UhpSseSubscriber } from "./types";
import {
  archiveSessionArtifacts,
  listSessionArtifacts,
  mimeTypeOf,
  parseMultipart,
  pruneOldUploads,
  readContainerFile,
  resolveInputFileIds,
  saveUpload,
  UHP_MAX_ARCHIVE_BYTES,
  UHP_MAX_UPLOAD_BYTES,
  UhpArchiveTooLargeError,
  UhpInputFileError,
} from "./files";
import {
  buildHarnessModelsResponse,
  buildModelsResponse,
  loadModels,
} from "./model";
import {
  ensureDefaultHarness,
  listEnabledHarnesses,
  resolveHarness,
  toWireHarness,
} from "./harness-registry";
import { markInterruptedResponses, pruneOldResponses } from "./store";
import { UHP_DEMO_HTML } from "./demo";

export type UhpServerOptions = {
  bridge: UhpBridge;
  getToken: () => string | null;
  getConfig?: () => UhpServerConfig;
};

export type UhpServerStatus = {
  running: boolean;
  port: number | null;
  url: string | null;
  conformanceClass: "extended";
};

function contentDisposition(filename: string): string {
  // HTTP header values must be ASCII. Keep readable ASCII where possible and
  // provide the exact Unicode name through RFC 5987 `filename*`.
  const base = basename(filename)
    .replace(/[\u0000-\u001f\u007f\r\n]/g, "")
    .slice(0, 200) || "download";
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(base).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function requestedVersion(req: IncomingMessage): string | null {
  const value = headerValue(req, UHP_VERSION_HEADER)?.trim();
  return value ? value : null;
}

function supportedCapabilities(): UhpCapabilities {
  // V1: Core + Extended. Optional capabilities are explicitly false.
  return extendedCapabilities();
}

export class UhpServer {
  private readonly bridge: UhpBridge;
  private readonly getToken: () => string | null;
  private readonly getConfig: () => UhpServerConfig;
  private server: Server | null = null;
  private port: number | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private readonly tasks: UhpTaskService;
  private readonly sessions: UhpSessionService;

  constructor(options: UhpServerOptions) {
    this.bridge = options.bridge;
    this.getToken = options.getToken;
    this.getConfig = options.getConfig ?? loadUhpConfig;
    this.tasks = new UhpTaskService({ bridge: options.bridge, config: this.getConfig });
    this.sessions = new UhpSessionService(options.bridge, this.tasks);
  }

  status(): UhpServerStatus {
    return {
      running: this.server !== null,
      port: this.port,
      url: this.port ? `http://127.0.0.1:${this.port}` : null,
      conformanceClass: "extended",
    };
  }

  taskService(): UhpTaskService {
    return this.tasks;
  }

  sessionService(): UhpSessionService {
    return this.sessions;
  }

  async start(port?: number | null): Promise<UhpServerStatus> {
    if (this.server) return this.status();
    const config = this.getConfig();
    const listenPort = typeof port === "number" ? port : config.port;
    try {
      // Do not let a cold sidecar/model query delay the HTTP listener forever.
      await Promise.race([
        ensureDefaultHarness(() => loadModels(() => this.bridge.listModels())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref?.()),
      ]);
    } catch (error) {
      logError(`[uhp] harness bootstrap failed: ${String(error)}`);
    }
    try {
      const interrupted = markInterruptedResponses();
      if (interrupted > 0) logInfo(`[uhp] marked ${interrupted} interrupted response(s)`);
      pruneOldResponses(config.responseRetentionDays);
      const uploads = pruneOldUploads(config.responseRetentionDays);
      if (uploads > 0) logInfo(`[uhp] pruned ${uploads} expired upload(s)`);
    } catch (error) {
      logError(`[uhp] response retention failed: ${String(error)}`);
    }
    this.tasks.attach();
    this.pruneTimer = setInterval(() => {
      try {
        const current = this.getConfig();
        pruneOldResponses(current.responseRetentionDays);
        pruneOldUploads(current.responseRetentionDays);
      } catch (error) {
        logError(`[uhp] periodic retention failed: ${String(error)}`);
      }
    }, 6 * 60 * 60 * 1000);
    this.pruneTimer.unref?.();
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (error instanceof UhpTaskError) {
          this.handleTaskError(res, error);
          return;
        }
        if (error instanceof HttpBodyError) {
          const mapped = uhpError(
            error.status === 413 ? "file_too_large" : "invalid_input",
            error.message,
            { status: error.status },
          );
          sendError(res, mapped.status, mapped.body);
          return;
        }
        this.handleUnexpected(res, error);
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", (error) =>
          reject(new Error(`failed to bind 127.0.0.1:${listenPort}: ${String(error)}`)),
        );
        server.listen(listenPort, "127.0.0.1", () => resolve());
      });
    } catch (error) {
      this.tasks.detach();
      if (this.pruneTimer) {
        clearInterval(this.pruneTimer);
        this.pruneTimer = null;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("EADDRINUSE")) {
        throw new Error(`UHP port ${listenPort} is already in use; choose another port.`);
      }
      throw error;
    }
    this.server = server;
    const address = server.address();
    this.port =
      address && typeof address === "object" && "port" in address
        ? Number(address.port)
        : listenPort;
    logInfo(`[uhp] server listening on http://127.0.0.1:${this.port}`);
    return this.status();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    try {
      await this.tasks.shutdown();
    } catch (error) {
      logError(`[uhp] task shutdown failed: ${String(error)}`);
    }
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Do not wait forever for keep-alive sockets.
      setTimeout(resolve, 2_000).unref?.();
    });
    logInfo("[uhp] server stopped");
  }

  private handleUnexpected(res: ServerResponse, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logError(`[uhp] request failed: ${message}`);
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    const mapped = uhpError("server_error", "The UHP server failed to complete the request.");
    sendError(res, mapped.status, mapped.body);
  }

  private handleTaskError(res: ServerResponse, error: UhpTaskError): void {
    const mapped = uhpError(error.code, error.message, {
      status: error.status,
      param: error.param,
      detail: error.detail,
    });
    sendError(res, mapped.status, mapped.body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = pathnameOf(req.url);

    // Version negotiation runs before auth so clients get the supported list.
    const requested = requestedVersion(req);
    if (requested && !UHP_SUPPORTED_VERSIONS.includes(requested)) {
      const mapped = uhpError(
        "unsupported_protocol_version",
        `Unsupported UHP version "${requested}".`,
        { param: null, detail: { supported_versions: [...UHP_SUPPORTED_VERSIONS] } },
      );
      sendError(res, mapped.status, mapped.body);
      return;
    }

    // Browser demo: same origin as /v1, so no CORS changes are needed.
    if (req.method === "GET" && path === "/demo") {
      res.writeHead(200, {
        ...baseHeaders(),
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(UHP_DEMO_HTML);
      return;
    }
    if (req.method === "GET" && path === "/") {
      res.writeHead(302, { ...baseHeaders(), Location: "/demo" });
      res.end();
      return;
    }

    const segments = path.split("/").filter(Boolean);
    if (segments[0] !== "v1") {
      notFound(res);
      return;
    }

    // Discovery is public by design.
    if (req.method === "GET" && segments.length === 2 && segments[1] === "uhp") {
      sendJson(
        res,
        200,
        discoveryDocument({
          capabilities: supportedCapabilities(),
          conformanceClass: "extended",
          implementation: {
            name: "kova",
            runtime: "electron-main",
            protocol: UHP_PROTOCOL_VERSION,
          },
        }),
      );
      return;
    }

    if (!isAuthorized(req, this.getToken())) {
      const mapped = uhpError("authentication_error", "A valid bearer token is required.", {
        type: "authentication_error",
        status: 401,
      });
      sendError(res, mapped.status, mapped.body, {
        "WWW-Authenticate": 'Bearer realm="uhp"',
      });
      return;
    }

    const method = req.method ?? "GET";
    if (segments[1] === "harnesses") {
      await this.handleHarnesses(req, res, method, segments);
      return;
    }
    if (segments[1] === "models") {
      if (method !== "GET" || segments.length !== 2) {
        methodNotAllowed(res, ["GET"]);
        return;
      }
      const models = await loadModels(() => this.bridge.listModels());
      const harness = resolveHarness(null);
      sendJson(res, 200, buildModelsResponse(models, harness?.defaultModel ?? null));
      return;
    }
    if (segments[1] === "responses") {
      await this.handleResponses(req, res, method, segments);
      return;
    }
    if (segments[1] === "sessions") {
      await this.handleSessions(req, res, method, segments);
      return;
    }
    if (segments[1] === "files") {
      await this.handleFiles(req, res, method, segments);
      return;
    }
    if (segments[1] === "containers") {
      await this.handleContainers(req, res, method, segments);
      return;
    }
    notFound(res);
  }

  private async handleHarnesses(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    segments: string[],
  ): Promise<void> {
    if (segments.length === 2) {
      if (method !== "GET") {
        methodNotAllowed(res, ["GET"]);
        return;
      }
      let harnesses = listEnabledHarnesses();
      if (harnesses.length === 0) {
        try {
          await ensureDefaultHarness(() => loadModels(() => this.bridge.listModels()));
          harnesses = listEnabledHarnesses();
        } catch (error) {
          logError(`[uhp] lazy harness bootstrap failed: ${String(error)}`);
        }
      }
      sendJson(res, 200, {
        object: "list",
        data: harnesses.map(toWireHarness),
      });
      return;
    }
    const harnessId = decodeSegment(segments[2] ?? "");
    if (!harnessId) {
      notFound(res);
      return;
    }
    if (segments.length === 4 && segments[3] === "models") {
      if (method !== "GET") {
        methodNotAllowed(res, ["GET"]);
        return;
      }
      const harness = resolveHarness(harnessId);
      if (!harness) {
        const mapped = uhpError("harness_not_found", "No matching harness was found.");
        sendError(res, mapped.status, mapped.body);
        return;
      }
      const models = await loadModels(() => this.bridge.listModels());
      sendJson(res, 200, buildHarnessModelsResponse(harness, models));
      return;
    }
    if (segments.length !== 3) {
      notFound(res);
      return;
    }
    if (method !== "GET") {
      methodNotAllowed(res, ["GET"]);
      return;
    }
    const harness = resolveHarness(harnessId);
    if (!harness) {
      const mapped = uhpError("harness_not_found", "No matching harness was found.");
      sendError(res, mapped.status, mapped.body);
      return;
    }
    sendJson(res, 200, toWireHarness(harness));
  }

  private async handleResponses(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    segments: string[],
  ): Promise<void> {
    if (segments.length === 2) {
      if (method !== "POST") {
        methodNotAllowed(res, ["POST"]);
        return;
      }
      const raw = await readJsonBody(req);
      const rawBody =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      let body: Record<string, unknown>;
      try {
        body = resolveInputFileIds(rawBody);
      } catch (error) {
        if (error instanceof UhpInputFileError) {
          const mapped = uhpError("file_not_found", error.message, {
            status: 404,
            param: "input",
            detail: { file_id: error.fileId },
          });
          sendError(res, mapped.status, mapped.body);
          return;
        }
        throw error;
      }
      const task = await this.tasks.prepare(body);
      // Keep the caller's original input (file_id, no server path) for
      // GET /v1/responses/{id}/input_items.
      this.tasks.setInputItems(task, rawBody.input ?? body.input);
      const stream = body.stream === true;
      const background = body.background === true;

      if (stream && !background) {
        res.writeHead(200, {
          ...baseHeaders(),
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders?.();
        const subscriber: UhpSseSubscriber = {
          write: (chunk) => {
            if (!res.writableEnded) res.write(chunk);
          },
          end: () => {
            if (!res.writableEnded) res.end();
          },
        };
        this.tasks.attachSse(task, subscriber, headerValue(req, "last-event-id") ?? undefined);
        // res.close fires when the client connection closes; req.close also
        // fires after the request body is consumed on some Node versions.
        res.once("close", () => this.tasks.detachSse(task, subscriber));
        void this.tasks.start(task, body).catch((error) => {
          logError(`[uhp] prompt start failed: ${String(error)}`);
          void this.tasks.cancelResponse(task.record.id).catch(() => undefined);
        });
        return;
      }

      if (background) {
        void this.tasks.start(task, body).catch((error) => {
          logError(`[uhp] background prompt start failed: ${String(error)}`);
          void this.tasks.cancelResponse(task.record.id).catch(() => undefined);
        });
        sendJson(res, 200, this.tasks.snapshot(task));
        return;
      }

      try {
        await this.tasks.start(task, body);
      } catch (error) {
        await this.tasks.cancelResponse(task.record.id).catch(() => undefined);
        throw error;
      }
      await task.done;
      sendJson(res, 200, this.tasks.snapshot(task));
      return;
    }

    const responseId = decodeSegment(segments[2] ?? "");
    if (!responseId) {
      notFound(res);
      return;
    }
    if (segments.length === 4 && segments[3] === "cancel") {
      if (method !== "POST") {
        methodNotAllowed(res, ["POST"]);
        return;
      }
      const response = await this.tasks.cancelResponse(responseId);
      if (!response) {
        const mapped = uhpError("response_not_found", "No matching response was found.");
        sendError(res, mapped.status, mapped.body);
        return;
      }
      sendJson(res, 200, response);
      return;
    }
    if (segments.length === 4 && segments[3] === "input_items") {
      if (method !== "GET") {
        methodNotAllowed(res, ["GET"]);
        return;
      }
      const items = this.tasks.getInputItems(responseId);
      if (!items) {
        const mapped = uhpError("response_not_found", "No matching response was found.");
        sendError(res, mapped.status, mapped.body);
        return;
      }
      sendJson(res, 200, { object: "list", data: items });
      return;
    }
    if (segments.length !== 3) {
      notFound(res);
      return;
    }
    if (method === "GET") {
      const response = this.tasks.getResponse(responseId);
      if (!response) {
        const mapped = uhpError("response_not_found", "No matching response was found.");
        sendError(res, mapped.status, mapped.body);
        return;
      }
      sendJson(res, 200, response);
      return;
    }
    if (method === "DELETE") {
      try {
        const deleted = this.tasks.deleteResponse(responseId);
        if (!deleted) {
          const mapped = uhpError("response_not_found", "No matching response was found.");
          sendError(res, mapped.status, mapped.body);
          return;
        }
        sendNoContent(res, 204);
      } catch (error) {
        if (error instanceof UhpTaskError) this.handleTaskError(res, error);
        else throw error;
      }
      return;
    }
    methodNotAllowed(res, ["GET", "DELETE"]);
  }

  private async handleSessions(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    segments: string[],
  ): Promise<void> {
    if (segments.length === 2) {
      if (method !== "GET") {
        methodNotAllowed(res, ["GET"]);
        return;
      }
      const query = queryOf(req.url);
      const page = this.sessions.list({
        limit: Number(query.get("limit") ?? 20),
        cursor: query.get("cursor"),
        harness: query.get("harness"),
      });
      sendJson(res, 200, { object: "list", ...page });
      return;
    }
    const sessionId = decodeSegment(segments[2] ?? "");
    if (!sessionId) {
      notFound(res);
      return;
    }
    const resolved = this.sessions.resolveId(sessionId);
    if (!resolved) {
      const mapped = uhpError("session_not_found", "No matching session was found.");
      sendError(res, mapped.status, mapped.body);
      return;
    }
    if (segments.length === 4 && segments[3] === "turns") {
      if (method !== "GET") {
        methodNotAllowed(res, ["GET"]);
        return;
      }
      sendJson(res, 200, {
        object: "list",
        data: this.sessions.turns(resolved),
        next_cursor: null,
      });
      return;
    }
    if (segments.length === 4 && segments[3] === "cancel") {
      if (method !== "POST") {
        methodNotAllowed(res, ["POST"]);
        return;
      }
      const cancelled = await this.tasks.cancelSession(resolved);
      const session = this.sessions.get(resolved);
      sendJson(res, 200, {
        ...(session ?? {}),
        status: cancelled ? "cancelled" : session?.status ?? "completed",
      });
      return;
    }
    if (segments.length === 4 && segments[3] === "files") {
      if (method !== "GET") {
        methodNotAllowed(res, ["GET"]);
        return;
      }
      const record = this.sessions.get(resolved);
      if (!record) {
        const mapped = uhpError("session_not_found", "No matching session was found.");
        sendError(res, mapped.status, mapped.body);
        return;
      }
      const kova = this.sessions.kovaId(resolved);
      if (!kova) {
        const mapped = uhpError("session_not_found", "No matching session was found.");
        sendError(res, mapped.status, mapped.body);
        return;
      }
      sendJson(res, 200, { files: listSessionArtifacts(kova) });
      return;
    }
    if (segments.length === 5 && segments[3] === "files" && segments[4] === "archive") {
      if (method !== "GET") {
        methodNotAllowed(res, ["GET"]);
        return;
      }
      const kova = this.sessions.kovaId(resolved);
      if (!kova) {
        const mapped = uhpError("session_not_found", "No matching session was found.");
        sendError(res, mapped.status, mapped.body);
        return;
      }
      let bytes: Buffer;
      try {
        bytes = archiveSessionArtifacts(kova);
      } catch (error) {
        if (error instanceof UhpArchiveTooLargeError) {
          const mapped = uhpError("file_too_large", error.message, {
            status: 413,
            detail: { max_bytes: UHP_MAX_ARCHIVE_BYTES },
          });
          sendError(res, mapped.status, mapped.body);
          return;
        }
        throw error;
      }
      this.sendBytes(
        res,
        bytes,
        "application/zip",
        `uhp-${resolved}-artifacts.zip`,
      );
      return;
    }
    if (segments.length !== 3) {
      notFound(res);
      return;
    }
    if (method === "GET") {
      const session = this.sessions.get(resolved);
      if (!session) {
        const mapped = uhpError("session_not_found", "No matching session was found.");
        sendError(res, mapped.status, mapped.body);
        return;
      }
      sendJson(res, 200, {
        ...session,
        turns: this.sessions.turns(resolved),
      });
      return;
    }
    if (method === "DELETE") {
      const deleted = await this.sessions.delete(resolved);
      if (!deleted) {
        const mapped = uhpError("session_not_found", "No matching session was found.");
        sendError(res, mapped.status, mapped.body);
        return;
      }
      sendJson(res, 200, {
        id: resolved,
        object: "session.deleted",
        deleted: true,
      });
      return;
    }
    methodNotAllowed(res, ["GET", "DELETE"]);
  }

  private async handleFiles(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    segments: string[],
  ): Promise<void> {
    if (segments.length !== 2) {
      notFound(res);
      return;
    }
    if (method !== "POST") {
      methodNotAllowed(res, ["POST"]);
      return;
    }
    const contentType = headerValue(req, "content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      const mapped = uhpError("invalid_input", "Expected multipart/form-data.", {
        param: "Content-Type",
      });
      sendError(res, mapped.status, mapped.body);
      return;
    }
    const body = await readRawBody(req, UHP_MAX_UPLOAD_BYTES + 1024 * 1024);
    let parts: ReturnType<typeof parseMultipart>;
    try {
      parts = parseMultipart(body, contentType);
    } catch {
      const mapped = uhpError("invalid_input", "Malformed multipart body.", {
        param: "body",
      });
      sendError(res, mapped.status, mapped.body);
      return;
    }
    const filePart =
      parts.find((part) => part.filename !== undefined && part.name === "file") ??
      parts.find((part) => part.filename !== undefined);
    if (!filePart) {
      const mapped = uhpError("invalid_input", "No file part was provided.", {
        param: "file",
      });
      sendError(res, mapped.status, mapped.body);
      return;
    }
    if (filePart.data.length > UHP_MAX_UPLOAD_BYTES) {
      const mapped = uhpError("file_too_large", "Uploaded file is too large.", {
        param: "file",
        detail: { max_bytes: UHP_MAX_UPLOAD_BYTES },
      });
      sendError(res, mapped.status, mapped.body);
      return;
    }
    let file: UhpFile;
    try {
      file = saveUpload({
        filename: filePart.filename,
        contentType: filePart.contentType,
        bytes: filePart.data,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "file_too_large") {
        const mapped = uhpError("file_too_large", "Uploaded file is too large.", {
          param: "file",
          detail: { max_bytes: UHP_MAX_UPLOAD_BYTES },
        });
        sendError(res, mapped.status, mapped.body);
        return;
      }
      throw error;
    }
    sendJson(res, 200, file);
  }

  private async handleContainers(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    segments: string[],
  ): Promise<void> {
    // /v1/containers/{cid}/files/{fid}/content|pdf
    if (segments.length !== 6 || segments[1] !== "containers" || segments[3] !== "files") {
      notFound(res);
      return;
    }
    if (method !== "GET") {
      methodNotAllowed(res, ["GET"]);
      return;
    }
    const containerId = decodeSegment(segments[2] ?? "");
    const fileId = decodeSegment(segments[4] ?? "");
    // segments: v1, containers, cid, files, fid, content -> length 6
    const action = segments[5];
    if (!containerId || !fileId) {
      notFound(res);
      return;
    }
    if (action === "pdf") {
      const mapped = uhpError("preview_unavailable", "PDF preview is not implemented.", {
        status: 501,
      });
      sendError(res, mapped.status, mapped.body);
      return;
    }
    if (action !== "content") {
      notFound(res);
      return;
    }
    const found = readContainerFile(containerId, fileId);
    if (!found) {
      const mapped = uhpError("file_not_found", "No matching file was found.");
      sendError(res, mapped.status, mapped.body);
      return;
    }
    this.sendBytes(
      res,
      found.bytes,
      mimeTypeOf(found.record.filename),
      found.record.filename,
    );
  }

  private sendBytes(
    res: ServerResponse,
    bytes: Buffer,
    contentType: string,
    filename: string,
  ): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(200, {
      ...baseHeaders(),
      "Content-Type": contentType || "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": contentDisposition(filename),
      "X-Content-Type-Options": "nosniff",
    });
    res.end(bytes);
  }
}
