/**
 * prompt 管线：排队判定 → 每线程串行链 → 单个 turn 的完整生命周期。
 *
 * - dispatchPrompt：prompt 入口。排队判定后沿所属线程的串行链执行（prompt
 *   长任务不占 mgmtQueue，只有会话准备段经 enqueueMgmt 串行）。
 * - runPromptTurn：单 turn 执行——会话准备、阈值/溢出压缩、UserPromptSubmit
 *   钩子、附件装配、委派收敛循环、finish/steered 补发与失败熔断记账。
 * - steerIntoActiveRun：并入当前轮（agent.steer），steered 流挂起 finish。
 * - abortRun：中止单线程 run 的全部在飞内容（父代理/子代理/审批/提问/压缩）。
 * - mgmtResolveSession：自动化 runner 经管理队列预建会话。
 */
import { logAt, logErr } from "../log";
import type { ImageContent } from "@earendil-works/pi-ai";
import { needsCompaction, runCompaction } from "../agent/context";
import { makeAutoContinueMessage, MAX_LENGTH_CONTINUES } from "../agent/context";
import { buildHookPayload, fireHookEvent } from "../agent/hooks";
import { clearPendingToolApprovals, composeModeSystemPrompt } from "../agent/modes";
import { cancelPendingMcpApprovals } from "../mcp/mcp-tools";
import { cancelPendingQuestions } from "../tools/question-tools";
import { noticeAppendedText, preparePromptAttachments } from "./prompt-attachments";
import { sendChunk, setActiveReqId, beginRun, isPromptActive } from "./stream";
import {
  broadcastQueueState,
  enqueueTurn,
  isTurnBusy,
  markTurnEnd,
  markTurnOutcome,
  markTurnStart,
  PROMPT_QUEUE_LIMIT,
  queueChunkId,
  queueSnapshot,
  shouldQueue,
  takeFrontEntry,
  waitQueueUnpaused,
} from "../sessions/prompt-queue";
import {
  noteActiveTurn,
  rebindRunThread,
  resolveSession,
  running,
  whenThreadIdle,
} from "../sessions/sessions";
import { persist } from "../sessions/transcript";
import { delegationResumeText, runningDelegations } from "../subagent/subagent";
import { enqueueMgmt } from "./mgmt-queue";
import type { Running } from "../types";

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

/** prompt turn 串行链：每线程一条（队列按线程隔离，不同线程并行跑 turn）。
 *  每节 = 一个 turn 的完整生命周期（会话准备 → runStepWithRecovery →
 *  委派收敛循环 → finally finish），跑完才放行该线程下一节 */
const promptChains = new Map<string, Promise<void>>();

/** 线程是否有未走完的串行链节（queue_resume 判断"空闲且无链节"用） */
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

/** 并入当前轮（steer）：把消息注入活跃 run（agent.steer，库在下次模型调用前
 *  消费、随活跃轮转录落盘），本请求走退化流 data-queue(steered) → start 后
 *  **挂起**——finish 不立即发：AI SDK 的 status 是单槽，流提前结束会把整个
 *  会话置回 ready（正在跑的宿主轮在 UI 上显示为已停止、Stop 因 activeResponse
 *  被清空而失灵）。finish 挂到宿主轮收尾时补发（flushSteeredFinishes），
 *  届时线程真正空闲，无副作用。AI SDK 对无内容 chunk 的流不会 push 空
 *  assistant 消息，回复继续在活跃轮的消息流里输出。返回 false（无活跃 run /
 *  正在收尾 / steer 抛错）由调用方落回普通排队。 */
export function steerIntoActiveRun(
  run: Running,
  reqId: string,
  msg: Record<string, unknown>,
): boolean {
  if (run.stopRequested) return false;
  try {
    // 与普通 prompt 同一条附件链路：拒收项折算说明行、合法项进 user 消息 content
    const attachments = preparePromptAttachments(msg, { cwd: run.cwd });
    const text = noticeAppendedText(String(msg.text ?? ""), attachments.noticeLines);
    const content: string | (ImageContent | { type: "text"; text: string })[] =
      attachments.images.length
        ? [{ type: "text", text }, ...attachments.images]
        : text;
    run.agent.steer({ role: "user", content, timestamp: Date.now() });
    if (attachments.images.length) {
      logAt(
        "event",
        `prompt steer: ${attachments.images.length} image(s) -> ${run.sessionId}`,
      );
    }
    sendChunk(reqId, {
      type: "data-queue",
      id: queueChunkId(reqId),
      data: { phase: "steered" },
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
  // data-queue chunk 渲染排队条。其他线程忙与本线程无关（并行跑各自的 turn）。
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
      sendChunk(reqId, {
        type: "error",
        errorText: `排队消息过多（上限 ${PROMPT_QUEUE_LIMIT} 条），请等当前对话完成后再发`,
      });
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
  // 队列暂停：链节在队首等待恢复（resume 唤醒全部等待节点，串行链保证依次取队首）。
  // 暂停闸只约束排队项（wasQueued）——空闲线程的全新发送不受残留 paused 态影响：
  // 队列清空后 paused 残留曾把非排队新消息永久卡在此处（前端 0 条排队时无恢复
  // 按钮可点，表现为一直「连接中」）
  if (wasQueued) await waitQueueUnpaused(threadId);
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
    release();
    // 本节是链尾且队列已空：摘掉链条目，防 map 随线程数无限增长
    if (!shouldQueue(threadId) && promptChains.get(threadId) === node) {
      promptChains.delete(threadId);
    }
  }
}

/** 单个 prompt turn 的完整执行（原 dispatchPrompt 主体）：会话准备段入管理队列
 *  串行执行，agent.prompt 长任务在队列外运行 */
async function runPromptTurn(
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
    sendChunk(reqId, { type: "error", errorText });
    onOutcome?.({ ok: false, errorText });
    return;
  }
  // 线程键漂移（刷新后草稿 id → sessionId）：resolveSession 在旧轮未收尾时
  // 不敢改绑 run.threadId（会把旧轮事件错路由进新请求），这里等旧键轮次
  // 完整结束（含委派收敛与 finish 收尾）后补改绑。不改绑的后果：事件路由按
  // run.threadId 查 activeReqByThread 落空，全部内容 chunk 静默丢弃，只剩
  // 显式 reqId 的 start/finish——前端"没回复却弹完成通知"（2026-09 修复）。
  if (run.threadId !== threadId) {
    await whenThreadIdle(run.threadId);
    await rebindRunThread(run, run.threadId, threadId);
  }
  if (!run.agent.state.model) {
    const errorText =
      "No model with credentials available. Open Settings → Model and add an API key.";
    turnError = errorText;
    sendChunk(reqId, { type: "error", errorText });
    onOutcome?.({ ok: false, errorText });
    return;
  }
  // 每轮请求前重排环境事实段（日历日跨天兜底：提示词只在建会话/切模式/改设置
  // 时重排，长会话跨过午夜日期会停旧）；纯字符串拼接零成本，块内容不变时
  // 重排出字节级相同的提示词，缓存前缀不受影响
  run.agent.state.systemPrompt = composeModeSystemPrompt(
    run.mode,
    run.cwd,
    run.agent.state.model,
  );
  setActiveReqId(threadId, reqId);
  run.stopRequested = false;
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
        sendChunk(reqId, { type: "error", errorText: turnError });
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
      sendChunk(reqId, { type: "error", errorText: turnError });
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
    sendChunk(reqId, { type: "error", errorText: turnError });
    // 父代理 turn 失败：中止遗留的后台子代理，让会话能回到空闲（D352）
    for (const d of run.delegations.values()) {
      if (d.status === "running") {
        d.stopRequested = true;
        d.abort();
      }
    }
  } finally {
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
    // Stop 中止可能不带 error chunk（abort() 让 prompt 静默收敛）：按失败结算
    const outcome: PromptTurnOutcome = turnError
      ? { ok: false, errorText: turnError }
      : run.stopRequested
        ? { ok: false, errorText: "run aborted by stop request" }
        : { ok: true };
    // 失败熔断记账：连续 turn 级失败达阈值自动暂停队列（成功清零；用户主动
    // Stop 不计入失败）
    markTurnOutcome(threadId, outcome.ok);
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
