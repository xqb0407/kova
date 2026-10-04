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
  BACKGROUND_CONTEXT,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  estimateContextTokens,
  generateSummary,
  withAbortSignal,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { getModels } from "../model/model-catalog";
import {
  appendCompactionRow,
  AUTO_CONTINUE_PREFIX,
  normalizeMessages,
  readCompaction,
  readTranscript,
  type CompactionRow,
} from "../sessions/transcript";
import { logErr } from "../log";
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

/** 摘要生成 seam：测试注入假实现；默认走 core 的 generateSummary */
export type SummarizeFn = (
  messages: AgentMessage[],
  reserveTokens: number,
  previousSummary: string | undefined,
) => Promise<string>;

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

/* --------------------- 长度截断自动续跑（stopReason "length"） --------------------- */

/** vendor 循环只对"length 截断 + 带 toolCall"的轮次自我续跑（把 tool call 标记
 *  失败重试）；"length 截断 + 零 toolCall"（模型把预算全花在思考/正文上还没吐出
 *  工具调用就被切断）会被当作自然收尾——任务"到一半停下"的根因。这里在 turn_end
 *  监听里补上该场景的续跑：followUp 队列恰好在此后轮询（getFollowUpMessages），
 *  时序由 vendor 契约保证（emit 会 await 全部监听器）。 */
export const MAX_LENGTH_CONTINUES = 3;

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

/** 构造续跑消息：user 角色 + 哨兵前缀（UI 双面不可见，见 AUTO_CONTINUE_PREFIX）。
 *  continues 为本次是第几次续跑（1 起）：实测弱模型会把整轮输出预算烧在
 *  reasoning 上被再切断（3 连 length、每轮 2 万+字符纯思考），第 2 次起
 *  追加反长思考指引——仿 prompt-pipeline 截断 toolCall hint 的就地自愈文风。 */
export function makeAutoContinueMessage(continues: number): AgentMessage {
  const escalation =
    continues >= 2
      ? "\n\n输出预算有限：不要再进行长篇思考（reasoning），先输出正文或立即发起工具调用；大文件写入拆成多次较小的调用。"
      : "";
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          AUTO_CONTINUE_PREFIX +
          "上一条回复因达到输出 token 上限被截断，任务尚未完成。" +
          "请从中断处直接继续，不要重复已输出的内容，也不要道歉或评论这次截断；" +
          "如果接下来需要产出文件或其他成果，立即发起对应的工具调用。" +
          escalation,
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

function defaultSummarize(
  model: Model<Api>,
  signal: AbortSignal | undefined,
): SummarizeFn {
  return async (messages, reserveTokens, previousSummary) => {
    const context = signal
      ? withAbortSignal(signal, BACKGROUND_CONTEXT)
      : BACKGROUND_CONTEXT;
    const result = await generateSummary(
      messages,
      getModels(),
      model,
      reserveTokens,
      undefined,
      previousSummary,
      undefined,
      undefined,
      undefined,
      context,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
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
  let summary: string;
  let summarized = true;
  // 原生事件通道（react-pi 迁移阶段 3）：压缩生命周期进 reducer
  //（metadata.compactionActive → 压缩横幅），与 data-compaction chunk 并行
  emitThreadEvent(run.sessionId, { type: "compaction_start", reason });
  const controller = new AbortController();
  run.compactionAbort = controller;
  try {
    const summarize =
      opts?.summarize ?? defaultSummarize(model, controller.signal);
    summary = await summarize(
      toSummarize,
      budget.requestHeadroom,
      previousSummary,
    );
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

  // 空摘要必须在写 checkpoint 前拦住：core 的 generateSummary 只在 stopReason 为
  // aborted/error 时报错，响应里没有 text 块时 contentText 返回 "" 且照样 ok。
  // （stopReason=length 把 maxTokens 烧在 reasoning 上、自定义 provider 回空
  // content 等都会走到这里。）一旦放行，下面会把整段历史替换成一条空摘要——
  // 磁盘 transcript 还在，但模型侧上下文永久清空。
  if (!summary.trim()) {
    if (run.stopRequested || controller.signal.aborted) {
      emitThreadEvent(run.sessionId, { type: "compaction_end", aborted: true, willRetry: false });
      return { ok: false, message: "Compaction aborted" };
    }
    if (reason === "manual") {
      emitThreadEvent(run.sessionId, { type: "compaction_end", aborted: false, willRetry: false });
      return { ok: false, message: "Summary generation returned no content" };
    }
    summarized = false;
    summary = CONTEXT_ROLLOVER_SUMMARY;
    logErr("compaction: summary generation returned empty content, fresh_window rollover");
  }

  const generation = run.compactionGeneration + 1;
  appendCompactionRow(run.sessionId, {
    seq: run.jsonlSeq,
    summary,
    tokensBefore,
    throughSeq: run.jsonlSeq - 1,
    createdAt: new Date().toISOString(),
    details: {
      generation,
      strategy: summarized ? "summary" : "fresh_window",
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

/** 逐请求缓存 miss 统计（判定口径参考 Claude Code /usage 的 cache miss 概念：
 *  单次请求重处理 ≥2,000 token 且 ≥ 当前 prompt 的 5% 记一次 miss）。
 *  冷启动首轮（会话第一个带 usage 的请求）是预期写入、compaction 检查点后的
 *  首个请求是预期重建（摘要前缀必然重排），均不计 miss、重建另计。
 *  近似限制：转录无法区分「进程重启后恢复会话的首轮」与「压缩后首轮」，
 *  若恰在检查点之后会被记为一次重建——最多差一轮，换取零新增持久化。 */
export type CacheMissStats = {
  /** 带 usage 的 assistant 请求数（错误/中止轮不计） */
  requests: number;
  misses: number;
  rebuilds: number;
};

export function sessionCacheMissStats(
  sessionId: string,
  compactionThroughSeq: number | null = null,
): CacheMissStats {
  const stats: CacheMissStats = { requests: 0, misses: 0, rebuilds: 0 };
  let rebuildCounted = false;
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
    stats.requests += 1;
    // 冷启动首轮：还没有「本应命中」的前缀
    if (stats.requests === 1) continue;
    if (
      compactionThroughSeq !== null &&
      !rebuildCounted &&
      row.seq > compactionThroughSeq
    ) {
      rebuildCounted = true;
      stats.rebuilds += 1;
      continue;
    }
    const input = usage.input ?? 0;
    const promptTotal =
      input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    if (input >= 2000 && input >= promptTotal * 0.05) stats.misses += 1;
  }
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
