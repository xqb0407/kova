/**
 * UHP client server registry (desktop side).
 *
 * The desktop is the only writer of ~/.kova/uhp-servers.json. Tokens are
 * encrypted with the same machine-derived key as the shared credentials file
 * so the sidecar can decrypt them without access to the desktop keychain.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  credentialFileSecret,
  decryptCredentialValue,
  encryptCredentialValue,
} from "pi-protocol/credential-file";
import { UHP_PROTOCOL_VERSION, isUhpRecord } from "uhp-protocol";
import type { UhpDiscovery, UhpHarness } from "uhp-protocol";
import { logError } from "../logging";

export type UhpClientServerEntry = {
  id: string;
  name: string;
  baseUrl: string;
  /** kenc:v1 ciphertext; never returned to the renderer. */
  token: string;
  enabled: boolean;
};

export type UhpClientServerView = {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasToken: boolean;
  tokenMasked: string | null;
};

type FileShape = {
  version: 1;
  updatedAt: string;
  servers: UhpClientServerEntry[];
};

export function uhpClientServersPath(): string {
  return (
    process.env.KOVA_UHP_SERVERS_FILE?.trim() ||
    join(homedir(), ".kova", "uhp-servers.json")
  );
}

function readFile(): FileShape {
  const path = uhpClientServersPath();
  if (!existsSync(path)) return { version: 1, updatedAt: new Date().toISOString(), servers: [] };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("invalid file");
    const servers = (raw as { servers?: unknown }).servers;
    if (!Array.isArray(servers)) throw new Error("invalid servers");
    const out: UhpClientServerEntry[] = [];
    for (const item of servers) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      if (
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        typeof value.baseUrl !== "string" ||
        typeof value.token !== "string"
      ) {
        continue;
      }
      out.push({
        id: value.id,
        name: value.name,
        baseUrl: value.baseUrl,
        token: value.token,
        enabled: value.enabled !== false,
      });
    }
    return { version: 1, updatedAt: new Date().toISOString(), servers: out };
  } catch (error) {
    logError(`[uhp] client server registry read failed: ${String(error)}`);
    return { version: 1, updatedAt: new Date().toISOString(), servers: [] };
  }
}

function writeFile(shape: FileShape): void {
  const path = uhpClientServersPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify({ ...shape, updatedAt: new Date().toISOString() }, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows */
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows */
  }
}

function tokenMask(token: string): string | null {
  try {
    const plain = decryptCredentialValue(token, credentialFileSecret());
    if (plain.length <= 8) return "********";
    return `${plain.slice(0, 4)}…${plain.slice(-4)}`;
  } catch {
    return null;
  }
}

function validateBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("baseUrl must not contain credentials; use the token field");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("baseUrl must not contain a query string or fragment");
  }
  if (
    parsed.protocol === "http:" &&
    parsed.hostname !== "localhost" &&
    parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "::1" &&
    parsed.hostname !== "[::1]"
  ) {
    throw new Error(
      "Refusing plaintext HTTP to a non-loopback UHP server; use HTTPS (bearer tokens must not travel in cleartext).",
    );
  }
  return baseUrl.replace(/\/+$/, "");
}

export function listUhpClientServers(): UhpClientServerView[] {
  return readFile().servers.map((server) => ({
    id: server.id,
    name: server.name,
    baseUrl: server.baseUrl,
    enabled: server.enabled,
    hasToken: Boolean(server.token),
    tokenMasked: tokenMask(server.token),
  }));
}

export function saveUhpClientServer(input: {
  id?: string;
  name?: string;
  baseUrl?: string;
  token?: string;
  enabled?: boolean;
}): UhpClientServerView {
  const file = readFile();
  const id = input.id?.trim() || `uhp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const existing = file.servers.find((server) => server.id === id);
  const rawBaseUrl = input.baseUrl?.trim() || existing?.baseUrl || "";
  if (!rawBaseUrl) throw new Error("baseUrl is required");
  const baseUrl = validateBaseUrl(rawBaseUrl);
  let token = existing?.token ?? "";
  if (typeof input.token === "string" && input.token.trim()) {
    token = encryptCredentialValue(input.token.trim(), credentialFileSecret());
  }
  if (!token) throw new Error("token is required");
  const next: UhpClientServerEntry = {
    id,
    name: input.name?.trim() || existing?.name || id,
    baseUrl,
    token,
    enabled: input.enabled ?? existing?.enabled ?? true,
  };
  const servers = file.servers.filter((server) => server.id !== id);
  servers.push(next);
  writeFile({ ...file, servers });
  return {
    id: next.id,
    name: next.name,
    baseUrl: next.baseUrl,
    enabled: next.enabled,
    hasToken: true,
    tokenMasked: tokenMask(next.token),
  };
}

export function deleteUhpClientServer(id: string): boolean {
  const file = readFile();
  const servers = file.servers.filter((server) => server.id !== id);
  if (servers.length === file.servers.length) return false;
  writeFile({ ...file, servers });
  return true;
}

export type UhpClientDiscoveryResult = {
  server: UhpClientServerView;
  discovery: UhpDiscovery;
  harnesses: UhpHarness[];
};

export async function discoverUhpClientServer(id: string): Promise<UhpClientDiscoveryResult> {
  const file = readFile();
  const server = file.servers.find((entry) => entry.id === id);
  if (!server) throw new Error(`UHP server "${id}" was not found.`);
  let token: string;
  try {
    token = decryptCredentialValue(server.token, credentialFileSecret());
  } catch {
    throw new Error(`UHP server "${id}" has an unreadable token. Re-enter it.`);
  }
  const base = validateBaseUrl(server.baseUrl);
  const headers = {
    Authorization: `Bearer ${token}`,
    "UHP-Version": UHP_PROTOCOL_VERSION,
    Accept: "application/json",
  };
  const discoveryResponse = await fetch(`${base}/v1/uhp`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!discoveryResponse.ok) {
    throw new Error(`UHP discovery failed with HTTP ${discoveryResponse.status}`);
  }
  const rawDiscovery: unknown = await discoveryResponse.json();
  if (
    !isUhpRecord(rawDiscovery) ||
    rawDiscovery.object !== "uhp.discovery" ||
    !Array.isArray(rawDiscovery.versions) ||
    !rawDiscovery.versions.includes(UHP_PROTOCOL_VERSION)
  ) {
    throw new Error(
      `UHP server does not advertise protocol ${UHP_PROTOCOL_VERSION}.`,
    );
  }
  const discovery = rawDiscovery as UhpDiscovery;
  const harnessResponse = await fetch(`${base}/v1/harnesses`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!harnessResponse.ok) {
    throw new Error(`UHP harness list failed with HTTP ${harnessResponse.status}`);
  }
  const harnessBody = (await harnessResponse.json()) as { data?: UhpHarness[] };
  return {
    server: {
      id: server.id,
      name: server.name,
      baseUrl: server.baseUrl,
      enabled: server.enabled,
      hasToken: true,
      tokenMasked: tokenMask(server.token),
    },
    discovery,
    harnesses: Array.isArray(harnessBody.data) ? harnessBody.data : [],
  };
}
