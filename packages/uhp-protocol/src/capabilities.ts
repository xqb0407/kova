/**
 * Capability maps for each conformance class.
 *
 * Rules:
 * - Unsupported capabilities must be present as `false`, not omitted.
 * - A server must not advertise a capability it cannot deliver.
 * - Extended requires files_input, files_output and session_listing.
 */
import type {
  UhpCapabilities,
  UhpCapability,
  UhpConformanceClass,
} from "./types";
import { UHP_CAPABILITY_KEYS } from "./types";

export function emptyCapabilities(): UhpCapabilities {
  const out = {} as UhpCapabilities;
  for (const key of UHP_CAPABILITY_KEYS) out[key] = false;
  return out;
}

/** Core: streaming tasks, sessions, cancellation. */
export function coreCapabilities(
  overrides: Partial<UhpCapabilities> = {},
): UhpCapabilities {
  const out = emptyCapabilities();
  out.streaming = true;
  out.sessions = true;
  out.cancellation = true;
  return { ...out, ...overrides };
}

/** Extended: Core + file input/output + session listing/inspection. */
export function extendedCapabilities(
  overrides: Partial<UhpCapabilities> = {},
): UhpCapabilities {
  const out = coreCapabilities();
  out.files_input = true;
  out.files_output = true;
  out.session_listing = true;
  return { ...out, ...overrides };
}

/** Full is intentionally not constructed here until the server implements it. */
export function fullCapabilities(
  overrides: Partial<UhpCapabilities> = {},
): UhpCapabilities {
  const out = extendedCapabilities();
  out.harness_management = true;
  out.session_sharing = true;
  return { ...out, ...overrides };
}

/**
 * Compute the highest class the advertised capabilities honestly satisfy.
 * Optional capabilities (plugins, environments, memories, input_requests,
 * branching, etc.) do not raise the class.
 */
export function conformanceClassFor(
  capabilities: UhpCapabilities,
): UhpConformanceClass {
  if (
    capabilities.harness_management &&
    capabilities.session_sharing
  ) {
    return "full";
  }
  if (
    capabilities.files_input &&
    capabilities.files_output &&
    capabilities.session_listing
  ) {
    return "extended";
  }
  return "core";
}

export function hasCapability(
  capabilities: UhpCapabilities,
  key: UhpCapability,
): boolean {
  return capabilities[key] === true;
}

/** List capability keys explicitly advertised as false (useful for logs/tests). */
export function disabledCapabilities(
  capabilities: UhpCapabilities,
): UhpCapability[] {
  return UHP_CAPABILITY_KEYS.filter((key) => !capabilities[key]);
}
