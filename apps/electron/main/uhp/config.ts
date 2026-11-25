/**
 * Pure UHP server config defaults/normalization. Kept separate from settings.ts
 * so tests and tooling can import it without pulling the SQLite/Electron graph.
 */
import { join } from "node:path";
import { appDataDir } from "../paths";
import type { UhpApprovalLevel, UhpServerConfig } from "./types";

export const UHP_SETTINGS_KEY = "uhp.server";
export const UHP_DEFAULT_PORT = 8788;
export const UHP_MAX_PORT = 65535;

const APPROVAL_LEVELS: readonly UhpApprovalLevel[] = [
  "ask",
  "workspace-write",
  "auto-edit",
  "review",
  "auto",
];

export function isUhpApprovalLevel(value: unknown): value is UhpApprovalLevel {
  return typeof value === "string" && (APPROVAL_LEVELS as readonly string[]).includes(value);
}

export function defaultUhpWorkspaceRoot(): string {
  return join(appDataDir(), "uhp", "workspace");
}

export function defaultUhpConfig(): UhpServerConfig {
  return {
    enabled: false,
    port: UHP_DEFAULT_PORT,
    bind: "loopback",
    workspaceRoot: defaultUhpWorkspaceRoot(),
    defaultHarnessId: null,
    approvalLevel: "workspace-write",
    maxConcurrentTasks: 2,
    responseRetentionDays: 30,
    apiKeyCipher: null,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeUhpConfig(raw: unknown): UhpServerConfig {
  const base = defaultUhpConfig();
  if (!raw || typeof raw !== "object") return base;
  const value = raw as Record<string, unknown>;
  return {
    enabled: value.enabled === true,
    port: clampInt(value.port, base.port, 1024, UHP_MAX_PORT),
    bind: "loopback",
    workspaceRoot:
      typeof value.workspaceRoot === "string" && value.workspaceRoot.trim()
        ? value.workspaceRoot.trim()
        : base.workspaceRoot,
    defaultHarnessId:
      typeof value.defaultHarnessId === "string" && value.defaultHarnessId.trim()
        ? value.defaultHarnessId.trim()
        : null,
    approvalLevel: isUhpApprovalLevel(value.approvalLevel)
      ? value.approvalLevel
      : base.approvalLevel,
    maxConcurrentTasks: clampInt(value.maxConcurrentTasks, base.maxConcurrentTasks, 1, 16),
    responseRetentionDays: clampInt(value.responseRetentionDays, base.responseRetentionDays, 1, 365),
    apiKeyCipher:
      typeof value.apiKeyCipher === "string" && value.apiKeyCipher.length > 0
        ? value.apiKeyCipher
        : null,
  };
}
