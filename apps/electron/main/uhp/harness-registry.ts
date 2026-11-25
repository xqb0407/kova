/**
 * Configured harness registry.
 *
 * V1 exposes harnesses selected by the local desktop UI. The wire API only
 * implements GET; the Full-class CRUD surface is documented in
 * docs/uhp-roadmap.md and is intentionally gated behind harness_management=false.
 */
import { newHarnessId } from "uhp-protocol";
import type { UhpHarness } from "uhp-protocol";
import { loadUhpConfig, saveUhpConfig } from "./settings";
import {
  deleteHarness as deleteStoredHarness,
  listHarnesses,
  loadHarness,
  saveHarness,
} from "./store";
import type { UhpHarnessProfile, UhpModelEntry } from "./types";
import { canonicalModelId, isModelAvailable, pickDefaultModel } from "./model";

export const KOVA_HARNESS_BASE = "kova-pi-agent";
export const KOVA_HARNESS_BASE_LABEL = "Kova pi-agent";

export function toWireHarness(profile: UhpHarnessProfile): UhpHarness {
  return {
    id: profile.id,
    object: "harness",
    name: profile.name,
    base: profile.base,
    baseLabel: profile.baseLabel ?? KOVA_HARNESS_BASE_LABEL,
    defaultModel: profile.defaultModel ?? null,
    systemPrompt: profile.systemPrompt ?? null,
    mcpServers: [],
    skills: [],
    disabledTools: [],
    maxStep: profile.maxStep ?? null,
    timeoutSeconds: profile.timeoutSeconds ?? null,
    createdAt: profile.createdAt,
  };
}

export function listEnabledHarnesses(): UhpHarnessProfile[] {
  return listHarnesses().filter((profile) => profile.enabled !== false);
}

export function resolveHarness(id: string | null | undefined): UhpHarnessProfile | null {
  if (id) {
    const direct = loadHarness(id);
    return direct && direct.enabled !== false ? direct : null;
  }
  const config = loadUhpConfig();
  if (config.defaultHarnessId) {
    const configured = loadHarness(config.defaultHarnessId);
    if (configured && configured.enabled !== false) return configured;
  }
  return listEnabledHarnesses()[0] ?? null;
}

let ensurePromise: Promise<UhpHarnessProfile> | null = null;

/** Ensure at least one harness exists once models are known. */
export async function ensureDefaultHarness(
  loadModels: () => Promise<UhpModelEntry[]>,
): Promise<UhpHarnessProfile> {
  const existing = listEnabledHarnesses();
  if (existing.length > 0) {
    const config = loadUhpConfig();
    if (!config.defaultHarnessId) {
      saveUhpConfig({ defaultHarnessId: existing[0].id });
    }
    return existing[0];
  }
  // Concurrent startup + first request must not create two harnesses.
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    let models: UhpModelEntry[] = [];
    try {
      models = await loadModels();
    } catch {
      models = [];
    }
    const defaultModel = pickDefaultModel(models, null);
    const profile: UhpHarnessProfile = {
      id: newHarnessId(),
      name: "Kova",
      base: KOVA_HARNESS_BASE,
      baseLabel: KOVA_HARNESS_BASE_LABEL,
      defaultModel,
      systemPrompt: null,
      // Keep undefined so the server-level approval setting is authoritative;
      // an explicitly saved harness can still override it.
      approvalLevel: undefined,
      workspace: null,
      maxStep: null,
      timeoutSeconds: null,
      createdAt: Date.now(),
      enabled: true,
    };
    saveHarness(profile);
    saveUhpConfig({ defaultHarnessId: profile.id });
    return profile;
  })();
  try {
    return await ensurePromise;
  } finally {
    ensurePromise = null;
  }
}

export function saveHarnessProfile(
  input: Partial<UhpHarnessProfile> & { name?: string },
): UhpHarnessProfile {
  const current = input.id ? loadHarness(input.id) : null;
  const now = Date.now();
  const profile: UhpHarnessProfile = {
    id: current?.id ?? input.id ?? newHarnessId(),
    name: input.name?.trim() || current?.name || "Kova harness",
    base: input.base?.trim() || current?.base || KOVA_HARNESS_BASE,
    baseLabel: input.baseLabel ?? current?.baseLabel ?? KOVA_HARNESS_BASE_LABEL,
    defaultModel: input.defaultModel ?? current?.defaultModel ?? null,
    systemPrompt: input.systemPrompt ?? current?.systemPrompt ?? null,
    // Undefined means "use the server-level setting"; do not pin a default
    // while merely renaming a harness.
    approvalLevel: input.approvalLevel ?? current?.approvalLevel,
    workspace: input.workspace ?? current?.workspace ?? null,
    maxStep: input.maxStep ?? current?.maxStep ?? null,
    timeoutSeconds: input.timeoutSeconds ?? current?.timeoutSeconds ?? null,
    createdAt: current?.createdAt ?? now,
    enabled: input.enabled ?? current?.enabled ?? true,
  };
  // Never persist a model id that cannot currently be served as the default.
  if (profile.defaultModel) {
    const canonical = profile.defaultModel.trim();
    profile.defaultModel = canonical.includes("/") ? canonical : profile.defaultModel;
  }
  saveHarness(profile);
  const config = loadUhpConfig();
  if (!config.defaultHarnessId) saveUhpConfig({ defaultHarnessId: profile.id });
  return profile;
}

export function removeHarnessProfile(id: string): boolean {
  const existing = loadHarness(id);
  if (!existing) return false;
  deleteStoredHarness(id);
  const config = loadUhpConfig();
  if (config.defaultHarnessId === id) {
    saveUhpConfig({ defaultHarnessId: listEnabledHarnesses()[0]?.id ?? null });
  }
  return true;
}

export function harnessDefaultModel(
  profile: UhpHarnessProfile,
  models: UhpModelEntry[],
): string | null {
  if (profile.defaultModel) {
    const match = models.find((m) => canonicalModelId(m) === profile.defaultModel);
    if (match && isModelAvailable(match)) return canonicalModelId(match);
  }
  return pickDefaultModel(models, profile.defaultModel);
}
