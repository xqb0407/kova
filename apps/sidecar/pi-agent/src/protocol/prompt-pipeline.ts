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
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ErrorPayload } from "pi-protocol";
import { classifyAgentError, toWireError } from "../agent/agent-errors";
import {
  contextInfo,
  needsCompaction,
  runCompaction,
  setLeadingSystemMessage,
  type CompactionOutcome,
} from "../agent/context";
import { buildHookPayload, fireHookEvent } from "../agent/hooks";
import { clearPendingToolApprovals, composeModeSystemPrompt } from "../agent/modes";
import { cancelPendingMcpApprovals } from "../mcp/mcp-tools";
import { cancelPendingQuestions } from "../tools/question-tools";
import { noticeAppendedText, preparePromptAttachments } from "./prompt-attachments";
import { send, sendChunk, sendErrorChunk, setActiveReqId, beginRun } from "./stream";
import { emitThreadEvent } from "./thread-events";
import { withEventSeq } from "./event-seq";
import {
  broadcastQueueState,
  enqueueTurn,
  isTurnBusy,
  markTurnEnd,
  markTurnStart,
  PROMPT_QUEUE_LIMIT,
  queueSnapshot,
  shouldQueue,
  takeFrontEntry,
} from "../sessions/prompt-queue";
import {
  ensureTaskSessionDir,
  isModelUnavailable,
  noteActiveTurn,
  rebindRunThread,
  resolveSession,
  running,
  whenThreadIdle,
} from "../sessions/sessions";
import { persist, STEER_PREFIX } from "../sessions/transcript";
import { delegationResumeText, runningDelegations } from "../subagent/subagent";
import { enqueueMgmt } from "./mgmt-queue";
import type { Running, SteerEntry } from "../types";

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

const TRUNCATED_TOOL_CALL_HINT =
  "\n\nHint: do NOT simply re-issue the same oversized call — it will hit the limit again. " +
  "For write, split the file into parts: write the first part, then append the rest with " +
  "edit calls (match the file's current tail as old_string). Keep each response small.";

/** 截断错误自愈增强：输出撞限被 core 标记失败的 toolCall，原错误文案只让模型
 *  「重发完整参数」——同样的大 write 重发还会再撞限，弱模型会原地打转。在
 *  下一轮请求前就地给这类错误 toolResult 附加拆分写入指引。
 *  只改内存上下文（转录已按原文案落盘，历史保真；自愈指引只需紧接的下一轮
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
        block.text.includes(TRUNCATED_TOOL_CALL_MARKER) &&
        !block.text.includes("do NOT simply re-issue")
      ) {
        block.text += TRUNCATED_TOOL_CALL_HINT;
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
    // 截断错误增强先行（即使不触发压缩也要做）：就地改 state.messages，
    // 压缩若触发则其 slice() 快照自然带上增强后的文本
    augmentTruncatedToolCallErrors(run.agent.state.messages);
    if (run.stopRequested || signal?.aborted) return undefined;
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
export function steerIntoActiveRun(
  run: Running,
  reqId: string,
  msg: Record<string, unknown>,
): boolean {
  // turnEnding：收尾段（finally）已开跑，挂起 finish 的补发已执行过——此刻
  // 受理的并入其 finish 永远没人补发（前端「已并入」徽标滞留不消失）
  if (run.stopRequested || run.turnEnding) return false;
  try {
    // 与普通 prompt 同一条附件链路：拒收项折算说明行、合法项进 user 消息 content。
    // 哨兵前缀：注入即真实 user 消息落转录，投影层（直播与快照直出同一出口）
    // 剥前缀并补「已并入当前回复」标记 part（刷新前后语义一致；模型侧前缀
    // 自解释，auto-continue 同款先例）
    const attachments = preparePromptAttachments(msg, { cwd: run.cwd });
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
    if (steerIntoActiveRun(activeRun, reqId, msg)) return;
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
  const tail = promptChains.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const node = new Promise<void>((r) => (release = r));
  promptChains.set(threadId, node);
  await tail;
  markTurnStart(threadId);
  try {
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
    await runPromptTurn(turnReqId, turnMsg, threadId, onOutcome);
  } finally {
    noteActiveTurn(threadId, false);
    markTurnEnd(threadId);
    // §7 上下文读数推送：轮收尾即现算下发（桌面占用环镜像直更，免拉取）。
    // 只认该线程仍驻留的 run——resolveSession 失败的轮没有 run，天然不推；
    // 盖事件水印（session_state 同款），桌面漏帧回拉 context_info。
    const endedRun = running.get(threadId);
    if (endedRun?.sessionId) {
      pushContextChanged(endedRun);
    }
    release();
    // 本节是链尾且队列已空：摘掉链条目，防 map 随线程数无限增长
    if (!shouldQueue(threadId) && promptChains.get(threadId) === node) {
      promptChains.delete(threadId);
    }
  }
}

/** 单个 prompt turn 的完整执行（原 dispatchPrompt 主体）：会话准备段入管理队列
 *  串行执行，agent.prompt 长任务在队列外运行。
 *
 *  外层是**崩溃隔离层**。内层的 try 只罩住 agent 段，会话准备段（ensureTaskSessionDir /
 *  rebindRunThread / 系统提示词重排 / 挂起清理）都在它之前：那几处任何一次同步抛错都会
 *  跳过内层 finally，于是——不发 finish（AI SDK 的 status 永远停在 streaming，Stop 失灵、
 *  线程看着一直忙）、不清 activeReqByThread（下一轮的内容 chunk 全被路由进这条死流）、
 *  不回调 onOutcome（无人值守的 automation runner 永远等下去）。protocol.ts 的兜底
 *  catch 只补了 error chunk，补不了这三条。
 *  这里把逃逸的抛错就地结算：错误 chunk + finish + 清路由 + 回报 onOutcome。 */
async function runPromptTurn(
  reqId: string,
  msg: Record<string, unknown>,
  threadId: string,
  onOutcome?: (outcome: PromptTurnOutcome) => void,
) {
  try {
    await runTurnBody(reqId, msg, threadId, onOutcome);
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
  onOutcome?: (outcome: PromptTurnOutcome) => void,
) {
  // 本轮错误结算文本（与下发前端的 error chunk 同源）；finally 里经 onOutcome 回报
  let turnError: string | undefined;
  const task = enqueueMgmt(() =>
    resolveSession(
      threadId,
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      typeof msg.cwd === "string" ? msg.cwd : undefined,
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
  // 任务工作区目录到这一刻才落盘：会话解析阶段不建（启动时草稿线程也会解析，
  // 那时无物可写，建了就是空壳目录）。自选了工作目录的会话内部自带判断跳过。
  ensureTaskSessionDir(run);
  // 线程键漂移（刷新后草稿 id → sessionId）：resolveSession 在旧轮未收尾时
  // 不敢改绑 run.threadId（会把旧轮事件错路由进新请求），这里等旧键轮次
  // 完整结束（含委派收敛与 finish 收尾）后补改绑。不改绑的后果：事件路由按
  // run.threadId 查 activeReqByThread 落空，全部内容 chunk 静默丢弃，只剩
  // 显式 reqId 的 start/finish——前端"没回复却弹完成通知"（2026-09 修复）。
  if (run.threadId !== threadId) {
    await whenThreadIdle(run.threadId);
    await rebindRunThread(run, run.threadId, threadId);
  }
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
  // 每轮请求前重排环境事实段（日历日跨天兜底：提示词只在建会话/切模式/改设置
  // 时重排，长会话跨过午夜日期会停旧）；纯字符串拼接零成本，块内容不变时
  // 重排出字节级相同的提示词，缓存前缀不受影响。
  // 0.99 迁移：提示词由转录首条 system 消息承载（state.systemPrompt 只读）
  setLeadingSystemMessage(
    run.agent.state.messages,
    composeModeSystemPrompt(
      run.mode,
      run.cwd,
      run.agent.state.model,
      run.designTheme,
    ),
  );
  setActiveReqId(threadId, reqId);
  run.stopRequested = false;
  run.turnEnding = false;
  // 上一次运行的溢出恢复残留（正常应在 runStepWithRecovery 内消费）兜底清理
  run.pendingOverflowRecovery = false;
  // 新一轮重置 provider 重试记账：预算清零、响应捕获清空，
  // data-retry part 换用新 id（同轮内多次尝试同 id 原地更新，见 provider-retry.ts）
  run.providerRetry.rateLimit = 0;
  run.providerRetry.transient = 0;
  run.retryCapture = {};
  run.providerRetryActive = false;
  run.providerRetryChunkId = `retry-${++run.providerRetryTurnSeq}`;
  // 长度截断自动续跑预算按轮重置（用户每发一条消息重新给满 MAX_LENGTH_CONTINUES 次）
  run.lengthContinues = 0;
  // 逐工具审批（含 plan_exit 确认）/挂起提问/MCP 审批理论上不会跨 turn 遗留
  // （abort 已结算），兜底清理防挂起：新用户输入时未决的 plan_exit 按拒绝结算
  clearPendingToolApprovals(run);
  cancelPendingQuestions(threadId);
  cancelPendingMcpApprovals(threadId);
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
  run.agent.prepareNextTurnWithContext = makeMidTurnCompactionHook(
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
  const runStep = async (text: string, images: ImageContent[]) => {
    if (stepStarted) sendChunk(reqId, { type: "finish-step" });
    sendChunk(reqId, { type: "start-step" });
    stepStarted = true;
    // 请求前阈值守卫（PI-Desktop pre-request guard）：上下文（含这条待发文本）
    // 已越过 hardLimit 就先压缩再发请求；压缩失败不阻塞本轮（溢出有恢复路径兜底）
    if (needsCompaction(run, text)) {
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
      await run.agent.prompt(text, images.length ? images : undefined);
    } catch (err) {
      // 线程串行链已消除本线程并发 prompt；此处兜底 abort 收尾等极窄竞态窗口。
      // 守卫抛错时尚未产生任何事件，waitForIdle 后原地重试一次是干净的。
      if (!isAlreadyProcessingError(err)) throw err;
      logErr("agent.prompt hit active-run guard, retrying after idle");
      await run.agent.waitForIdle();
      beginRun(threadId);
      await run.agent.prompt(text, images.length ? images : undefined);
    }
  };

  // 溢出恢复：stream.ts 吞掉溢出错误后置位 → 强制压缩后用同一文本重跑一次，
  // 重跑仍溢出不再恢复（直接报错），防循环
  const runStepWithRecovery = async (text: string, images: ImageContent[]) => {
    await runStep(text, images);
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

  // Claude Code 式 UserPromptSubmit 钩子：turn 实际开跑时触发（排队消息在
  // 队首就位后），通知式，v1 不阻塞 prompt
  fireHookEvent(
    "UserPromptSubmit",
    buildHookPayload({
      event: "UserPromptSubmit",
      sessionId: run.sessionId,
      threadId,
      prompt: msg.text,
    }),
  );

  // 附件（用户图片）：闸门裁决见 prompt-attachments.ts；拒收项折算成说明行
  // 追加到文本尾部（模型可读、刷新后可见），合法项组装 ImageContent 走
  // agent.prompt(text, images) 进模型上下文并随 agent 消息本体自动落转录。
  // 溢出恢复/委派收敛的重跑段不携带图片（resume 为纯文本）。
  // 模型硬门已移除（input 元数据不可靠，实测误拦支持图像的模型）：附件过
  // 物理闸门（prompt-attachments.ts）后一律放行，端点不支持时 API 报错可见。
  const promptAttachments = preparePromptAttachments(msg, { cwd: run.cwd });
  const promptText = noticeAppendedText(String(msg.text ?? ""), promptAttachments.noticeLines);
  if (promptAttachments.images.length) {
    logAt(
      "event",
      `prompt attachments: ${promptAttachments.images.length} image(s) -> ${run.sessionId}`,
    );
  }

  try {
    await runStepWithRecovery(promptText, promptAttachments.images);
    // 后台委派收敛循环（ADR 0089）：turn 结束时若还有运行中的子代理，等它们完成，
    // 把未投递的报告作为恢复 prompt 继续喂给父代理（同一条 reqId 消息流内续跑）。
    // 用户 Stop（stopRequested）直接退出。
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
    // 拆除轮间压缩挂钩：钩子闭包的 emitCompaction 绑定本 turn 的 reqId
    run.agent.prepareNextTurnWithContext = undefined;
    if (stepStarted) sendChunk(reqId, { type: "finish-step" });
    // Stop/promote 中止的 turn：finish 前发 abort 标记——前端据此把残缺回复
    // 结算为「被结束」而非「正常完成」（不弹完成通知）；AI SDK 保留 partial 内容
    if (run.stopRequested) {
      // 「已停止」标记 part：直播随消息渲染分隔线（前端 StoppedDataUI）
      sendChunk(reqId, { type: "data-stopped", id: "stopped", data: {} });
      sendChunk(reqId, { type: "abort" });
    }
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
    const stranded = findUnansweredSteers(run);
    run.steerEntries = undefined;
    for (const e of stranded) {
      // force 旁路每线程限流：队列已被普通排队占满（5 条）也必须收下，
      // 否则就是静默丢弃用户已受理的消息，违背上面的「并入不丢」承诺
      enqueueTurn(e.reqId, threadId, e.msg, { force: true });
      logAt("event", `steer reclaim: reqId=${e.reqId} thread=${threadId} 未获回应 → 回队`);
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
): Promise<Running> {
  return enqueueMgmt(() => resolveSession(threadId, sessionId, cwd));
}

/** 中止单个线程的 run：父代理、后台子代理、挂起审批/提问与压缩请求全部结算 */
export function abortRun(run: Running, threadId: string): void {
  run.stopRequested = true;
  clearPendingToolApprovals(run);
  cancelPendingQuestions(threadId);
  cancelPendingMcpApprovals(threadId);
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
