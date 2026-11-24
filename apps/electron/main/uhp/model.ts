/**
 * Model projection for UHP.
 *
 * Kova's canonical model id is `provider/modelId`; the model catalogue remains
 * the source of truth for availability/authentication.
 */
import type { UhpHarnessModelsResponse, UhpModelsResponse } from "uhp-protocol";
import type { UhpHarnessProfile, UhpModelEntry } from "./types";

const MODELS_CACHE_MS = 5_000;
let cached: { at: number; models: UhpModelEntry[] } | null = null;

export function canonicalModelId(entry: Pick<UhpModelEntry, "provider" | "id">): string {
  return `${entry.provider}/${entry.id}`;
}

export function parseModelId(
  value: string,
): { provider: string; modelId: string } | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export async function loadModels(
  loader: () => Promise<UhpModelEntry[]>,
  options: { force?: boolean } = {},
): Promise<UhpModelEntry[]> {
  const now = Date.now();
  if (!options.force && cached && now - cached.at < MODELS_CACHE_MS) return cached.models;
  const models = await loader();
  cached = { at: now, models };
  return models;
}

export function invalidateModelCache(): void {
  cached = null;
}

export function isModelAvailable(entry: UhpModelEntry): boolean {
  return entry.enabled && entry.authed;
}

export function buildModelsResponse(
  models: UhpModelEntry[],
  defaultModel?: string | null,
): UhpModelsResponse {
  const backends: UhpModelsResponse["backends"] = {};
  for (const model of models) {
    const backend = model.provider;
    const bucket = (backends[backend] ??= { models: [] });
    const id = canonicalModelId(model);
    bucket.models.push({
      id,
      label: model.name,
      backend,
      available: isModelAvailable(model),
    });
  }
  for (const [backend, bucket] of Object.entries(backends)) {
    const preferred =
      defaultModel && defaultModel.startsWith(`${backend}/`)
        ? bucket.models.find((model) => model.id === defaultModel && model.available)
        : undefined;
    const fallback = bucket.models.find((model) => model.available);
    bucket.default = preferred?.id ?? fallback?.id ?? null;
    const chosen = preferred ?? fallback;
    if (chosen) chosen.default = true;
  }
  return { backends };
}

export function buildHarnessModelsResponse(
  profile: UhpHarnessProfile,
  models: UhpModelEntry[],
): UhpHarnessModelsResponse {
  const available = models.filter((model) => isModelAvailable(model));
  const requested = profile.defaultModel ?? null;
  const defaultModel =
    requested && available.some((model) => canonicalModelId(model) === requested)
      ? requested
      : available[0]
        ? canonicalModelId(available[0])
        : null;
  return {
    harness_id: profile.id,
    backend: profile.base,
    default: defaultModel,
    fallback: defaultModel,
    models: available.map((model) => {
      const id = canonicalModelId(model);
      return {
        id,
        label: model.name,
        backend: model.provider,
        available: true,
        ...(defaultModel === id ? { default: true } : {}),
      };
    }),
  };
}

/** Resolve a task `model` field (canonical, or a unique bare id). */
export function resolveModelEntry(
  models: UhpModelEntry[],
  requested: string | null | undefined,
): UhpModelEntry | null {
  if (!requested) return null;
  const canonical = models.find((m) => canonicalModelId(m) === requested);
  if (canonical) return canonical;
  const matches = models.filter((m) => m.id === requested);
  return matches.length === 1 ? matches[0] : null;
}

/** Pick a sensible default: configured value, then an authenticated model. */
export function pickDefaultModel(
  models: UhpModelEntry[],
  preferred?: string | null,
): string | null {
  if (preferred) {
    const match = resolveModelEntry(models, preferred);
    if (match) return canonicalModelId(match);
  }
  const first = models.find(isModelAvailable);
  return first ? canonicalModelId(first) : null;
}
