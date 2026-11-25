/**
 * UHP error model. Every non-2xx response uses the same envelope; task
 * failures are HTTP 200 with a `failed` response object.
 */
import type { UhpErrorBody, UhpErrorEnvelope, UhpErrorType } from "./types";

export const UHP_ERROR_STATUS: Readonly<Record<string, number>> = {
  unsupported_protocol_version: 400,
  invalid_input: 400,
  header_not_allowed: 400,
  authentication_error: 401,
  permission_error: 403,
  harness_not_found: 404,
  response_not_found: 404,
  session_not_found: 404,
  plugin_not_found: 404,
  file_not_found: 404,
  session_expired: 404,
  environment_not_found: 404,
  memory_not_found: 404,
  memory_record_not_found: 404,
  memories_not_attached: 404,
  harness_mismatch: 409,
  session_busy: 409,
  response_busy: 409,
  branch_unavailable: 409,
  harness_busy: 409,
  plugin_conflict: 409,
  idempotency_key_reused: 409,
  input_not_pending: 409,
  resume_not_pending: 409,
  input_request_expired: 410,
  precondition_failed: 412,
  file_too_large: 413,
  input_response_invalid: 422,
  model_unavailable: 422,
  model_not_available: 422,
  unsupported_base: 422,
  environment_not_ready: 409,
  environment_busy: 409,
  environment_exists: 409,
  environment_invalid: 422,
  memory_invalid: 422,
  memory_unsupported: 422,
  memory_busy: 409,
  unsupported_transport: 422,
  rate_limit_error: 429,
  server_error: 500,
  server_unavailable: 503,
  environment_unavailable: 502,
  memory_unavailable: 502,
  preview_failed: 502,
  preview_unavailable: 501,
  not_implemented: 501,
};

const ERROR_TYPES: Readonly<Record<string, UhpErrorType>> = {
  authentication_error: "authentication_error",
  permission_error: "permission_error",
  rate_limit_error: "rate_limit_error",
};

/** Build the canonical error envelope. */
export function uhpError(
  code: string,
  message: string,
  options: {
    type?: UhpErrorType;
    param?: string | null;
    detail?: Record<string, unknown> | null;
    status?: number;
  } = {},
): { status: number; body: UhpErrorEnvelope } {
  const status = options.status ?? UHP_ERROR_STATUS[code] ?? 400;
  const type =
    options.type ??
    ERROR_TYPES[code] ??
    (status >= 500 ? "server_error" : "invalid_request_error");
  return {
    status,
    body: {
      error: {
        type,
        code,
        message,
        param: options.param ?? null,
        detail: options.detail ?? null,
      },
    },
  };
}

export function isUhpErrorEnvelope(value: unknown): value is UhpErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const body = error as Partial<UhpErrorBody>;
  return (
    typeof body.type === "string" &&
    typeof body.code === "string" &&
    typeof body.message === "string"
  );
}
