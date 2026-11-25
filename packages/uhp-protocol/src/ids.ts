/**
 * UHP object identifiers and their prefixes.
 */
import type {
  UhpCapabilities,
  UhpConformanceClass,
  UhpDiscovery,
  UhpHarness,
} from "./types";
import { UHP_PROTOCOL_VERSION, UHP_SUPPORTED_VERSIONS } from "./types";

function randomToken(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export const newResponseId = (): string => `resp_${randomToken()}`;
export const newHarnessId = (): string => `chrn_${randomToken()}`;
export const newSessionId = (): string => `hsess_${randomToken()}`;
export const newFileId = (): string => `file_${randomToken()}`;
export const newContainerId = (): string => `cntr_${randomToken()}`;

export const isResponseId = (value: string): boolean => value.startsWith("resp_");
export const isHarnessId = (value: string): boolean => value.startsWith("chrn_");
export const isSessionId = (value: string): boolean => value.startsWith("hsess_");
export const isFileId = (value: string): boolean => value.startsWith("file_");
export const isContainerId = (value: string): boolean => value.startsWith("cntr_");

/** UHP session id ↔ Kova session id. Kova ids are opaque UUID-ish strings. */
export function uhpSessionIdFor(kovaSessionId: string): string {
  if (isSessionId(kovaSessionId)) return kovaSessionId;
  return `hsess_${kovaSessionId}`;
}

export function kovaSessionIdFrom(uhpSessionId: string): string | null {
  if (!isSessionId(uhpSessionId)) return null;
  const rest = uhpSessionId.slice("hsess_".length);
  return rest.length > 0 ? rest : null;
}

export function createHarness(input: {
  id: string;
  name: string;
  base: string;
  baseLabel?: string;
  defaultModel?: string | null;
  systemPrompt?: string | null;
  maxStep?: number | null;
  timeoutSeconds?: number | null;
  createdAt?: number;
}): UhpHarness {
  return {
    id: input.id,
    object: "harness",
    name: input.name,
    base: input.base,
    ...(input.baseLabel !== undefined ? { baseLabel: input.baseLabel } : {}),
    defaultModel: input.defaultModel ?? null,
    systemPrompt: input.systemPrompt ?? null,
    mcpServers: [],
    skills: [],
    disabledTools: [],
    maxStep: input.maxStep ?? null,
    timeoutSeconds: input.timeoutSeconds ?? null,
    createdAt: input.createdAt ?? Date.now(),
  };
}

/** Build the discovery document for a live capability map. */
export function discoveryDocument(input: {
  capabilities: UhpCapabilities;
  conformanceClass: UhpConformanceClass;
  implementation?: Record<string, unknown>;
}): UhpDiscovery {
  return {
    object: "uhp.discovery",
    protocol: "uhp",
    versions: [...UHP_SUPPORTED_VERSIONS],
    default_version: UHP_PROTOCOL_VERSION,
    conformance_class: input.conformanceClass,
    capabilities: input.capabilities,
    ...(input.capabilities.plugins
      ? { plugin_schemas: ["https://agent-plugins.org/schemas/plugin-1.0.0.json"] }
      : {}),
    ...(input.implementation ? { implementation: input.implementation } : {}),
  };
}
