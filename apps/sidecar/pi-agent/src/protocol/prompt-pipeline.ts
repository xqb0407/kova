/**
 * prompt 管线：排队判定 → 每线程串行链 → 单个 turn 的完整生命周期。
 *
 * - dispatchPrompt：prompt 入口。排队判定后沿所属线程的串行链执行（prompt
 *   长任务不占 mgmtQueue，只有会话准备段经 enqueueMgmt 串行）。
 * - runPromptTurn：单 turn 执行——会话准备、阈值/溢出压缩、UserPromptSubmit
 *   钩子、附件装配、委派收敛循环、finish/steered 补发。
 * - steerIntoActiveRun：并入当前轮（agent.steer），steered 流挂起 finish。
 * - abortRun：中止单线程 run 的全部在飞内容（父代理/子代理/审批/提问/压缩）。
 * - mgmtResolveSession：自动化 runner 经管理队列预建会话。
 */
import { logAt, logErr } from "../log";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { CAPABILITY_REMINDER_PREFIX, type ErrorPayload } from "pi-protocol";
import { classifyAgentError, toWireError } from "../agent/agent-errors";
import {
  contextInfo,
  microcompactMessages,
  needsCompaction,
  runCompaction,
  type CompactionOutcome,
} from "../agent/context";
import {
  buildHookPayload,
  fireHookEvent,
  runHooks,
  runHooksCollect,
  type HookDecision,
} from "../agent/hooks";
import {
  armBgTasksIdle,
  refreshBgTasks,
  touchBgTasksIdle,
} from "../tools/bg-tasks";

import {
  emptyTurnPlan,
  getCapabilityRegistry,
  reminderMessages,
  renderReminders,
  type TurnSnapshot,
} from "../agent/assembly";
import {
  clearPendingToolApprovals,
  drainPromptUpdates,
  queuePromptUpdates,
  refreshGoalToolset,
  renderPromptUpdate,
  syncRunPrompt,
} from "../agent/modes";
import { syncGoalOnUserPrompt } from "../goal/goal";
import { emitPlanningState } from "../agent/modes";
import { cancelPendingMcpApprovals } from "../mcp/mcp-tools";
import { cancelPendingMcpElicitations } from "../mcp/elicitation";
import { cancelPendingMcpTasks } from "../mcp/mcp-tasks";
import { activeMcpServers } from "../mcp/mcp-config";
import { cancelPendingQuestions } from "../tools/question-tools";
import { noticeAppendedText, preparePromptAttachments } from "./prompt-attachments";
import { environmentTurnLine, localDateString } from "../tools/tools";
import {
  send,
  sendChunk,
  sendErrorChunk,
  sendEventChunk,
  setActiveReqId,
  beginRun,
} from "./stream";
import { emitThreadEvent } from "./thread-events";
import { withEventSeq } from "./event-seq";
import {
  broadcastQueueState,
  cancelAllEntries,
  enqueueTurn,
  isQueuePaused,
  isTurnBusy,
  markTurnEnd,
  markTurnStart,
  pauseQueue,
  PROMPT_QUEUE_LIMIT,
  queueSnapshot,
  shouldQueue,
  takeFrontEntry,
} from "../sessions/prompt-queue";
import {
  isModelUnavailable,
  noteActiveTurn,
  rebindRunThread,
  resolveSession,
  running,
  sanitizeRemoteTargetInput,
  whenThreadIdle,
} from "../sessions/sessions";
import {
  appendTurnTimingRow,
  persist,
  removeTranscriptRow,
  STEER_PREFIX,
} from "../sessions/transcript";
import {
  knowledgeRefsRecord,
  libraryRootGet,
  sessionTouch,
} from "../storage/hostdb";
import { delegationResumeText, runningDelegations } from "../subagent/subagent";
import { enqueueMgmt } from "./mgmt-queue";
import type { Running, SteerEntry } from "../types";

/** 用户显式 :library 引用的隐藏块行：`[资料库笔记] rel → \`abs\``（含路径） */
const USER_LIBRARY_REF_RE =
  /^\[资料库(?:笔记|文件)\] (.+?) → (?:`([^`]+)`|"([^"]+)")/u;

/** 显式引用也计入「被 N 个任务引用」：不依赖 agent 是否真的 kb_read。
 *  scope 从引用自带的绝对路径反推：资料库换过位置后，旧根的引用仍归旧根，
 *  不会被记到新根同名 rel 上。 */
function recordUserLibraryRefs(sessionId: string, text: string): void {
  if (!sessionId || !text.includes("[[library-refs")) return;
  const refs = new Map<string, { rel: string; root: string }>();
  for (const line of text.split("\n")) {
    const match = USER_LIBRARY_REF_RE.exec(line.trim());
    if (!match?.[1]) continue;
    const rel = match[1].trim();
    const abs = (match[2] ?? match[3] ?? "").trim();
    // abs 末段就是 rel：按路径自身分隔符匹配，兼容 Windows 反斜杠
    const tail = abs.includes("\\") ? rel.replace(/\//g, "\\") : rel;
    const root =
      abs && abs.endsWith(tail)
        ? abs.slice(0, abs.length - tail.length).replace(/[\\/]+$/u, "")
        : "";
    refs.set(`${root}\u0000${rel}`, { rel, root });
  }
  if (refs.size === 0) return;
  void (async () => {
    try {
      // 只有反推不出根的引用才需要向宿主问当前根（常见路径零 RPC）
      let currentRoot = "";
      if ([...refs.values()].some((ref) => !ref.root)) {
        try {
          currentRoot = (await libraryRootGet()).root ?? "";
        } catch {
          /* 根查询失败：仅记录能反推出根的那些引用 */
        }
      }
      for (const { rel, root } of refs.values()) {
        const scopeId = root || currentRoot;
        if (!scopeId) continue;
        await knowledgeRefsRecord({
          sessionId,
          source: "library",
          scopeId,
          path: rel,
        });
      }
    } catch {
      /* 统计失败不影响发送 */
    }
  })();
}

/** data-compaction 完成态载荷（同 id 的 start/complete/failed 生命周期见 dispatchPrompt） */
function compactionChunkData(outcome: {
  generation: number;
  tokensBefore: number;
  summarized: boolean;
}) {
  return {
    phase: "complete",
    generation: outcome.generation,
    tokensBefore: outcome.tokensBefore,
    summarized: outcome.summarized,
  };
}

/**
 * 取走本轮能力排队的提醒，转成下一次模型请求前的 user 消息。
 * 只在 prepareNextTurnWithContext 里调用——最终轮不会走到这里，提醒随轮末丢弃。
 */
function takeCapabilityReminders(run: Running): AgentMessage[] {
  return reminderMessages(run.capabilityReminders?.splice(0) ?? []);
}

/** §7 context_changed 推送：轮收尾与轮间压缩后共用（桌面占用环镜像直更）。
 *  同时发契约 context_usage 事件（react-pi 迁移阶段 3）：reducer 的
 *  state.contextUsage / metadata.contextUsage 由它驱动。 */
function pushContextChanged(run: Running): void {
  if (!run.sessionId) return;
  const info = contextInfo(run);
  send(
    withEventSeq(run.sessionId, {
      type: "context_changed" as const,
      sessionId: run.sessionId,
      usedTokens: info.usedTokens,
      threshold: info.hardLimit,
      contextWindow: info.contextWindow,
      cacheHitRatio: info.cacheHitRate,
    }),
  );
  emitThreadEvent(run.sessionId, {
    type: "context_usage",
    contextUsage: {
      tokens: info.usedTokens,
      contextWindow: info.contextWindow,
      percent:
        info.contextWindow > 0
          ? Math.round((info.usedTokens / info.contextWindow) * 100)
          : null,
    },
  });
}

/** 轮间自动压缩钩子（Claude Code 式）：core 循环在每轮工具结果落位后、下一次
 *  模型请求前调用 prepareNextTurn（vendor 注释明言该缝为 compaction 预留）。
 *  占用越线就地压缩：复用边界压缩同一条 runCompaction（checkpoint 落盘、state
 *  重写为摘要头），返回替换上下文让下一轮请求直接以摘要继续——长任务不再等整
 *  轮结束或溢出兜底。压缩失败不阻塞本轮（溢出有恢复路径兜底）。notify 转发
 *  start/complete/failed 生命周期（runPromptTurn 接 data-compaction part 与
 *  context_changed 推送，钩子本体不碰传输层，保持可单测）。 */
export type MidTurnCompactionHook = NonNullable<Agent["prepareNextTurnWithContext"]>;

/* ---------------------- 截断错误自愈增强 ---------------------- */

/** pi-agent-core 对「输出撞 maxTokens 截断」的工具调用统一标记的文案关键短语
 *  （agent-loop.js failTruncatedToolCalls；跨包耦合只认短语，升级时同步） */
const TRUNCATED_TOOL_CALL_MARKER = "hit the output token limit";

/** 宿主 RPC 侧的失败信号（storage/hostdb/transport.ts）：整份 payload 的读写往返
 *  超时或中止，与截断同属「这次调用太大」。**以前只认截断文案，这类失败拿不到
 *  任何指引，模型只会原样重发同一个大 write → 一直失败、看起来没有自愈。**
 *  超时文案含 "host_query timeout:"，中止文案以 "Operation aborted" 开头。 */
const HOST_RPC_FAILURE_MARKERS = ["host_query timeout:", "Operation aborted"];

/** 需要「拆开写」指引的工具调用错误：输出截断 或 宿主 RPC 往返失败 */
const isOversizedCallError = (text: string): boolean =>
  text.includes(TRUNCATED_TOOL_CALL_MARKER) ||
  HOST_RPC_FAILURE_MARKERS.some((m) => text.includes(m));

const TRUNCATED_TOOL_CALL_HINT =
  "\n\nHint: do NOT simply re-issue the same oversized call — it will fail the same way. " +
  "For write, split the file into parts: write the first part with mode \"overwrite\", then " +
  "append the rest with mode \"append\" (or edit calls matching the file's current tail). " +
  "For .json files write a valid skeleton first, then extend it with edit — append cannot keep JSON valid. " +
  "Keep each response small.";

/** 超大调用自愈增强：输出撞限（core 标记）或宿主 RPC 往返失败（超时/中止）的
 *  toolCall，原错误文案只让模型「重发完整参数」——同一个大 write 重发还会照样
 *  失败，弱模型会原地打转。在下一轮请求前就地给这类错误 toolResult 附加拆分写入
 *  指引。只改内存上下文（转录已按原文案落盘，历史保真；自愈指引只需紧接的下一轮
 *  生效，刷新重建后消失无妨）。幂等：按 hint 特征短语防重复追加。 */
export function augmentTruncatedToolCallErrors(messages: unknown[]): void {
  for (const m of messages) {
    const msg = m as { role?: string; isError?: boolean; content?: unknown };
    if (!msg || msg.role !== "toolResult" || !msg.isError || !Array.isArray(msg.content)) continue;
    for (const c of msg.content) {
      const block = c as { type?: string; text?: string };
      if (
        block.type === "text" &&
        typeof block.text === "string" &&
        isOversizedCallError(block.text) &&
        !block.text.includes("do NOT simply re-issue")
      ) {
        block.text += TRUNCATED_TOOL_CALL_HINT;
      }
    }
  }
}

/* ---------------------- 重复失败调用硬闸 ---------------------- */

/** 同一 (tool, 参数) 连续失败达到该次数：追加终止性指引，阻止模型原地重试 */
const REPEAT_FAILURE_THRESHOLD = 3;

/** 幂等标记（同时是追加文案的固定短语） */
const REPEATED_FAILURE_MARKER = `has failed ${REPEAT_FAILURE_THRESHOLD} consecutive times`;

const REPEATED_FAILURE_HINT =
  `\n\nThis exact call ${REPEATED_FAILURE_MARKER}. Do NOT retry it unchanged — ` +
  "change the arguments or the approach (re-read the file, split the task, fix the " +
  "root cause the error points at), or report the blocker to the user instead of looping.";

/** 工具调用参数的签名文本：对象 JSON 序列化、字符串原样（判"同一调用"用） */
function toolArgsText(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === undefined) return "";
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return String(args);
  }
}

/** 从 assistant 消息收集 toolCallId → "tool|args" 签名（toolResult 上只有名字，没有参数） */
function collectCallSignatures(messages: unknown[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const c of msg.content) {
      const block = c as { type?: string; id?: unknown; name?: unknown; arguments?: unknown };
      if (!block || block.type !== "toolCall" || typeof block.id !== "string") continue;
      byId.set(block.id, `${String(block.name ?? "tool")}|${toolArgsText(block.arguments)}`);
    }
  }
  return byId;
}

/**
 * 重复失败调用硬闸：同一 (tool, 参数) 连续失败 ≥3 次时，给最后一条错误 toolResult
 * 追加终止性指引。原始错误文案只描述「这次为什么失败」，对「别再原样重试」只字
 * 未提，弱模型会一路重发（实测：同一份大 write 连发 3 次，全靠上一段的截断自愈
 * 才拉回）。与截断自愈同款：只改内存上下文（转录已按原文案落盘，历史保真）、
 * 幂等（按特征短语防重复追加）。链的判定是严格连续的——签名变化、调用成功、
 * 或签名不可判（toolCall 已出窗口）都清零，避免把「有进展的重试」误判成打转。
 */
export function augmentRepeatedFailureCalls(messages: unknown[]): void {
  const signatures = collectCallSignatures(messages);
  let lastSig: string | null = null;
  let count = 0;
  for (const m of messages) {
    const msg = m as {
      role?: string;
      toolCallId?: unknown;
      isError?: boolean;
      content?: unknown;
    };
    if (!msg || msg.role !== "toolResult") continue;
    const sig = typeof msg.toolCallId === "string" ? signatures.get(msg.toolCallId) : undefined;
    if (!sig || !msg.isError) {
      lastSig = null;
      count = 0;
      continue;
    }
    if (sig === lastSig) count += 1;
    else {
      lastSig = sig;
      count = 1;
    }
    if (count < REPEAT_FAILURE_THRESHOLD || !Array.isArray(msg.content)) continue;
    for (const c of msg.content) {
      const block = c as { type?: string; text?: string };
      if (
        block.type === "text" &&
        typeof block.text === "string" &&
        !block.text.includes(REPEATED_FAILURE_MARKER)
      ) {
        block.text += REPEATED_FAILURE_HINT;
      }
    }
  }
}

export function makeMidTurnCompactionHook(
  run: Running,
  notify: (
    phase: "start" | "complete" | "failed",
    outcome?: CompactionOutcome,
  ) => void,
  /** 测试注入假摘要实现；生产缺省走 core generateSummary */
  opts?: { summarize?: import("../agent/context").SummarizeFn },
): MidTurnCompactionHook {
  return async (_lastTurn, signal) => {
    // 截断/重复失败增强先行（即使不触发压缩也要做）：就地改 state.messages，
    // 压缩若触发则其 slice() 快照自然带上增强后的文本
    augmentTruncatedToolCallErrors(run.agent.state.messages);
    augmentRepeatedFailureCalls(run.agent.state.messages);
    if (run.stopRequested || signal?.aborted) return undefined;
    // 轻清理先行（90% 触发）：清旧工具结果可能直接把占用拉回阈值下，省一次
    // 全量压缩；叙事（用户/助手轮）全保，压缩后"只剩转述"的失忆窗口推迟出现。
    // 元素对象跨数组共享，原地改 content 对活循环立即生效，无需换 context。
    const micro = microcompactMessages(
      run.agent.state.messages,
      run.agent.state.model ?? undefined,
    );
    if (micro.cleared > 0) {
      logAt(
        "event",
        `microcompact: cleared ${micro.cleared} old tool results (-${micro.tokensSaved} est. tokens) -> ${run.sessionId}`,
      );
    }
    if (!needsCompaction(run)) return undefined;
    notify("start");
    logAt("event", `mid-turn compaction: threshold crossed -> ${run.sessionId}`);
    const outcome = await runCompaction(run, "threshold", opts);
    if (!outcome.ok) {
      if (!run.stopRequested) logErr("mid-turn compaction failed:", outcome.message);
      notify("failed");
      return undefined;
    }
    notify("complete", outcome);
    // 0.99 迁移：AgentContext 无 systemPrompt 字段（提示词由 messages 首条
    // system 消息承载，runCompaction 已保留头部），直接回传 state 快照
    return {
      context: {
        messages: run.agent.state.messages.slice(),
        tools: (run.agent.state.tools ?? []).slice(),
      },
    };
  };
}

/** prompt turn 串行链：每线程一条（队列按线程隔离，不同线程并行跑 turn）。
 *  每节 = 一个 turn 的完整生命周期（会话准备 → runStepWithRecovery →
 *  委派收敛循环 → finally finish），跑完才放行该线程下一节 */
const promptChains = new Map<string, Promise<void>>();

/** 线程是否有未走完的串行链节（queue_pop 判断"空闲且无链节"用） */
export function hasPromptChain(threadId: string): boolean {
  return promptChains.has(threadId);
}

/** "Agent is already processing a prompt" 兜底识别（pi-agent-core 守卫文案） */
function isAlreadyProcessingError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return text.includes("Agent is already processing");
}

/** Stop 钩子要求继续工作的最大次数（每轮）：防钩子 block 死循环 */
const MAX_STOP_HOOK_CONTINUES = 3;

/** turn 结算结果（onOutcome 回传给调用方；错误以 chunk 下发、不抛出，
 *  无人值守 runner 需要程序化判定成败时经此回调观察） */
export type PromptTurnOutcome = { ok: boolean; errorText?: string };

/** 并入当前轮（steer）：把消息注入活跃 run（agent.steer），本请求走退化流
 *  start 后**挂起**——finish 不立即发：AI SDK 的 status 是单槽，流提前结束会把
 *  整个会话置回 ready（正在跑的宿主轮在 UI 上显示为已停止、Stop 因
 *  activeResponse 被清空而失灵）。finish 挂到宿主轮收尾时补发
 *  （pendingSteeredFinishes），届时线程真正空闲，无副作用。
 *
 *  投递保证两半（pi-core 只在模型调用边界消费 steering 队列，
 *  agent-loop.js runLoop；注入≠回应，历史事故「并入后一直不回复」）：
 *  - 入队后就地结算挂起的工具审批/提问/MCP 审批（abortRun 同款三件套，无挂起
 *    时幂等 no-op）：循环阻塞在这些交互上时边界永不到来，解阻塞让循环抵达边界
 *    消费注入（取消语义「用户发起了新消息」与并入一致）；
 *  - 登记进 run.steerEntries：轮末若本轮始终没对注入给出回应（边界前被中止等），
 *    findUnansweredSteers + runTurnBody finally 把它回队重发，绝不静默丢消息。
 *  返回 false（无活跃 run / 正在收尾 / steer 抛错）由调用方落回普通排队。 */
export async function steerIntoActiveRun(
  run: Running,
  reqId: string,
  msg: Record<string, unknown>,
): Promise<boolean> {
  // turnEnding：收尾段（finally）已开跑，挂起 finish 的补发已执行过——此刻
  // 受理的并入其 finish 永远没人补发（前端「已并入」徽标滞留不消失）
  if (run.stopRequested || run.turnEnding) return false;
  try {
    // 与普通 prompt 同一条附件链路：超限图先归一化到当前模型的
    // inputLimits.images.resize/内联闸门，拒收项折算说明行、合法项进 user
    // 消息 content。哨兵前缀：注入即真实 user 消息落转录，投影层（直播与
    // 快照直出同一出口）剥前缀并补「已并入当前回复」标记 part（刷新前后
    // 语义一致；模型侧前缀自解释，auto-continue 同款先例）
    const attachments = await preparePromptAttachments(msg, {
      cwd: run.cwd,
      model: run.agent.state.model,
    });
    // 图片归一化可能解码 1-2 秒；等完再看一眼轮状态——收尾已经开始的注入
    // 不能再塞给 agent（finish 已补发、steer 会滞留到下一轮），返回 false
    // 让调用方落回普通排队路径。
    if (run.stopRequested || run.turnEnding) return false;
    // 并入当前轮与普通发送在「这条消息和目标什么关系」上必须是同一套判据：
    // 用户插话就是在接管，目标该让位。少了这一句，steer 是唯一能绕过
    // 「用户输入即接管」的入口，循环会在用户已经开口之后继续自己往下跑
    syncGoalOnUserPrompt(run, String(msg.text ?? ""));
    recordUserLibraryRefs(run.sessionId, String(msg.text ?? ""));
    const text = STEER_PREFIX + noticeAppendedText(String(msg.text ?? ""), attachments.noticeLines);
    const content: string | (ImageContent | { type: "text"; text: string })[] =
      attachments.images.length
        ? [{ type: "text", text }, ...attachments.images]
        : text;
    const userMsg = { role: "user" as const, content, timestamp: Date.now() };
    run.agent.steer(userMsg);
    if (attachments.images.length) {
      logAt(
        "event",
        `prompt steer: ${attachments.images.length} image(s) -> ${run.sessionId}`,
      );
    }
    // 解边界阻塞（注入之后、边界抵达之前完成结算）：提问/审批挂起时循环永远
    // 走不到模型调用边界，注入会一直滞留在 agent 内部队列。先入队再解阻塞，
    // 边界一到即消费。
    clearPendingToolApprovals(run);
    cancelPendingQuestions(run.threadId);
    cancelPendingMcpApprovals(run.threadId);
    cancelPendingMcpElicitations(run.threadId);
    void cancelPendingMcpTasks(run.threadId);
    // 回收记账（findUnansweredSteers）：本轮收尾时仍未获回应的注入自动回队
    (run.steerEntries ??= []).push({
      reqId,
      msg,
      message: userMsg,
      gen: run.compactionGeneration,
    });
    sendChunk(reqId, { type: "start" });
    // finish 不发：登记后随宿主轮收尾补发（见 runPromptTurn finally）
    let pending = pendingSteeredFinishes.get(run.threadId);
    if (!pending) {
      pending = new Set();
      pendingSteeredFinishes.set(run.threadId, pending);
    }
    pending.add(reqId);
    return true;
  } catch {
    return false;
  }
}

/** 撤回一条未获回应的注入消息（内存上下文 + 转录行），返回是否真的撤到了
 *  什么。内存侧按对象身份定位（与 findUnansweredSteers 同款），转录侧按
 *  persist 登记的 seq（SteerEntry.seq）：行没落盘（边界未抵达就中止）时只做
 *  内存侧（此时它还在 steering 队列里，findUnansweredSteers 已 drain 清出）。 */
function withdrawInjectedSteer(run: Running, entry: SteerEntry): boolean {
  let withdrew = false;
  const messages = run.agent.state.messages as unknown[];
  const index = messages.indexOf(entry.message);
  if (index >= 0) {
    messages.splice(index, 1);
    // 该行此前已随 persist 入账（persistedSeq 是按 state.messages 下标记账的
    // 「已落盘前缀长度」）：从中间摘一条，长度与下标记账同步收缩 1，
    // 否则后续 persist 会跳过下一条未落盘的消息（漏写转录）
    if (run.persistedSeq > index) run.persistedSeq -= 1;
    withdrew = true;
  }
  if (entry.seq !== undefined) {
    try {
      if (removeTranscriptRow(run.sessionId, entry.seq) > 0) {
        withdrew = true;
        // 索引计数负增量（与 truncate_session 同款）：消息行少了一条
        void sessionTouch(run.sessionId, "", "", -1).catch(() => {});
      }
    } catch (err) {
      // 撤行失败不阻断回收：气泡多留一条，但消息绝不丢（回队重发优先）
      logErr("steer withdraw: transcript row removal failed:", err);
    }
  }
  if (withdrew && run.sessionId) {
    // 转录被就地改写，得让前端重拉快照（本轮 finish 触发的刷新可能早于这次改写，
    // 只靠它会把已撤回的气泡留在屏上）。entry_appended 非 custom 变体在桌面端
    // 走 needsSnapshotRefresh → refreshInBackground，是既有的「快照对账」钩子。
    emitThreadEvent(run.sessionId, {
      type: "entry_appended",
      entry: { type: "steer_withdrawn", reqId: entry.reqId },
    });
  }
  return withdrew;
}

/** 并入回收检测：本轮注入的 steer 条目里「始终没被回应」的部分。
 *  - 仍滞留 agent 内部 steering 队列（边界从未抵达）：drain 清出防泄漏到下一轮，
 *    回收；
 *  - 已进转录（按注入消息对象的身份判定）但其后没有任何有内容的 assistant
 *    消息（注入点被中止、模型从未轮到回应）：回收；
 *  - 队列没有、转录也找不到本体：轮间压缩重写过 state.messages（注入已被消费、
 *    折进摘要）——代数变过则不回收；代数没变说明消息凭空缺席，按未回应回收。
 *  纯检测无副作用（drain 除外），回收方把条目回队由既有队列派发链重发。 */
export function findUnansweredSteers(run: Running): SteerEntry[] {
  const entries = run.steerEntries;
  if (!entries || entries.length === 0) return [];
  // steeringQueue 在 Agent 类型上是私有字段（无公开全量读取：peek/drain 受
  // one-at-a-time 模式限制只看队首，多条并入会漏检）。运行时是普通属性，
  // 窄转型快照全体滞留项并清空——pi-core 轮末从不清残队（abort/prompt 都
  // 不动它），不清会漏投到下一轮边界，与回收重发形成双份投递。
  const steering = (run.agent as unknown as {
    steeringQueue: { messages: unknown[]; clear(): void };
  }).steeringQueue;
  const stranded = new Set<unknown>(steering.messages);
  steering.clear();
  const messages = run.agent.state.messages;
  const out: SteerEntry[] = [];
  for (const e of entries) {
    if (stranded.has(e.message)) {
      out.push(e);
      continue;
    }
    const idx = (messages as unknown[]).indexOf(e.message);
    if (idx >= 0) {
      const answered = (messages as { role?: string; content?: unknown[] }[])
        .slice(idx + 1)
        .some(
          (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.length > 0,
        );
      if (!answered) out.push(e);
      continue;
    }
    if (run.compactionGeneration === e.gen) out.push(e);
  }
  return out;
}

/** 并入当前轮（steer）的退化流：threadId -> 已注入、待宿主轮收尾时补发 finish
 *  的请求 id。steered 流提前 finish 会把框架共享的 status 置回 ready（见
 *  steerIntoActiveRun 注释），故挂起到宿主轮真正结束 */
const pendingSteeredFinishes = new Map<string, Set<string>>();

/** prompt 入口：排队判定后沿所属线程的串行链执行（prompt 长任务依旧不占 mgmtQueue） */
export async function dispatchPrompt(
  reqId: string,
  msg: Record<string, unknown>,
  onOutcome?: (outcome: PromptTurnOutcome) => void,
) {
  const threadId = String(msg.threadId ?? "default");

  // 本线程上一轮未结束（或本线程队列非空）→ 进该线程 FIFO 队列，前端经
  // data-queue-state 快照渲染排队条。其他线程忙与本线程无关（并行跑各自的 turn）。
  // 例外：本线程活跃 turn 已被 Stop 中止、正在收尾（stopRequested 置位到链节
  // finally 之间）不算「真忙」——此刻到达的新 prompt 不进队列，直接沿链等收尾
  // 后执行。否则会出现「刚点了停止、新消息却显示排队中」，且用户再点一次 Stop
  // 会把它连带取消（不执行）。串行性由线程链保证，顺序与排队完全一致，只是不渲染排队条。
  const activeRun = running.get(threadId);
  const activeStopping = isTurnBusy(threadId) && activeRun?.stopRequested === true;
  const wasQueued = shouldQueue(threadId) && !activeStopping;
  // 并入当前轮（steer）：线程忙且显式标记时注入活跃轮，本请求退化流收尾；
  // 任何落空（空闲/收尾中/注入失败）落回下面的普通排队路径
  if (wasQueued && msg.steer === true && activeRun) {
    if (await steerIntoActiveRun(activeRun, reqId, msg)) return;
  }
  if (wasQueued) {
    // 诊断：排队的真实原因（busy 位 / 队列残留），排查「看起来结束了却排队」
    logAt(
      "event",
      `prompt queued: thread=${threadId} busy=${isTurnBusy(threadId)} queueLen=${queueSnapshot(threadId).length} stopping=${activeStopping} prevStopRequested=${activeRun?.stopRequested === true}`,
    );
    const enqueued = enqueueTurn(reqId, threadId, msg);
    if (!enqueued.ok) {
      sendErrorChunk(
        reqId,
        `排队消息过多（上限 ${PROMPT_QUEUE_LIMIT} 条），请等当前对话完成后再发`,
        { code: "QUEUE_LIMIT", source: "runtime", retryable: true },
      );
      return;
    }
  }

  // 沿线程链排队：前面每个 turn 完整跑完（含 finish 收尾）才轮到本节。
  // 链节是可互换的工人槽，开跑时取该线程当前队首（queue_promote 重排后顺序依然正确）
  return runChainSlot(threadId, reqId, msg, wasQueued, onOutcome);
}

/**
 * 串行链工人槽（dispatchPrompt 与队列恢复接力 kickQueueDrain 共用）：
 * 挂到该线程链尾，接棒后——wasQueued 时取当前队首执行（顺序与队列一致，
 * 取不到=已被取消/被别的槽消费，静默让位），否则直接执行自带 prompt。
 * 暂停位检查点在接棒后：排队槽见暂停位即让位（冻结自动派发），队列项
 * 留在引擎，恢复由 kickQueueDrain 补槽接棒。
 */
async function runChainSlot(
  threadId: string,
  reqId: string,
  msg: Record<string, unknown>,
  wasQueued: boolean,
  onOutcome?: (outcome: PromptTurnOutcome) => void,
): Promise<void> {
  const tail = promptChains.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const node = new Promise<void>((r) => (release = r));
  promptChains.set(threadId, node);
  await tail;
  // 链节真正接棒开跑的时刻：排队项前面所有轮都收尾后才取，与用户看到的
  // 「这一轮开始」一致；作为 turn_timing 行的 startedAt 下发。
  const turnStartedAt = Date.now();
  markTurnStart(threadId);
  try {
    // 队列暂停（v3.1）：排队链节接棒后检查暂停位——冻结「自动派发」，
    // 当前轮自然跑完后不再开下一轮。链节静默让位（finally 统一收尾：
    // markTurnEnd/release/链尾清理），队列项留在引擎；恢复后由原生接力
    // （kickQueueDrain 补槽）接棒。直接发送（线程空闲不排队）不受暂停
    // 影响：暂停只冻结排队项的出队
    if (wasQueued && isQueuePaused(threadId)) return;
    let turnReqId = reqId;
    let turnMsg = msg;
    if (wasQueued) {
      const next = takeFrontEntry(threadId);
      // 本项已被取消（取消时流已收尾）或队列已空：静默让位。
      // 派发出队无 per-item chunk：前端由 data-queue-state 快照中条目消失
      // 驱动消息回填（见 pi-queue.ts 三条同步规则）。
      // 先建立新请求的事件路由再广播快照——上一轮流收尾时路由已清空，
      // 不先 setActiveReqId 的话出队快照会被静默丢弃
      if (!next) return;
      turnReqId = next.reqId;
      turnMsg = next.msg;
      setActiveReqId(threadId, turnReqId);
      broadcastQueueState(threadId);
    }
    // 通报 sessions：LRU 驱逐不得动正在跑 turn 的会话；
    // sessionId/requestId 取自实际开跑的 turn（排队换位后是队首消息）
    noteActiveTurn(
      threadId,
      true,
      typeof turnMsg.sessionId === "string" ? turnMsg.sessionId : undefined,
      turnReqId,
    );
    // onOutcome 属于本次调用的链节；自动化线程每次运行新建（键唯一），
    // 不会与他人共用队列，闭包语义安全
    await runPromptTurn(
      turnReqId,
      turnMsg,
      threadId,
      onOutcome,
      turnStartedAt,
    );
  } finally {
    noteActiveTurn(threadId, false);
    // 缓存保活换相：streaming 模式就此停止，idle 模式继续暖到 30 分钟上限
    running.get(threadId)?.cacheWarmer?.onAgentSettled();
    markTurnEnd(threadId);
    // §7 上下文读数推送：轮收尾即现算下发（桌面占用环镜像直更，免拉取）。
    // 只认该线程仍驻留的 run——resolveSession 失败的轮没有 run，天然不推；
    // 盖事件水印（session_state 同款），桌面漏帧回拉 context_info。
    const endedRun = running.get(threadId);
    if (endedRun?.sessionId) {
      pushContextChanged(endedRun);
    }
    release();
    // 本节是链尾（map 里没有更晚注册的槽位）：摘掉链条目。队列非空也要摘
    // ——steer 回收（enqueueTurn force）等不经 dispatchPrompt 的入队没有
    // 配套槽位，残留的已完结链节会让 hasPromptChain 永久顶住 queue_pop，
    // 回收项永远没人派发。有后续槽位时 map 里是那个槽位的节点，不相等，
    // 不会误删。暂停让位同理：恢复由 kickQueueDrain 补槽。
    if (promptChains.get(threadId) === node) {
      promptChains.delete(threadId);
    }
  }
}

/**
 * 队列恢复的原生接力（v3.1）：为暂停中的排队项补链节（工人槽）。
 * queue_resume / queue_promote 的隐式恢复调用——槽位按当时队列长度补足，
 * 接棒后逐个取队首执行，派发顺序与队列一致；条目被取消/再次暂停时槽位
 * 静默让位，多余槽位无害（取到 null 即让位）。不重复入队：条目本就在
 * 队列，槽位只负责取队首。
 *
 * 为什么不走前端接力泵（queue_pop → resend）：重发的 prompt 到达时队列
 * 若还有后续条目，shouldQueue 判真把它**再次入队到队尾**——多元素队列
 * 顺序翻转，且重发槽跑完后续条目后链尾因队列非空不清理，残留链节把
 * hasPromptChain 永久顶住、泵弹不出剩余项（探针实测坐实）。原生槽用
 * 原始 reqId 直派，前端 inflight 还挂着（暂停不重启），start/finish/内容
 * 帧照常到达，与正常 autoDrain 完全同通道。重启孤儿队列（流已死）仍走
 * 泵——链节在场时泵被 hasPromptChain 守卫拦住，两条路互不干扰。
 */
export function kickQueueDrain(threadId: string): Promise<void[]> {
  const slots = queueSnapshot(threadId).length;
  if (slots === 0) return Promise.resolve([]);
  const pending: Promise<void>[] = [];
  for (let i = 0; i < slots; i++) {
    pending.push(runChainSlot(threadId, "", {}, true));
  }
  // 槽位自身不该 reject（runPromptTurn 内部已归因收尾，finally 保证链节
  // 收尾）；兜一层防 handler 侧 void 调用触发 unhandled rejection
  return Promise.all(pending).catch((err) => {
    logErr(
      "kickQueueDrain slot crashed:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  });
}

/** 轮工时收尾：写一条 turn_timing 行（每轮最多一次）。
 *  必须在 sendChunk(finish) 之前调用——finish 帧会触发前端强制拉快照，
 *  晚写这一行的话快照里没有权威耗时，摘要行又会退回本地推导。
 *  没有锚点（会话解析失败、无用户行的自动化轮）或已经写过时静默跳过。 */
function finalizeTurnTiming(run: Running | undefined): void {
  if (!run || run.turnTimingWritten) return;
  if (run.turnStartedAt === undefined || run.turnAnchorSeq === undefined) return;
  run.turnTimingWritten = true;
  try {
    appendTurnTimingRow(run.sessionId, {
      anchorSeq: run.turnAnchorSeq,
      startedAt: run.turnStartedAt,
      // 展示耗时从 AI 首次回复起算；startedAt 仍保留链节派发时刻供审计
      ...(run.turnFirstResponseAt !== undefined
        ? { firstResponseAt: run.turnFirstResponseAt }
        : {}),
      endedAt: Date.now(),
      ...(run.stopRequested ? { interrupted: true } : {}),
    });
  } catch (err) {
    // 落盘失败不阻断收尾：前端仍可用本地时间戳推导，下一轮照常记录
    logErr("turn timing persist failed:", err);
  }
}

/** 单个 prompt turn 的完整执行（原 dispatchPrompt 主体）：会话准备段入管理队列
 *  串行执行，agent.prompt 长任务在队列外运行。
 *
 *  外层是**崩溃隔离层**。内层的 try 只罩住 agent 段，会话准备段（rebindRunThread /
 *  系统提示词重排 / 挂起清理）都在它之前：那几处任何一次同步抛错都会
 *  跳过内层 finally，于是——不发 finish（AI SDK 的 status 永远停在 streaming，Stop 失灵、
 *  线程看着一直忙）、不清 activeReqByThread（下一轮的内容 chunk 全被路由进这条死流）、
 *  不回调 onOutcome（无人值守的 automation runner 永远等下去）。protocol.ts 的兜底
 *  catch 只补了 error chunk，补不了这三条。
 *  这里把逃逸的抛错就地结算：错误 chunk + finish + 清路由 + 回报 onOutcome。 */
async function runPromptTurn(
  reqId: string,
  msg: Record<string, unknown>,
  threadId: string,
  onOutcome: ((outcome: PromptTurnOutcome) => void) | undefined,
  turnStartedAt: number,
) {
  try {
    await runTurnBody(reqId, msg, threadId, onOutcome, turnStartedAt);
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logErr("prompt turn crashed before teardown:", errorText);
    // 崩在 agent 开跑之后：run 可能还挂着活动轮/子代理，一并停掉，否则线程回不到空闲
    const run = running.get(threadId);
    if (run) {
      run.stopRequested = true;
      try {
        run.agent.abort();
      } catch {
        /* 中止本身失败无补救可做：错误已上报，不让它盖掉主因 */
      }
    }
    // 先清路由再发 chunk：activeReqByThread 还指着这条死流的话，finish 会落空
    setActiveReqId(threadId, null);
    finalizeTurnTiming(run);
    sendErrorChunk(reqId, errorText, toWireError(classifyAgentError(err, { opaqueFallback: "runtime" })));
    sendChunk(reqId, { type: "finish" });
    onOutcome?.({ ok: false, errorText });
  }
}

/** turn 主体（收尾由内层 finally 保证，见 runPromptTurn 的隔离层说明） */
async function runTurnBody(
  reqId: string,
  msg: Record<string, unknown>,
  threadId: string,
  onOutcome: ((outcome: PromptTurnOutcome) => void) | undefined,
  turnStartedAt: number,
) {
  // 本轮错误结算文本（与下发前端的 error chunk 同源）；finally 里经 onOutcome 回报
  let turnError: string | undefined;
  const task = enqueueMgmt(() =>
    resolveSession(
      threadId,
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      typeof msg.cwd === "string" ? msg.cwd : undefined,
      // 远程项目绑定：cwd 命中远程项目时前端随 prompt 携带——草稿会话
      // （先开对话、后选远程项目）在这里补绑，避免被 rebind 成假本地会话；
      // 已是远程的 run 有 persistedCwd 守卫，不会被这里覆盖
      sanitizeRemoteTargetInput(msg.remote),
    ),
  );

  let run;
  try {
    run = await task;
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    turnError = errorText;
    // 会话准备段（建会话/读凭据）的抛错都是本地路径：含糊串按运行时归因（§8）
    sendErrorChunk(reqId, errorText, toWireError(classifyAgentError(err, { opaqueFallback: "runtime" })));
    onOutcome?.({ ok: false, errorText });
    return;
  }
  // 任务工作区目录不在这里落盘：解析阶段不建（启动时草稿线程也会解析，那时无物
  // 可写，建了就是空壳目录），轮初同样不建——本轮只聊天、不碰文件的会话不该留痕。
  // 真正落盘推迟到 agent 用到它的时刻（bash 派发前 ensure / 写文件自带），
  // 见 sessions/resolve.ts ensureTaskSessionDir。
  // 线程键漂移（刷新后草稿 id → sessionId）：resolveSession 在旧轮未收尾时
  // 不敢改绑 run.threadId（会把旧轮事件错路由进新请求），这里等旧键轮次
  // 完整结束（含委派收敛与 finish 收尾）后补改绑。不改绑的后果：事件路由按
  // run.threadId 查 activeReqByThread 落空，全部内容 chunk 静默丢弃，只剩
  // 显式 reqId 的 start/finish——前端"没回复却弹完成通知"（2026-09 修复）。
  if (run.threadId !== threadId) {
    await whenThreadIdle(run.threadId);
    await rebindRunThread(run, run.threadId, threadId);
  }
  // 本回合开始：撤销空闲自动停的 pending 定时器（用户回来继续对话了，
  // 自动停顺延到本回合结束后重新计时）。放在改绑之后：台账/定时器此时
  // 都已迁到 threadId 键上，与 finally 的 armBgTasksIdle 同键。
  // 覆盖面：所有轮次入口（用户 prompt / goal loop 经 kickGoalLoop→
  // dispatchPrompt / automation_run / 队列泵重发）都收敛到 runTurnBody，
  // touch/arm 无挂点缺漏；漏挂新入口的回归由 fire 的 isPromptActive 兜底。
  touchBgTasksIdle(threadId);
  // 本轮计时起点（链节接棒时已定）；锚点由 persist 在首条 user 行落盘时捕获。
  // 放在改绑之后：旧键轮次可能仍在使用同一个 run，提前清空会毁掉它的收尾打点。
  run.turnStartedAt = turnStartedAt;
  run.turnFirstResponseAt = undefined;
  run.turnAnchorSeq = undefined;
  run.turnTimingWritten = false;
  // 一个凭据都没有的环境：resolveCurrentModel 补的是 unknown/unknown 占位对象
  // （恒 truthy），旧的 `!model` 判据在这里从不命中，请求会带着假模型打 provider
  // 报出无关错误。占位形状的判定见 isModelUnavailable。
  if (isModelUnavailable(run.agent.state.model)) {
    const errorText =
      "No model with credentials available. Open Settings → Model and add an API key.";
    turnError = errorText;
    sendErrorChunk(reqId, errorText, {
      code: "MODEL_NOT_CONFIGURED",
      source: "runtime",
      retryable: false,
    });
    onOutcome?.({ ok: false, errorText });
    return;
  }
  // 自定义命令的展开**不在这里做**：用户消息以 /name 原文落盘与展示（气泡可读、
  // 编辑重发拿回原文），模型请求时由 Agent.transformContext（resolve.ts 接线）
  // 展开成模板——展示与请求两条路径分离，转录不被模板文本污染。
  // 目标同步：goal 档下「这条用户消息」要么就是新目标（首个目标），要么是对
  // 进行中目标的接管（暂停 + 清零安全 epoch）。必须排在下面那次提示词重排之前——
  // 重排会把目标块写进系统提示词，晚一步这一轮的模型就看不到自己要做的是什么。
  // 取 msg.text 原话而非拼了附件提示行的 promptText：目标原文是用户亲手打的那段，
  // 不该把被拒附件的说明行算进目标。
  syncGoalOnUserPrompt(
    run,
    String(msg.text ?? ""),
    msg.goalMaxAutoTurns,
    msg.goalAcceptanceMode,
    msg.goalMaxDurationMinutes,
  );
  recordUserLibraryRefs(run.sessionId, String(msg.text ?? ""));
  // 目标刚建起来时工具表要跟着换：这一条路径是在 dispatch 过程里建目标的，而
  // state.tools 只在会话物化 / 切模式 / 几个设置项 reload 时重建——不补这一次，
  // 协商轮拿到的仍是上一阶段的表，goal_propose_criteria 不在里面（模型只能空转
  // 到协商计数耗尽）。必须在下面那次提示词重排之前：重排会按新的契约阶段写目标块，
  // 表与块要同源地描述同一轮能做什么
  refreshGoalToolset(run);
  // 回合级能力装配：工具与系统段已在会话级定稿，这里只处理用户提示词前缀、
  // 提醒与钩子快照。装配失败退化为空计划，不阻断本轮。
  const capabilitySnapshot: TurnSnapshot = {
    sessionId: run.sessionId,
    threadId,
    cwd: run.cwd,
    mode: run.mode,
    appMode: run.appMode,
    model: run.agent.state.model ?? null,
    turnId: reqId,
    messages: run.agent.state.messages.slice(),
    userText: String(msg.text ?? ""),
    approvalLevel: run.approvalLevel,
  };
  let turnCapabilities = emptyTurnPlan(capabilitySnapshot);
  try {
    turnCapabilities = await getCapabilityRegistry().assembleTurn(capabilitySnapshot);
  } catch (error) {
    logErr("capabilities: turn assembly failed:", error);
  }
  // 每轮把模式盘面推一次：run 可能被驱逐后按「会话偏好行 ?? 全局 kv」重新物化，
  // 而这两处一旦与前端上次看到的不一致（写入失败/滞后），前端就会一直显示另一档
  // 而没有任何东西来纠正它——「档位自己变了」这类症状就是这么来的。推一次的成本
  // 是一个小 chunk，换来的是任何漂移活不过一轮。无活跃请求时 sendEventChunk 自行丢弃
  emitPlanningState(run);
  // 每轮请求前同步系统提示词：skills / externalDirs / memory / instructions
  // 变化走尾部更新，其余段变化整体重写首条 system。日期不再进 system——首轮与跨天作为隐藏
  // 提醒投递，长会话跨午夜不会因此重写前缀。
  syncRunPrompt(run, run.agent.state.model);
  const today = localDateString();
  if (run.lastEnvDate !== today) {
    queuePromptUpdates(run, [{ key: "environment-date", text: environmentTurnLine() }]);
    run.lastEnvDate = today;
  }
  const promptUpdateTexts = drainPromptUpdates(run).map((update) =>
    renderPromptUpdate(update.key, update.text),
  );
  setActiveReqId(threadId, reqId);
  run.stopRequested = false;
  run.turnEnding = false;
  // promote 的「保留队列」标记只在它触发的那次 abort 里有效；轮首复位，
  // 防 abort 没有落到收尾（agent 不在跑）时标记泄漏到下一次 Stop。
  run.preserveQueueOnStop = false;
  run.discardQueueOnStop = false;
  // 上一次运行的溢出恢复残留（正常应在 runStepWithRecovery 内消费）兜底清理
  run.pendingOverflowRecovery = false;
  // 新一轮重置 provider 重试记账：预算清零、响应捕获清空，
  // data-retry part 换用新 id（同轮内多次尝试同 id 原地更新，见 provider-retry.ts）
  run.providerRetry.rateLimit = 0;
  run.providerRetry.transient = 0;
  run.retryCapture = {};
  run.providerRetryActive = false;
  run.providerRetryChunkId = `retry-${++run.providerRetryTurnSeq}`;
  // 轮初显式清台：上一轮可能给前端 store 留了 retrying 残余（Stop 拆流后
  // resolved 收不到），多窗口/后台轮没有 start/finish 帧可借道，这里每轮发
  // 一次 idle 让所有窗口自愈（与 emitPlanningState 每轮推盘同款成本）
  sendEventChunk(
    threadId,
    { type: "data-retry", id: run.providerRetryChunkId, data: { phase: "idle" } },
    run.sessionId,
  );
  // 长度截断自动续跑预算按轮重置（用户每发一条消息重新给满 MAX_LENGTH_CONTINUES 次）
  run.lengthContinues = 0;
  // autoVerify 验证注入预算同款按轮重置
  run.verifyContinues = 0;
  // Stop 钩子要求继续工作的预算同款按轮重置
  run.stopHookContinues = 0;
  // 逐工具审批（含 plan_exit 确认）/挂起提问/MCP 审批理论上不会跨 turn 遗留
  // （abort 已结算），兜底清理防挂起：新用户输入时未决的 plan_exit 按拒绝结算
  clearPendingToolApprovals(run);
  cancelPendingQuestions(threadId);
  cancelPendingMcpApprovals(threadId);
  cancelPendingMcpElicitations(threadId);
  void cancelPendingMcpTasks(threadId);
  sendChunk(reqId, { type: "start" });

  // 每段 prompt 是消息流里的一个 step；resume 段前重置内容 id，避免与上一段撞 id
  let stepStarted = false;
  // data-compaction 生命周期：start/complete/failed 复用同一个 part id，
  // AI SDK 按 id 就地更新 data part → 前端横幅从「正在压缩」原地变成「压缩完成」
  let compactionSeq = 0;
  const emitCompaction = (id: string, data: Record<string, unknown>) =>
    sendChunk(reqId, { type: "data-compaction", id, data });
  // 轮间压缩挂钩：闭包持有本 turn 的 reqId 流，收尾必须拆除（跨轮残留会把
  // chunk 发错流）。同一次压缩的 start/complete/failed 复用一个 part id 原地更新
  let midTurnCid: string | null = null;
  const compactionHook = makeMidTurnCompactionHook(
    run,
    (phase, outcome) => {
      if (phase === "start") {
        midTurnCid = `cmp-${++compactionSeq}`;
        emitCompaction(midTurnCid, { phase: "start" });
        return;
      }
      if (!midTurnCid) return;
      if (phase === "complete" && outcome?.ok) {
        emitCompaction(midTurnCid, compactionChunkData(outcome));
        pushContextChanged(run);
      } else {
        emitCompaction(midTurnCid, { phase: "failed" });
      }
      midTurnCid = null;
    },
  );
  // 能力收尾提醒的注入点：prepareNextTurnWithContext 只在循环确认继续时调用，
  // 因此最终轮排队的提醒不会残留到下一次用户 prompt（见 stream.ts 的 queueReminder）。
  run.agent.prepareNextTurnWithContext = async (context, signal) => {
    const update = await compactionHook(context, signal);
    const promptUpdates = reminderMessages(
      drainPromptUpdates(run).map((item) => renderPromptUpdate(item.key, item.text)),
    );
    const reminders = [...takeCapabilityReminders(run), ...promptUpdates];
    if (reminders.length === 0) return update;
    return {
      ...(update ?? {}),
      messages: [...(update?.messages ?? []), ...reminders],
    };
  };
  /** 发一轮请求：有尾部更新时把它们作为 leading user 消息插在真实用户消息前。
   *  更新消息带 capability-reminder 哨兵，UI 投影按前缀隐藏；每次重试重建对象，
   *  避免同一份 AgentMessage 被重复 append 到状态里。
   *
   *  兼容性说明：OpenAI Chat 兼容端点接受连续 user 消息（e2e mock 亦覆盖）。
   *  若某个严格端点拒绝，退路是把更新并入真实 user 文本，并在 UI 投影、回显
   *  去重、标题/搜索提取处统一剥掉——那是一次跨端改动，暂不纳入缓存修复。 */
  const promptAgent = async (
    text: string,
    images: ImageContent[],
    updates: readonly string[],
  ) => {
    if (updates.length === 0) {
      await run.agent.prompt(text, images.length ? images : undefined);
      return;
    }
    const userMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text }, ...images],
      timestamp: Date.now(),
    } as AgentMessage;
    await run.agent.prompt([...reminderMessages(updates), userMessage]);
  };

  const runStep = async (text: string, images: ImageContent[], updates: readonly string[] = []) => {
    if (stepStarted) sendChunk(reqId, { type: "finish-step" });
    sendChunk(reqId, { type: "start-step" });
    stepStarted = true;
    // 请求前阈值守卫（PI-Desktop pre-request guard）：上下文（含这条待发文本、
    // 本轮图片，以及同样随请求下发的前置提示词更新）已越过 hardLimit 就先压缩
    // 再发请求；图片/更新不计入的话，接近阈值时会直接越窗走溢出恢复。压缩
    // 失败不阻塞本轮（溢出有恢复路径兜底）
    const guardText = updates.length ? `${text}\n\n${updates.join("\n\n")}` : text;
    if (needsCompaction(run, guardText, images)) {
      // 轻清理先行：已越 hardLimit 时轻清理必然过触发线，先清旧工具结果再复测，
      // 拉回阈值下就省一次全量压缩；仍越线才走全量压缩（叙事保住一部分）
      const micro = microcompactMessages(
        run.agent.state.messages,
        run.agent.state.model ?? undefined,
      );
      if (micro.cleared > 0) {
        logAt(
          "event",
          `microcompact: cleared ${micro.cleared} old tool results (-${micro.tokensSaved} est. tokens) -> ${run.sessionId}`,
        );
      }
    }
    if (needsCompaction(run, guardText, images)) {
      const cid = `cmp-${++compactionSeq}`;
      emitCompaction(cid, { phase: "start" });
      const outcome = await runCompaction(run, "threshold");
      if (outcome.ok) {
        emitCompaction(cid, compactionChunkData(outcome));
      } else {
        // 终止态必发（含 Stop 中止），否则分隔线卡在「正在压缩…」的转圈上
        if (!run.stopRequested) logErr("threshold compaction failed:", outcome.message);
        emitCompaction(cid, { phase: "failed" });
      }
    }
    beginRun(threadId);
    try {
      await promptAgent(text, images, updates);
    } catch (err) {
      // 线程串行链已消除本线程并发 prompt；此处兜底 abort 收尾等极窄竞态窗口。
      // 守卫抛错时尚未产生任何事件，waitForIdle 后原地重试一次是干净的。
      if (!isAlreadyProcessingError(err)) throw err;
      logErr("agent.prompt hit active-run guard, retrying after idle");
      await run.agent.waitForIdle();
      beginRun(threadId);
      await promptAgent(text, images, updates);
    }
  };

  // 溢出恢复：stream.ts 吞掉溢出错误后置位 → 强制压缩后用同一文本重跑一次，
  // 重跑仍溢出不再恢复（直接报错），防循环
  const runStepWithRecovery = async (
    text: string,
    images: ImageContent[],
    updates: readonly string[] = [],
  ) => {
    await runStep(text, images, updates);
    if (!run.pendingOverflowRecovery) return;
    run.pendingOverflowRecovery = false;
    if (run.stopRequested) return;
    // 溢出恢复压缩也走同一条 data-compaction 生命周期（start → complete/failed）
    const cid = `cmp-${++compactionSeq}`;
    emitCompaction(cid, { phase: "start" });
    const outcome = await runCompaction(run, "overflow");
    if (!outcome.ok) {
      // 终止态必发（含 Stop 中止），错误 chunk 仅非 Stop 时发
      emitCompaction(cid, { phase: "failed" });
      if (!run.stopRequested) {
        turnError = `Context overflow, automatic compaction failed: ${outcome.message}`;
        sendErrorChunk(reqId, turnError, {
          code: "CONTEXT_COMPACTION_FAILED",
          source: "runtime",
          retryable: false,
        });
      } else {
        turnError = "run aborted by stop request";
      }
      return;
    }
    emitCompaction(cid, compactionChunkData(outcome));
    // 溢出意味着首次请求确实发出过，更新消息已随上下文进入 state；重试不再
    // 重复投递，避免同一段日期/技能更新在历史里出现两份。
    await runStep(text, images);
    if (run.pendingOverflowRecovery) {
      run.pendingOverflowRecovery = false;
      turnError = "Context overflow persisted after compaction. Start a new session.";
      sendErrorChunk(reqId, turnError, {
        code: "CONTEXT_TOO_LARGE",
        source: "provider",
        retryable: false,
      });
    }
  };

  // Claude Code 式 UserPromptSubmit 钩子：真实用户提交时触发（排队消息在
  // 队首就位后），通知式，v1 不阻塞 prompt。goal 续跑/automation 的注入文本
  // 带 internal 标记，不是用户提交，不触发。
  if (msg.internal !== true) {
    fireHookEvent(
      "UserPromptSubmit",
      buildHookPayload({
        event: "UserPromptSubmit",
        sessionId: run.sessionId,
        threadId,
        prompt: msg.text,
      }),
      { workspace: run.cwd },
    );
  }

  // 附件（用户图片）：超限图先经 image-normalize 缩放/转码；处理不了的拒收项
  // 折算成说明行追加到文本尾部（模型可读、刷新后可见），合法项组装 ImageContent
  // 走 agent.prompt(text, images) 进模型上下文并随 agent 消息本体自动落转录。
  // 溢出恢复/委派收敛的重跑段不携带图片（resume 为纯文本）。
  // 模型能力门在请求侧按元数据收口（pi-ai downgradeUnsupportedImages，补丁已
  // 恢复 user 分支）：附件过物理闸门（prompt-attachments.ts）后进转录进上下文，
  // 目录标为纯文本输入的模型在 transformMessages 阶段把图片换成占位文本；
  // 元数据标成支持图像但端点真拒图的残余由 provider-retry 拒图修复兜底。
  const promptAttachments = await preparePromptAttachments(msg, {
    cwd: run.cwd,
    model: run.agent.state.model,
  });
  // 能力前缀与提醒只进用户消息尾部（系统头必须跨轮字节稳定）；默认无能力时
  // 两个字符串都为空，拼接结果与改造前逐字节相同。
  const promptText = [
    turnCapabilities.userPrefix,
    noticeAppendedText(String(msg.text ?? ""), promptAttachments.noticeLines),
    renderReminders(turnCapabilities.reminders),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (promptAttachments.images.length) {
    logAt(
      "event",
      `prompt attachments: ${promptAttachments.images.length} image(s) -> ${run.sessionId}`,
    );
  }

  // 从这里才挂到 run 上：之前任何提前抛错（附件处理/提示词重排）都不会留下
  // 上一轮的计划；内层 finally 负责清理。
  run.turnCapabilities = turnCapabilities;
  run.capabilityReminders = [];
  try {
    // SessionStart 放在轮次复位之后：钩子执行期间用户点 Stop 能落到 run 上
    // （stopRequested 已归零且 activeReqId 已登记），不会被随后的复位吞掉。
    const sessionStartContext = await fireSessionStartHook(run);
    if (run.stopRequested) return;
    await runStepWithRecovery(
      promptText,
      promptAttachments.images,
      sessionStartContext ? [...promptUpdateTexts, sessionStartContext] : promptUpdateTexts,
    );
    // 整轮循环：委派收敛 → Stop 钩子（block 可要求继续）→ 直到自然结束。
    // 用户 Stop（stopRequested）任何时刻都直接退出。
    for (;;) {
      if (run.stopRequested) break;
      // 后台委派收敛循环（ADR 0089）：turn 结束时若还有运行中的子代理，等它们完成，
      // 把未投递的报告作为恢复 prompt 继续喂给父代理（同一条 reqId 消息流内续跑）。
      while (!run.stopRequested) {
        const pending = runningDelegations(run);
        if (pending.length > 0) {
          await Promise.all(pending.map((d) => d.completion));
          if (run.stopRequested) break;
        }
        const resume = delegationResumeText(run);
        if (!resume) break;
        await runStepWithRecovery(resume, []);
      }
      if (run.stopRequested) break;
      // Claude Code 式 Stop：整轮工作收尾时执行；decision=block 表示「还没完」，
      // 把 reason 作为 follow-up 继续干（有预算，防钩子死循环）。
      // continue:false（stop=true）表示明确结束，不再续跑。
      const stopDecision = await runStopHooks(run);
      if (run.stopRequested) break;
      if (stopDecision?.decision === "block" && !stopDecision.stop) {
        const continues: number = run.stopHookContinues ?? 0;
        if (continues < MAX_STOP_HOOK_CONTINUES) {
          run.stopHookContinues = continues + 1;
          const reason =
            stopDecision.reason?.trim() ||
            "The Stop hook asked you to keep working. Review the task and continue; " +
              "finish only when the work is genuinely complete.";
          logAt("event", `Stop hook requested continuation #${run.stopHookContinues}`);
          // 复用能力提醒哨兵：这是系统给模型的内部指令，不是用户说的话，
          // 历史投影按前缀隐藏，也不参与标题/轮锚点/草稿判定。
          await runStepWithRecovery(
            `${CAPABILITY_REMINDER_PREFIX}<system-reminder>\n${reason}\n</system-reminder>`,
            [],
          );
          continue;
        }
        logErr(
          `Stop hook continuation budget exhausted (${MAX_STOP_HOOK_CONTINUES}); ending turn`,
        );
      }
      break;
    }
  } catch (err) {
    turnError = err instanceof Error ? err.message : String(err);
    sendErrorChunk(reqId, turnError, toWireError(classifyAgentError(err)));
    // 父代理 turn 失败：中止遗留的后台子代理，让会话能回到空闲（D352）
    for (const d of run.delegations.values()) {
      if (d.status === "running") {
        d.stopRequested = true;
        d.abort();
      }
    }
  } finally {
    // 收尾开始即关闭 steer 受理窗口（见 Running.turnEnding）
    run.turnEnding = true;
    // 后台任务状态探测（P1）：模型工作期间自行退出的任务在这里把状态带回来，
    // header 徽标/快速查看不用等下一次 task_output。fire-and-forget，失败静默。
    void refreshBgTasks(threadId).catch(() => {});
    // 回合结束：名下仍有运行中后台任务则臂空闲自动停定时器（见 bg-tasks.ts）
    armBgTasksIdle(threadId);
    // 压缩标志轮界兜底：runCompaction 的 reshape 段（readTranscript/
    // appendCompactionRow 同步 fs）抛异常时 5 个 endCompaction 出口都到不了，
    // 标志会粘在驻留 run 上——快照权威值跟着粘，横幅跨 idle 快照不消失。
    // 压缩只发生在轮内（pre-turn/溢出恢复/轮间），轮界清零恒安全。
    run.compactionActive = false;
    // 拆除轮间压缩挂钩：钩子闭包的 emitCompaction 绑定本 turn 的 reqId
    run.agent.prepareNextTurnWithContext = undefined;
    // 回合级能力快照只服务当前轮；清掉避免下一轮复用旧钩子与旧提醒。
    run.turnCapabilities = undefined;
    run.capabilityReminders = undefined;
    if (stepStarted) sendChunk(reqId, { type: "finish-step" });
    // Stop/promote 中止的 turn：finish 前发 abort 标记——前端据此把残缺回复
    // 结算为「被结束」而非「正常完成」（不弹完成通知）；AI SDK 保留 partial 内容
    if (run.stopRequested) {
      // 「已停止」标记 part：直播随消息渲染分隔线（前端 StoppedDataUI）
      sendChunk(reqId, { type: "data-stopped", id: "stopped", data: {} });
      sendChunk(reqId, { type: "abort" });
    }
    // 权威工时行必须在 finish 之前落盘：finish 帧触发前端强制拉快照，
    // 快照扫描到这一行，历史轮耗时就不再依赖消息 id 推导。
    finalizeTurnTiming(run);
    sendChunk(reqId, { type: "finish" });
    // 补发挂起的 steered 流 finish：宿主轮已真正收尾，此刻结束它们不会误触
    // 框架的 status 回落（线程本来就空闲了）
    const steered = pendingSteeredFinishes.get(threadId);
    if (steered) {
      pendingSteeredFinishes.delete(threadId);
      for (const steeredReqId of steered) {
        sendChunk(steeredReqId, { type: "finish" });
      }
    }
    setActiveReqId(threadId, null);
    persist(run);
    // 并入回收（「并入不丢」保证）：注入后本轮始终没给出回应的条目回队该线程
    // 队列尾（queue_update 广播，前端 pill 恢复显示、「已并入」徽标让位），由
    // 既有链节/接力泵按普通轮次派发——失败并入自动降级为排队，绝不静默丢消息。
    // 撤回注入行（转录 + 内存上下文，见 withdrawInjectedSteer）：未获回应的并入
    // 不算送达，气泡必须随条目回收一起消失，否则同一内容既有气泡又在队列条、
    // 重发还再落一条同文行（前端两条同文气泡，删队列行也撤不回）。
    const stranded = findUnansweredSteers(run);
    run.steerEntries = undefined;
    for (const e of stranded) {
      const withdrew = withdrawInjectedSteer(run, e);
      // force 旁路每线程限流：队列已被普通排队占满（5 条）也必须收下，
      // 否则就是静默丢弃用户已受理的消息，违背上面的「并入不丢」承诺
      enqueueTurn(e.reqId, threadId, e.msg, { force: true });
      logAt(
        "event",
        `steer reclaim: reqId=${e.reqId} thread=${threadId} 未获回应 → 回队${
          withdrew ? "（注入行已撤回）" : ""
        }`,
      );
    }
    // Stop 语义对齐成熟实现：用户主动 Stop 时保留队列并暂停自动派发
    // （pauseReason="stopped"），等显式「继续」再跑。promote（立即发送）触发的
    // abort 置 preserveQueueOnStop，队首必须继续派发，不能暂停。放在回收之后：
    // 回收项也算进队列，避免「Stop 时刚好把并入项收回队列却不冻结」。
    // 轮首复位后 TS 会把字段收窄成 false；用 Boolean 读取运行期真值
    //（promote / abort 处理器可能在轮中把它重新置 true）。
    const preserveQueue = Boolean(run.preserveQueueOnStop);
    const discardQueue = Boolean(run.discardQueueOnStop);
    run.preserveQueueOnStop = false;
    run.discardQueueOnStop = false;
    if (run.stopRequested) {
      if (preserveQueue) {
        // promote（立即发送）：队首继续派发，不暂停
      } else if (discardQueue) {
        // IM 等没有排队 UI 的调用方：停止即丢弃整队，不留暂停态
        cancelAllEntries(threadId);
      } else {
        pauseQueue(threadId, "stopped");
      }
    }
    // Stop 中止可能不带 error chunk（abort() 让 prompt 静默收敛）：按失败结算
    const outcome: PromptTurnOutcome = turnError
      ? { ok: false, errorText: turnError }
      : run.stopRequested
        ? { ok: false, errorText: "run aborted by stop request" }
        : { ok: true };
    onOutcome?.(outcome);
  }
}

/** 供自动化 runner 经管理队列预建会话（与 runPromptTurn 的会话准备段同源
 *  串行）：拿到 run 后可先施加 per-task 模型再 dispatchPrompt；后续
 *  resolveSession 走 running 表 fast path 复用同一实例 */
export function mgmtResolveSession(
  threadId: string,
  sessionId?: string,
  cwd?: string,
  projectId?: string,
): Promise<Running> {
  return enqueueMgmt(() =>
    resolveSession(threadId, sessionId, cwd, undefined, projectId),
  );
}

/** 中止单个线程的 run：父代理、后台子代理、挂起审批/提问与压缩请求全部结算 */
export function abortRun(run: Running, threadId: string): void {
  run.stopRequested = true;
  clearPendingToolApprovals(run);
  cancelPendingQuestions(threadId);
  cancelPendingMcpApprovals(threadId);
  cancelPendingMcpElicitations(threadId);
  void cancelPendingMcpTasks(threadId);
  for (const d of run.delegations.values()) {
    if (d.status === "running") {
      d.stopRequested = true;
      d.abort();
    }
  }
  // 正在跑的压缩摘要请求也要中止（runCompaction 会因此放弃装填 checkpoint）
  run.compactionAbort?.abort();
  run.agent.abort();
}

/**
 * SessionStart 钩子：来源在 resolveSession 物化时记到 run 上，这里在首个真实
 * 用户回合开跑前消费一次并清空。
 *
 * 不直接在 resolveSession 里发：读取主题、目标按钮、手动压缩等管理请求也会
 * 物化会话，直接发会让外部命令被 UI 操作误触；也不能每个用户回合都发——
 * SessionStart 的语义是「会话开始/恢复」，不是「每次提问」。
 */
export async function fireSessionStartHook(run: Running): Promise<string | undefined> {
  const source = run.sessionStartSource;
  if (!source) return undefined;
  run.sessionStartSource = undefined;
  const result = await runHooksCollect(
    "SessionStart",
    buildHookPayload({
      event: "SessionStart",
      sessionId: run.sessionId,
      threadId: run.threadId,
      source,
    }),
    { workspace: run.cwd },
  );
  return result.context;
}

/**
 * 整轮结束的 Stop 钩子（runTurnBody 的整轮循环里执行）。
 *
 * 为什么不在 agent_end / turn_end 触发：
 * - turn_end 是每个内部 LLM 轮，带工具调用的轮后面还会继续；
 * - agent_end 在一次用户回复里也可能触发多次（溢出恢复重跑、委派收敛后的
 *   恢复 prompt 都会再起一轮），此时工作还没真正结束。
 * 调用方在委派收敛完成后执行；decision=block 表示钩子要求继续工作。
 * 用户主动 Stop 不触发（与 Claude Code 的 Stop 语义一致）。
 */
export async function runStopHooks(run: Running): Promise<HookDecision | undefined> {
  if (run.stopRequested) return undefined;
  return runHooks(
    "Stop",
    buildHookPayload({
      event: "Stop",
      sessionId: run.sessionId,
      threadId: run.threadId,
    }),
    { workspace: run.cwd },
  );
}
