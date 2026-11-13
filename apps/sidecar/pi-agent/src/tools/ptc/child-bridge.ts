/**
 * PTC 子调用桥：把 Kova 的 AgentTool 包成脚本可见的 `tools.<name>(args)`。
 *
 * 关键约束：每次子调用都走 pi-agent-core 的 `runToolCall()`，因此参数校验、
 * `beforeToolCall`（审批/模式门控）、工具执行、`afterToolCall`（goal 证据、
 * PostToolUse 钩子）与模型直接调用完全同一条链。子调用的结果不写入
 * `agent.state.messages`，只回给脚本并记录在 run_code 的 details 里。
 */
import {
  type AgentContext,
  type AgentTool,
  type AgentToolCallOutcome,
  type AgentToolResult,
  runToolCall,
} from "@earendil-works/pi-agent-core";
import type {
  CodemodeJsonSchema,
  CodemodeTool,
  CodemodeToolContext,
} from "@earendil-works/pi-codemode";
import type {
  AssistantMessage,
  ImageContent,
  JsonObject,
  TextContent,
} from "@earendil-works/pi-ai";
import type { Running } from "../../types";
import { settleInteraction } from "../../sessions/pending-interactions";
import { PtcScheduler, type PtcCallMode } from "./scheduler";

/**
 * 第一版只读工具。名字以 `buildTools()` 实际产出为准；缺失的工具会自动跳过，
 * 因此条件注册（记忆/知识库未开启）不会把整个 PTC 拖挂。
 */
export const PTC_READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "WebFetch",
  "WebSearch",
  "kb_search",
  "kb_read",
  "memory_read",
  "memory_search",
  "search_external_files",
]);

/**
 * 这些工具可以并行。当前与只读清单同集：只读 = 无共享可变状态 = 并行安全。
 * 放开写类/MCP 时只改 READ_ONLY（决定「能不能调」），并把需要独占的名字从
 * 这里移除（决定「怎么调度」）——两份清单不再靠人工同步。
 */
export const PTC_PARALLEL_TOOL_NAMES: ReadonlySet<string> = PTC_READ_ONLY_TOOL_NAMES;

export const PTC_MAX_CHILD_CALLS = 100;
const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;

export type PtcChildCallStatus = "running" | "ok" | "error" | "cancelled";

export interface PtcChildCall {
  /** `<run_code toolCallId>/<n>`，与审批卡上的子调用 id 一致。 */
  id: string;
  name: string;
  /** 压缩后的参数 JSON，仅供 UI。 */
  args: string;
  status: PtcChildCallStatus;
  durationMs?: number;
  error?: string;
}

export interface PtcToolEnvelope {
  status: "ok" | "error" | "cancelled";
  isError: boolean;
  output: string;
  data?: unknown;
  images?: ImageContent[];
  error?: { code: string; message: string };
}

export interface PtcChildBridge {
  /** 传给 CodemodeSandbox 的工具表。 */
  readonly tools: CodemodeTool[];
  /** 当前子调用记录（含 running）。 */
  snapshot(): PtcChildCall[];
  /**
   * 脚本结束时收尾：把仍在运行的调用标成 cancelled（沙箱已 abort 它们的
   * per-call signal），并把本次 run_code 名下还没结算的审批卡按拒绝关掉——
   * 脚本的 deadline/abort 断不了挂在审批上的 runToolCall，不结算的话用户
   * 之后点「允许」就是把结果写给一个无人等待的调用。
   */
  finalize(): void;
}

export interface PtcChildBridgeOptions {
  run: Running;
  parentToolCallId: string;
  parentDescription?: string;
  /** 子调用开始/结束时触发，用于把 details.ptc 推给 UI。 */
  onChange?: () => void;
}

interface ParentCallInfo {
  parentToolCallId: string;
  parentDescription?: string;
}

/** 子调用 id → 父 run_code 信息；审批卡据此显示「来自 run_code」。 */
const parentByChildId = new Map<string, ParentCallInfo>();

export function ptcParentOf(childToolCallId: string): ParentCallInfo | undefined {
  return parentByChildId.get(childToolCallId);
}

export function createPtcChildBridge(options: PtcChildBridgeOptions): PtcChildBridge {
  const { run, parentToolCallId, parentDescription, onChange } = options;
  const childAgentTools = run.baseTools.filter((tool) =>
    PTC_READ_ONLY_TOOL_NAMES.has(tool.name),
  );
  const scheduler = new PtcScheduler();
  const calls: PtcChildCall[] = [];
  let nextId = 1;
  let issued = 0;
  const assistantMessage = findAssistantMessage(run, parentToolCallId);
  const context: AgentContext = run.loopContext ?? {
    messages: run.agent.state.messages,
    tools: run.agent.state.tools,
  };

  const publish = () => onChange?.();

  const tools: CodemodeTool[] = childAgentTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as CodemodeJsonSchema,
    outputSchema: ptcEnvelopeSchema(tool.outputSchema as CodemodeJsonSchema | undefined),
    execute: async (args, callContext) =>
      executeChild(tool, args, callContext, {
        run,
        parentToolCallId,
        parentDescription,
        assistantMessage,
        context,
        agentTools: childAgentTools,
        scheduler,
        calls,
        publish,
        allocateId: () => `${parentToolCallId}/${nextId++}`,
        countIssued: () => ++issued,
      }),
  }));

  return {
    tools,
    snapshot: () => calls.map((call) => ({ ...call })),
    finalize: () => {
      let changed = false;
      for (const call of calls) {
        if (call.status !== "running") continue;
        call.status = "cancelled";
        changed = true;
      }
      // 脚本级 abort 断不了挂在审批上的子调用：把本次 run_code 名下的挂起卡
      // 按拒绝结算（与 modes.ts 的 clearApprovalsForDelegation 同一语义，但
      // 不 import modes——modes → 本模块已是既有依赖，反向 import 会成环）。
      // settleInteraction 单源在 pending-interactions，modes 也是从它拿的。
      for (const [approvalId, pending] of [...run.pendingToolApprovals]) {
        if (pending.parentToolCallId !== parentToolCallId) continue;
        run.pendingToolApprovals.delete(approvalId);
        settleInteraction(approvalId, "cancelled");
        pending.settledBy = "clear";
        pending.resolve({ approved: false, remember: false });
      }
      if (changed) publish();
    },
  };
}

interface ExecuteChildOptions {
  run: Running;
  parentToolCallId: string;
  parentDescription?: string;
  assistantMessage: AssistantMessage;
  context: AgentContext;
  agentTools: AgentTool[];
  scheduler: PtcScheduler;
  calls: PtcChildCall[];
  publish: () => void;
  allocateId: () => string;
  countIssued: () => number;
}

async function executeChild(
  tool: AgentTool,
  args: unknown,
  callContext: CodemodeToolContext,
  options: ExecuteChildOptions,
): Promise<PtcToolEnvelope> {
  const issued = options.countIssued();
  if (issued > PTC_MAX_CHILD_CALLS) {
    return {
      status: "error",
      isError: true,
      output: `PTC refused this call after reaching the ${PTC_MAX_CHILD_CALLS}-call limit; it was not executed.`,
      error: {
        code: "PTC_TOOL_CALL_LIMIT_EXCEEDED",
        message: `PTC refused this call after reaching the ${PTC_MAX_CHILD_CALLS}-call limit; it was not executed.`,
      },
    };
  }

  const id = options.allocateId();
  const record: PtcChildCall = {
    id,
    name: tool.name,
    args: previewArgs(args),
    status: "running",
  };
  options.calls.push(record);
  options.publish();
  parentByChildId.set(id, {
    parentToolCallId: options.parentToolCallId,
    parentDescription: options.parentDescription,
  });

  const startedAt = performance.now();
  try {
    const outcome = await options.scheduler.run(
      callModeFor(tool.name),
      () =>
        runToolCall(
          {
            type: "toolCall",
            id,
            name: tool.name,
            arguments: (args ?? {}) as JsonObject,
          },
          {
            tools: options.agentTools,
            assistantMessage: options.assistantMessage,
            context: options.context,
            signal: callContext.signal,
            beforeToolCall: options.run.agent.beforeToolCall,
            afterToolCall: options.run.agent.afterToolCall,
          },
        ),
    );

    const envelope = toEnvelope(tool, outcome, callContext.signal);
    record.status = envelope.status;
    record.durationMs = performance.now() - startedAt;
    if (envelope.error) record.error = truncate(envelope.error.message, ERROR_PREVIEW_CHARS);
    options.publish();
    return envelope;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record.status = callContext.signal.aborted ? "cancelled" : "error";
    record.durationMs = performance.now() - startedAt;
    record.error = truncate(message, ERROR_PREVIEW_CHARS);
    options.publish();
    return {
      status: record.status === "cancelled" ? "cancelled" : "error",
      isError: true,
      output: message,
      error: { code: "PTC_CHILD_FAILED", message },
    };
  } finally {
    parentByChildId.delete(id);
  }
}

function callModeFor(toolName: string): PtcCallMode {
  return PTC_PARALLEL_TOOL_NAMES.has(toolName) ? "parallel" : "sequential";
}

function toEnvelope(
  tool: AgentTool,
  outcome: AgentToolCallOutcome,
  signal: AbortSignal,
): PtcToolEnvelope {
  const output = textOf(outcome.result);
  const images = imageBlocks(outcome.result);
  const data = outcome.result.structuredContent;
  const cancelled = outcome.isError && signal.aborted;
  const message = output || `Tool "${tool.name}" failed`;
  if (!outcome.isError) {
    return {
      status: "ok",
      isError: false,
      output,
      ...(data !== undefined ? { data } : {}),
      ...(images.length > 0 ? { images } : {}),
    };
  }
  return {
    status: cancelled ? "cancelled" : "error",
    isError: true,
    output,
    ...(data !== undefined ? { data } : {}),
    ...(images.length > 0 ? { images } : {}),
    error: { code: cancelled ? "PTC_CANCELLED" : "PTC_TOOL_FAILED", message },
  };
}

function textOf(result: AgentToolResult<unknown>): string {
  return (result.content ?? [])
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function imageBlocks(result: AgentToolResult<unknown>): ImageContent[] {
  return (result.content ?? []).filter(
    (block): block is ImageContent => block.type === "image",
  );
}

export function ptcEnvelopeSchema(dataSchema: CodemodeJsonSchema | undefined): CodemodeJsonSchema {
  return {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ok", "error", "cancelled"] },
      isError: { type: "boolean" },
      output: { type: "string" },
      // 始终声明 data：没有 outputSchema 的工具也可能返回 structuredContent。
      data: dataSchema ?? {},
      images: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string" },
            data: { type: "string" },
            mimeType: { type: "string" },
          },
        },
      },
      error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
      },
    },
    required: ["status", "isError", "output"],
  };
}

function previewArgs(args: unknown): string {
  if (args === undefined) return "";
  try {
    return truncate(JSON.stringify(args) ?? "", ARGS_PREVIEW_CHARS);
  } catch {
    return "";
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** 找到发起本次 run_code 的 assistant 消息；找不到时用合成的单调用消息。 */
function findAssistantMessage(run: Running, toolCallId: string): AssistantMessage {
  const messages = run.agent.state.messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const assistant = message as AssistantMessage;
    if (
      Array.isArray(assistant.content) &&
      assistant.content.some(
        (block) => block.type === "toolCall" && block.id === toolCallId,
      )
    ) {
      return assistant;
    }
  }
  // 正常运行中父消息必然已在 state.messages（agent loop 先 append assistant 再执行
  // 工具），这里基本不可达。不回退到「最后一条 assistant」——那可能带着别的批次，
  // modeBeforeToolCall 的批次独占检查会读错消息；synthetic 只有一个 toolCall，
  // 对批次检查是无害的。
  return syntheticAssistantMessage(run, toolCallId);
}

function syntheticAssistantMessage(run: Running, toolCallId: string): AssistantMessage {
  const model = run.agent.state.model;
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: toolCallId,
        name: "run_code",
        arguments: {},
      },
    ],
    api: (model?.api ?? "openai-completions") as AssistantMessage["api"],
    provider: (model?.provider ?? "unknown") as AssistantMessage["provider"],
    model: model?.id ?? "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}
