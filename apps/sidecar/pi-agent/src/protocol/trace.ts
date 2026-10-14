/**
 * Agent 调用轨迹（trace）：把一次 prompt 的 agent 事件流归并成 span 树，
 * run 结束时一行 JSON 追加到 <sessionsDir>/traces/<sessionId>.jsonl。
 *
 * 结构：run（agent_start→agent_end）→ turn × n → llm_call / tool_call / retry。
 * 记录器纯同步内存操作（不阻塞流路径）；只在 settle() 时做一次文件写入，
 * 崩溃最多丢在飞 run（转录仍兜底消息内容），读取端零部分树问题。
 *
 * 接线：主代理由 stream.ts onAgentEvent 喂事件（source = ui | automation，
 * 按有无协议 reqId 区分）；子代理由 subagent.ts 自己订阅（source = subagent，
 * 归属父会话的 trace 文件）。retry 打点在 provider-retry 的控制器回调
 * （makeUiRetryController / subagent 内联控制器），两条装配都覆盖。
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { traceLivePath, tracePath } from "../storage/storage";
import { logErr } from "../log";
import { exportTraceRun } from "../observability/otlp-exporter";

/** run 来源：ui = 前端线程请求；automation = 旁路/定时任务（无协议 reqId）；subagent = Task 委派 */
export type TraceSource = "ui" | "automation" | "subagent";

export type TraceSpanKind = "turn" | "llm_call" | "tool_call" | "retry";
export type TraceStatus = "ok" | "error" | "aborted";

/**
 * 为什么整个 run 停了。
 *
 * 这一维度推导不出来：记录器只看得到 AgentEvent，而长度续跑、context overflow
 * 重跑、goal 续跑、用户 Stop 这些编排决策都发生在 stream.ts 里，压根不经过
 * handle()。没有 noteOutcome 上报，记录永远只知道 stopReason，不知道是
 * 「自然收尾」还是「续跑预算烧完了」。
 *
 * aborted 单独成一类而不是并进 error：用户点 Stop 不是错误，混进去会污染错误率。
 */
export type TraceOutcomeReason =
  | "completed"
  | "user-stop"
  | "context-overflow"
  | "length-budget-exhausted"
  | "error"
  /** 进程中断：从 live 增量落盘抢救回来的 run（partial 记录专用） */
  | "interrupted";

/** stream 侧上报的终止归因；detail 是给面板看的一句话说明 */
export type TraceOutcomeInfo = { reason: TraceOutcomeReason; detail?: string };

export type TraceSpan = {
  /**
   * 创建时生成的 16hex 唯一 id（v2 身份模型）：面板与 OTLP 都从它取 id，
   * 不再各自派生。旧记录（v2 之前写入）缺失，消费方回退到顺序派生。
   */
  spanId?: string;
  /** 父 span 的 spanId：同轮子 span 指向所属 turn；turn 省略（挂在 run 根下） */
  parentSpanId?: string;
  kind: TraceSpanKind;
  /** tool 名 / retry 错误码；turn 无名 */
  name?: string;
  startMs: number;
  endMs: number;
  status: TraceStatus;
  attrs?: Record<string, string | number | boolean>;
  /** 仅 turn 持有子 span（llm_call / tool_call / retry，按发生序） */
  children?: TraceSpan[];
  /**
   * 内容详情（llm_call）：请求上下文（system + 消息列表的截断渲染）与回复正文。
   * 本地轨迹始终记录（转录本就存全文，无新增暴露面）；是否随 OTLP 上传由
   * observability 的 redactContent 门控（otlp-exporter）。
   */
  detail?: { request?: string; response?: string };
};

/** traces JSONL 的一行（一个 run 的完整树） */
export type TraceRunRecord = {
  /**
   * v2 根身份（16 字节随机 hex）：面板与 OTLP 的 traceId。旧记录缺失时消费方
   * 回退到 runId。
   */
  traceId?: string;
  /** v1 兼容别名：与 traceId 同值（旧读取端/导出文件不破） */
  runId: string;
  /** 父 run 的 traceId：subagent 委派时回填父 run（跨 run 因果边） */
  parentRunId?: string;
  /** 触发本 run 的父 span：父 run 里那次 Task tool_call 的 spanId */
  parentSpanId?: string;
  sessionId: string;
  source: TraceSource;
  startMs: number;
  endMs: number;
  status: TraceStatus;
  /**
   * 终止归因（v2 新增）。缺省时由 lastStopReason 兜底推导（aborted→user-stop，
   * error→error，其余→completed），但那只是 stopReason 的翻译；真正的编排
   * 决策（续跑/溢出/Stop）只能靠 stream 侧 noteOutcome 上报。
   */
  outcome?: TraceOutcomeInfo;
  /** 末轮模型 "provider/model" */
  model?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  spans: TraceSpan[];
  /**
   * 这条记录是「意外中断」抢救出来的：进程死在 run 中途，下次启动从
   * <sessionId>.live.jsonl 的轮行拼回。此时 spans 只到最后一个闭合的轮，
   * 不完整。消费方（面板/导出）据此提示截断，不要当成正常 run。
   */
  partial?: boolean;
};

/* --------------------- 在飞 run 的增量落盘（live） --------------------- */

/** live 文件里 run 的头部行：一份在飞 run 写一次，带 pid 供残留判定 */
type LiveRunHeader = {
  kind: "run";
  /** 写入进程。崩溃 = 换进程 = pid 不同；同进程并发的 run pid 相同，不会被误判 */
  pid: number;
  traceId: string;
  sessionId: string;
  source: TraceSource;
  startMs: number;
  model?: string;
};

/** live 文件里一轮闭合时追加的行。轮在 turn_end 已收口，之后不再变 */
type LiveTurnLine = { kind: "turn"; traceId: string; turn: TraceSpan };

type LiveLine = LiveRunHeader | LiveTurnLine;

/** 单文件体积护栏：超过即重写为末尾 1MB（长会话不给磁盘埋炸弹） */
const MAX_TRACE_FILE_BYTES = 5 * 1024 * 1024;
const TRACE_TAIL_BYTES = 1024 * 1024;
const ATTR_TEXT_MAX = 200;
/** 内容捕获的截断阈值：单条消息 2k、整个请求上下文 64k、回复 8k（traces 是元数据
 * 视图的补充而非转录复制品，护栏防止大上下文把 5MB 文件护栏打穿） */
const MSG_TEXT_MAX = 2_000;
const REQUEST_MAX = 64_000;
const RESPONSE_MAX = 8_000;
/** 成功工具出参的独立上限：比 RESPONSE_MAX 小得多，理由见 DETAIL_BUDGET_BYTES。
 *  失败出参不砍——stderr 是诊断核心，用 TOOL_RESULT_ERR_MAX */
const TOOL_RESULT_OK_MAX = 1_500;
const TOOL_RESULT_ERR_MAX = 8_000;
/** 面板那行红字（attrs.errorMessage）的上限，与检查器里展开的正文分开 */
const TOOL_ERR_LINE_MAX = 2_000;
/**
 * detail 正文的 per-run 内存预算。
 *
 * 没有它，recorder 的常驻内存随 run 长度线性涨：detail.request ≤64KB/llm 调用、
 * detail.response ≤8KB/llm、工具出参 ≤8KB/个。100 轮 × 3 工具 ≈ 9.6MB 一直挂到
 * settle()。文件侧早有 5MB 护栏（MAX_TRACE_FILE_BYTES），内存侧此前零护栏。
 *
 * 超预算时从**最旧的 span** 起摘掉 detail 正文（只摘正文，kind/时间/status/attrs
 * 一律保留——视图的骨架不能缺）。最旧优先的理由：最新的那次请求才是要看的那次。
 * 摘下后 100 轮 run ≈ 结构 400KB + 预算 512KB ≈ 1MB 封顶。
 */
const DETAIL_BUDGET_BYTES = 512 * 1024;

const detailBytes = (span: TraceSpan): number =>
  (span.detail?.request?.length ?? 0) + (span.detail?.response?.length ?? 0);

const clip = (value: unknown, max = ATTR_TEXT_MAX): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return undefined;
  return s.length > max ? s.slice(0, max) : s;
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/* ----------------------------- 身份（v2 身份模型） ----------------------------- */

/** span 唯一 id：8 字节随机 → 16hex（符合 OTel spanId 规范，创建时生成、纯内存） */
const newSpanId = (): string => randomBytes(8).toString("hex");
/** trace 根 id：16 字节随机 → 32hex（符合 OTel traceId 规范） */
const newTraceId = (): string => randomBytes(16).toString("hex");

/* --------------------------- 内容渲染（捕获用） --------------------------- */

/** pi-ai 内容块（string 或块数组）→ 纯文本：text 取正文、toolCall 摘要、
 * image 占位、thinking 跳过（体量大且非提示词本体） */
function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Record<string, unknown>[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "toolCall")
      parts.push(
        `[tool_call] ${String(block.name ?? "tool")}(${clip(block.arguments, 400) ?? ""})`,
      );
    else if (block.type === "image") parts.push("[图片]");
  }
  return parts.join("\n");
}

function renderMessage(role: string, content: unknown): string {
  const text = clip(renderContent(content), MSG_TEXT_MAX);
  return text ? `[${role}] ${text}` : `[${role}]（空）`;
}

/** streamFn 拿到的请求上下文 → 逐条消息的截断渲染（system + 消息列表） */
function renderRequest(context: unknown): string {
  const ctx = (context ?? {}) as { systemPrompt?: unknown; messages?: unknown[] };
  const lines: string[] = [];
  const system = clip(ctx.systemPrompt, MSG_TEXT_MAX);
  if (system) lines.push(`[system] ${system}`);
  for (const msg of Array.isArray(ctx.messages) ? ctx.messages : []) {
    const m = msg as { role?: string; content?: unknown };
    if (typeof m.role !== "string") continue;
    lines.push(renderMessage(m.role, m.content));
  }
  const joined = lines.join("\n\n");
  return joined.length > REQUEST_MAX ? `${joined.slice(0, REQUEST_MAX)}\n…[已截断]` : joined;
}

/** assistant 回复正文（text/toolCall 块渲染，thinking 跳过） */
function renderResponse(content: unknown): string {
  return clip(renderContent(content), RESPONSE_MAX) ?? "";
}

type UsageAcc = { input: number; output: number; cacheRead: number; cacheWrite: number };

type OpenRun = {
  /** 本 run 的根身份（openRun 时生成，finalize 写入记录） */
  traceId: string;
  startMs: number;
  turns: TraceSpan[];
  openTurn: TraceSpan | null;
  /** 当前轮内打开中的 llm_call（message_start → message_end） */
  openLlm: TraceSpan | null;
  /** toolCallId → 打开中的 tool_call */
  openTools: Map<string, TraceSpan>;
  /** toolCallId → spanId：工具收口后仍可查（Task 委派回填父 span 身份用） */
  toolSpanIds: Map<string, string>;
  /** 打开中的 retry（onRetry → noteRetrySettled） */
  openRetry: TraceSpan | null;
  /** 轮次序号（attrs 用） */
  turnSeq: number;
  /** 末条 assistant 消息的 stopReason（决定 run status） */
  lastStopReason?: string;
  /** stream 侧上报的终止归因；未上报时 finalize 按 stopReason 兜底推导 */
  outcome?: TraceOutcomeInfo;
  model?: string;
  usage: UsageAcc;
  /**
   * detail 正文的内存记账：detailQueue 按时间序持有带正文的 span 引用，
   * detailTotal 是它们正文的字节和。超 DETAIL_BUDGET_BYTES 就从队首摘——
   * 摘一个减一笔，均摊 O(1)；每次全遍历会是 O(n²)。
   * 只摘 detail 正文，span 本身留在树里（视图骨架不能缺）。
   */
  detailQueue: TraceSpan[];
  detailTotal: number;
  /** 已追加到 live 文件的轮数（turn_end 时按差额补写） */
  liveTurnsWritten: number;
};

const statusOfStopReason = (stopReason: unknown): TraceStatus =>
  stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : "ok";

export type TraceRunRecorder = {
  readonly sessionId: string;
  readonly source: TraceSource;
  /** 当前打开中 run 的 traceId（无在跑 run 时空串）——Task 委派回填父身份用 */
  readonly traceId: string;
  /** 喂一条 agent 事件（同步、零 IO）；agent_start 打开/重开 run */
  handle(event: AgentEvent): void;
  /** LLM 请求上下文（streamFn 处调用，先于该请求的 message_start）；
   * 附加到随后打开的 llm_call span 的 detail.request */
  noteRequest(context: unknown): void;
  /** provider 重试开始（provider-retry 控制器 onRetry 回调） */
  noteRetry(info: { attempt: number; delayMs: number; code: string; message?: string }): void;
  /** 重试周期结束：新尝试开始出流或终态错误（onSettled 回调） */
  noteRetrySettled(): void;
  /** 该 toolCallId 对应 tool_call span 的 spanId（工具收口后仍可查）；无则 undefined */
  spanIdForToolCall(toolCallId: string): string | undefined;
  /**
   * 上报终止归因（stream.ts 编排层调用）。
   * 编排决策不经过 AgentEvent，记录器只能靠这个口拿到「为什么停在这」。
   * 后写覆盖先写（续跑注入多条时以最后一次为准）；无打开中的 run 时忽略。
   */
  noteOutcome(info: TraceOutcomeInfo): void;
  /**
   * 结算当前 run 并写入 traces JSONL。无打开中的 run 时 no-op 返回 false。
   * forcedStatus 用于异常残留（没走到 agent_end 就被新 run 顶替）：按 error 收。
   */
  settle(forcedStatus?: TraceStatus): boolean;
};

/** parent：子代理委派回填的父身份（父 run 的 traceId 与那次 Task tool_call 的 spanId） */
export function createTraceRunRecorder(
  sessionId: string,
  source: TraceSource,
  parent?: { parentRunId?: string; parentSpanId?: string },
): TraceRunRecorder {
  let run: OpenRun | null = null;
  let pending: TraceRunRecord[] = [];
  let pendingRequest: string | null = null;

  const openRun = (): OpenRun => ({
    traceId: newTraceId(),
    startMs: Date.now(),
    turns: [],
    openTurn: null,
    openLlm: null,
    openTools: new Map(),
    toolSpanIds: new Map(),
    openRetry: null,
    turnSeq: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    detailQueue: [],
    detailTotal: 0,
    liveTurnsWritten: 0,
  });

  /**
   * 登记一个带 detail 正文的 span 并结算内存预算。
   * 超预算从队首（最旧）摘到回预算内——只摘正文，span 结构原样保留。
   */
  const registerDetail = (r: OpenRun, span: TraceSpan): void => {
    const bytes = detailBytes(span);
    if (bytes === 0) return;
    r.detailQueue.push(span);
    r.detailTotal += bytes;
    while (r.detailTotal > DETAIL_BUDGET_BYTES && r.detailQueue.length > 0) {
      const oldest = r.detailQueue.shift()!;
      r.detailTotal -= detailBytes(oldest);
      // 摘正文但留下结构：面板仍能看到那次调用/那个工具，只是点开没正文
      delete oldest.detail;
    }
  };

  /** 兜底收口仍在打开中的子 span（正常路径已在各自 end 事件闭合；atMs 之后的 status 只落在异常残留上） */
  const closePendingChildren = (r: OpenRun, status: TraceStatus, atMs: number): void => {
    if (r.openRetry) {
      r.openRetry.endMs = atMs;
      r.openRetry.status = "ok";
      r.openRetry = null;
    }
    if (r.openLlm) {
      r.openLlm.endMs = atMs;
      r.openLlm.status = status;
      r.openLlm = null;
    }
    for (const tool of r.openTools.values()) {
      tool.endMs = atMs;
      tool.status = status;
    }
    r.openTools.clear();
  };

  const closeTurn = (r: OpenRun, atMs: number): void => {
    if (!r.openTurn) return;
    r.openTurn.endMs = atMs;
    r.openTurn = null;
  };

  const finalize = (forcedStatus?: TraceStatus): TraceRunRecord | null => {
    if (!run) return null;
    const r = run;
    run = null;
    // 未消费的请求快照作废（不该跟着下一个 run 的首个 llm span 走）
    pendingRequest = null;
    const endMs = Date.now();
    const status = forcedStatus ?? statusOfStopReason(r.lastStopReason);
    closePendingChildren(r, status === "ok" ? "ok" : status, endMs);
    closeTurn(r, endMs);
    // 终止归因：stream 上报优先；没上报就用 stopReason 兜底翻译（用户 Stop 的
    // 路径由 stream 显式传 aborted，这条兜底只在异常残留时兜底）
    const outcome =
      r.outcome ??
      (status === "aborted"
        ? { reason: "user-stop" as const }
        : status === "error"
          ? { reason: "error" as const }
          : { reason: "completed" as const });
    const hasUsage =
      r.usage.input > 0 || r.usage.output > 0 || r.usage.cacheRead > 0 || r.usage.cacheWrite > 0;
    return {
      traceId: r.traceId,
      runId: r.traceId,
      ...(parent?.parentRunId ? { parentRunId: parent.parentRunId } : {}),
      ...(parent?.parentSpanId ? { parentSpanId: parent.parentSpanId } : {}),
      sessionId,
      source,
      startMs: r.startMs,
      endMs,
      status,
      outcome,
      ...(r.model ? { model: r.model } : {}),
      ...(hasUsage ? { usage: { ...r.usage } } : {}),
      spans: r.turns,
    };
  };

  const noteOutcome = (info: TraceOutcomeInfo): void => {
    if (!run) return;
    run.outcome = info;
  };

  const childrenOf = (r: OpenRun): TraceSpan[] => {
    // 正常时序 turn_start 先于一切子 span；缺失（异常事件序）时补一个隐式 turn
    if (!r.openTurn) {
      r.openTurn = {
        spanId: newSpanId(),
        kind: "turn",
        startMs: Date.now(),
        endMs: 0,
        status: "ok",
        children: [],
      };
      r.turns.push(r.openTurn);
    }
    return (r.openTurn.children ??= []);
  };

  /**
   * 喂一条 agent 事件。
   *
   * 整体包 try/catch 是刻意的：handle 被 onAgentEvent 调用，而 agent-core 派发
   * 监听器时**没有 try/catch**（`for (const l of listeners) await l(event)`），
   * 这里抛出去会一路冒到 runAgentLoop，直接打断用户的 run。轨迹是纯观察者，
   * 它出问题最多少一条记录，绝不该毁掉对话。异常只 logErr。
   */
  const handle = (event: AgentEvent): void => {
    try {
      handleInner(event);
    } catch (err) {
      logErr("trace: handle failed:", err);
    }
  };

  const handleInner = (event: AgentEvent): void => {
    if (event.type === "agent_start") {
      // 复用场景的残留保护（stream.ts/subagent 正常都会先 settle）：按 error 收
      // 进 pending，不阻塞新 run，也不丢轨迹（finalize 一并清掉未消费的请求快照）
      if (run) pending.push(finalize("error")!);
      run = openRun();
      // 上一个进程崩在这会话里留下的 live 行，抢救进主文件再开新 run
      promoteLive();
      writeLiveHeader(run);
      return;
    }
    if (!run) return;
    const r = run;
    switch (event.type) {
      case "turn_start": {
        r.turnSeq += 1;
        r.openTurn = {
          spanId: newSpanId(),
          kind: "turn",
          startMs: Date.now(),
          endMs: 0,
          status: "ok",
          attrs: { index: r.turnSeq },
          children: [],
        };
        r.turns.push(r.openTurn);
        break;
      }
      case "message_start": {
        const m = event.message as { role?: string };
        if (m.role !== "assistant") break;
        const msg = event.message as {
          model?: string;
          provider?: string;
          timestamp?: number;
        };
        const children = childrenOf(r);
        r.openLlm = {
          spanId: newSpanId(),
          parentSpanId: r.openTurn!.spanId,
          kind: "llm_call",
          startMs: num(msg.timestamp) ?? Date.now(),
          endMs: 0,
          status: "ok",
          attrs: {
            ...(msg.provider ? { provider: msg.provider } : {}),
            ...(msg.model ? { model: msg.model } : {}),
          },
          ...(pendingRequest ? { detail: { request: pendingRequest } } : {}),
        };
        pendingRequest = null;
        children.push(r.openLlm);
        break;
      }
      case "message_end": {
        const m = event.message as {
          role?: string;
          content?: unknown;
          stopReason?: string;
          errorMessage?: string;
          model?: string;
          provider?: string;
          usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
        };
        if (m.role !== "assistant") {
          // toolResult/user 收口（正常已被 assistant 的 message_end 闭合）
          if (r.openLlm) {
            r.openLlm.endMs = Date.now();
            r.openLlm = null;
          }
          break;
        }
        if (!r.openLlm) break;
        const span = r.openLlm;
        r.openLlm = null;
        span.endMs = Date.now();
        span.status = statusOfStopReason(m.stopReason);
        const model = [m.provider, m.model].filter(Boolean).join("/");
        if (model) span.attrs = { ...span.attrs, model };
        if (m.stopReason) span.attrs = { ...span.attrs, stopReason: m.stopReason };
        const errorMessage = clip(m.errorMessage);
        if (errorMessage) span.attrs = { ...span.attrs, errorMessage };
        const usage = m.usage;
        if (usage) {
          const input = num(usage.input) ?? 0;
          const output = num(usage.output) ?? 0;
          const cacheRead = num(usage.cacheRead) ?? 0;
          const cacheWrite = num(usage.cacheWrite) ?? 0;
          span.attrs = {
            ...span.attrs,
            inputTokens: input,
            outputTokens: output,
            cacheRead,
            cacheWrite,
          };
          // 用量口径与 usage-stats 一致：error/aborted 轮不计入
          if (span.status === "ok") {
            r.usage.input += input;
            r.usage.output += output;
            r.usage.cacheRead += cacheRead;
            r.usage.cacheWrite += cacheWrite;
          }
        }
        if (model) r.model = model;
        r.lastStopReason = m.stopReason;
        // 内容捕获：回复正文；请求上下文兜底附加（noteRequest 晚于 message_start 的时序）
        if (!span.detail?.request && pendingRequest) {
          span.detail = { ...span.detail, request: pendingRequest };
        }
        pendingRequest = null;
        const response = renderResponse(m.content);
        if (response) span.detail = { ...span.detail, response };
        // llm span 的 detail 是本 run 最大的一块（request 上限 64KB）
        registerDetail(r, span);
        break;
      }
      case "tool_execution_start": {
        const children = childrenOf(r);
        const spanId = newSpanId();
        const span: TraceSpan = {
          spanId,
          parentSpanId: r.openTurn!.spanId,
          kind: "tool_call",
          name: event.toolName,
          startMs: Date.now(),
          endMs: 0,
          status: "ok",
          attrs: { args: clip(event.args) ?? "" },
        };
        r.openTools.set(event.toolCallId, span);
        r.toolSpanIds.set(event.toolCallId, spanId);
        children.push(span);
        break;
      }
      case "tool_execution_end": {
        const span = r.openTools.get(event.toolCallId);
        if (!span) break;
        r.openTools.delete(event.toolCallId);
        span.endMs = Date.now();
        span.status = event.isError ? "error" : "ok";
        // 失败原因与出参：此前这里只记 status，面板能答「哪个工具失败」答不了
        // 「为什么失败」。正文复用 detail.response（request 位已有 args，不重复占）。
        const res = event.result as
          | { content?: unknown; details?: Record<string, unknown> }
          | undefined;
        const text = renderContent(res?.content);
        if (text) {
          // 失败出参不砍（stderr 是诊断核心），成功出参用小上限——见常量注释
          const clipped = clip(
            text,
            event.isError ? TOOL_RESULT_ERR_MAX : TOOL_RESULT_OK_MAX,
          );
          span.detail = { ...span.detail, response: clipped };
          // 失败正文另存一份 attrs，面板不必解析 detail 就能直接显示
          if (event.isError && clipped) {
            span.attrs = {
              ...span.attrs,
              errorMessage: clip(text, TOOL_ERR_LINE_MAX) ?? clipped,
            };
          }
          registerDetail(r, span);
        }
        // bash 类工具的退出码在 details 里；取不到就不记，不猜
        const code = num(
          res?.details?.exitCode ?? res?.details?.exit_code ?? res?.details?.code,
        );
        if (code != null) span.attrs = { ...span.attrs, exitCode: code };
        break;
      }
      case "turn_end": {
        if (!r.openTurn) break;
        // 正常时序子 span 已全部闭合；残留的（异常事件序）按 error 收口。
        // 轮自身完整走完即 ok，子 span 的 error 状态留在各自 span 上
        const atMs = Date.now();
        closePendingChildren(r, "error", atMs);
        closeTurn(r, atMs);
        // 本轮已收口、之后不再变 → 追加进 live（崩溃兜底 + 近实时）。
        // 只在这里落盘：轮级事件，一次迭代一下；token 级的 message_update 不碰
        appendLiveTurns(r);
        break;
      }
      case "agent_end":
        // 结算由外部 settle() 触发（stream.ts / subagent），这里只记账
        break;
      default:
        // message_update / tool_execution_update：token/进度级，不参与计时
        break;
    }
  };

  const noteRequest = (context: unknown): void => {
    // streamFn 每次逻辑请求恰好调用一次（重试在 wrapper 内部重流，不走这里）
    pendingRequest = renderRequest(context);
  };

  const noteRetry = (info: { attempt: number; delayMs: number; code: string; message?: string }): void => {
    if (!run) return;
    const atMs = Date.now();
    if (run.openRetry) {
      run.openRetry.endMs = atMs;
      run.openRetry = null;
    }
    const children = childrenOf(run);
    run.openRetry = {
      spanId: newSpanId(),
      parentSpanId: run.openTurn!.spanId,
      kind: "retry",
      name: info.code,
      startMs: atMs,
      endMs: 0,
      status: "ok",
      attrs: {
        attempt: info.attempt,
        delayMs: info.delayMs,
        ...(info.message ? { message: clip(info.message) } : {}),
      },
    };
    children.push(run.openRetry);
  };

  const noteRetrySettled = (): void => {
    if (!run?.openRetry) return;
    run.openRetry.endMs = Date.now();
    run.openRetry = null;
  };

  /* --------------------------- 在飞 run 的增量落盘 --------------------------- */
  // 全部包 try/catch：这些函数会被 handle() 调用，而 handle() 的异常能一路冒到
  // runAgentLoop 打断用户的 run。轨迹是纯观察者，它失败最多少条记录。
  // 前提：同一进程 + 全同步 API + Node 单线程，所以多 recorder 并发 append 同一
  // live 文件不会撕裂单行。若将来把 trace 改成 async，这个前提就破了。

  const appendLive = (line: LiveLine): void => {
    try {
      const file = traceLivePath(sessionId);
      mkdirSync(dirname(file), { recursive: true });
      try {
        trimTraceFile(file);
      } catch {
        // 首写/竞态，跳过护栏
      }
      appendFileSync(file, JSON.stringify(line) + "\n");
    } catch (err) {
      logErr("trace: live append failed:", err);
    }
  };

  /** 写 run 头部行（一份在飞 run 一次） */
  const writeLiveHeader = (r: OpenRun): void => {
    appendLive({
      kind: "run",
      pid: process.pid,
      traceId: r.traceId,
      sessionId,
      source,
      startMs: r.startMs,
      ...(r.model ? { model: r.model } : {}),
    });
  };

  /** turn_end 时把本轮追加进 live（按差额补写，防漏防重） */
  const appendLiveTurns = (r: OpenRun): void => {
    for (let i = r.liveTurnsWritten; i < r.turns.length; i++) {
      appendLive({ kind: "turn", traceId: r.traceId, turn: r.turns[i]! });
    }
    r.liveTurnsWritten = r.turns.length;
  };

  /** 读 live 文件并按 traceId 分组（容错撕裂行） */
  const readLiveLines = (): Map<string, LiveLine[]> => {
    const groups = new Map<string, LiveLine[]>();
    let raw: string;
    try {
      raw = readFileSync(traceLivePath(sessionId), "utf8");
    } catch {
      return groups;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t) as LiveLine;
        if (!parsed?.traceId) continue;
        const list = groups.get(parsed.traceId);
        if (list) list.push(parsed);
        else groups.set(parsed.traceId, [parsed]);
      } catch {
        // 撕裂行跳过
      }
    }
    return groups;
  };

  /**
   * 把崩溃残留（pid 不是当前进程的组）从 live 抢救进主文件。
   *
   * pid 判定是必需的：automation 旁路 run 与 ui run 可以并发写同一个会话。
   * 若不加区分地 promote，正在跑的那个 run 会被误判成残留、提前写成 partial，
   * 之后它自己 settle 又写一条完整的 → 同一 traceId 两条记录。崩溃必然换进程，
   * 所以 pid 不同 = 残留；同进程并发 = pid 相同 = 不动。
   */
  const promoteLive = (): void => {
    try {
      const groups = readLiveLines();
      if (groups.size === 0) return;
      let changed = false;
      for (const [traceId, lines] of groups) {
        const header = lines.find((l): l is LiveRunHeader => l.kind === "run");
        // 无头部（撕裂/被 trim 掉）无法判定归属，保守跳过
        if (!header) continue;
        if (header.pid === process.pid) continue; // 同进程的在飞 run，不能动
        const turns = lines
          .filter((l): l is LiveTurnLine => l.kind === "turn")
          .map((l) => l.turn);
        changed = true;
        if (turns.length === 0) continue; // 只写了头没跑完一轮，没有可抢救的内容
        const endMs = turns.reduce((m, t) => Math.max(m, t.endMs || t.startMs), header.startMs);
        pending.push({
          traceId,
          runId: traceId,
          sessionId,
          source: header.source,
          startMs: header.startMs,
          endMs,
          status: "error",
          outcome: {
            reason: "interrupted",
            detail: "进程中断，本 run 未正常收尾（记录取自增量落盘，只到最后一个闭合的轮）",
          },
          ...(header.model ? { model: header.model } : {}),
          spans: turns,
          partial: true,
        });
      }
      if (changed) clearLive(null); // 残留组清掉；能清的都清了
    } catch (err) {
      logErr("trace: promote failed:", err);
    }
  };

  /**
   * 从 live 文件里清掉某个 traceId 的行；传 null 清全部。
   * 保留并发 run 的行——不能整文件删。
   */
  const clearLive = (traceId: string | null): void => {
    try {
      const groups = readLiveLines();
      if (groups.size === 0) return;
      const keep: string[] = [];
      for (const [id, lines] of groups) {
        if (traceId !== null && id === traceId) continue;
        for (const l of lines) keep.push(JSON.stringify(l));
      }
      const file = traceLivePath(sessionId);
      if (keep.length === 0) {
        rmSync(file, { force: true });
        return;
      }
      writeFileSync(file, keep.join("\n") + "\n");
    } catch (err) {
      logErr("trace: live clear failed:", err);
    }
  };

  const settle = (forcedStatus?: TraceStatus): boolean => {
    const record = finalize(forcedStatus);
    if (record) pending.push(record);
    if (!pending.length) return false;
    const toWrite = pending;
    pending = [];
    try {
      for (const item of toWrite) writeRunRecord(item);
    } catch (err) {
      // 轨迹失败绝不影响主流程
      logErr("trace: write failed:", err);
    }
    // 完整记录已落主文件，live 里本 run 的行可以清了（保留并发 run 的）
    for (const item of toWrite) clearLive(item.traceId ?? null);
    // OTLP 导出（enabled 门控/采样在 exporter 内部；入队零 IO，失败不抛）
    for (const item of toWrite) exportTraceRun(item);
    return true;
  };

  return {
    sessionId,
    source,
    get traceId() {
      return run?.traceId ?? "";
    },
    handle,
    noteRequest,
    noteRetry,
    noteRetrySettled,
    spanIdForToolCall: (toolCallId) => run?.toolSpanIds.get(toolCallId),
    noteOutcome,
    settle,
  };
}

/* ------------------------------- 存储与读取 ------------------------------- */

function trimTraceFile(file: string): void {
  const st = statSync(file);
  if (st.size <= MAX_TRACE_FILE_BYTES) return;
  // 保留末尾 1MB，从其后第一个换行起（丢掉可能撕裂的半行）
  const buf = readFileSync(file);
  const tail = buf.subarray(buf.length - TRACE_TAIL_BYTES);
  const nl = tail.indexOf(0x0a);
  writeFileSync(file, nl >= 0 ? tail.subarray(nl + 1) : tail);
}

function writeRunRecord(record: TraceRunRecord): void {
  const file = tracePath(record.sessionId);
  mkdirSync(dirname(file), { recursive: true });
  try {
    trimTraceFile(file);
  } catch {
    // 文件不可 stat（首写/竞态）直接跳过护栏，尽力而为
  }
  appendFileSync(file, JSON.stringify(record) + "\n");
}

/** 读会话的轨迹 run（文件序即时间序，取末尾 limit 个）；文件缺失/撕裂行容错 */
export function readTraceRuns(sessionId: string, limit = 50): TraceRunRecord[] {
  let raw: string;
  try {
    raw = readFileSync(tracePath(sessionId), "utf8");
  } catch {
    return [];
  }
  const runs: TraceRunRecord[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      runs.push(JSON.parse(t) as TraceRunRecord);
    } catch {
      // 撕裂行跳过
    }
  }
  return runs.slice(-Math.max(1, limit));
}

/* ------------------------- 在飞 run 的读取（面板用） ------------------------- */

/**
 * 读某会话当前在飞的 run（live 增量落盘的轮行拼回）。
 *
 * 与 readTraceRuns 分开是为了省 IO：readTraceRuns 要 readFileSync 整个主文件
 * （可达 5MB）并逐行 parse，面板 2 秒轮一次太浪费；live 文件只有一个在飞 run。
 *
 * 只读，不做 promote——抢救残留是写入端的职责（agent_start 时按 pid 判定）。
 * pid 与当前进程不同的组视为崩溃残留，也一并返回，标注 partial，让面板能显示
 * 「上次跑到哪就断了」，而不是等下次有新 run 才看到。
 */
export function readLiveRun(sessionId: string): TraceRunRecord[] {
  let raw: string;
  try {
    raw = readFileSync(traceLivePath(sessionId), "utf8");
  } catch {
    return [];
  }
  // 按 traceId 分组（主 run 与并行子代理共写同一文件）
  const groups = new Map<string, LiveLine[]>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as LiveLine;
      if (!parsed?.traceId) continue;
      const list = groups.get(parsed.traceId);
      if (list) list.push(parsed);
      else groups.set(parsed.traceId, [parsed]);
    } catch {
      // 撕裂行跳过
    }
  }

  const out: TraceRunRecord[] = [];
  for (const [traceId, lines] of groups) {
    const header = lines.find((l): l is LiveRunHeader => l.kind === "run");
    if (!header) continue; // 无头部无法判定归属
    const turns = lines.filter((l): l is LiveTurnLine => l.kind === "turn").map((l) => l.turn);
    const gone = header.pid !== process.pid;
    const endMs = turns.reduce((m, t) => Math.max(m, t.endMs || t.startMs), header.startMs);
    out.push({
      traceId,
      runId: traceId,
      sessionId,
      source: header.source,
      startMs: header.startMs,
      // 在飞：endMs 用「已录到的最后时刻」，消费方靠 partial 区分是否已收尾
      endMs,
      status: gone ? "error" : "ok",
      outcome: gone
        ? { reason: "interrupted", detail: "进程中断，只到最后一个闭合的轮" }
        : undefined,
      ...(header.model ? { model: header.model } : {}),
      spans: turns,
      partial: true,
    });
  }
  return out;
}
