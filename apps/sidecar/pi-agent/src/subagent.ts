/**
 * 子代理：由 Task 工具派生的有界 delegate agent 循环（对齐 PI-Desktop agent-runtime / ADR 0062）。
 *
 * delegate 是同一 sidecar 进程里的第二个 pi Agent，拥有独立的 system prompt、
 * 独立的（可固定的）模型和只属于它定义声明的工具集合。两条边界构成设计：
 * - 父代理的模型上下文只增量地收到 delegate 的最终报告（TaskWait 结果或恢复 prompt）；
 *   子消息与子工具行不进父转录（它们活在子 Agent 实例里，persist 天然不会写入）。
 * - delegate 的生命周期不惊动协议层的 turn 处理：Task 启动后立即返回，TaskWait
 *   提前收敛，turn 结束后仍未完成的由 dispatchPrompt 的收敛循环等待并投递报告。
 *   只有用户 Stop 或 TaskStop 会中止它。
 */
import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  getModels,
  makePromptCacheKeyPayloadHook,
  makeSessionAffinityHeaders,
} from "./model-catalog";
import { logErr } from "./log";
import {
  captureProviderResponse,
  carriesRetryDelayHeaders,
  claimRetry,
  createProviderRetryStream,
  createRetryBudget,
  providerRetryMaxRetries,
} from "./provider-retry";
import { normalizeSubagentName, type SubagentDefinition } from "./subagent-definitions";
import { buildSubagentMgmtTools } from "./subagent-mgmt-tools";
import { makeAutoContinueMessage, MAX_LENGTH_CONTINUES, needsLengthContinuation } from "./context";
import { send, sendEventChunk } from "./stream";
import { createTraceRunRecorder, type TraceRunRecorder } from "./trace";
import type {
  DelegationRecord,
  Running,
  SubagentActivityItem,
  SubagentRunResult,
  SubagentRunStatus,
} from "./types";

export const SUBAGENT_TOOL_NAME = "Task";
/** 收敛运行中的委派并读取报告 */
export const SUBAGENT_WAIT_TOOL_NAME = "TaskWait";
/** 不等待、只汇报会话内的委派状态 */
export const SUBAGENT_LIST_TOOL_NAME = "TaskList";
/** 停止运行中的委派 */
export const SUBAGENT_STOP_TOOL_NAME = "TaskStop";

/** 报告是唯一进入父代理上下文的内容，别让它变成委派本想避免的上下文问题 */
export const MAX_SUBAGENT_REPORT_CHARS = 12_000;
/** 单会话并发委派上限 */
export const MAX_SUBAGENT_CONCURRENCY = 8;
/** 已完成委派记录的保留上限（最旧的先丢弃，running 永不丢弃） */
const MAX_RETAINED_DELEGATIONS = 50;
/** 活动缓冲上限：满时优先丢最旧的 thinking/text 增量（结构事件永不主动丢） */
export const MAX_ACTIVITY_ITEMS = 400;

/* ----------------------- 运行活动流（面板可观测性） -----------------------
 * delegate 的内部过程不进父转录，但归一化成 SubagentActivityItem 后：
 * - 进 DelegationRecord.activity（内存环形缓冲，get_subagent_activity 快照读它）
 * - 以无 id 通知行 {type:"subagent_activity", delegationId, item} 广播
 *   （宿主原样转发，同 turn_changed；父 turn 已结束后台委派仍在跑也送达）
 */

/** delegationId -> 记录（全局索引：delegationId 是 uuid，快照查询不必先定位会话） */
const delegationIndex = new Map<string, DelegationRecord>();

/** 委派进全局索引（Task 启动时调用；快照查询与 prune 清理共用同一份） */
export function registerDelegation(record: DelegationRecord): void {
  delegationIndex.set(record.delegationId, record);
}

/** 活动条目入缓冲（超限先丢最旧的增量项）并广播通知行 */
export function pushActivity(record: DelegationRecord, item: SubagentActivityItem): void {
  const buf = record.activity;
  if (buf.length >= MAX_ACTIVITY_ITEMS) {
    const dropAt = buf.findIndex(
      (x) => (x.kind === "thinking" || x.kind === "text") && x.op === "delta",
    );
    buf.splice(dropAt >= 0 ? dropAt : 0, 1);
  }
  buf.push(item);
  send({ type: "subagent_activity", delegationId: record.delegationId, item });
}

/** 工具参数的一行摘要（面板工具行展示用）：取首个有值的常见目标字段 */
export function summarizeToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) {
      const line = v.trim().split("\n")[0]!;
      return line.length > 100 ? `${line.slice(0, 100)}…` : line;
    }
  }
  return undefined;
}

/** 快照应答载荷（protocol.ts get_subagent_activity 用） */
export function getDelegationSnapshot(delegationId: string):
  | {
      record: {
        /** 规范全量 id：前端按 ≥4 位前缀查询时据此把别名条目迁回正式键 */
        delegationId: string;
        agentName: string;
        description?: string;
        status: SubagentRunStatus;
        startedAt: number;
        completedAt?: number;
        turns: number;
        toolCalls: number;
        report?: string;
      };
      items: SubagentActivityItem[];
    }
  | undefined {
  let record = delegationIndex.get(delegationId);
  if (!record && delegationId.length >= 4) {
    // 短 id（Task 结果里给模型/用户看的 8 位前缀）同样可查，同 findDelegation 语义
    for (const [id, r] of delegationIndex) {
      if (id.startsWith(delegationId)) {
        record = r;
        break;
      }
    }
  }
  if (!record) return undefined;
  return {
    record: {
      delegationId: record.delegationId,
      agentName: record.agentName,
      description: record.description,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      turns: record.turns,
      toolCalls: record.toolCalls,
      report: record.result?.report,
    },
    items: [...record.activity],
  };
}
const TASKWAIT_DEFAULT_TIMEOUT_SECONDS = 300;
const TASKWAIT_MAX_TIMEOUT_SECONDS = 3600;

/** 定义名归一（身份匹配用，事实源在 subagent-definitions） */
export { normalizeSubagentName };

/** 超长报告保留头尾、中间截断 */
export function boundedReport(value: string): string {
  const text = value.trim();
  if (text.length <= MAX_SUBAGENT_REPORT_CHARS) return text;
  const marker = "\n\n[subagent report truncated]\n\n";
  const available = MAX_SUBAGENT_REPORT_CHARS - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

/** "provider/modelId" → { provider, modelId }（首个 "/" 分隔） */
export function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
  const idx = key.indexOf("/");
  if (idx <= 0 || idx === key.length - 1) return undefined;
  return { provider: key.slice(0, idx), modelId: key.slice(idx + 1) };
}

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
    `You are the "${definition.name}" subagent inside the Xulux desktop app, working on one task delegated by the main agent.`,
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

/** 运行中的委派记录 */
export function runningDelegations(run: Running): DelegationRecord[] {
  return [...run.delegations.values()].filter((r) => r.status === "running");
}

/** 结算一次委派并唤醒所有等待它的 TaskWait */
export function settleDelegation(
  run: Running,
  record: DelegationRecord,
  result: SubagentRunResult,
): void {
  if (record.status !== "running") return;
  record.status =
    record.stopRequested && result.status === "aborted" ? "stopped" : result.status;
  record.result = result;
  record.turns = result.turns;
  record.toolCalls = result.toolCalls;
  record.completedAt = Date.now();
  pushActivity(record, {
    kind: "status",
    status: record.status,
    turns: record.turns,
    toolCalls: record.toolCalls,
    report: result.report,
    at: record.completedAt,
  });
  record.resolveCompletion();
  pruneFinishedDelegations(run);
}

/** 已完成记录超上限时丢弃最旧的；running 永不丢弃 */
function pruneFinishedDelegations(run: Running): void {
  const finished = [...run.delegations.values()]
    .filter((r) => r.status !== "running")
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  const excess = finished.length - MAX_RETAINED_DELEGATIONS;
  for (const record of finished.slice(0, Math.max(0, excess))) {
    run.delegations.delete(record.delegationId);
    delegationIndex.delete(record.delegationId);
  }
}

/** 单行进度描述（TaskList 与等待心跳共用） */
export function delegationHeartbeat(record: DelegationRecord): string {
  const end = record.completedAt ?? Date.now();
  const secs = Math.max(0, Math.round((end - record.startedAt) / 1000));
  const id = record.delegationId.slice(0, 8);
  return record.status === "running"
    ? `${record.agentName} (${id}): running ${secs}s`
    : `${record.agentName} (${id}): ${record.status} after ${secs}s`;
}

/**
 * 生成给父代理的恢复 prompt：所有尚未投递的已结算报告 + 仍在运行的进度行。
 * 没有可投递内容时返回空串（调用方据此退出收敛循环）。投递过的记录就地标记。
 */
export function delegationResumeText(run: Running): string {
  const settled = [...run.delegations.values()]
    .filter((r) => r.status !== "running" && r.result && !r.reportedToParent)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (settled.length === 0) return "";
  for (const record of settled) record.reportedToParent = true;
  const still = runningDelegations(run).sort((a, b) => a.startedAt - b.startedAt);
  const reports = settled
    .map(
      (r) =>
        `[${r.agentName} (delegation ${r.delegationId.slice(0, 8)}, ${r.status})]\n${r.result!.report}`,
    )
    .join("\n\n");
  const heartbeat = still.length
    ? `Still running:\n${still.map(delegationHeartbeat).join("\n")}`
    : "";
  return [
    "Background subagents you started with Task have finished. Their reports follow. Use them to continue your work; do not re-delegate the same tasks.",
    reports,
    heartbeat,
  ]
    .filter((part) => part.trim())
    .join("\n\n");
}

/** 等到 targetCompleted 条记录结算、或超时/中止；返回是否超时或被中止 */
export function waitForDelegations(
  targets: readonly DelegationRecord[],
  targetCompleted: number,
  deadline: number | null,
  signal?: AbortSignal,
): Promise<boolean> {
  const settledCount = () => targets.filter((r) => r.status !== "running").length;
  if (settledCount() >= targetCompleted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (timedOut: boolean) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(timedOut);
    };
    const check = () => {
      if (settledCount() >= targetCompleted) finish(false);
    };
    for (const record of targets) {
      if (record.status === "running") record.completion.then(check);
    }
    const onAbort = () => finish(true);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      deadline === null
        ? undefined
        : setTimeout(() => finish(true), Math.max(0, deadline - Date.now()));
  });
}

/**
 * 解析 delegate 用的模型：Task 的 model 覆盖 > 定义固定 > 继承会话当前模型。
 * 目录里查不到或没凭据时返回 error 文本（放进工具结果，模型可读）。
 */
async function resolveDelegateModel(
  run: Running,
  definition: SubagentDefinition,
  override: string,
): Promise<{ model?: Model<Api>; error?: string }> {
  const models = getModels();
  const key = override || definition.model;
  if (!key) {
    const parent = run.agent.state.model as Model<Api> | undefined;
    if (!parent) return { error: "No model is available for the subagent (session has no model)." };
    return { model: parent };
  }
  const parsed = parseModelKey(key);
  if (!parsed) {
    return {
      error: `Model "${key}" is not available. Use "provider/modelId", e.g. "anthropic/claude-sonnet-4".`,
    };
  }
  const model = models.getModel(parsed.provider, parsed.modelId);
  if (!model) return { error: `Model "${key}" was not found in the model catalog.` };
  const auth = await models.getAuth(parsed.provider).catch(() => undefined);
  if (!auth) {
    return {
      error: `No credentials configured for "${parsed.provider}". Open Settings → Model and add an API key.`,
    };
  }
  return { model };
}

/** 工具级错误：不抛出，把解释留在模型读得到的结果里 */
function subagentToolError(text: string) {
  return { content: [{ type: "text" as const, text }], details: { error: text } };
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
  signal?: AbortSignal;
  /** 归一化活动条目回调（进缓冲 + 广播；见 pushActivity） */
  onActivity?: (item: SubagentActivityItem) => void;
};

/** 长缓存开关（与 sessions.ts 主代理一致）：PI_CACHE_RETENTION=long 时启用，compat 守门自动降级 */
function cacheRetentionOption() {
  return process.env.PI_CACHE_RETENTION === "long" ? { cacheRetention: "long" as const } : {};
}

/** 一次 delegate 执行。实例单次使用。 */
class SubagentRun {
  private readonly agent: Agent;
  private readonly opts: SubagentRunOptions;
  private lastReportText = "";
  private turns = 0;
  private toolCalls = 0;
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
    this.trace = createTraceRunRecorder(opts.traceSessionId, "subagent");
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
      ...(error ? { error } : {}),
    };
  }

  /** 消费计数与报告所需的事件，并把过程归一化成活动条目转发（onActivity）；
   * turn_end / agent_end 留在内部，delegate 结束绝不能终结父代理的 turn。 */
  private handleEvent(event: AgentEvent): void {
    // 轨迹记账：全事件喂给记录器，agent_end 即结算（handle 先行保证 endMs 收在事件上）
    this.trace.handle(event);
    if (event.type === "agent_end") this.trace.settle();
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
        this.agent.followUp(makeAutoContinueMessage());
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

/** Task 返回的 delegationId 在正文里是 8 位短 id；查找时同时接受完整 id 与短 id 前缀 */
function findDelegation(run: Running, id: string): DelegationRecord | undefined {
  return (
    run.delegations.get(id) ??
    [...run.delegations.values()].find((r) => r.delegationId.startsWith(id) && id.length >= 4)
  );
}

/**
 * 会话级子代理工具组：Task / TaskWait / TaskList / TaskStop，外加
 * 管理工具 subagents_list / subagents_save / subagents_delete（主代理创建、
 * 更新、删除子智能体定义，见 subagent-mgmt-tools.ts）。
 * baseTools 是父代理的基础工具目录（delegate 的工具按定义从里面取，绝不包含本组，
 * delegate 不能继续委派、也不能管理定义）；definitions 是会话可用的子代理定义；
 * reload 在管理工具改动后重建各会话的工具目录（sessions.ts 注入，避免模块环）。
 */
export function buildSubagentTools(
  run: Running,
  baseTools: AgentTool[],
  definitions: SubagentDefinition[],
  reload: () => Promise<void>,
): AgentTool[] {
  const names = definitions.map((d) => d.name);

  const taskTool: AgentTool = {
    name: SUBAGENT_TOOL_NAME,
    label: "Task",
    description: [
      "Start one subagent in the background and return immediately; you keep working while it runs, then converge with TaskWait when you need its report.",
      "Use it when the work is separable: parallel exploration of independent directions (one Task per direction in the same assistant message), a multi-file implementation with a complete spec (fixer), an adversarial read-only review of a change you just made (code-reviewer), or a wide search / long log / multi-file survey whose intermediate output would otherwise fill this context (explorer, test-runner).",
      "Do not delegate what you can finish in a couple of tool calls, and do not delegate anything that needs the user — a subagent cannot ask a question or propose a plan on your behalf.",
      "`task` is the delegate's only instruction. It cannot see this conversation, and you cannot correct it while it runs, so state the goal, the paths and facts it cannot infer, and exactly what to report back.",
      "Pass `model` (\"provider/modelId\") only to pick a cheaper or faster model for a simple job; omit it to inherit this session's model.",
      "To run delegates concurrently, emit several Task calls in one assistant message. A message that mixes Task with any other tool runs one call at a time. You may keep working or talk to the user while they run; the runtime delivers their reports when they finish. Call TaskStop only to cancel.",
      `Available subagents:\n${definitions
        .map((d) => `- ${d.name} (tools: ${d.tools.join(", ")}): ${d.description}`)
        .join("\n")}`,
    ].join("\n\n"),
    parameters: Type.Object({
      agent: Type.String({
        description: `Name of the subagent to run: ${names.join(", ")}.`,
      }),
      task: Type.String({
        description:
          "The complete brief: goal, context the delegate cannot infer, and the exact report you want back.",
      }),
      description: Type.Optional(
        Type.String({
          description: "Short label for this delegation (3-6 words), shown to the user.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Override the delegate's model for this run, e.g. 'anthropic/claude-sonnet-4'. Omit to use the subagent's default.",
        }),
      ),
    }),
    // 同一条消息里的多个 Task 并发执行
    executionMode: "parallel",
    execute: async (toolCallId, params) => {
      const p = params as { agent?: string; task?: string; description?: string; model?: string };
      const requested = String(p.agent ?? "");
      const definition = definitions.find(
        (d) => normalizeSubagentName(d.name) === normalizeSubagentName(requested),
      );
      if (!definition) {
        return subagentToolError(
          `Unknown subagent "${requested}". Available: ${names.join(", ")}.`,
        );
      }
      const brief = String(p.task ?? "").trim();
      if (!brief) {
        return subagentToolError(
          `Delegating to ${definition.name} needs a non-empty \`task\` brief.`,
        );
      }
      if (runningDelegations(run).length >= MAX_SUBAGENT_CONCURRENCY) {
        return subagentToolError(
          `${MAX_SUBAGENT_CONCURRENCY} subagents are already running for this session. Wait for some with TaskWait or stop them with TaskStop before delegating more.`,
        );
      }
      const resolved = await resolveDelegateModel(run, definition, String(p.model ?? "").trim());
      const model = resolved.model;
      if (!model) return subagentToolError(resolved.error ?? "model unavailable");
      const tools = definition.tools
        .map((name) => baseTools.find((t) => t.name === name.toLowerCase()))
        .filter((t): t is AgentTool => t !== undefined);
      if (tools.length === 0) {
        return subagentToolError(
          `The ${definition.name} subagent declares no tool available in this session.`,
        );
      }
      const delegationId = randomUUID();
      const label = String(p.description ?? "").trim();
      const controller = new AbortController();
      let resolveCompletion: () => void = () => {};
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const record: DelegationRecord = {
        delegationId,
        agentName: definition.name,
        modelId: model.id,
        status: "running",
        description: label || undefined,
        activity: [],
        stopRequested: false,
        startedAt: Date.now(),
        turns: 0,
        toolCalls: 0,
        reportedToParent: false,
        completion,
        resolveCompletion,
        abort: () => controller.abort(),
      };
      run.delegations.set(delegationId, record);
      registerDelegation(record);
      // toolCallId ↔ delegationId 绑定：走本线程活跃请求流（刷新 attach 可回放，
      // 前端 Task 消息行据此开面板 tab）；历史重建时前端另有结果文本解析兜底
      sendEventChunk(run.threadId, {
        type: "data-subagentDelegation",
        data: {
          toolCallId,
          delegationId,
          agentName: definition.name,
          description: label || undefined,
        },
      });
      new SubagentRun({
        definition,
        task: brief,
        model,
        cwd: run.cwd,
        tools,
        sessionId: delegationId,
        traceSessionId: run.sessionId,
        signal: controller.signal,
        onActivity: (item) => pushActivity(record, item),
      })
        .run()
        .then(
          (result) => settleDelegation(run, record, result),
          // SubagentRun.run() 自会把错误折进结果；这个兜底只是防止意外 rejection
          // 让委派永远卡在 running。
          (error: unknown) =>
            settleDelegation(run, record, {
              agentName: definition.name,
              modelId: model.id,
              status: "failed",
              report: "",
              turns: 0,
              toolCalls: 0,
              error: {
                code: "UNEXPECTED_DELEGATION_REJECTION",
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        );
      return {
        content: [
          {
            type: "text" as const,
            text: `Delegation ${delegationId.slice(0, 8)} started: the ${definition.name} subagent is working in the background${label ? ` (${label})` : ""}. Continue your own independent work, then call TaskWait with this delegationId to converge, or TaskStop to stop it.`,
          },
        ],
        details: {
          delegationId,
          agent: definition.name,
          status: "running",
          modelId: model.id,
        },
      };
    },
  };

  const waitTool: AgentTool = {
    name: SUBAGENT_WAIT_TOOL_NAME,
    label: "Task Wait",
    description:
      "Wait for one or more subagents started by Task and return their reports. `delegationIds` defaults to every running subagent; use mode \"any\" with `minCompleted` to converge as soon as the first (or first N) finish. Settled delegations return immediately, so re-reading a report by id is cheap. A wait timeout is not a failure: unfinished delegates keep working and the runtime delivers their reports when they finish.",
    parameters: Type.Object({
      delegationIds: Type.Optional(
        Type.Array(Type.String({ description: "Delegation ids returned by Task (full or 8-char prefix)." }), {
          description: "Defaults to all running subagents.",
        }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("any")], {
          description: "Wait for every target (all) or the first to finish (any).",
        }),
      ),
      minCompleted: Type.Optional(
        Type.Number({
          minimum: 1,
          description: 'With mode "any": wait until at least this many finished.',
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: TASKWAIT_MAX_TIMEOUT_SECONDS,
          description: `Max seconds to wait; defaults to ${TASKWAIT_DEFAULT_TIMEOUT_SECONDS}.`,
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const p = params as {
        delegationIds?: string[];
        mode?: string;
        minCompleted?: number;
        timeoutSeconds?: number;
      };
      const ids = Array.isArray(p.delegationIds) ? p.delegationIds.map(String) : [];
      const mode = p.mode === "any" ? "any" : "all";
      const minCompleted = Math.max(1, Math.floor(p.minCompleted ?? 1));
      const timeoutSeconds = Math.min(
        Math.max(1, Math.floor(p.timeoutSeconds ?? TASKWAIT_DEFAULT_TIMEOUT_SECONDS)),
        TASKWAIT_MAX_TIMEOUT_SECONDS,
      );
      const targets = ids.length
        ? ids
            .map((id) => findDelegation(run, id))
            .filter((r): r is DelegationRecord => r !== undefined)
        : runningDelegations(run);
      if (targets.length === 0) {
        const text = ids.length
          ? "None of the requested delegation ids exist in this session. Call TaskList to see them."
          : "No subagents are currently running.";
        return { content: [{ type: "text" as const, text }], details: { delegations: [] } };
      }
      const unknownIds = ids.filter((id) => !findDelegation(run, id));
      const targetCompleted =
        mode === "all"
          ? targets.length
          : Math.min(Math.max(minCompleted, 1), targets.length);
      const deadline = Date.now() + timeoutSeconds * 1000;
      const timedOut = await waitForDelegations(targets, targetCompleted, deadline, signal);
      for (const record of targets) {
        if (record.status !== "running") record.reportedToParent = true;
      }
      const results = targets.map((record) => ({
        id: record.delegationId.slice(0, 8),
        agent: record.agentName,
        status: record.status,
        report:
          record.status === "running"
            ? delegationHeartbeat(record)
            : (record.result?.report ?? `(${record.status} without a report)`),
      }));
      const note = timedOut
        ? `Still running after ${timeoutSeconds}s: ${results.filter((r) => r.status !== "running").length}/${targets.length} finished. This is not a failure — unfinished delegates keep working and the runtime will deliver their reports when they finish. Call TaskStop only to cancel.`
        : mode === "any"
          ? `Converged after ${results.filter((r) => r.status !== "running").length} of ${targets.length} finished.`
          : "";
      const unknownNote = unknownIds.length
        ? `Unknown delegation ids (not found in this session): ${unknownIds.join(", ")}.`
        : "";
      const text = [
        results
          .map((r) => `- ${r.agent} (${r.id}, ${r.status}):\n${r.report}`)
          .join("\n\n"),
        note,
        unknownNote,
      ]
        .filter((part) => part.trim())
        .join("\n\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { status: timedOut ? "timeout" : "completed", delegations: results },
      };
    },
  };

  const listTool: AgentTool = {
    name: SUBAGENT_LIST_TOOL_NAME,
    label: "Task List",
    description:
      "List the subagents started by Task in this session with their status. Use it to check progress without waiting, or before TaskStop to choose what to stop.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async () => {
      const delegations = [...run.delegations.values()].sort(
        (a, b) => a.startedAt - b.startedAt,
      );
      const text =
        delegations.length === 0
          ? "No subagents have been started in this session."
          : delegations.map(delegationHeartbeat).join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: {
          delegations: delegations.map((r) => ({
            id: r.delegationId,
            agent: r.agentName,
            status: r.status,
          })),
        },
      };
    },
  };

  const stopTool: AgentTool = {
    name: SUBAGENT_STOP_TOOL_NAME,
    label: "Task Stop",
    description:
      "Stop one or more running subagents. `delegationIds` defaults to every running subagent. Stopped subagents report as stopped; their partial work is lost.",
    parameters: Type.Object({
      delegationIds: Type.Optional(
        Type.Array(Type.String({ description: "Delegation ids returned by Task (full or 8-char prefix)." }), {
          description: "Defaults to all running subagents.",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const p = params as { delegationIds?: string[] };
      const ids = Array.isArray(p.delegationIds) ? p.delegationIds.map(String) : [];
      const targets = ids.length
        ? ids
            .map((id) => findDelegation(run, id))
            .filter((r): r is DelegationRecord => r !== undefined)
        : runningDelegations(run);
      if (targets.length === 0) {
        const text = ids.length
          ? "None of the requested delegation ids exist in this session. Call TaskList to see them."
          : "No subagents are currently running.";
        return { content: [{ type: "text" as const, text }], details: { stopped: [] } };
      }
      const stopping = targets.filter((r) => r.status === "running");
      for (const record of stopping) {
        record.stopRequested = true;
        record.abort();
      }
      return {
        content: [
          {
            type: "text" as const,
            text: stopping.length
              ? `Stopping ${stopping.length} subagent(s): ${stopping.map((r) => r.agentName).join(", ")}. They report as stopped once they wind down.`
              : "Requested subagents are already settled; call TaskList to see their reports.",
          },
        ],
        details: { stopped: stopping.map((r) => r.delegationId) },
      };
    },
  };

  return [taskTool, waitTool, listTool, stopTool, ...buildSubagentMgmtTools(run, reload)];
}
