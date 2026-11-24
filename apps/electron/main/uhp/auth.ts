/**
 * Bearer authentication for the UHP server.
 *
 * `GET /v1/uhp` is intentionally unauthenticated (capability discovery must be
 * safe to call before a token exists). Every other endpoint requires a token.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still compare equal-length buffers so timing does not reveal length.
    const filler = Buffer.alloc(left.length);
    timingSafeEqual(left, filler);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function isAuthorized(req: IncomingMessage, expectedToken: string | null): boolean {
  if (!expectedToken) return false;
  const token = bearerToken(req);
  if (!token) return false;
  return constantTimeEqual(token, expectedToken);
}
