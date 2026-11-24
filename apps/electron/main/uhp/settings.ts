/**
 * UHP server configuration. Stored in the host SQLite kv table so it follows
 * the same backup/restore path as other desktop settings.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appDataDir } from "../paths";
import { kvGet, kvSet } from "../store";
import { decrypt, encrypt } from "../secret";
import {
  UHP_DEFAULT_PORT,
  UHP_MAX_PORT,
  UHP_SETTINGS_KEY,
  defaultUhpConfig,
  defaultUhpWorkspaceRoot,
  normalizeUhpConfig,
} from "./config";
import type { UhpServerConfig } from "./types";

export {
  UHP_DEFAULT_PORT,
  UHP_MAX_PORT,
  UHP_SETTINGS_KEY,
  defaultUhpConfig,
  defaultUhpWorkspaceRoot,
  normalizeUhpConfig,
};

export function loadUhpConfig(): UhpServerConfig {
  const raw = kvGet(UHP_SETTINGS_KEY);
  if (!raw) return defaultUhpConfig();
  try {
    return normalizeUhpConfig(JSON.parse(raw));
  } catch {
    return defaultUhpConfig();
  }
}

export function saveUhpConfig(patch: Partial<UhpServerConfig>): UhpServerConfig {
  const next = { ...loadUhpConfig(), ...patch };
  const normalized = normalizeUhpConfig(next);
  kvSet(UHP_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

/** Generate a 32-byte URL-safe bearer token. */
function makeApiKey(): string {
  return randomBytes(32).toString("base64url");
}

export function hasUhpApiKey(config: UhpServerConfig = loadUhpConfig()): boolean {
  return typeof config.apiKeyCipher === "string" && config.apiKeyCipher.length > 0;
}

/** Decrypt the active token; returns null when no token or the cipher is unavailable. */
export function getUhpApiKey(config: UhpServerConfig = loadUhpConfig()): string | null {
  if (!config.apiKeyCipher) return null;
  try {
    const plain = decrypt(config.apiKeyCipher);
    return plain.ok && plain.value.length > 0 ? plain.value : null;
  } catch {
    return null;
  }
}

/** Rotate the token. The plaintext is returned once and never stored. */
export function rotateUhpApiKey(): { token: string; config: UhpServerConfig } {
  const token = makeApiKey();
  const cipher = encrypt(token);
  const config = saveUhpConfig({ apiKeyCipher: cipher });
  return { token, config };
}

/** Called when enabling for the first time; returns the plaintext only if created. */
export function ensureUhpApiKey(): { token: string | null; config: UhpServerConfig } {
  const config = loadUhpConfig();
  if (config.apiKeyCipher) return { token: null, config };
  return rotateUhpApiKey();
}

export function maskApiKey(token: string | null): string | null {
  if (!token) return null;
  if (token.length <= 8) return "********";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function ensureUhpDirs(): void {
  const config = loadUhpConfig();
  mkdirSync(config.workspaceRoot, { recursive: true });
  mkdirSync(join(appDataDir(), "uhp", "files"), { recursive: true });
  mkdirSync(join(appDataDir(), "uhp", "artifacts"), { recursive: true });
}
