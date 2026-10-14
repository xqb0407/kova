/**
 * 上下文维护（compaction）：在回合边界把此前的全部模型上下文压成一条摘要消息，
 * 替换原始历史，使长会话能持续进行。数据模型与阈值公式参考 PI-Desktop
 * （agent-runtime/runtime.ts 的 codex-shaped completed_turn 形态）：
 *   - 压缩只发生在回合边界，压缩后不保留任何原始尾部消息（摘要覆盖全部历史）；
 *   - checkpoint 行持久化到 JSONL（全量消息行保留，UI 历史不受影响）；
 *   - generation 计数器藏在 checkpoint 的 opaque details 里（宿主原样持久化，
 *     不需要为它单独加 schema 字段）；
 *   - 摘要生成失败时走 fresh_window 兜底（不花模型请求，装填固定 rollover
 *     marker），保证会话能继续。
 *
 * 与 PI-Desktop 的差异：我们不引入 pi 的 Entry 树投射（buildSessionContext），
 * 摘要以 user 角色 + core 官方前缀模板承载——裸 Agent 的默认 convertToLlm 会
 * 丢弃 compactionSummary 自定义角色，user 角色路径语义相同且零覆盖成本。
 */
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  retryAssistantCall,
  type Api,
  type Message,
  type Model,
  type RetryCallbacks,
  type RetryPolicy,
} from "@earendil-works/pi-ai";
import { getModels } from "../model/model-catalog";
import {
  PROVIDER_SETUP_RETRY_INITIAL_DELAY_MS,
  providerRetryMaxRetries,
} from "../model/provider-retry";
import {
  makePromptCacheKeyPayloadHook,
  makeSessionAffinityHeaders,
} from "../model/thinking";
import {
  appendCompactionRow,
  AUTO_CONTINUE_PREFIX,
  normalizeMessages,
  persist,
  readCompaction,
  readTranscript,
  type CompactionRow,
} from "../sessions/transcript";
import { logAt, logErr } from "../log";
import { classifyAgentError } from "./agent-errors";
import { emitThreadEvent } from "../protocol/thread-events";
import type { Running } from "../types";

/**
 * 热换系统提示词（0.99 迁移）：pi-agent-core 0.99 起 `state.systemPrompt` 是
 * 只读投影（转录里 leading system 消息的回放值），改提示词必须改写转录首条
 * system 消息本身。三个使用面共用本函数：
 *   - agent.state.messages：静态路径（下一次 prompt 生效）；
 *   - loopContext.messages：轮中路径（活循环下一次请求立即生效，数组是 loop
 *     的活引用，原地 unshift/替换元素均可被读到）；
 *   - 压缩后头部缺失时由本函数重建（runCompaction 保留头部分支之外的兜底）。
 * 幂等：有头部替换 content，无头部补插。timestamp 沿用旧头（无头时 0，
 * 与 core createInitialSystemMessage 同值），不扰动排序。
 */
export function setLeadingSystemMessage(messages: AgentMessage[], prompt: string): void {
  const head = messages[0] as { role?: string; content?: unknown; timestamp?: number } | undefined;
  if (head && head.role === "system") {
    messages[0] = { ...head, content: prompt } as AgentMessage;
  } else {
    messages.unshift({ role: "system", content: prompt, timestamp: 0 } as unknown as AgentMessage);
  }
}

/** 从 checkpoint 的 opaque details 读 generation（PI-Desktop context-compaction.ts 同设计：
 * 宿主原样持久化 details，不需要为计数器改 record schema；缺省/非法视为第 1 代） */
export function checkpointGeneration(details: unknown): number {
  const value = (details as { generation?: unknown } | null | undefined)
    ?.generation;
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : 1;
}

/** 无显式窗口/输出配置的模型兜底（与 PI-Desktop provider-binding 一致） */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
/** 头部留出的请求余量下限（PI-Desktop COMPACTION_RESERVE_FLOOR_TOKENS） */
const COMPACTION_RESERVE_FLOOR_TOKENS = 16_384;
/** 摘要失败降级时保留的最近原文预算（对齐 pi 的 keepRecentTokens: 20000）。
 *  曾经这里是零保留：整段历史换成一条 rollover marker，模型当场失忆、只能向
 *  用户重新要上下文（生产 2026-10-05 会话的现场）。保留最近一段原文，压缩失败
 *  也还能接着干。 */
const COMPACTION_KEEP_TAIL_TOKENS = 24_000;

/** fresh_window 兜底装填的固定 marker（对应 PI-Desktop CONTEXT_ROLLOVER_SUMMARY） */
const CONTEXT_ROLLOVER_SUMMARY = [
  "[context rollover: a new context window was started without summarizing conversation history]",
  "Earlier messages in this session are not part of this request. The complete transcript is still available to the user, and the environment is unchanged.",
  "Ask before assuming anything about work that is not visible here.",
].join("\n\n");

export type CompactionReason = "threshold" | "overflow" | "manual";

export type CompactionOutcome =
  | {
      ok: true;
      generation: number;
      tokensBefore: number;
      summarized: boolean;
      /** 摘要文本（fresh_window 兜底时为固定 rollover marker），compact 响应透传给前端渲染 */
      summary: string;
    }
  | { ok: false; message: string };

/** 摘要请求的结果。text 为空 / truncated 视为失败，不得落成 checkpoint
 *  （对齐 pi 的 getSummarizationFailure：截断的摘要含半截文本，不是可用的上下文）。
 *  usage 只作观测（写进 checkpoint details），缺席不影响判定。 */
export type SummarizeOutcome = {
  text: string;
  /** provider 用量（openai 口径 output 已含 reasoning） */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning?: number;
  };
  /** 输出撞满 maxTokens（等价 stopReason=length）：摘要不完整 */
  truncated?: boolean;
  /** 实际尝试次数（内部降级重试后 >1） */
  attempts?: number;
};

/** 摘要请求要复用的聊天上下文：与聊天请求同形（0.99 起系统提示词在
 *  messages[0] 里、工具表同一份），服务端前缀缓存才认得出这是同一段对话的
 *  开头——这是「压缩请求走缓存」的全部前提。 */
export type SummarizeChat = {
  /** 完整 state.messages（含 leading system 消息），与聊天请求字节同源 */
  messages: readonly AgentMessage[];
  /** 聊天用的工具表（同一份、同序；换表会让缓存前缀从 tools 段就失配） */
  tools: readonly unknown[];
  /** 会话 id：prompt_cache_key 补发与会话亲和头都靠它，缺了会路由到别的缓存分片 */
  sessionId: string;
  /** 会话思考档位：与聊天请求同参数（部分端点把参数算进缓存键；pi 的摘要也照发） */
  thinkingLevel?: string;
};

/** 摘要生成 seam：测试注入假实现（可直接返回字符串，少写参数即可）；默认走
 *  `defaultSummarize`——复用聊天前缀 + 尾部摘要指令的真实请求 */
export type SummarizeFn = (
  messages: AgentMessage[],
  reserveTokens: number,
  previousSummary: string | undefined,
  chat: SummarizeChat,
) => Promise<string | SummarizeOutcome>;

/** 摘要文本归一：字符串实现与结果对象两种形状都吃 */
function summaryOutcomeOf(
  result: string | SummarizeOutcome,
): SummarizeOutcome {
  return typeof result === "string" ? { text: result } : result;
}

/** 压缩前的模型上下文预算（公式移植自 PI-Desktop contextBudget） */
export function contextBudget(
  messages: AgentMessage[],
  model: Model<Api>,
): { tokens: number; hardLimit: number; requestHeadroom: number } {
  const contextWindow = Math.max(
    1,
    Math.round(model.contextWindow || DEFAULT_CONTEXT_WINDOW),
  );
  const modelOutputBudget = Math.min(
    Math.max(1, Math.round(model.maxTokens || DEFAULT_MAX_TOKENS)),
    Math.max(1, Math.floor(contextWindow * 0.25)),
  );
  const reserveFloor = Math.min(
    COMPACTION_RESERVE_FLOOR_TOKENS,
    Math.max(1, Math.floor(contextWindow * 0.5)),
  );
  const requestHeadroom = Math.min(
    contextWindow - 1,
    Math.max(
      reserveFloor,
      modelOutputBudget,
      Math.ceil(contextWindow * 0.05),
    ),
  );
  const hardLimit = Math.max(1, contextWindow - requestHeadroom);
  return {
    tokens: estimateContextTokens(messages).tokens,
    hardLimit,
    requestHeadroom,
  };
}

/** 合成摘要消息识别：user 角色 + core 前缀模板（恢复投射与迭代摘要都靠它） */
export function isSummaryMessage(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  // AgentMessage 的自定义角色变体没有 content 字段，联合窄化不可靠，显式取
  const content = (message as { content?: unknown }).content;
  const first = Array.isArray(content)
    ? (content[0] as { type?: string; text?: string } | undefined)
    : undefined;
  return (
    !!first &&
    first.type === "text" &&
    typeof first.text === "string" &&
    first.text.startsWith(COMPACTION_SUMMARY_PREFIX)
  );
}

export function makeSummaryMessage(summary: string): AgentMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX,
      },
    ],
    timestamp: Date.now(),
  } as AgentMessage;
}

/* --------------------- 自动续跑（长度截断 / 流中断） --------------------- */

/** vendor 循环只对"length 截断 + 带 toolCall"的轮次自我续跑（把 tool call 标记
 *  失败重试）；"length 截断 + 零 toolCall"（模型把预算全花在思考/正文上还没吐出
 *  工具调用就被切断）会被当作自然收尾——任务"到一半停下"的根因。这里在 turn_end
 *  监听里补上该场景的续跑：followUp 队列恰好在此后轮询（getFollowUpMessages），
 *  时序由 vendor 契约保证（emit 会 await 全部监听器）。
 *
 *  同一个机制也覆盖第二种中断：**provider/网关把流掐断**（`Stream ended without
 *  finish_reason` 这类可重试错误）且本轮零 toolCall——线上实测的"回答到一半"。
 *  带 toolCall 的轮不自动续：重发可能把已经跑过的工具再跑一遍，那条路留给错误卡
 *  上的手动「重试」。两种原因共用同一预算（按用户轮重置），网关持续抖动时最多
 *  自动续 MAX_LENGTH_CONTINUES 次就停手。 */
export const MAX_LENGTH_CONTINUES = 3;

/** 自动续跑的原因（决定注入消息的措辞与日志） */
export type ContinuationReason = "length" | "stream";

/** 该轮是否为"截断且无 toolCall"——需要注入续跑消息才成立 */
export function needsLengthContinuation(message: AgentMessage): boolean {
  const m = message as {
    role?: string;
    stopReason?: string;
    content?: { type: string }[];
  };
  return (
    m?.role === "assistant" &&
    m.stopReason === "length" &&
    Array.isArray(m.content) &&
    !m.content.some((c) => c.type === "toolCall")
  );
}

/** 该轮是否为"provider 流中断且无 toolCall"：可重试类错误（网络/限流/5xx/流被
 *  掐断）才算——配额、鉴权这类确定性失败不自动续（重发只会再撞同一堵墙）。 */
export function needsStreamBreakContinuation(message: AgentMessage): boolean {
  const m = message as {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
    content?: { type: string }[];
  };
  if (m?.role !== "assistant" || m.stopReason !== "error") return false;
  if (!Array.isArray(m.content) || m.content.some((c) => c.type === "toolCall")) {
    return false;
  }
  return classifyAgentError(m.errorMessage ?? "").retriable === true;
}

/** 构造续跑消息：user 角色 + 哨兵前缀（UI 双面不可见，见 AUTO_CONTINUE_PREFIX）。
 *  continues 为本次是第几次续跑（1 起）：实测弱模型会把整轮输出预算烧在
 *  reasoning 上被再切断（3 连 length、每轮 2 万+字符纯思考），第 2 次起
 *  追加反长思考指引——仿 prompt-pipeline 截断 toolCall hint 的就地自愈文风。
 *  reason="stream" 时措辞换成"连接中断"，并明确叫模型别道歉/别复述。 */
export function makeAutoContinueMessage(
  continues: number,
  reason: ContinuationReason = "length",
): AgentMessage {
  const escalation =
    continues >= 2
      ? "\n\n输出预算有限：不要再进行长篇思考（reasoning），先输出正文或立即发起工具调用；大文件写入拆成多次较小的调用。"
      : "";
  const opener =
    reason === "stream"
      ? "上一条回复在传输中被中断（网关/网络原因，不是你的问题，也不是用户的指令）。"
      : "上一条回复因达到输出 token 上限被截断，任务尚未完成。";
  const closing =
    reason === "stream"
      ? "请从中断处直接继续输出，不要重复已输出的内容，也不要道歉或评论这次中断；" +
        "如果接下来需要产出文件或其他成果，立即发起对应的工具调用。"
      : "请从中断处直接继续，不要重复已输出的内容，也不要道歉或评论这次截断；" +
        "如果接下来需要产出文件或其他成果，立即发起对应的工具调用。";
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: AUTO_CONTINUE_PREFIX + opener + closing + escalation,
      },
    ],
    timestamp: Date.now(),
  } as AgentMessage;
}

/**
 * 从 JSONL 转录重建恢复用的模型上下文（sessions.ts 重启续聊入口）。
 * 有检查点时：摘要消息覆盖 throughSeq 及之前的全部历史行，其后的消息行原样保留
 * ——与压缩时安装进 state 的形状一致；无检查点时行为与旧版全量恢复相同。
 */
export function projectRestoreContext(
  rows: { seq: number; agent: Message }[],
  checkpoint: CompactionRow | undefined,
): Message[] {
  // 归一是幂等的：形状已对的消息原样返回，只有存量畸形块被修。不做这层的话，
  // 一条 {type:"text"} 脏行会让恢复出的上下文在每次请求前的 token 估算里抛
  // TypeError，续聊永远起不来。
  // system 行一并滤除（防御）：0.99 起转录不落盘 system，恢复上下文统一由
  // initialState.systemPrompt 重建头部。
  const rows0 = rows.filter((r) => (r.agent as { role?: string }).role !== "system");
  if (!checkpoint) return normalizeMessages(rows0.map((r) => r.agent));
  const tail = normalizeMessages(
    rows0.filter((r) => r.seq > checkpoint.throughSeq).map((r) => r.agent),
  );
  return [
    makeSummaryMessage(checkpoint.summary) as unknown as Message,
    ...tail,
  ];
}

function summaryTextOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content as {
    type: string;
    text?: string;
  }[];
  const text = content[0]?.text ?? "";
  return text.slice(
    COMPACTION_SUMMARY_PREFIX.length,
    text.length - COMPACTION_SUMMARY_SUFFIX.length,
  );
}

/** 进入摘要范围的消息：跳过 leading system 消息（全量提示词进摘要既浪费
 *  token 又污染摘要内容，且提示词热换后仍由 system 头部承载）、合成摘要头
 *  与错误/中止的 assistant 消息（同 session-context 的 isContextMessage） */
function isCompactableMessage(message: AgentMessage): boolean {
  // AgentMessage 的类型层 role 联合不含 "system"（运行时首条才有），比较走宽松
  if ((message as { role?: string }).role === "system") return false;
  if (isSummaryMessage(message)) return false;
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "deferred")
  );
}

/** 请求前阈值守卫：当前上下文 + 待发用户消息是否已越过 hardLimit */
export function needsCompaction(run: Running, pendingText?: string): boolean {
  const model = run.agent.state.model;
  if (!model) return false;
  const messages = run.agent.state.messages as AgentMessage[];
  if (messages.length <= 1 && !pendingText) return false;
  const projected = [...messages];
  if (pendingText) {
    projected.push({
      role: "user",
      content: [{ type: "text", text: pendingText }],
      timestamp: Date.now(),
    } as AgentMessage);
  }
  const budget = contextBudget(projected, model);
  return budget.tokens >= budget.hardLimit;
}

/** core 的摘要输出上限公式（compaction.js: maxTokens = min(0.8×reserveTokens,
 *  model.maxTokens)）。本地复算一份，用于把 completion_tokens 撞满上限判成截断。 */
function summaryMaxTokens(reserveTokens: number, model: Model<Api>): number {
  return Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
}

/** 摘要请求的重试策略：与聊天路径共用同一预算旋钮（PI_PROVIDER_RETRY_MAX，
 *  默认 10），但**按次成本完全不同**——摘要一次尝试是 2-3 分钟量级（生产实测
 *  2m17s / 2m40s），照搬 10 次会把压缩挂成半小时。上限压到 3：PI_PROVIDER_RETRY_MAX=0
 *  仍可整体关掉，配置更小的值照办。 */
const SUMMARY_RETRY_MAX_ATTEMPTS = 3;

function summaryRetryPolicy(): RetryPolicy {
  const maxRetries = Math.min(
    providerRetryMaxRetries(),
    SUMMARY_RETRY_MAX_ATTEMPTS,
  );
  return {
    enabled: maxRetries > 0,
    maxRetries,
    baseDelayMs: PROVIDER_SETUP_RETRY_INITIAL_DELAY_MS,
  };
}

/** 降级重试时的对话裁剪：保留头部（leading system / 摘要头）+ 最近的尾部，
 *  预算按比例收缩。请求更小、更快、更不容易被网关掐（生产两例失败都在 112K
 *  量级的请求上）。尾部不能以悬空 toolResult 开头——它的 toolCall 已不在窗口里，
 *  部分 provider 直接 400。 */
const SUMMARY_TRIM_KEEP_RATIO = 0.6;
const SUMMARY_TRIM_MIN_TOKENS = 8_000;
/** 降级摘要的诚实声明（前缀形式）：告诉模型这份摘要没覆盖最早的历史 */
const SUMMARY_PARTIAL_NOTE =
  "[note: this summary was generated from a truncated view of the session — its earliest part was not available. Do not assume it covers the start of the work.]";

/** 摘要指令：尾部追加的一条 user 消息。**不重写任何已有内容**——这是前缀缓存
 *  能命中的前提（Claude Code 的压缩也是这个形状：真实对话 + 尾部指令）。 */
function summaryInstruction(previousSummary: string | undefined): string {
  const intro = previousSummary
    ? "The summary at the start of this conversation is out of date: the messages after it are new. Rewrite that summary so it covers the whole session from the beginning, keeping everything in it that is still true."
    : "The conversation above is the session so far.";
  return [
    intro,
    "",
    "Your task now is to write a structured summary of this session that a later turn can continue from with no other context. Do NOT continue the conversation, do NOT answer anything in it, and do NOT call any tools — reply with the summary text only.",
    "",
    "Use exactly these sections:",
    "### In Progress",
    "### Blocked",
    "### Key Decisions",
    "### Next Steps",
    "### Critical Context",
    "",
    'Keep each section concise. Preserve exact file paths, function names, commands and error messages. If a section has nothing, write "None".',
  ].join("\n");
}

/** assistant 文本块拼接（core 的 contentText 不在包导出面上，这里只认 text 块） */
function assistantTextOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    const b = block as { type?: string; text?: unknown } | null;
    if (b?.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

/** 摘要响应里出现工具调用即失败（pi 的同类守卫）：那不是摘要，是被截断的思路 */
function hasToolCall(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((b) => (b as { type?: string } | null)?.type === "toolCall")
  );
}

function trimForSummaryRetry(messages: readonly AgentMessage[]): AgentMessage[] {
  if (messages.length <= 3) return [...messages];
  const head = messages[0]!; // leading system 消息（或上一代摘要头）
  const rest = messages.slice(1);
  const total = rest.reduce((sum, m) => sum + estimateTokens(m), 0);
  const budget = Math.max(
    SUMMARY_TRIM_MIN_TOKENS,
    Math.floor(total * SUMMARY_TRIM_KEEP_RATIO),
  );
  let acc = 0;
  let cut = rest.length;
  while (cut > 0) {
    const cost = estimateTokens(rest[cut - 1]!);
    if (acc + cost > budget) break;
    acc += cost;
    cut -= 1;
  }
  let start = cut;
  while (
    start < rest.length &&
    (rest[start] as { role?: string }).role !== "user"
  ) {
    start += 1;
  }
  if (start >= rest.length) return [...messages];
  return [head, ...rest.slice(start)];
}

/** 摘要请求只用得到注册表的 completeSimple；窄化是为了测试可注入假实现
 *  （mock.module 是进程级的，会把假 registry 泄漏给同进程的其它测试文件）。 */
export type SummaryModels = Pick<import("@earendil-works/pi-ai").Models, "completeSimple">;

export function defaultSummarize(
  model: Model<Api>,
  signal: AbortSignal | undefined,
  models: SummaryModels = getModels(),
): SummarizeFn {
  return async (_compactable, reserveTokens, previousSummary, chat) => {
    if (!chat) {
      throw new Error(
        "summary request requires the chat context (messages/tools/sessionId)",
      );
    }
    const retry = summaryRetryPolicy();
    const callbacks: RetryCallbacks = {
      onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
        logAt(
          "event",
          `compaction: summary retry ${attempt}/${maxAttempts} in ${delayMs}ms (${errorMessage})`,
        );
      },
    };
    // 与聊天请求同形：同一 system（在 messages[0] 里）、同一 tools、同一亲和头与
    // prompt_cache_key，唯一差别是尾部多一条摘要指令 → 服务端前缀缓存能命中整段
    // 对话，压缩不再是一笔 112K 全价重算；同时直连 completeSimple 让我们终于拿到
    // 真实 stopReason（截断判定不用再靠 output>=cap 反推）。
    const options = {
      maxTokens: summaryMaxTokens(reserveTokens, model),
      ...(signal ? { signal } : {}),
      sessionId: chat.sessionId,
      headers: makeSessionAffinityHeaders(chat.sessionId),
      onPayload: makePromptCacheKeyPayloadHook(chat.sessionId),
      // 思考档位与聊天同参数（pi 的 createSummarizationOptions 同规则）——
      // 某些端点把参数算进缓存键，参数不一致会让"本该命中"的前缀失配
      ...(model.reasoning &&
      chat.thinkingLevel &&
      chat.thinkingLevel !== "off"
        ? { reasoning: chat.thinkingLevel as never }
        : {}),
      // 与聊天路径同一长缓存开关（Anthropic 1h / OpenAI 24h，compat 守门自动降级）
      ...(process.env.PI_CACHE_RETENTION === "long"
        ? { cacheRetention: "long" as const }
        : {}),
    };
    const attempt = async (
      messages: readonly AgentMessage[],
      partial: boolean,
    ): Promise<SummarizeOutcome | { error: string }> => {
      const instruction = {
        role: "user",
        content: [
          {
            type: "text",
            text: summaryInstruction(partial ? undefined : previousSummary),
          },
        ],
        timestamp: Date.now(),
      } as unknown as AgentMessage;
      const response = await retryAssistantCall(
        () =>
          models.completeSimple(
            model,
            {
              messages: [...messages, instruction],
              ...(chat.tools.length ? { tools: chat.tools } : {}),
            } as never,
            options as never,
          ),
        retry,
        signal,
        callbacks,
      );
      if (response.stopReason === "aborted") return { error: "summary request aborted" };
      if (response.stopReason === "error") {
        return { error: response.errorMessage || "summary request failed" };
      }
      if (hasToolCall(response.content)) {
        return { error: "summarization attempted to call a tool" };
      }
      const text = assistantTextOf(response.content);
      return {
        text: partial && text.trim() ? `${SUMMARY_PARTIAL_NOTE}\n\n${text}` : text,
        usage: response.usage,
        // 精确判定：撞满输出上限（stopReason=length）的摘要含半截内容，不得
        // 成为 checkpoint（pi 的 getSummarizationFailure 同判定）
        truncated: response.stopReason === "length",
      };
    };
    const usable = (
      r: SummarizeOutcome | { error: string },
    ): r is SummarizeOutcome =>
      !("error" in r) && r.text.trim().length > 0 && r.truncated !== true;
    const reasonOf = (r: SummarizeOutcome | { error: string }): string =>
      "error" in r
        ? r.error
        : r.truncated
          ? "summary truncated at the output cap"
          : "summary generation returned empty content";

    const first = await attempt(chat.messages, false);
    if (usable(first)) return { ...first, attempts: 1 };
    if (signal?.aborted) throw new Error(reasonOf(first));
    const trimmed = trimForSummaryRetry(chat.messages);
    if (trimmed.length < chat.messages.length) {
      logAt(
        "event",
        `compaction: summary retry with trimmed history (${chat.messages.length} -> ${trimmed.length} messages): ${reasonOf(first)}`,
      );
      const second = await attempt(trimmed, true);
      if (usable(second)) return { ...second, attempts: 2 };
      throw new Error(reasonOf(second));
    }
    throw new Error(reasonOf(first));
  };
}

/**
 * 执行一次压缩：摘要当前上下文 → 落 checkpoint 行 → 用摘要消息替换 Agent 状态。
 * 只在回合边界（prompt 之前 / 溢出错误结算之后）调用；running 中途绝不调用。
 */
export async function runCompaction(
  run: Running,
  reason: CompactionReason,
  opts?: { summarize?: SummarizeFn },
): Promise<CompactionOutcome> {
  const model = run.agent.state.model;
  if (!model) return { ok: false, message: "No model configured" };
  const messages = run.agent.state.messages as AgentMessage[];
  // 0.99 起转录首条是 leading system 消息：迭代摘要的 previousSummary 要从
  // 首条**非 system** 消息找（否则恒 miss，摘要迭代退化为无前次摘要）
  const firstContent = messages.find((m) => (m as { role?: string }).role !== "system");
  const previousSummary =
    firstContent && isSummaryMessage(firstContent)
      ? summaryTextOf(firstContent)
      : undefined;
  const toSummarize = messages.filter(isCompactableMessage);
  if (toSummarize.length === 0) {
    return { ok: false, message: "No new context is available to compact" };
  }

  const budget = contextBudget(messages, model);
  const tokensBefore = budget.tokens;
  // 摘要请求复用的聊天前缀：完整 messages（含 leading system）+ 同一份工具表。
  // 只做形状搬运，不改任何字节——换掉任何一段都等于让压缩重新付一次全价。
  const chatContext: SummarizeChat = {
    messages,
    tools: (run.agent.state.tools ?? []) as readonly unknown[],
    sessionId: run.sessionId,
    thinkingLevel: run.agent.state.thinkingLevel as string | undefined,
  };
  let outcome: SummarizeOutcome | null = null;
  let summary = "";
  let summarized = true;
  // 原生事件通道（react-pi 迁移阶段 3）：压缩生命周期进 reducer
  //（metadata.compactionActive → 压缩横幅），与 data-compaction chunk 并行
  emitThreadEvent(run.sessionId, { type: "compaction_start", reason });
  const controller = new AbortController();
  run.compactionAbort = controller;
  try {
    const summarize =
      opts?.summarize ?? defaultSummarize(model, controller.signal);
    outcome = summaryOutcomeOf(
      await summarize(
        toSummarize,
        budget.requestHeadroom,
        previousSummary,
        chatContext,
      ),
    );
    summary = outcome.text;
  } catch (err) {
    // 用户 Stop 期间失败：不装填兜底 checkpoint，让外层循环退出
    if (run.stopRequested || controller.signal.aborted) {
      emitThreadEvent(run.sessionId, { type: "compaction_end", aborted: true, willRetry: false });
      return { ok: false, message: "Compaction aborted" };
    }
    if (reason === "manual") {
      emitThreadEvent(run.sessionId, { type: "compaction_end", aborted: false, willRetry: false });
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    summarized = false;
    summary = CONTEXT_ROLLOVER_SUMMARY;
    logErr("compaction: summary generation failed, fresh_window rollover:", err);
  } finally {
    run.compactionAbort = undefined;
  }

  // 不可用摘要必须在写 checkpoint 前拦住，两种形态：
  //   1) 空文本：core 的 generateSummary 只在 stopReason 为 aborted/error 时报错，
  //      响应里没有 text 块时 contentText 返回 "" 且照样 ok；
  //   2) 撞满输出上限（truncated）：半截摘要比空摘要更隐蔽——它看起来是成功的。
  //      （pi 的 getSummarizationFailure 同判定：length stop 不得成为 checkpoint。）
  // 放行的后果是把整段历史替换成一条不完整摘要——磁盘 transcript 还在，但模型
  // 侧上下文永久残缺。defaultSummarize 内部已按同一判定降级重试，这里是注入实现
  //（测试/子代理）与竞态的兜底闸门。
  if (!summary.trim() || outcome?.truncated === true) {
    const truncated = outcome?.truncated === true && summary.trim().length > 0;
    if (run.stopRequested || controller.signal.aborted) {
      emitThreadEvent(run.sessionId, { type: "compaction_end", aborted: true, willRetry: false });
      return { ok: false, message: "Compaction aborted" };
    }
    if (reason === "manual") {
      emitThreadEvent(run.sessionId, { type: "compaction_end", aborted: false, willRetry: false });
      return {
        ok: false,
        message: truncated
          ? "Summary generation was truncated at the output cap"
          : "Summary generation returned no content",
      };
    }
    summarized = false;
    summary = CONTEXT_ROLLOVER_SUMMARY;
    logErr(
      truncated
        ? "compaction: summary truncated at output cap, fresh_window rollover"
        : "compaction: summary generation returned empty content, fresh_window rollover",
    );
  }

  // ---- 上下文形状落定 --------------------------------------------------------
  // 先把 state 里还没入账的消息落盘再改形状：轮中压缩时当前轮的 assistant/
  // toolResult 只活在 state 里，不先入账就会随形状重写一起消失——转录缺段
  //（刷新后 UI 历史断档，复盘也少证据），而降级路径的"保留尾部"更是必须靠
  // 转录行才能取回。
  try {
    await persist(run);
  } catch (err) {
    logErr("compaction: persist before reshape failed:", err);
  }
  // 摘要成功：摘要头覆盖全部历史（throughSeq = 末尾，其后无行）。
  // 摘要失败：不再整段清空——保留最近 COMPACTION_KEEP_TAIL_TOKENS 原文，切点
  // 走 core 的合法切点表（悬空 toolResult 会让部分 provider 400）。装载侧
  // projectRestoreContext 天然支持「摘要 + 其后行原样保留」，所以只需要把
  // throughSeq 指到被丢弃的最后一行。
  let throughSeq = run.jsonlSeq - 1;
  let tailMessages: AgentMessage[] = [];
  if (!summarized) {
    const rows = readTranscript(run.sessionId).filter(
      (r) => (r.agent as { role?: string }).role !== "system",
    );
    // 切点走 core 的合法切点表（findCutPoint）：toolResult 不是合法切点——它的
    // toolCall 已被摘掉，悬空的 toolResult 会让部分 provider 直接 400；且窗口
    // 围绕 keepRecentTokens 收敛，不会为了找边界把整段原历史又留下来。
    const entries = rows.map((r) => ({
      id: "",
      parentId: null,
      seq: r.seq,
      timestamp: 0,
      type: "message" as const,
      message: r.agent as unknown as AgentMessage,
    }));
    let start = findCutPoint(
      entries,
      0,
      entries.length,
      COMPACTION_KEEP_TAIL_TOKENS,
    ).firstKeptEntryIndex;
    // 兜底（core 已排除 toolResult 切点，正常取不到这条分支）
    while (
      start < rows.length &&
      (rows[start]!.agent as { role?: string }).role === "toolResult"
    ) {
      start += 1;
    }
    if (start < rows.length) {
      tailMessages = rows
        .slice(start)
        .map((r) => r.agent as unknown as AgentMessage);
      // 切点落在首行 = 一条都不丢：throughSeq 必须指到首行之前，否则装载侧
      //（seq > throughSeq 才保留）会把刚保下来的尾部当成"已被摘要覆盖"整段丢掉，
      // 活状态与刷新后的状态分叉。
      throughSeq = start > 0 ? rows[start - 1]!.seq : rows[0]!.seq - 1;
    }
  }

  const generation = run.compactionGeneration + 1;
  appendCompactionRow(run.sessionId, {
    seq: run.jsonlSeq,
    summary,
    tokensBefore,
    throughSeq,
    createdAt: new Date().toISOString(),
    details: {
      generation,
      strategy: summarized ? "summary" : "fresh_window",
      // 观测位：摘要请求的用量/尝试次数/保留下来的尾部条数。生产两例失败
      //（2026-10-04 流断、2026-10-05 空响应）复盘时缺的正是这些数字。
      ...(outcome?.usage ? { summaryUsage: outcome.usage } : {}),
      ...(outcome?.attempts ? { summaryAttempts: outcome.attempts } : {}),
      ...(tailMessages.length ? { keptTailMessages: tailMessages.length } : {}),
    },
  });
  run.jsonlSeq += 1;
  // 0.99 起系统提示词由转录首条 system 消息承载：压缩重建历史必须保留它，
  // 否则压缩后下一轮请求裸奔（模型丢失全部系统指令）
  const sysHead =
    (messages[0] as { role?: string } | undefined)?.role === "system" ? messages[0] : undefined;
  run.agent.state.messages = [
    ...(sysHead ? [sysHead] : []),
    makeSummaryMessage(summary) as unknown as Message,
    ...tailMessages,
  ] as AgentMessage[];
  // 主题全文随摘要替换离开上下文：加载台账清空，下一次 use_design_theme
  // 自动重贴全文（design 段「动笔前先加载」指令常驻，驱动模型复 call 自愈）
  run.designThemeLoads?.clear();
  // 合成摘要头不再作为消息行落盘（checkpoint 行已承载 summary），
  // persistedSeq 指向 state 末尾，下一轮 persist 只写新增消息
  run.persistedSeq = run.agent.state.messages.length;
  run.compactionGeneration = generation;
  emitThreadEvent(run.sessionId, { type: "compaction_end", aborted: false, willRetry: false });
  return {
    ok: true,
    generation,
    tokensBefore,
    summarized,
    summary,
  };
}

/* ------------------------------- 上下文信息面板 ------------------------------- */

/** 字符串 token 估算：与 core estimateTokens 同一启发式（ceil(字符数 / 4)），
 * 保证面板读数与阈值守卫口径一致 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 会话累计的 provider 用量（全历史 assistant 消息求和；错误/中止轮不计） */
export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** 平均缓存命中率：cacheRead / (input + cacheRead + cacheWrite)；无用量数据返回 null */
export function cacheHitRateOf(totals: UsageTotals): number | null {
  const promptTotal =
    totals.input + totals.cacheRead + totals.cacheWrite;
  if (promptTotal <= 0) return null;
  return totals.cacheRead / promptTotal;
}

/**
 * 一条 assistant 消息的用量 → 计入口径的总数（四项相加）。
 *
 * 与 sessionUsageTotals / usage-stats 同一口径，也是目标模式 token 读数用的那个：
 * error / aborted 轮不计（provider 没真正算完，账也是虚的）。抽出来是为了让
 * 「从转录重算」和「从事件现累」两条路不会漂成两个数。
 */
export function messageUsageTokens(message: unknown): number {
  const m = message as
    | { role?: string; stopReason?: string; usage?: Partial<UsageTotals> | null }
    | undefined;
  if (!m || m.role !== "assistant") return 0;
  if (m.stopReason === "error" || m.stopReason === "aborted") return 0;
  const u = m.usage;
  if (!u) return 0;
  return (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
}

/** 从 JSONL 转录聚合会话累计用量（usage 随 assistant 消息行本来就落盘，不另建持久化） */
export function sessionUsageTotals(sessionId: string): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const row of readTranscript(sessionId)) {
    const msg = row.agent as unknown as {
      role?: string;
      stopReason?: string;
      usage?: Partial<UsageTotals> | null;
    };
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
    const usage = msg.usage;
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
  }
  return totals;
}

/** 缓存 TTL：空闲超过它的重算归因成「过了缓存有效期」（对齐 pi 的
 *  CACHE_TTL_MS = 5min），而不是不明原因。 */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** 单次重算的噪声地板（pi 同值 1024）：缓存断点/分块粒度造成的千把 token 抖动
 *  不算 miss。 */
const CACHE_MISS_NOISE_FLOOR_TOKENS = 1_024;
/** 「近 N 轮」命中率窗口：累计值会被冷启动与重建轮稀释，短窗才看得到稳态。 */
const CACHE_RECENT_WINDOW = 10;

/** 缓存统计。
 *
 *  两套口径并存：
 *   - `misses`（旧）：单轮 input ≥2,000 且 ≥ prompt 5%。分不清「本轮新增内容」
 *     （工具结果本来就是新内容）与「前缀被重算」，实测误报能占九成，仅用于
 *     兼容旧面板的分母；
 *   - `missedTokens`/`missCount`（pi 口径，权威）：单轮重算量 =
 *     min(上一轮 prompt, 本轮 prompt) − cacheRead，地板 1024。这个数才是
 *     「多付了多少 token」，并带 `lastMiss` 归因（空闲超 TTL / 模型切换）。
 *
 *  冷启动首轮没有「本应命中」的前缀，两套口径都不计；模型从未上报过缓存活动
 *  的会话（provider 不支持）整段不计重算（pi 的 reportedCache 判据）。
 *  近似限制：转录无法区分「进程重启后恢复会话的首轮」与「压缩后首轮」，
 *  若恰在检查点之后会被记为一次重建——最多差一轮，换取零新增持久化。 */
export type CacheMissStats = {
  /** 带 usage 的 assistant 请求数（错误/中止轮不计） */
  requests: number;
  /** 旧口径计数（≥2000 且 ≥5%）：面板分母仍用它，与 rebuilds 语义配套 */
  misses: number;
  /** 压缩检查点后首轮：预期重建，旧口径不计 */
  rebuilds: number;
  /** pi 口径：真·重算 tokens（含压缩后重建轮，它确实整段重算过） */
  missedTokens: number;
  /** 触发重算的轮次数 */
  missCount: number;
  /** 最近一次重算的归因；两项都不成立时为 null = 未归因（多为前端失配） */
  lastMiss: {
    tokens: number;
    /** 距上一轮请求的空闲时长（ms） */
    idleMs: number;
    modelChanged: boolean;
  } | null;
  /** 最近 CACHE_RECENT_WINDOW 个请求的命中率（含冷启动轮） */
  recent: { requests: number; hitRate: number | null };
};

export function sessionCacheMissStats(
  sessionId: string,
  compactionThroughSeq: number | null = null,
): CacheMissStats {
  const stats: CacheMissStats = {
    requests: 0,
    misses: 0,
    rebuilds: 0,
    missedTokens: 0,
    missCount: 0,
    lastMiss: null,
    recent: { requests: 0, hitRate: null },
  };
  let rebuildCounted = false;
  // 有过缓存活动才把「零命中」当整段重算：否则会把「provider 根本不报缓存」的
  // 会话全记成 miss（pi 的 reportedCache 判据）
  let reportedCache = false;
  let prevPrompt = 0;
  let prevAt = 0;
  let prevModel = "";
  const window: { prompt: number; cacheRead: number }[] = [];
  for (const row of readTranscript(sessionId)) {
    const msg = row.agent as unknown as {
      role?: string;
      stopReason?: string;
      usage?: Partial<UsageTotals> | null;
      timestamp?: number;
      model?: string;
      provider?: string;
    };
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
    const usage = msg.usage;
    if (!usage) continue;
    const input = usage.input ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const promptTotal = input + cacheRead + cacheWrite;
    const at = typeof msg.timestamp === "number" ? msg.timestamp : 0;
    const modelKey = `${msg.provider ?? ""}/${msg.model ?? ""}`;
    stats.requests += 1;
    window.push({ prompt: promptTotal, cacheRead });
    if (window.length > CACHE_RECENT_WINDOW) window.shift();

    // 冷启动首轮：还没有「本应命中」的前缀
    if (stats.requests > 1) {
      // 旧口径（面板分母沿用）
      if (
        compactionThroughSeq !== null &&
        !rebuildCounted &&
        row.seq > compactionThroughSeq
      ) {
        rebuildCounted = true;
        stats.rebuilds += 1;
      } else if (input >= 2000 && input >= promptTotal * 0.05) {
        stats.misses += 1;
      }
      // pi 口径：上一轮 prompt 里有多少没被缓存读到。
      // 判据（pi 同款）：本轮上报了缓存活动（读写任一），或本会话此前上报过——
      // 否则无法区分「provider 不支持缓存」与「整段 miss」，宁可不计。
      if (cacheRead + cacheWrite > 0 || reportedCache) {
        const missed = Math.min(prevPrompt, promptTotal) - cacheRead;
        if (missed > CACHE_MISS_NOISE_FLOOR_TOKENS) {
          stats.missedTokens += missed;
          stats.missCount += 1;
          stats.lastMiss = {
            tokens: missed,
            idleMs: prevAt && at ? Math.max(0, at - prevAt) : 0,
            modelChanged: prevModel !== "" && modelKey !== prevModel,
          };
        }
      }
    }
    if (cacheRead + cacheWrite > 0) reportedCache = true;
    prevPrompt = promptTotal;
    prevAt = at;
    prevModel = modelKey;
  }
  const windowPrompt = window.reduce((sum, w) => sum + w.prompt, 0);
  const windowCached = window.reduce((sum, w) => sum + w.cacheRead, 0);
  stats.recent = {
    requests: window.length,
    hitRate: windowPrompt > 0 ? windowCached / windowPrompt : null,
  };
  return stats;
}

export type ContextInfoResult = {
  /** 当前模型（无模型时 null，各占用字段按 0 呈现） */
  model: { provider: string; id: string; name: string } | null;
  contextWindow: number;
  /** 压缩阈值（contextWindow − requestHeadroom，与 needsCompaction 同一公式） */
  hardLimit: number;
  /** 消息历史占用（模型实际所见：压缩后 = 摘要头 + 增量） */
  messageTokens: number;
  systemPromptTokens: number;
  toolTokens: number;
  /** 模型可见的请求总占用：usage 可用时 messageTokens 已含系统提示词与工具
   *  定义（取末条 assistant 的 provider 用量），直接作总数；纯估算口径才
   *  三项相加。占用环/推送一律用本字段，叠加两项会把环推到虚高越线 */
  usedTokens: number;
  messageCount: number;
  /** 已发生的压缩代数（0 = 从未压缩） */
  generation: number;
  /** 最近一次压缩检查点（无则 null） */
  lastCompaction: {
    tokensBefore: number;
    summarized: boolean;
    createdAt: string;
  } | null;
  /** 当前占用是否已越过压缩阈值（下次请求前会先压缩） */
  needsCompaction: boolean;
  usage: UsageTotals;
  cacheHitRate: number | null;
  /** 逐请求 miss 计数（Claude Code 口径，见 sessionCacheMissStats） */
  cacheMisses: CacheMissStats;
};

/** context_info 计算体的输入（迭代2）：live run 与未加载会话的只读投影共用；
 *  systemPrompt/tools 已是组装好的最终形态（投影侧按"新建 run 会得到的样子"构建） */
export type ContextInfoInput = {
  model: Model<Api> | null;
  messages: AgentMessage[];
  systemPrompt: string;
  tools: readonly { name: string; description?: string; parameters?: unknown }[];
  sessionId: string;
  compactionGeneration: number;
};

/** context_info 命令的计算体：全部现算，零新增持久化 */
export function contextInfoFrom(input: ContextInfoInput): ContextInfoResult {
  const model = input.model;
  const messages = input.messages;
  // 0.99 起 live 路径的 messages 自带 leading system 消息（prompt 与工具声明
  // 已在其中），而本函数口径是「消息历史 + 单独的 systemPrompt/tools 三段」；
  // 投影路径则不含 system 头。统一滤掉 system 头再估算，两侧读数不分叉、
  // 纯估算分支（estimated + systemPromptTokens + toolTokens）不重复计系统段。
  const contentMessages = messages.filter(
    (m) => (m as { role?: string }).role !== "system",
  );
  const estimate = estimateContextTokens(contentMessages);
  const estimated = estimate.tokens;
  const budget = model ? contextBudget(contentMessages, model) : null;
  const usage = sessionUsageTotals(input.sessionId);
  const checkpoint = readCompaction(input.sessionId);
  const systemPromptTokens = estimateTextTokens(input.systemPrompt);
  const toolTokens = estimateTextTokens(
    input.tools
      .map(
        (t) =>
          `${t.name}\n${t.description ?? ""}\n${t.parameters ? JSON.stringify(t.parameters) : ""}`,
      )
      .join("\n"),
  );
  return {
    model: model
      ? { provider: model.provider, id: model.id, name: model.name }
      : null,
    contextWindow: budget
      ? Math.max(1, Math.round(model!.contextWindow || DEFAULT_CONTEXT_WINDOW))
      : 0,
    hardLimit: budget?.hardLimit ?? 0,
    messageTokens: estimated,
    systemPromptTokens,
    toolTokens,
    usedTokens: estimate.usageTokens > 0 ? estimated : estimated + systemPromptTokens + toolTokens,
    messageCount: contentMessages.length,
    generation: input.compactionGeneration,
    lastCompaction: checkpoint
      ? {
          tokensBefore: checkpoint.tokensBefore,
          summarized: (checkpoint.details as { strategy?: string } | undefined)
            ?.strategy !== "fresh_window",
          createdAt: checkpoint.createdAt,
        }
      : null,
    needsCompaction: budget
      ? contentMessages.length > 1 && estimated >= budget.hardLimit
      : false,
    usage,
    cacheHitRate: cacheHitRateOf(usage),
    cacheMisses: sessionCacheMissStats(
      input.sessionId,
      checkpoint ? checkpoint.throughSeq : null,
    ),
  };
}

/** 从活动 run 现算（live 路径） */
export function contextInfo(run: Running): ContextInfoResult {
  const state = run.agent.state;
  return contextInfoFrom({
    model: state.model ?? null,
    messages: state.messages as AgentMessage[],
    systemPrompt: state.systemPrompt ?? "",
    tools: (state.tools ?? []) as ContextInfoInput["tools"],
    sessionId: run.sessionId,
    compactionGeneration: run.compactionGeneration,
  });
}
