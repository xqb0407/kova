/**
 * delegate 执行循环：一次委派 = 一个独立 pi Agent 实例（独立 system prompt、
 * 可固定模型、定义声明的工具集），provider 重试/轨迹/长度续跑与主代理同款。
 * 委派注册表与活动流见 delegation.ts，Task 工具组见 tools.ts。
 */
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AfterToolCallContext,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
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
import { imageModelKey, stripImagesFromContext } from "../model/image-rejection";
import type { SubagentDefinition } from "./subagent-definitions";
import type { SubagentHistoryMessage } from "../types";
import {
  makeAutoContinueMessage,
  MAX_LENGTH_CONTINUES,
  needsLengthContinuation,
  repairDanglingToolCalls,
} from "../agent/context";
import { createTraceRunRecorder, type TraceRunRecorder } from "../protocol/trace";
import { messageUsageTokens } from "../agent/context";
import type { SubagentActivityItem, SubagentRunResult, SubagentRunStatus } from "../types";
import { normalizeSubagentHistory, toSubagentHistory } from "./history";
import { boundedReport, summarizeToolArgs, toolFilePath } from "./delegation";
import type { Message } from "@earendil-works/pi-ai";
import { normalizeToolResultImages } from "../tools/image-normalize";
import type { ProjectableContentBlock } from "../tools/image-parts";

/**
 * 组装 delegate 的 system prompt：框架说明在前，定义正文在后
 * （正文是定义自己的行为说明，让它对"怎么干活"有最后发言权）。
 */
export function composeSubagentSystemPrompt(options: {
  definition: SubagentDefinition;
  cwd: string;
  /** 能力目录块（技能/知识源/MCP/记忆）；各维度未声明时该块为空串。
   *  省略此参数或传空串时，输出与本能力模型引入前**逐字节相同**——
   *  这是缓存不变式，进测试（§8 测试 5）。 */
  capabilityBlock?: string;
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
  // 顺序：框架 → 能力目录 → 定义正文。正文放最后，让定义对"怎么干活"
  // 有最后发言权（与能力目录的"你有什么"分层）。
  return [framing, options.capabilityBlock, definition.prompt]
    .filter((b) => b && b.trim().length > 0)
    .join("\n\n");
}

type SubagentRunOptions = {
  definition: SubagentDefinition;
  /** 初次启动的任务 brief；resume 轮省略——上下文由 initialMessages 承载，
   *  执行走 agent.continue()（尾部已是真实 follow-up 用户消息）。 */
  task?: string;
  /** resume 轮的会话历史（上一轮 transcript 存档），作为初始上下文整体注入 */
  initialMessages?: SubagentHistoryMessage[];
  /** resume 轮的轮次/工具计数基数：对外报告 = 本实例计数 + 基数（跨轮累加） */
  turnBase?: number;
  toolCallBase?: number;
  model: Model<Api>;
  cwd: string;
  tools: AgentTool[];
  /** 能力目录块（技能/知识源/MCP/记忆）；空串时提示词与引入前逐字节相同 */
  capabilityBlock?: string;
  /** 委派 id：透传给 provider 做缓存路由（OpenAI prompt_cache_key / Anthropic session-affinity） */
  sessionId: string;
  /** 父会话 id：轨迹归属（trace.ts 写进父会话的 traces 文件；sessionId 是 delegationId） */
  traceSessionId: string;
  /** 父 run 的 traceId：轨迹因果边（子 run 挂在父 run 下） */
  parentRunId?: string;
  /** 触发本次委派的父 span：父 run 里那次 Task tool_call 的 spanId */
  parentSpanId?: string;
  /**
   * 工具闸门：每次工具调用前问一次，接**父会话**的审批链
   * （modes.subagentToolGate）。刻意必填——子代理拿到的是父会话的基础工具表，
   * 里面就有 write/edit/bash，漏接这一个参数等于整条链绕过审批；写成必填，
   * 漏接会编译不过，而不是静默放行。
   */
  toolGate: (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>;
  /**
   * 工具结果回调：父会话用它把子代理的调用记进目标证据台账。
   * 可选——非 goal 场景没有台账可记。
   */
  onToolResult?: (context: AfterToolCallContext) => void | Promise<void>;
  signal?: AbortSignal;
  /** 归一化活动条目回调（进缓冲 + 广播；见 pushActivity） */
  onActivity?: (item: SubagentActivityItem) => void;
  /** 每轮结束的历史快照回调（覆盖写中途存档；进程被打断后 resume 用） */
  onHistory?: (messages: SubagentHistoryMessage[]) => void;
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
  /** 本实例的轮次/工具计数（resume 轮从 turnBase/toolCallBase 起算） */
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
  /** 已被证实拒图的模型集合（同主代理 Running.imageRejectionModels，见 model/image-rejection.ts） */
  private readonly imageRejectionModels = new Set<string>();
  /** 调用轨迹（trace.ts）：归属父会话文件，随 handleEvent 喂事件、agent_end 结算 */
  private readonly trace: TraceRunRecorder;
  private retryCapture: {
    status?: number;
    headers?: Readonly<Record<string, string>>;
  } = {};

  constructor(opts: SubagentRunOptions) {
    this.opts = opts;
    this.trace = createTraceRunRecorder(
      opts.traceSessionId,
      "subagent",
      {
        parentRunId: opts.parentRunId,
        parentSpanId: opts.parentSpanId,
      },
      // 定义名随 trace 落盘：链路追踪面板据此显示「派给了谁」与头像
      opts.definition.name,
    );
    this.agent = new Agent({
      sessionId: this.opts.sessionId,
      // 与主代理一致：自定义 OpenAI 兼容端点补发 prompt_cache_key
      onPayload: makePromptCacheKeyPayloadHook(this.opts.sessionId),
      streamFn: (m, context, options) => {
        // 拒图 sticky 命中（同主代理，见 model/image-rejection.ts）：入口直接剥图
        const imageKey = imageModelKey(m);
        const effectiveContext = this.imageRejectionModels.has(imageKey)
          ? stripImagesFromContext(context)
          : context;
        // 轨迹内容捕获：同主代理（附加到随后打开的 llm_call span）
        this.trace.noteRequest(effectiveContext);
        this.retryCapture.status = undefined;
        this.retryCapture.headers = undefined;
        return createProviderRetryStream(
          m,
          effectiveContext,
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
          (retryOptions, ctx) => getModels().streamSimple(m, ctx, retryOptions),
          {
            claim: (error) => claimRetry(this.retryBudget, error),
            headers: () => this.retryCapture.headers,
            status: () => this.retryCapture.status,
            onImageFallbackRecovered: () => this.imageRejectionModels.add(imageKey),
            // delegate 没有自己的 UI 流，重试经活动流上屏（amber 行）+ 日志
            onRetry: ({ error, attempt, delayMs }) => {
              this.trace.noteRetry({
                attempt,
                delayMs,
                code: error.code,
                message: error.message,
              });
              this.opts.onActivity?.({
                kind: "retry",
                attempt,
                maxRetries: providerRetryMaxRetries(),
                delayMs,
                code: error.code,
                message: error.message,
                at: Date.now(),
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
      afterToolCall: async (context) => {
        // 目标证据：子代理的 write/bash 也要能证明父目标（否则把活全交给子代理
        // 的目标永远交不出可核验证据）。账记失败不阻断工具结果。
        try {
          await this.opts.onToolResult?.(context);
        } catch (err) {
          logErr("subagent goal evidence:", err);
        }
        // sidecar 工具直接执行、没有父级簿记，这里只负责定义的轮次上限
        const capped =
          this.opts.definition.maxTurns !== undefined &&
          this.turns >= this.opts.definition.maxTurns;
        if (capped) this.cappedTurns = true;
        return capped ? { terminate: true } : undefined;
      },
      // 审批闸门：委托方的 run 决定档位与边界（主代理侧注册的是同一个判定核心）
      beforeToolCall: (context) => this.opts.toolGate(context),
      initialState: {
        systemPrompt: composeSubagentSystemPrompt({
          definition: this.opts.definition,
          cwd: this.opts.cwd,
          capabilityBlock: this.opts.capabilityBlock,
        }),
        model: this.opts.model,
        tools: this.opts.tools,
        // 保留历史消息的全部顶层字段（toolResult 的 toolCallId/toolName、
        // assistant 的 stopReason 等）：只留 role+content 会让 provider 拒绝。
        // 旧存档先归一（剥掉无法配对的工具对），再补齐悬空调用，保证序列合法。
        messages: repairDanglingToolCalls(
          normalizeSubagentHistory(this.opts.initialMessages ?? []).map((m) => ({
            ...m,
            timestamp: m.timestamp ?? Date.now(),
          })) as unknown as Message[],
        ) as unknown as AgentMessage[],
      },
      // delegate 是干活的，不是扇出点：自己的工具串行执行，也没有 Task 工具可以继续嵌套
      toolExecution: "sequential",
    });
    this.agent.subscribe((event) => this.handleEvent(event));
  }

  /** 是否已结束（run() 返回后置位）：结束后 steer 不再受理 */
  private settled = false;

  /**
   * 给运行中的 delegate 插入一条消息（SendMessage / 对话页输入）。
   * 走 pi-core 的 steering 队列：不中止、不排队重跑，下个模型调用边界被消费。
   * 返回 false = 委派已结束（调用方应转 resume 路径或明确报错）。
   */
  steer(text: string): boolean {
    const body = text.trim();
    if (!body || this.settled) return false;
    const msg: AgentMessage = {
      role: "user",
      content: `[user follow-up] ${body}`,
      timestamp: Date.now(),
    };
    try {
      this.agent.steer(msg);
      return true;
    } catch (err) {
      logErr(`subagent ${this.opts.definition.name}: steer failed:`, err);
      return false;
    }
  }

  /** 结束时的会话历史存档（resume 的初始上下文）；条数 + 字节双上限防膨胀 */
  historySnapshot(): SubagentHistoryMessage[] {
    const messages = (this.agent.state.messages ?? []) as AgentMessage[];
    const MAX_HISTORY = 100;
    // 每轮都会覆盖写一份中途快照；单个工具结果可能很大，只按条数限会让
    // 每轮同步写数 MB。从最新往回取到字节预算为止（最新一条超预算也保留）。
    const MAX_HISTORY_BYTES = 2_000_000;
    const kept: AgentMessage[] = [];
    let bytes = 0;
    for (let i = messages.length - 1; i >= 0 && kept.length < MAX_HISTORY; i--) {
      const message = messages[i]!;
      let size = 0;
      try {
        size = Buffer.byteLength(JSON.stringify(message) ?? "", "utf8");
      } catch {
        size = 0; // 非 JSON 安全的消息后面序列化也会失败，按 0 计
      }
      if (kept.length > 0 && bytes + size > MAX_HISTORY_BYTES) break;
      kept.unshift(message);
      bytes += size;
    }
    // 截断点可能落在轮中：开头的 toolResult 没有对应的 assistant toolCall，
    // 直接喂给 provider 是非法序列（"tool message without preceding call"）。
    while (kept.length > 0 && kept[0]?.role === "toolResult") {
      kept.shift();
    }
    return toSubagentHistory(kept);
  }

  async run(): Promise<SubagentRunResult> {
    const signal = this.opts.signal;
    if (signal?.aborted) {
      this.settled = true;
      return this.result("aborted", "The delegated task was aborted before it started.");
    }
    const onAbort = () => this.agent.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let caught: unknown;
    try {
      // 初次启动：task 是 brief；resume 轮：不 prompt——initialMessages 尾部已是
      // 真实用户消息（follow-up），用 continue() 从当前 transcript 续跑（pi-core
      // 原生契约：最后一条须为 user/toolResult）。prompt("") 会注入一条空 user
      // 消息且顺序错位，绝不可用。
      if (this.opts.task) {
        await this.agent.prompt(this.opts.task);
      } else {
        await this.agent.continue();
      }
      await this.agent.waitForIdle();
    } catch (err) {
      caught = err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    if (signal?.aborted) {
      this.settled = true;
      return this.result("aborted", "The delegated task was aborted.");
    }
    if (this.streamError) {
      this.settled = true;
      return this.result("failed", "", this.streamError);
    }
    if (caught) {
      this.settled = true;
      return this.result("failed", "", {
        code: "SUBAGENT_ERROR",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
    this.settled = true;
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
      // 对外报告带 resume 基数：父记录的轮次/工具计数跨轮累加，不被本轮覆盖
      turns: this.turns + (this.opts.turnBase ?? 0),
      toolCalls: this.toolCalls + (this.opts.toolCallBase ?? 0),
      tokens: this.tokens,
      ...(error ? { error } : {}),
    };
  }

  /** 消费计数与报告所需的事件，并把过程归一化成活动条目转发（onActivity）；
   * turn_end / agent_end 留在内部，delegate 结束绝不能终结父代理的 turn。 */
  private async handleEvent(event: AgentEvent): Promise<void> {
    // 与主代理同一条图片口径：工具结果里的超限图先缩放/转码到子代理模型的
    // inputLimits.images.resize 与内联闸门内，再让 agent-core 构造 toolResult
    // 消息（订阅回调是 await 的，原地改 result.content 对模型生效）
    if (event.type === "tool_execution_end") {
      const result = event.result as { content?: ProjectableContentBlock[] } | undefined;
      if (result?.content) {
        const normalized = await normalizeToolResultImages(result.content, this.opts.model);
        if (normalized) {
          try {
            result.content = normalized as ProjectableContentBlock[];
          } catch (err) {
            logErr("subagent tool result image normalize: content is not writable:", err);
          }
        }
      }
    }
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
        // 轮次号带 resume 基数：面板时间线的轮次跨轮单调递增
        this.opts.onActivity?.({
          kind: "turn",
          n: this.turns + (this.opts.turnBase ?? 0),
          at: Date.now(),
        });
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
        // 每轮收尾覆盖写中途历史：sidecar 被重启时至少保住最后一个完整轮次
        // （settle 时的 transcript 行是终态权威存档，二者不冲突）
        this.opts.onHistory?.(this.historySnapshot());
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
          filePath: toolFilePath(event.toolName, event.args),
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
