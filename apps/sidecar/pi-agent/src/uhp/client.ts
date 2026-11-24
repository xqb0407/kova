/**
 * Minimal UHP client used by the sidecar's external subagent backend.
 *
 * It speaks the same HTTP/SSE contract as the server in Electron main. Keep it
 * dependency-free: Bun/Node fetch + the shared SSE parser.
 */
import {
  SseParser,
  UHP_PROTOCOL_VERSION,
  isUhpErrorEnvelope,
  isUhpRecord,
  isUhpTerminalEvent,
} from "uhp-protocol";
import type {
  UhpCreateResponseRequest,
  UhpDiscovery,
  UhpHarness,
  UhpHarnessModelsResponse,
  UhpResponse,
  UhpStreamEvent,
} from "uhp-protocol";

export class UhpClientError extends Error {
  status: number;
  code: string;
  param: string | null;
  detail: Record<string, unknown> | null;
  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      param?: string | null;
      detail?: Record<string, unknown> | null;
    } = {},
  ) {
    super(message);
    this.name = "UhpClientError";
    this.status = options.status ?? 0;
    this.code = options.code ?? "uhp_client_error";
    this.param = options.param ?? null;
    this.detail = options.detail ?? null;
  }
}

const CONTROL_TIMEOUT_MS = 15_000;

export type UhpClientOptions = {
  baseUrl: string;
  token: string;
  /** Optional request timeout; streaming has no total timeout by default. */
  timeoutMs?: number;
};

export type UhpCreateResponseOptions = {
  signal?: AbortSignal;
  onEvent?: (event: UhpStreamEvent) => void;
};

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function readError(response: Response): Promise<UhpClientError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (isUhpErrorEnvelope(body)) {
    return new UhpClientError(body.error.message, {
      status: response.status,
      code: body.error.code,
      param: body.error.param,
      detail: body.error.detail,
    });
  }
  return new UhpClientError(`UHP request failed with HTTP ${response.status}`, {
    status: response.status,
  });
}

export class UhpClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number | undefined;

  constructor(options: UhpClientOptions) {
    const baseUrl = trimBase(options.baseUrl);
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new UhpClientError("UHP baseUrl must be an absolute http(s) URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new UhpClientError("UHP baseUrl must use http or https.");
    }
    if (parsed.username || parsed.password) {
      throw new UhpClientError("UHP baseUrl must not contain credentials; use the token field.");
    }
    if (parsed.search || parsed.hash) {
      throw new UhpClientError("UHP baseUrl must not contain a query string or fragment.");
    }
    // UHP requires TLS off-loopback; never send a bearer token in cleartext.
    if (
      parsed.protocol === "http:" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "::1" &&
      parsed.hostname !== "[::1]"
    ) {
      throw new UhpClientError(
        "Refusing to send a UHP bearer token over plaintext HTTP to a non-loopback host; use HTTPS.",
      );
    }
    this.baseUrl = baseUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "UHP-Version": UHP_PROTOCOL_VERSION,
      ...extra,
    };
  }

  /** Control-plane calls must not hang a Task forever; streaming is exempt. */
  private controlSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(CONTROL_TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  async discovery(signal?: AbortSignal): Promise<UhpDiscovery> {
    const response = await fetch(`${this.baseUrl}/v1/uhp`, {
      method: "GET",
      headers: this.headers({ Accept: "application/json" }),
      signal: this.controlSignal(signal),
    });
    if (!response.ok) throw await readError(response);
    const body: unknown = await response.json();
    if (!isUhpRecord(body) || body.object !== "uhp.discovery") {
      throw new UhpClientError("Server returned an invalid discovery document.");
    }
    if (
      !Array.isArray(body.versions) ||
      !body.versions.includes(UHP_PROTOCOL_VERSION)
    ) {
      throw new UhpClientError(
        `Server does not speak UHP ${UHP_PROTOCOL_VERSION}; supported: ${
          Array.isArray(body.versions) ? body.versions.join(", ") : "unknown"
        }.`,
      );
    }
    return body as UhpDiscovery;
  }

  async listHarnesses(signal?: AbortSignal): Promise<UhpHarness[]> {
    const response = await fetch(`${this.baseUrl}/v1/harnesses`, {
      headers: this.headers({ Accept: "application/json" }),
      signal: this.controlSignal(signal),
    });
    if (!response.ok) throw await readError(response);
    const body: unknown = await response.json();
    const data = isUhpRecord(body) && Array.isArray(body.data) ? body.data : [];
    return data.filter(isUhpRecord) as UhpHarness[];
  }

  async listHarnessModels(
    harnessId: string,
    signal?: AbortSignal,
  ): Promise<UhpHarnessModelsResponse> {
    const response = await fetch(
      `${this.baseUrl}/v1/harnesses/${encodeURIComponent(harnessId)}/models`,
      {
        headers: this.headers({ Accept: "application/json" }),
        signal: this.controlSignal(signal),
      },
    );
    if (!response.ok) throw await readError(response);
    return (await response.json()) as UhpHarnessModelsResponse;
  }

  async getResponse(responseId: string, signal?: AbortSignal): Promise<UhpResponse> {
    const response = await fetch(
      `${this.baseUrl}/v1/responses/${encodeURIComponent(responseId)}`,
      {
        headers: this.headers({ Accept: "application/json" }),
        signal: this.controlSignal(signal),
      },
    );
    if (!response.ok) throw await readError(response);
    return (await response.json()) as UhpResponse;
  }

  async cancel(responseId: string, signal?: AbortSignal): Promise<UhpResponse> {
    const response = await fetch(
      `${this.baseUrl}/v1/responses/${encodeURIComponent(responseId)}/cancel`,
      {
        method: "POST",
        headers: this.headers({ Accept: "application/json" }),
        signal: this.controlSignal(signal),
      },
    );
    if (!response.ok) throw await readError(response);
    return (await response.json()) as UhpResponse;
  }

  /**
   * Create a task. Streaming is requested by default; if the server ignores
   * `stream` and returns JSON, the final response is returned directly.
   */
  async createResponse(
    request: UhpCreateResponseRequest,
    options: UhpCreateResponseOptions = {},
  ): Promise<UhpResponse> {
    const response = await fetch(`${this.baseUrl}/v1/responses`, {
      method: "POST",
      headers: this.headers({
        Accept: "text/event-stream, application/json",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ ...request, stream: request.stream !== false }),
      signal: options.signal ?? this.timeoutSignal(),
    });
    if (!response.ok) throw await readError(response);

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const body = (await response.json()) as UhpResponse;
      if (!isUhpRecord(body) || body.object !== "response" || typeof body.id !== "string") {
        throw new UhpClientError("Server returned an invalid response object.");
      }
      return body;
    }
    if (!response.body) {
      throw new UhpClientError("Server returned an empty event stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let finalResponse: UhpResponse | null = null;
    let terminalSeen = false;

    const consume = (chunk: string) => {
      for (const message of parser.push(chunk)) {
        let event: unknown;
        try {
          event = JSON.parse(message.data);
        } catch {
          continue;
        }
        if (!isUhpRecord(event) || typeof event.type !== "string") continue;
        if (typeof event.sequence_number !== "number") continue;
        const typed = event as unknown as UhpStreamEvent;
        options.onEvent?.(typed);
        if (isUhpTerminalEvent(typed)) {
          finalResponse = typed.response;
          terminalSeen = true;
        }
      }
    };

    try {
      while (!terminalSeen) {
        const { done, value } = await reader.read();
        if (done) break;
        consume(decoder.decode(value, { stream: true }));
      }
      if (terminalSeen) {
        // The terminal event is the end of the contract. Do not wait for a
        // buggy server to close the socket (which would hang the Task).
        await reader.cancel().catch(() => undefined);
      } else {
        consume(decoder.decode());
        for (const message of parser.end()) {
          try {
            const event = JSON.parse(message.data) as unknown;
            if (isUhpRecord(event) && typeof event.type === "string") {
              const typed = event as unknown as UhpStreamEvent;
              options.onEvent?.(typed);
              if (isUhpTerminalEvent(typed)) {
                finalResponse = typed.response;
                terminalSeen = true;
              }
            }
          } catch {
            /* ignore malformed tail */
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }

    if (finalResponse) {
      if (
        !isUhpRecord(finalResponse) ||
        finalResponse.object !== "response" ||
        typeof finalResponse.id !== "string"
      ) {
        throw new UhpClientError("UHP terminal event carried an invalid response.");
      }
      return finalResponse;
    }
    throw new UhpClientError("UHP stream ended without a terminal event.");
  }

  private timeoutSignal(): AbortSignal | undefined {
    if (!this.timeoutMs || this.timeoutMs <= 0) return undefined;
    return AbortSignal.timeout(this.timeoutMs);
  }
}
