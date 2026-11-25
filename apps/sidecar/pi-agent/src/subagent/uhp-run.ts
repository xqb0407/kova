/**
 * External UHP subagent runner.
 *
 * Maps UHP SSE events onto the same SubagentActivityItem stream the local
 * SubagentRun produces, and returns the same SubagentRunResult shape. It does
 * not use a pi Agent: the external harness owns its loop and tools.
 */
import type {
  UhpHarness,
  UhpResponse,
  UhpStreamEvent,
} from "uhp-protocol";
import type {
  SubagentActivityItem,
  SubagentHistoryMessage,
  SubagentRunResult,
} from "../types";
import type { SubagentDefinition } from "./subagent-definitions";
import { UhpClient, UhpClientError } from "../uhp/client";
import { clientForServer, resolveUhpServer, type UhpClientServer } from "../uhp/servers";
import { logErr } from "../log";

type UhpSubagentRunOptions = {
  definition: SubagentDefinition;
  cwd: string;
  task?: string;
  initialMessages?: SubagentHistoryMessage[];
  signal: AbortSignal;
  onActivity: (item: SubagentActivityItem) => void;
  onResponseId?: (responseId: string) => void;
  /** Mid-run history snapshot for crash/resume. */
  onHistory?: (messages: SubagentHistoryMessage[]) => void;
  turnBase?: number;
  toolCallBase?: number;
  previousResponseId?: string | null;
  /** Per-Task override; takes precedence over definition.uhp.model. */
  modelOverride?: string | null;
};

type ItemState = {
  id: string;
  type: string;
  outputIndex: number;
  text: string;
  name?: string;
  callId?: string;
  args?: string;
  startedText?: boolean;
  startedReasoning?: boolean;
  startedTool?: boolean;
};

type ActivityDraft = SubagentActivityItem extends infer T
  ? T extends SubagentActivityItem
    ? Omit<T, "at"> & { at?: number }
    : never
  : never;

function activity(item: ActivityDraft): SubagentActivityItem {
  return { ...item, at: item.at ?? Date.now() } as SubagentActivityItem;
}

function textFromMessages(messages: SubagentHistoryMessage[] | undefined): string {
  if (!messages?.length) return "";
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const content = message.content;
      if (typeof content === "string") parts.push(content);
    }
  }
  return parts.join("\n\n").trim();
}

function reportFromResponse(response: UhpResponse): string {
  const parts: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message") continue;
    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const value = part as { type?: string; text?: string };
      if (value.type === "output_text" && typeof value.text === "string") {
        parts.push(value.text);
      }
    }
  }
  const text = parts.join("\n").trim();
  if (text) return text;
  const toolOutputs: string[] = [];
  for (const item of response.output) {
    if (item.type !== "function_call_output") continue;
    const value = item as { output?: unknown };
    if (typeof value.output === "string" && value.output.trim()) {
      toolOutputs.push(value.output.trim());
    }
  }
  return toolOutputs.join("\n").slice(0, 8_000);
}

function statusOf(response: UhpResponse): SubagentRunResult["status"] {
  if (response.status === "completed") return "completed";
  if (response.status === "incomplete") return "truncated";
  if (response.status === "cancelled") return "aborted";
  return "failed";
}

function countToolCalls(response: UhpResponse): number {
  return response.output.filter((item) => item.type === "function_call").length;
}

export class UhpSubagentRun {
  private readonly opts: UhpSubagentRunOptions;
  private readonly queue: string[] = [];
  private readonly history: SubagentHistoryMessage[] = [];
  private readonly items = new Map<string, ItemState>();
  private readonly toolNames = new Map<string, string>();
  private client: UhpClient | null = null;
  private server: UhpClientServer | null = null;
  private harness: UhpHarness | null = null;
  private responseId: string | null = null;
  private reportedResponseId: string | null = null;
  private previousResponseId: string | null;
  private cancelled = false;
  private lastResponse: UhpResponse | null = null;

  constructor(options: UhpSubagentRunOptions) {
    this.opts = options;
    this.previousResponseId = options.previousResponseId ?? null;
    for (const message of options.initialMessages ?? []) this.history.push(message);
  }

  steer(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    this.queue.push(trimmed);
    return true;
  }

  historySnapshot(): SubagentHistoryMessage[] {
    return [...this.history];
  }

  async run(): Promise<SubagentRunResult> {
    const definition = this.opts.definition;
    const turnBase = this.opts.turnBase ?? 0;
    const toolCallBase = this.opts.toolCallBase ?? 0;
    const modelId =
      this.opts.modelOverride || definition.uhp?.model || definition.model || "uhp";

    try {
      this.server = resolveUhpServer(definition.uhp?.server);
      this.client = clientForServer(this.server);
      const discovery = await this.client.discovery(this.opts.signal);
      if (!discovery.capabilities.streaming) {
        throw new UhpClientError("The UHP server does not advertise streaming capability.");
      }
      this.harness = await this.resolveHarness();
    } catch (error) {
      return this.failure(error, modelId, turnBase, toolCallBase);
    }

    let task = this.opts.task?.trim() ?? "";
    if (!task) task = textFromMessages(this.opts.initialMessages);
    if (!task) {
      return this.failure(new Error("UHP subagent task is empty."), modelId, turnBase, toolCallBase);
    }

    if (this.opts.signal.aborted) {
      return {
        agentName: definition.name,
        modelId,
        status: "stopped",
        report: "",
        turns: turnBase,
        toolCalls: toolCallBase,
      };
    }

    this.opts.onActivity(
      activity({
        kind: "turn",
        n: turnBase + 1,
        at: Date.now(),
      }),
    );

    try {
      let response = await this.runOne(task, modelId);
      this.lastResponse = response;
      while (
        this.queue.length > 0 &&
        !this.cancelled &&
        !response.error &&
        response.status !== "cancelled"
      ) {
        const next = this.queue.shift()!;
        this.history.push({ role: "user", content: next });
        response = await this.runOne(next, modelId);
        this.lastResponse = response;
      }
      return this.resultFrom(response, modelId, turnBase, toolCallBase);
    } catch (error) {
      if (this.cancelled || (error instanceof Error && error.name === "AbortError")) {
        return {
          agentName: definition.name,
          modelId,
          status: "aborted",
          report: reportFromResponse(this.lastResponse ?? emptyResponse()),
          turns: turnBase + 1,
          toolCalls: toolCallBase + countToolCalls(this.lastResponse ?? emptyResponse()),
        };
      }
      return this.failure(error, modelId, turnBase, toolCallBase);
    }
  }

  private async resolveHarness(): Promise<UhpHarness> {
    if (!this.client) throw new Error("UHP client is not initialized.");
    const wanted = this.opts.definition.uhp?.harness;
    const harnesses = await this.client.listHarnesses(this.opts.signal);
    if (wanted) {
      const found = harnesses.find((harness) => harness.id === wanted);
      if (!found) throw new UhpClientError(`UHP harness "${wanted}" was not found.`);
      return found;
    }
    if (harnesses.length === 1) return harnesses[0];
    if (harnesses.length === 0) {
      throw new UhpClientError("The UHP server exposes no harness.");
    }
    throw new UhpClientError(
      "The UHP server exposes multiple harnesses; set uhp.harness in the subagent definition.",
    );
  }

  private async runOne(task: string, modelId: string): Promise<UhpResponse> {
    if (!this.client || !this.harness) throw new Error("UHP client is not initialized.");
    this.items.clear();
    this.toolNames.clear();
    this.history.push({ role: "user", content: task });
    const request = {
      input: task,
      metadata: {
        harness_id: this.harness.id,
        // cwd is a Kova extension; omit it unless explicitly configured so
        // other UHP servers can use their own harness workspace.
        ...(this.opts.definition.uhp?.cwd
          ? { cwd: this.opts.definition.uhp.cwd }
          : {}),
      },
      instructions: this.opts.definition.prompt,
      ...(modelId !== "uhp" ? { model: modelId } : {}),
      ...(this.previousResponseId
        ? { previous_response_id: this.previousResponseId }
        : {}),
      stream: true,
    };
    const response = await this.client.createResponse(request, {
      signal: this.opts.signal,
      onEvent: (event) => this.onEvent(event),
    });
    this.previousResponseId = response.id;
    this.rememberResponseId(response.id);
    const report = reportFromResponse(response);
    if (report) this.history.push({ role: "assistant", content: report });
    try {
      this.opts.onHistory?.([...this.history]);
    } catch (error) {
      logErr(`[uhp] failed to persist subagent history: ${String(error)}`);
    }
    return response;
  }

  /** Persist the external id as soon as it exists, not only after completion. */
  private rememberResponseId(id: string): void {
    this.responseId = id;
    if (this.reportedResponseId === id) return;
    this.reportedResponseId = id;
    try {
      this.opts.onResponseId?.(id);
    } catch (error) {
      logErr(`[uhp] failed to persist external response id ${id}: ${String(error)}`);
    }
    // Stop can arrive before response.created. In that window cancel() has no
    // id to send; cancel the remote task as soon as the created event lands.
    if (this.cancelled && this.client) {
      void this.client.cancel(id).catch(() => undefined);
    }
  }

  private onEvent(event: UhpStreamEvent): void {
    switch (event.type) {
      case "response.created":
        this.rememberResponseId(event.response.id);
        return;
      case "response.output_item.added": {
        const item = event.item;
        const id = typeof item.id === "string" ? item.id : `item-${event.output_index}`;
        const state: ItemState = {
          id,
          type: item.type,
          outputIndex: event.output_index,
          text: "",
          ...(item.type === "function_call"
            ? {
                name: (item as { name?: string }).name,
                callId: (item as { call_id?: string }).call_id,
                args: (item as { arguments?: string }).arguments,
              }
            : {}),
        };
        this.items.set(id, state);
        if (item.type === "function_call") {
          // Defer the tool-start activity until arguments.done so the panel
          // shows the real arguments, not the empty shell sent by added.
          if (state.callId) this.toolNames.set(state.callId, state.name ?? "tool");
        }
        return;
      }
      case "response.output_text.delta": {
        const state = this.items.get(event.item_id);
        if (!state) return;
        if (!state.startedText) {
          state.startedText = true;
          this.opts.onActivity(
            activity({ kind: "text", op: "start", id: state.id }),
          );
        }
        state.text += event.delta;
        this.opts.onActivity(
          activity({ kind: "text", op: "delta", id: state.id, delta: event.delta }),
        );
        return;
      }
      case "response.output_text.done": {
        const state = this.items.get(event.item_id);
        if (!state) return;
        if (!state.startedText) {
          state.startedText = true;
          this.opts.onActivity(activity({ kind: "text", op: "start", id: state.id }));
        }
        state.text = event.text;
        this.opts.onActivity(activity({ kind: "text", op: "end", id: state.id }));
        return;
      }
      case "response.reasoning_summary_text.delta": {
        const state = this.items.get(event.item_id);
        if (!state) return;
        if (!state.startedReasoning) {
          state.startedReasoning = true;
          this.opts.onActivity(
            activity({ kind: "thinking", op: "start", id: state.id }),
          );
        }
        state.text += event.delta;
        this.opts.onActivity(
          activity({ kind: "thinking", op: "delta", id: state.id, delta: event.delta }),
        );
        return;
      }
      case "response.reasoning_summary_part.done": {
        const state = this.items.get(event.item_id);
        if (!state || !state.startedReasoning) return;
        this.opts.onActivity(activity({ kind: "thinking", op: "end", id: state.id }));
        return;
      }
      case "response.function_call_arguments.done": {
        const state = this.items.get(event.item_id);
        if (!state) return;
        state.args = event.arguments;
        if (!state.startedTool) {
          state.startedTool = true;
          this.opts.onActivity(
            activity({
              kind: "tool",
              op: "start",
              toolCallId: state.callId ?? state.id,
              toolName: state.name ?? "tool",
              argsSummary: summarizeArgs(state.args),
            }),
          );
        }
        return;
      }
      case "response.output_item.done": {
        const item = event.item;
        if (item.type === "function_call_output") {
          const callId = (item as { call_id?: string }).call_id ?? "tool";
          this.opts.onActivity(
            activity({
              kind: "tool",
              op: "end",
              toolCallId: callId,
              toolName: this.toolNames.get(callId) ?? "tool",
              resultSummary: summarizeResult((item as { output?: unknown }).output),
            }),
          );
        }
        return;
      }
      case "error":
        this.opts.onActivity(
          activity({
            kind: "retry",
            attempt: 0,
            maxRetries: 0,
            delayMs: 0,
            code: event.code,
            message: event.message,
          }),
        );
        return;
      default:
        return;
    }
  }

  private resultFrom(
    response: UhpResponse,
    modelId: string,
    turnBase: number,
    toolCallBase: number,
  ): SubagentRunResult {
    const status = this.cancelled ? "aborted" : statusOf(response);
    return {
      agentName: this.opts.definition.name,
      modelId: response.model || modelId,
      status,
      report: reportFromResponse(response),
      turns: turnBase + 1,
      toolCalls: toolCallBase + countToolCalls(response),
      ...(response.usage ? { tokens: response.usage.total_tokens } : {}),
      ...(response.error
        ? {
            error: {
              code: response.error.code,
              message: response.error.message,
            },
          }
        : {}),
    };
  }

  private failure(
    error: unknown,
    modelId: string,
    turnBase: number,
    toolCallBase: number,
  ): SubagentRunResult {
    const message = error instanceof Error ? error.message : String(error);
    logErr(`[uhp] subagent ${this.opts.definition.name} failed: ${message}`);
    return {
      agentName: this.opts.definition.name,
      modelId,
      status: this.cancelled ? "aborted" : "failed",
      report: "",
      turns: turnBase + 1,
      toolCalls: toolCallBase,
      error: {
        code: error instanceof UhpClientError ? error.code : "UHP_SUBAGENT_FAILED",
        message,
      },
    };
  }

  cancel(): void {
    this.cancelled = true;
    if (this.client && this.responseId) {
      void this.client.cancel(this.responseId).catch(() => undefined);
    }
  }
}

function emptyResponse(): UhpResponse {
  return {
    id: "resp_empty",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "failed",
    error: null,
    incomplete_details: null,
    previous_response_id: null,
    model: "uhp",
    output: [],
    store: false,
    usage: null,
    metadata: { session_id: "hsess_unknown" },
  };
}

function summarizeArgs(args: string | undefined): string | undefined {
  if (!args) return undefined;
  const text = args.replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function summarizeResult(output: unknown): string | undefined {
  if (typeof output === "string") {
    const text = output.replace(/\s+/g, " ").trim();
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  }
  return undefined;
}
