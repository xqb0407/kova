/**
 * delegate 执行循环：一次委派 = 一个独立 pi Agent 实例（独立 system prompt、
 * 可固定模型、定义声明的工具集），provider 重试/轨迹/长度续跑与主代理同款。
 * 委派注册表与活动流见 delegation.ts，Task 工具组见 tools.ts。
 */
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  getModels,
  makePromptCacheKeyPayloadHook,
  makeSessionAffinityHeaders,
} from "../model/model-catalog";
import { logErr } from "../log";
import {
  captureProviderResponse,
  carriesRetryDelayHeaders,
  claimRetry,
  createProviderRetryStream,
  createRetryBudget,
  providerRetryMaxRetries,
} from "../model/provider-retry";
import type { SubagentDefinition } from "./subagent-definitions";
import { makeAutoContinueMessage, MAX_LENGTH_CONTINUES, needsLengthContinuation } from "../agent/context";
import { createTraceRunRecorder, type TraceRunRecorder } from "../protocol/trace";
import { messageUsageTokens } from "../agent/context";
import type { SubagentActivityItem, SubagentRunResult, SubagentRunStatus } from "../types";
import { boundedReport, summarizeToolArgs } from "./delegation";

/**
 * 组装 delegate 的 system prompt：框架说明在前，定义正文在后
 * （正文是定义自己的行为说明，让它对"怎么干活"有最后发言权）。
 */
export function composeSubagentSystemPrompt(options: {
  definition: SubagentDefinition;
  cwd: string;
}): string {
  const { definition, cwd } = options;
  const toolList = definition.tools.join(", ") || "none";
  const canMutate = definition.tools.some((t) => ["bash", "write", "edit"].includes(t));
  const framing = [
    `You are the "${definition.name}" subagent inside the Kova desktop app, working on one task delegated by the main agent.`,
    `The workspace directory is \`${cwd}\`. Relative paths resolve there.`,
    `You cannot see the user, ask questions, or delegate further. Finish the task with the tools you have: ${toolList}.`,
    canMutate
      ? "You may change files, but only the ones the task is about; leave everything else untouched."
      : "You have no tools that change files or run commands, so never report an edit you could not have made.",
    "Your final message is the report the main agent receives when you finish. Make it self-contained: what you did, what you found with exact paths and line numbers, and anything you could not finish.",
    "Keep the report tight. Report findings, not narration, and never pad it with a summary of your own process.",
  ].join("\n");
  return [framing, definition.prompt].filter((b) => b.trim().length > 0).join("\n\n");
}

type SubagentRunOptions = {
  definition: SubagentDefinition;
  task: string;
  model: Model<Api>;
  cwd: string;
  tools: AgentTool[];
  /** 委派 id：透传给 provider 做缓存路由（OpenAI prompt_cache_key / Anthropic session-affinity） */
  sessionId: string;
  /** 父会话 id：轨迹归属（trace.ts 写进父会话的 traces 文件；sessionId 是 delegationId） */
  traceSessionId: string;
  /** 父 run 的 traceId：轨迹因果边（子 run 挂在父 run 下） */
  parentRunId?: string;
  /** 触发本次委派的父 span：父 run 里那次 Task tool_call 的 spanId */
  parentSpanId?: string;
  signal?: AbortSignal;
  /** 归一化活动条目回调（进缓冲 + 广播；见 pushActivity） */
  onActivity?: (item: SubagentActivityItem) => void;
};

/** 长缓存开关（与 sessions.ts 主代理一致）：PI_CACHE_RETENTION=long 时启用，compat 守门自动降级 */
function cacheRetentionOption() {
  return process.env.PI_CACHE_RETENTION === "long" ? { cacheRetention: "long" as const } : {};
}
/** 一次 delegate 执行。实例单次使用。 */
export class SubagentRun {
  private readonly agent: Agent;
  private readonly opts: SubagentRunOptions;
  private lastReportText = "";
  private turns = 0;
  private toolCalls = 0;
  /** 本次委派的 token 累计（四项相加，错误/中止轮不计），随结果回传父 run */
  private tokens = 0;
  private cappedTurns = false;
  private streamError?: { code: string; message: string };
  /** 长度截断自动续跑计数（预算按一次委派；见 context.ts） */
  private lengthContinues = 0;
  /** delegate 的 provider 请求自动重试记账（预算按一次委派，静默只记日志） */
  private readonly retryBudget = createRetryBudget();
  /** 调用轨迹（trace.ts）：归属父会话文件，随 handleEvent 喂事件、agent_end 结算 */
  private readonly trace: TraceRunRecorder;
  private retryCapture: {
    status?: number;
    headers?: Readonly<Record<string, string>>;
  } = {};

  constructor(opts: SubagentRunOptions) {
    this.opts = opts;
    this.trace = createTraceRunRecorder(opts.traceSessionId, "subagent", {
      parentRunId: opts.parentRunId,
      parentSpanId: opts.parentSpanId,
    });
    this.agent = new Agent({
      sessionId: this.opts.sessionId,
      // 与主代理一致：自定义 OpenAI 兼容端点补发 prompt_cache_key
      onPayload: makePromptCacheKeyPayloadHook(this.opts.sessionId),
      streamFn: (m, context, options) => {
        // 轨迹内容捕获：同主代理（附加到随后打开的 llm_call span）
        this.trace.noteRequest(context);
        this.retryCapture.status = undefined;
        this.retryCapture.headers = undefined;
        return createProviderRetryStream(
          m,
          context,
          {
            ...options,
            // 与主代理同款：无条件补发会话亲和头（参考 opencode）
            headers: {
              ...options?.headers,
              ...makeSessionAffinityHeaders(this.opts.sessionId),
            },
            ...cacheRetentionOption(),
            fetch: captureProviderResponse(options?.fetch, (response) => {
              this.retryCapture.status = response?.status;
              this.retryCapture.headers = carriesRetryDelayHeaders(
                response?.status,
              )
                ? response?.headers
                : undefined;
            }),
          },
          (retryOptions) => getModels().streamSimple(m, context, retryOptions),
          {
            claim: (error) => claimRetry(this.retryBudget, error),
            headers: () => this.retryCapture.headers,
            status: () => this.retryCapture.status,
            // delegate 没有自己的 UI 流，重试过程只留日志
            onRetry: ({ error, attempt, delayMs }) => {
              this.trace.noteRetry({
                attempt,
                delayMs,
                code: error.code,
                message: error.message,
              });
              logErr(
                `subagent ${this.opts.definition.name}: provider retry ${attempt}/${providerRetryMaxRetries()} in ${delayMs}ms (${error.code})`,
              );
            },
            // 重试等待收口（新尝试出流 / 终态错误 / Stop 打断退避）
            onSettled: () => this.trace.noteRetrySettled(),
          },
        );
      },
      afterToolCall: async () => {
        // sidecar 工具直接执行、没有父级簿记，这里只负责定义的轮次上限
        const capped =
          this.opts.definition.maxTurns !== undefined &&
          this.turns >= this.opts.definition.maxTurns;
        if (capped) this.cappedTurns = true;
        return capped ? { terminate: true } : undefined;
      },
      initialState: {
        systemPrompt: composeSubagentSystemPrompt({
          definition: this.opts.definition,
          cwd: this.opts.cwd,
        }),
        model: this.opts.model,
        tools: this.opts.tools,
        messages: [],
      },
      // delegate 是干活的，不是扇出点：自己的工具串行执行，也没有 Task 工具可以继续嵌套
      toolExecution: "sequential",
    });
    this.agent.subscribe((event) => this.handleEvent(event));
  }

  async run(): Promise<SubagentRunResult> {
    const signal = this.opts.signal;
    if (signal?.aborted) {
      return this.result("aborted", "The delegated task was aborted before it started.");
    }
    const onAbort = () => this.agent.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let caught: unknown;
    try {
      await this.agent.prompt(this.opts.task);
      await this.agent.waitForIdle();
    } catch (err) {
      caught = err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    if (signal?.aborted) {
      return this.result("aborted", "The delegated task was aborted.");
    }
    if (this.streamError) return this.result("failed", "", this.streamError);
    if (caught) {
      return this.result("failed", "", {
        code: "SUBAGENT_ERROR",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
    if (this.cappedTurns) return this.result("truncated", this.lastReportText);
    if (!this.lastReportText.trim()) {
      return this.result("failed", "", {
        code: "SUBAGENT_NO_REPORT",
        message: "The subagent finished without writing a report.",
      });
    }
    return this.result("completed", this.lastReportText);
  }

  private result(
    status: SubagentRunStatus,
    report: string,
    error?: { code: string; message: string },
  ): SubagentRunResult {
    const name = this.opts.definition.name;
    const body = report.trim();
    const text =
      status === "completed"
        ? body
        : status === "truncated"
          ? [
              `The ${name} subagent hit its ${this.opts.definition.maxTurns ?? "configured"}-turn limit before finishing.`,
              ...(body ? ["Its last report was:", body] : []),
            ].join("\n\n")
          : status === "aborted"
            ? `The ${name} subagent was aborted after ${this.turns} turn(s).`
            : [
                `The ${name} subagent failed after ${this.turns} turn(s): ${error?.message ?? "unknown error"}.`,
                ...(body ? ["Its last output was:", body] : []),
              ].join("\n\n");
    return {
      agentName: name,
      modelId: this.opts.model.id,
      status,
      report: boundedReport(text),
      turns: this.turns,
      toolCalls: this.toolCalls,
      tokens: this.tokens,
      ...(error ? { error } : {}),
    };
  }

  /** 消费计数与报告所需的事件，并把过程归一化成活动条目转发（onActivity）；
   * turn_end / agent_end 留在内部，delegate 结束绝不能终结父代理的 turn。 */
  private handleEvent(event: AgentEvent): void {
    // 轨迹记账：全事件喂给记录器，agent_end 即结算（handle 先行保证 endMs 收在事件上）
    this.trace.handle(event);
    if (event.type === "agent_end") this.trace.settle();
    // 自己的账自己记：子代理是独立 Agent，用量不进父会话转录，只能靠结果回传
    if (event.type === "message_end") {
      this.tokens += messageUsageTokens(event.message);
    }
    switch (event.type) {
      case "turn_start":
        this.turns += 1;
        this.opts.onActivity?.({ kind: "turn", n: this.turns, at: Date.now() });
        break;
      case "message_update": {
        const onActivity = this.opts.onActivity;
        if (!onActivity) break;
        const e = event.assistantMessageEvent;
        const at = Date.now();
        switch (e.type) {
          case "text_start":
            onActivity({ kind: "text", op: "start", id: `c${e.contentIndex}`, at });
            break;
          case "text_delta":
            onActivity({ kind: "text", op: "delta", id: `c${e.contentIndex}`, delta: e.delta, at });
            break;
          case "text_end":
            onActivity({ kind: "text", op: "end", id: `c${e.contentIndex}`, at });
            break;
          case "thinking_start":
            onActivity({ kind: "thinking", op: "start", id: `c${e.contentIndex}`, at });
            break;
          case "thinking_delta":
            onActivity({
              kind: "thinking",
              op: "delta",
              id: `c${e.contentIndex}`,
              delta: e.delta,
              at,
            });
            break;
          case "thinking_end":
            onActivity({ kind: "thinking", op: "end", id: `c${e.contentIndex}`, at });
            break;
          default:
            break;
        }
        break;
      }
      case "message_end": {
        const m = event.message as AssistantMessage;
        if (m.role !== "assistant") break;
        if (m.stopReason === "error") {
          this.streamError = {
            code: "PROVIDER_ERROR",
            message:
              (m as { errorMessage?: string }).errorMessage || "provider stream failed",
          };
          break;
        }
        // 报告是最后一条有文本的 assistant 消息；纯工具调用轮没有文本，
        // 不能清掉早前轮次已经产出的报告
        const text = m.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("")
          .trim();
        if (text) this.lastReportText = text;
        break;
      }
      case "turn_end": {
        // 主代理同款：length 截断且零 toolCall 会被 vendor 循环当自然收尾，
        // 子代理任务同样会"到一半停下"。注入续跑消息（预算按一次委派计）。
        if (!needsLengthContinuation(event.message)) break;
        if (this.lengthContinues >= MAX_LENGTH_CONTINUES) {
          logErr(`subagent length-truncated turn: auto-continue budget exhausted`);
          break;
        }
        this.lengthContinues += 1;
        this.agent.followUp(makeAutoContinueMessage(this.lengthContinues));
        break;
      }
      case "tool_execution_start":
        this.toolCalls += 1;
        this.opts.onActivity?.({
          kind: "tool",
          op: "start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          argsSummary: summarizeToolArgs(event.args),
          at: Date.now(),
        });
        break;
      case "tool_execution_end": {
        const result = event.result as {
          content?: { type: string; text?: string }[];
          details?: { error?: unknown };
        };
        const text = (result?.content ?? [])
          .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
          .join("\n")
          .trim();
        const firstLine = text.split("\n")[0] ?? "";
        this.opts.onActivity?.({
          kind: "tool",
          op: "end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          resultSummary: firstLine ? firstLine.slice(0, 100) : undefined,
          failed:
            result?.details?.error !== undefined || /\[exit code: |\[timeout\]/.test(text),
          at: Date.now(),
        });
        break;
      }
      default:
        break;
    }
  }
}
