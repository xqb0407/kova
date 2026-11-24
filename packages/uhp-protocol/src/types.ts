/**
 * UHP 2026-10-19 wire types.
 *
 * This package is the single source of truth for the external UHP HTTP
 * contract. It is intentionally separate from pi-protocol (the internal
 * sidecar ⇄ desktop NDJSON contract): UHP is a public, versioned HTTP API;
 * pi-protocol is a private, additive-only transport.
 *
 * Schema baseline: https://unifiedharnessprotocol.org/spec/2026-10-19
 */

export const UHP_PROTOCOL_VERSION = "2026-10-19" as const;
export type UhpProtocolVersion = typeof UHP_PROTOCOL_VERSION;

/** Versions this build can speak. Only versions whose full behavior we ship belong here. */
export const UHP_SUPPORTED_VERSIONS: readonly string[] = [UHP_PROTOCOL_VERSION];

export type UhpConformanceClass = "core" | "extended" | "full";

/* ------------------------------ capabilities ------------------------------ */

export const UHP_CAPABILITY_KEYS = [
  "streaming",
  "sessions",
  "cancellation",
  "files_input",
  "files_output",
  "session_listing",
  "harness_management",
  "harness_retirement",
  "input_history",
  "input_requests",
  "resume",
  "session_sharing",
  "session_branching",
  "idempotency",
  "harness_idempotency",
  "plugins",
  "environments",
  "memories",
] as const;

export type UhpCapability = (typeof UHP_CAPABILITY_KEYS)[number];
export type UhpCapabilities = Record<UhpCapability, boolean>;

/* ------------------------------ discovery ------------------------------ */

export type UhpDiscovery = {
  object: "uhp.discovery";
  protocol: "uhp";
  versions: string[];
  default_version: string;
  conformance_class: UhpConformanceClass;
  capabilities: UhpCapabilities;
  /** Required when capabilities.plugins is true. */
  plugin_schemas?: string[];
  /** Free-form debugging / bug-report identification. */
  implementation?: Record<string, unknown>;
};

/* ------------------------------ errors ------------------------------ */

export type UhpErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "harness_error"
  | "server_error";

export type UhpErrorBody = {
  type: UhpErrorType;
  code: string;
  message: string;
  param: string | null;
  detail: Record<string, unknown> | null;
};

export type UhpErrorEnvelope = { error: UhpErrorBody };

/* ------------------------------ models ------------------------------ */

export type UhpModel = {
  id: string;
  label?: string;
  backend?: string;
  available: boolean;
  default?: boolean;
};

export type UhpModelsResponse = {
  backends: Record<
    string,
    {
      default?: string | null;
      models: UhpModel[];
    }
  >;
};

export type UhpHarnessModelsResponse = {
  harness_id: string;
  backend: string;
  default?: string | null;
  /** Deprecated by the spec; kept for compatibility. */
  fallback?: string | null;
  models: UhpModel[];
};

/* ------------------------------ harnesses ------------------------------ */

export type UhpMcpServer = {
  name: string;
  url: string;
  transport?: "http" | "sse";
  enabled?: boolean;
  headers?: Record<string, string>;
  auth?: unknown;
};

export type UhpSkillFile = {
  path: string;
  content?: string;
  content_b64?: string;
};

export type UhpSkill = {
  name: string;
  enabled?: boolean;
  files?: UhpSkillFile[];
};

export type UhpPlugin = {
  name: string;
  enabled?: boolean;
  /** Opaque package bytes, base64. */
  blob?: string;
  files?: UhpSkillFile[];
  manifest?: Record<string, unknown>;
  mcpServers?: UhpMcpServer[];
  skills?: UhpSkill[];
  skipped?: unknown[];
};

export type UhpHarness = {
  id: string;
  object: "harness";
  name: string;
  base: string;
  baseLabel?: string;
  defaultModel?: string | null;
  systemPrompt?: string | null;
  mcpServers?: UhpMcpServer[];
  skills?: UhpSkill[];
  plugins?: UhpPlugin[];
  environment?: string | null;
  disabledTools?: string[];
  maxStep?: number | null;
  timeoutSeconds?: number | null;
  /** Unix milliseconds. */
  createdAt: number;
};

export type UhpCreateHarnessRequest = {
  name: string;
  base: string;
  default_model?: string;
  system_prompt?: string;
  mcp_servers?: UhpMcpServer[];
  skills?: UhpSkill[];
  plugins?: UhpPlugin[];
  environment?: string;
  disabled_tools?: string[];
  max_step?: number;
  timeout_seconds?: number;
};

/** Full-class PUT replaces mutable configuration; base/id/createdAt are immutable. */
export type UhpUpdateHarnessRequest = Partial<UhpCreateHarnessRequest>;

/* ------------------------------ responses ------------------------------ */

export type UhpResponseStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "incomplete"
  | "cancelled";

export type UhpIncompleteReason =
  | "max_steps"
  | "timeout"
  | "input_required"
  | (string & {});

export type UhpResponseError = {
  type: UhpErrorType;
  code: string;
  message: string;
  param?: string | null;
  detail?: Record<string, unknown> | null;
};

export type UhpUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type UhpAnnotation = {
  type: "container_file_citation" | (string & {});
  container_id?: string;
  file_id?: string;
  filename?: string;
  download_url?: string;
  start_index?: number;
  end_index?: number;
  [key: string]: unknown;
};

export type UhpOutputTextPart = {
  type: "output_text";
  text: string;
  annotations: UhpAnnotation[];
};

export type UhpRefusalPart = {
  type: "refusal";
  refusal: string;
};

export type UhpOutputContent = UhpOutputTextPart | UhpRefusalPart | (Record<string, unknown> & { type: string });

export type UhpMessageItem = {
  id: string;
  type: "message";
  role: "assistant";
  status: "in_progress" | "completed" | "incomplete";
  content: UhpOutputContent[];
};

export type UhpReasoningItem = {
  id: string;
  type: "reasoning";
  status: "in_progress" | "completed" | "incomplete";
  summary: { type: "summary_text"; text: string }[];
};

export type UhpFunctionCallItem = {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status: "in_progress" | "completed" | "incomplete";
};

export type UhpFunctionCallOutputItem = {
  id: string;
  type: "function_call_output";
  call_id: string;
  output: string;
  status: "in_progress" | "completed" | "incomplete";
};

export type UhpInputRequestItem = {
  id: string;
  type: "input_request";
  status: "pending" | "completed" | "cancelled" | "expired";
  kind: "choice" | "confirm" | "free_text" | "secret";
  prompt: string;
  options?: { id: string; label?: string }[];
  expires_at?: number | null;
};

/**
 * Clients must tolerate unknown output item types. Use this shape when
 * narrowing fails rather than rejecting the response.
 */
export type UhpUnknownOutputItem = Record<string, unknown> & { type: string; id?: string };

export type UhpOutputItem =
  | UhpMessageItem
  | UhpReasoningItem
  | UhpFunctionCallItem
  | UhpFunctionCallOutputItem
  | UhpInputRequestItem
  | UhpUnknownOutputItem;

export type UhpResponseMetadata = {
  /** Required by the protocol; the UHP session this response belongs to. */
  session_id: string;
  harness_id?: string;
  requested_model?: string;
  model_fallback?: boolean;
  model_fallback_reason?: string;
  ignored_fields?: string[];
  voided_input_requests?: string[];
  [key: string]: unknown;
};

export type UhpResponse = {
  id: string;
  object: "response";
  /** Unix seconds. */
  created_at: number;
  status: UhpResponseStatus;
  error: UhpResponseError | null;
  incomplete_details: { reason: UhpIncompleteReason; [key: string]: unknown } | null;
  previous_response_id: string | null;
  model: string;
  output: UhpOutputItem[];
  store: boolean;
  usage: UhpUsage | null;
  metadata: UhpResponseMetadata;
};

export type UhpInputContent =
  | { type: "input_text"; text: string }
  | {
      type: "input_file";
      filename?: string;
      file_data?: string;
      file_id?: string;
      mime_type?: string;
      /** Server-resolved local path (only trusted alongside file_id). */
      path?: string;
    }
  | {
      type: "input_image";
      image_url?: string;
      file_id?: string;
      file_data?: string;
      mime_type?: string;
      /** Server-resolved local path (only trusted alongside file_id). */
      path?: string;
      detail?: string;
    }
  | { type: "output_text"; text: string }
  | (Record<string, unknown> & { type: string });

export type UhpInputMessage = {
  /** Responses-style input items carry an explicit `message` discriminant. */
  type?: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: string | UhpInputContent[];
};

export type UhpInputResponseItem = {
  type: "input_response";
  input_request_id: string;
  answer: unknown;
};

export type UhpResumeItem = {
  type: "resume";
  note?: string;
};

export type UhpInputItem = UhpInputMessage | UhpInputResponseItem | UhpResumeItem;

export type UhpCreateResponseRequest = {
  input: string | UhpInputItem[];
  model?: string;
  metadata?: {
    harness_id?: string;
    memory?: string;
    /**
     * Kova extension: UHP has no top-level cwd field. Clients that omit it
     * get the harness's configured workspace.
     */
    cwd?: string;
    [key: string]: unknown;
  };
  stream?: boolean;
  previous_response_id?: string;
  branch?: boolean;
  instructions?: string;
  store?: boolean;
  max_output_tokens?: number;
  max_step?: number;
  timeout_seconds?: number;
  environment?: string;
  /** Reserved by the spec; servers must accept and ignore. */
  tools?: unknown[];
  /** Reserved by the spec; servers must accept and ignore. */
  include?: string[];
  background?: boolean;
  [key: string]: unknown;
};

/* ------------------------------ sessions ------------------------------ */

export type UhpBranchedFrom = {
  response_id: string;
  session_id: string;
  /** Counts from 1. */
  turn: number;
};

export type UhpSession = {
  id: string;
  object: "session";
  harness_id: string;
  title: string;
  status: string;
  /** Unix seconds. */
  created_at: number;
  /** Unix seconds. */
  updated_at: number;
  branched_from?: UhpBranchedFrom;
};

export type UhpTurnTool = Record<string, unknown>;
export type UhpTurnFile = Record<string, unknown>;

export type UhpSessionTurn = {
  id: string;
  status: UhpResponseStatus;
  user?: unknown;
  assistant?: unknown;
  tools?: UhpTurnTool[];
  files?: UhpTurnFile[];
  /** Unix seconds. */
  created_at?: number;
  /** Unix seconds. */
  completed_at?: number | null;
  imported?: boolean;
  environment?: string | null;
};

export type UhpSessionList = {
  data: UhpSession[];
  next_cursor: string | null;
};

export type UhpSessionDetail = UhpSession & {
  turns?: UhpSessionTurn[];
};

export type UhpSessionShare = {
  id: string;
  object: "session.share";
  url: string;
};

/* ------------------------------ files ------------------------------ */

export type UhpFile = {
  id: string;
  object: "file";
  filename: string;
  bytes: number;
  /** Unix seconds. */
  created_at: number;
};

export type UhpSessionFile = {
  id: string;
  container_id: string;
  filename: string;
  bytes: number;
  /** Unix seconds. */
  created_at: number;
};

export type UhpFileList = {
  files: UhpSessionFile[];
};

/* ------------------------------ request helpers ------------------------------ */

export type UhpCreateResponseParseError = {
  message: string;
  param: string | null;
};

/** Narrow an unknown JSON value to a non-null object. */
export function isUhpRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract text from a Responses-style input without losing file/image parts. */
export function collectInputText(input: UhpCreateResponseRequest["input"]): string {
  if (typeof input === "string") return input;
  const parts: string[] = [];
  for (const item of input) {
    if (!isUhpRecord(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type === "input_response" || record.type === "resume") continue;
    const content = record.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isUhpRecord(part)) continue;
      if (part.type === "input_text" && typeof part.text === "string") {
        parts.push(part.text);
      } else if (part.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("\n").trim();
}
