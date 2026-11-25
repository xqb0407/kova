/**
 * System-level UHP client server registry.
 *
 * The desktop app is the only writer of ~/.kova/uhp-servers.json; workspace
 * subagent YAML may only reference a server id, never a URL or token. Tokens
 * are stored as kenc:v1 ciphertext (same machine-derived key as the shared
 * credentials file) and can also come from env for headless use.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  credentialFileSecret,
  decryptCredentialValue,
} from "pi-protocol/credential-file";
import { UhpClient } from "./client";

export type UhpClientServer = {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  enabled: boolean;
};

type RawServer = {
  id?: unknown;
  name?: unknown;
  baseUrl?: unknown;
  url?: unknown;
  token?: unknown;
  enabled?: unknown;
};

export function uhpServersPath(): string {
  return process.env.KOVA_UHP_SERVERS_FILE?.trim() || join(homedir(), ".kova", "uhp-servers.json");
}

function decodeToken(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  if (!value.startsWith("kenc:v1:")) return value;
  try {
    return decryptCredentialValue(value, credentialFileSecret());
  } catch {
    return null;
  }
}

function normalizeServer(raw: RawServer, index: number): UhpClientServer | null {
  if (!raw || typeof raw !== "object") return null;
  const id =
    typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `server-${index + 1}`;
  const baseUrl =
    typeof raw.baseUrl === "string" && raw.baseUrl.trim()
      ? raw.baseUrl.trim()
      : typeof raw.url === "string" && raw.url.trim()
        ? raw.url.trim()
        : "";
  const token = decodeToken(raw.token);
  if (!baseUrl || !token) return null;
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    baseUrl,
    token,
    enabled: raw.enabled !== false,
  };
}

export function loadUhpClientServers(): UhpClientServer[] {
  const path = uhpServersPath();
  if (!existsSync(path)) return envFallback();
  try {
    // Refuse world-readable token files. (Windows mode bits are unreliable;
    // the desktop writer still sets 0600 where supported.)
    if (process.platform !== "win32") {
      const mode = statSync(path).mode & 0o777;
      if ((mode & 0o077) !== 0) return envFallback();
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return envFallback();
    const servers = (parsed as { servers?: unknown }).servers;
    if (!Array.isArray(servers)) return envFallback();
    const out: UhpClientServer[] = [];
    servers.forEach((raw, index) => {
      const server = normalizeServer(raw as RawServer, index);
      if (server) out.push(server);
    });
    return out;
  } catch {
    return envFallback();
  }
}

function envFallback(): UhpClientServer[] {
  const baseUrl = process.env.KOVA_UHP_BASE_URL?.trim();
  const token = process.env.KOVA_UHP_TOKEN?.trim();
  if (!baseUrl || !token) return [];
  return [
    {
      id: process.env.KOVA_UHP_SERVER_ID?.trim() || "default",
      name: "UHP (env)",
      baseUrl,
      token,
      enabled: true,
    },
  ];
}

export function resolveUhpServer(id: string | null | undefined): UhpClientServer {
  const servers = loadUhpClientServers().filter((server) => server.enabled);
  if (id) {
    const found = servers.find((server) => server.id === id);
    if (found) return found;
    const env = envFallback().find((server) => server.id === id);
    if (env) return env;
    throw new Error(`UHP server "${id}" is not configured on this machine.`);
  }
  if (servers.length === 1) return servers[0];
  if (servers.length === 0) {
    throw new Error(
      "No UHP client server is configured. Add one in Settings → UHP, or set KOVA_UHP_BASE_URL/KOVA_UHP_TOKEN.",
    );
  }
  throw new Error("Multiple UHP servers are configured; the subagent must name uhp.server.");
}

export function clientForServer(server: UhpClientServer): UhpClient {
  return new UhpClient({ baseUrl: server.baseUrl, token: server.token });
}
