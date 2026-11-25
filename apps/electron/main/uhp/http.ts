/**
 * Small HTTP helpers for the UHP server. We use node:http directly to match
 * the existing remote gateway and avoid adding a framework dependency.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { UHP_PROTOCOL_VERSION } from "uhp-protocol";
import type { UhpErrorEnvelope } from "uhp-protocol";

export const UHP_VERSION_HEADER = "UHP-Version";
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export class HttpBodyError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Read a JSON body with a hard byte cap. */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new HttpBodyError("request body too large", 413);
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpBodyError("request body is not valid JSON", 400);
  }
}

/** Read a raw body with a hard byte cap (file uploads use their own parser). */
export async function readRawBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new HttpBodyError("request body too large", 413);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function baseHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    [UHP_VERSION_HEADER]: UHP_PROTOCOL_VERSION,
    "Cache-Control": "no-store",
    ...extra,
  };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...baseHeaders(extraHeaders),
    "Content-Type": JSON_CONTENT_TYPE,
    "Content-Length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

export function sendError(
  res: ServerResponse,
  status: number,
  envelope: UhpErrorEnvelope,
  extraHeaders?: Record<string, string>,
): void {
  sendJson(res, status, envelope, extraHeaders);
}

export function sendNoContent(res: ServerResponse, status = 204): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, baseHeaders());
  res.end();
}

export function methodNotAllowed(res: ServerResponse, allow: string[]): void {
  sendError(
    res,
    405,
    {
      error: {
        type: "invalid_request_error",
        code: "method_not_allowed",
        message: "Method not allowed for this endpoint.",
        param: null,
        detail: null,
      },
    },
    { Allow: allow.join(", ") },
  );
}

export function notFound(res: ServerResponse): void {
  sendError(res, 404, {
    error: {
      type: "invalid_request_error",
      code: "not_found",
      message: "Not found.",
      param: null,
      detail: null,
    },
  });
}

/** Strip query string and trailing slash (except root). */
export function pathnameOf(url: string | undefined): string {
  const raw = (url ?? "/").split("?")[0];
  if (raw.length > 1 && raw.endsWith("/")) return raw.slice(0, -1);
  return raw;
}

export function queryOf(url: string | undefined): URLSearchParams {
  const raw = url ?? "/";
  const index = raw.indexOf("?");
  return new URLSearchParams(index === -1 ? "" : raw.slice(index + 1));
}

/** Decode one path segment safely. */
export function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}
