/**
 * pi-agent sidecar 协议层：stdin/stdout 上的 NDJSON。
 *
 * 输入（stdin，每行一个 JSON）：
 *   { "type": "prompt", "id": "<reqId>", "text": "...", "threadId": "...", "sessionId": "...", "cwd": "..." }
 *       sessionId = 会话 id（索引表/JSONL 文件名）；提供则恢复该会话（跨重启），缺省则按 threadId 懒建新会话
 *       cwd = workspace 目录；仅在需要新建会话时使用，缺省为用户主目录
 *       prompt 结束后若有后台子代理（Task 委派）仍在运行，等待其完成并在同一条
 *       reqId 消息流内注入恢复 prompt 投递报告（多 step 收敛），再发 finish
 *   { "type": "abort" }   中止父代理与全部后台子代理，并取消全部排队 prompt
 *   { "type": "queue_update", "id", "requestId", "text" }   → { id, type: "queue_updated", requestId }
 *       修改排队中的 prompt 文本（仅 queued 状态可改；requestId 为原 prompt 的 reqId）
 *   { "type": "queue_cancel", "id", "requestId" }           → { id, type: "queue_cancelled", requestId }
 *       删除单个排队项，其 prompt 流立即 abort + finish 收尾（不执行）
 *   { "type": "queue_promote", "id", "requestId" }          → { id, type: "queue_promoted", requestId }
 *       立即发送：该项提到队首并中止当前活跃 turn（其余排队项保留，按新顺序依次执行）
 *   prompt 排队（prompt-queue.ts）：上一轮未结束时到达的 prompt 进 FIFO 队列，
 *       流上先发 { chunk: { type: "data-queue", id: "queue-<reqId>", data: { phase: "queued", position } } }，
 *       轮到时同 id 原地更新 { phase: "active" }；执行顺序由全局串行链保证
 *   { "type": "ping", "id" }                                  → { id, type: "pong" }
 *   { "type": "list_sessions", "id" }                         → { id, type: "sessions", sessions: [...] }
 *   { "type": "new_session", "id", "threadId", "cwd" }        → { id, type: "session", sessionId, threadId }
 *   { "type": "get_history", "id", "sessionId" }              → { id, type: "history", messages: UIMessage[] }
 *       历史从 agent 消息重建，含工具部件（tool part 的 input/output 与 live 流一致）；
 *       compaction 检查点行重建为 data-compaction 分隔线 part（刷新后分隔线不丢）
 *   { "type": "delete_session", "id", "sessionId" }           → { id, type: "deleted" }
 *   { "type": "rename_session", "id", "sessionId", "name" }   → { id, type: "renamed" }
 *   { "type": "archive_session", "id", "sessionId", "archived" } → { id, type: "archived" }
 *       归档 / 取消归档（archived: bool）：列表项打标，正文与索引行不动；list_sessions 会带回 archived 字段
 *   { "type": "list_models", "id" }                           → { id, type: "models", models: [...], providers: [...] }
 *       models 项含 enabled 与 maxTokens/input/cost 属性（enabled=false = 已被过滤隐藏，前端自行过滤）
 *   { "type": "set_model", "id", "provider", "modelId" }      → { id, type: "model", provider, modelId }
 *   { "type": "get_model", "id" }                             → { id, type: "model", provider, modelId }
 *       未选择时 provider/modelId 为空串（前端据此校准 UI 真值）
 *   { "type": "set_thinking", "id", "level" }                 → { id, type: "thinking", level }（深度思考档位，广播到活动会话）
 *   { "type": "set_thinking_maps", "id", "maps" }             → { id, type: "thinking_maps", applied }（模型级 thinkingLevelMap 覆盖整包下发）
 *   { "type": "get_personalization", "id" }                   → { id, type: "personalization", settings }（个性化设置：回复风格/称呼/人设/自定义指令）
 *   { "type": "set_personalization", "id", "settings" }       → { id, type: "personalization", settings }（落 SQLite kv + 活动会话系统提示词热替换）
 *   { "type": "usage_stats", "id" }                           → { id, type: "usage_stats", stats }（全局使用统计：增量物化到 SQLite 后从库聚合）
 *   { "type": "get_todo_state", "id", "threadId", "sessionId"? } → { id, type: "todo_state", tasks, nextId }（任务清单水合，只读）
 *   { "type": "get_provider_filter", "id", "provider" }       → { id, type: "provider_filter", provider, models: string[] | null }
 *       models = 勾选（可见）的模型 id；null = 无过滤记录（目录全可见）
 *   { "type": "set_provider_filter", "id", "provider", "models": string[] } → { id, type: "provider_filter", provider, models }
 *       写 models 表行（enabled 位切换，属性覆盖保留）；空数组 = 清除该 provider 的全部行；
 *       目录外的 modelId（内置厂商手动新增）按行挂进目录
 *   { "type": "update_model", "id", "provider", "modelId", name?, reasoning?, contextWindow?, maxTokens?, input?, cost? }
 *                                                             → { id, type: "model_updated", provider, modelId }
 *       消息里携带的字段写入 models 表（null = 重置为继承内置值；未携带 = 保留现值）并原地应用到目录；
 *       目录外的 modelId 同样会挂载为新增模型
 *   { "type": "set_credential", "id", "provider", "apiKey" }  → { id, type: "credential", provider }
 *   { "type": "list_credentials", "id" }                      → { id, type: "credentials", credentials: [...] }
 *   { "type": "delete_credential", "id", "provider" }         → { id, type: "credential_deleted", provider }
 *   { "type": "fetch_models", "id", "baseUrl", "apiKey", "api" } → { id, type: "fetched_models", models: [...] }
 *       api = openai-chat | openai-responses | anthropic-messages，决定列表端点与鉴权方式
 *   { "type": "add_custom_provider", "providerId"?, "name", "baseUrl", "apiKey", "api", "models": [{ "id", ... }] }
 *                                                             → { id, type: "custom_provider", provider }
 *       providerId = 编辑目标的业务 id（协议 reqId 占用了 "id" 字段，故改名）；缺省为新建
 *   { "type": "list_custom_providers", "id" }                 → { id, type: "custom_providers", providers: [...] }
 *   { "type": "toggle_custom_provider", "id", "provider", "enabled" } → { id, type: "custom_provider_toggled", provider, enabled }
 *   { "type": "set_mode", "id", "threadId", "sessionId"?, "mode" }       → { id, type: "mode_changed", mode, planning, proposal }
 *       mode = agent | plan | goal；切换会热替换工具集与系统提示词
 *   { "type": "approve_plan", "id", "threadId", "sessionId"? }           → { id, type: "planning_state", mode, planning, proposal }
 *       批准未决提案：回 agent 模式（前端随后发批准消息开始实施）
 *   { "type": "reject_plan", "id", "threadId", "sessionId"? }            → { id, type: "planning_state", mode, planning, proposal }
 *       拒绝未决提案：留在契约模式继续修改
 *   { "type": "tool_confirm", "id", "threadId", "sessionId"?, "approvalId", "approved" } → { id, type: "tool_confirmed", approvalId }
 *       结算 bash/write/edit 执行前的逐工具审批（prompt 流内 data-toolApproval chunk 发起）
 *   { "type": "question_answer", "id", "threadId", "questionId", "answers": [{ questionId, selectedIds, otherText?, skipped? }] } → { id, type: "question_answered", questionId }
 *       结算 Question 工具的挂起提问（prompt 流内 data-question chunk 发起，前端 AskUserQuestions 卡片作答）
 *   { "type": "context_info", "id", "threadId", "sessionId"? } → { id, type: "context_info", ... }
 *       上下文面板读数：容量/阈值/消息/系统提示词/工具占用 + 平均缓存命中率（现算，零持久化）
 *   { "type": "compact", "id", "threadId", "sessionId"? }     → { id, type: "compacted", generation, tokensBefore, summarized }
 *       手动压缩上下文（仅空闲回合边界；prompt 运行中拒绝）
 *   { "type": "test_provider", "id", "baseUrl", "apiKey", "api", "model" } → { id, type: "tested", ok: true }
 *   { "type": "delete_custom_provider", "id", "provider" }    → { id, type: "custom_provider_deleted", provider }
 *   prompt 流内审批推送：{ id, chunk: { type: "data-planningState", data: { mode, planning, proposal } } }
 *                 审批请求：{ id, chunk: { type: "data-toolApproval", data: { approvalId, toolCallId, toolName, input } } }
 *
 * prompt 流（stdout）：{ "id": "<reqId>", "chunk": { ...AI SDK UIMessageChunk } }
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels, type Message } from "@earendil-works/pi-ai";
import { logErr } from "./log";
import { sessionPath } from "./storage";
import { resolveHostResult } from "./hostdb";
import {
  credentialDelete,
  credentialGet,
  credentialList,
  credentialSet,
  customProviderDelete,
  customProviderGet,
  customProviderSetEnabled,
  customProviderUpsert,
  customProvidersList,
  modelsAll,
  modelsDeleteProvider,
  modelsList,
  modelsReplace,
  type ModelReplaceItem,
  sessionDelete,
  sessionList,
  sessionRename,
  sessionSetArchived,
} from "./hostdb";
import {
  applyRowToCatalogModel,
  CUSTOM_MODEL_DEFAULTS,
  getCurrentModelKey,
  getCurrentThinkingLevel,
  getModels,
  normalizeApi,
  parseModelCost,
  parseModelInput,
  registerCustomProvider,
  setCurrentModelKey,
  setCurrentThinkingLevel,
  setThinkingMapOverrides,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./model-catalog";
import {
  readTranscript,
  readAllCompactions,
  persist,
  historyToUiMessages,
} from "./transcript";
import { contextInfo, needsCompaction, runCompaction } from "./context";
import { running, resolveSession } from "./sessions";
import {
  cancelAllEntries,
  cancelEntry,
  enqueueTurn,
  isTurnBusy,
  markTurnEnd,
  markTurnStart,
  PROMPT_QUEUE_LIMIT,
  promoteEntry,
  queueChunkId,
  shouldQueue,
  takeFrontEntry,
  updateEntryText,
} from "./prompt-queue";
import { getTodoState, replayTodoFromMessages } from "./todo";
import {
  delegationResumeText,
  runningDelegations,
} from "./subagent";
import {
  beginRun,
  isPromptActive,
  send,
  sendChunk,
  setCurrentReqId,
} from "./stream";
import {
  applyMode,
  clearPendingToolApprovals,
  closeProposalOnNewPrompt,
  composeModeSystemPrompt,
  planningPayload,
  resolveToolApproval,
} from "./modes";
import {
  applyPersonalization,
  getPersonalization,
} from "./personalization";
import { aggregateUsageStats } from "./usage-stats";
import {
  cancelPendingQuestions,
  resolveQuestionAnswer,
  type QuestionAnswerItem,
} from "./question-tools";
import type { CustomModelSpec, Running, SessionSummary } from "./types";

/** stdin 关闭（父进程写完）不等于任务处理完毕，等挂起请求清零再退出 */
let stdinClosed = false;
let pendingOps = 0;
let exiting = false;

function maybeExit() {
  if (exiting || !stdinClosed || pendingOps > 0) return;
  exiting = true;
  // end() 会先冲刷 stdout 队列再退出，避免超长响应行被截断
  process.stdout.end(() => process.exit(0));
}

/** 入口在 stdin 关闭时调用（readline close 事件） */
export function markStdinClosed() {
  stdinClosed = true;
  maybeExit();
}

/** 管理命令串行队列：避免凭据写入与列表查询等异步命令交叠产生竞态 */
let mgmtQueue: Promise<void> = Promise.resolve();

/** 启动初始化闸门：模型目录就绪（自定义提供商注册/覆盖合并）之前到达的命令先缓冲，
 *  避免启动恢复的 set_model 抢在目录就绪前被 "model not found" 拒绝而回落默认模型。
 *  host_result 不经闸门（host_query 的挂起结算必须即时）。gate 由 index.ts 注入且
 *  内部已 catch（不会 reject）。 */
let initGate: Promise<void> = Promise.resolve();

export function setInitGate(gate: Promise<void>): void {
  initGate = gate;
}

let fallbackSeq = 0;

export function handleLine(raw: string) {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    logErr("unparseable line:", String(raw).slice(0, 200));
    return;
  }

  // 宿主对 host_query 的响应：交给 hostdb 的挂起表结算，不走命令分发
  if (resolveHostResult(msg)) return;

  const reqId = typeof msg.id === "string" ? msg.id : `req-${fallbackSeq++}`;
  const run = async () => {
    try {
      // 启动恢复命令等目录就绪再分发（set_model 否则会因目录未就绪被拒）
      await initGate;
      await dispatch(reqId, msg);
    } catch (err) {
      logErr("handleLine failed:", err);
      send({ id: reqId, type: "error", errorText: err instanceof Error ? err.message : String(err) });
    } finally {
      pendingOps -= 1;
      maybeExit();
    }
  };
  pendingOps += 1;
  if (msg.type === "prompt") {
    // prompt 主体是长任务，不占队列；但会话准备（建会话/读凭据）作为队列任务执行，
    // 与 set_credential / new_session 等保持严格先后
    void (async () => {
      try {
        await dispatchPrompt(reqId, msg);
      } catch (err) {
        sendChunk(reqId, { type: "error", errorText: err instanceof Error ? err.message : String(err) });
      } finally {
        pendingOps -= 1;
        maybeExit();
      }
    })();
  } else {
    mgmtQueue = mgmtQueue.then(run, run);
  }
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

/** prompt turn 全局 FIFO 串行链：每节 = 一个 turn 的完整生命周期（会话准备 →
 *  runStepWithRecovery → 委派收敛循环 → finally finish），跑完才放行下一节 */
let promptChain: Promise<void> = Promise.resolve();
/** 正在跑的 turn 所属线程（queue_promote 中止活跃 turn 时定位 run 用） */
let activeTurnThreadId: string | null = null;

/** "Agent is already processing a prompt" 兜底识别（pi-agent-core 守卫文案） */
function isAlreadyProcessingError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return text.includes("Agent is already processing");
}

/** prompt 入口：排队判定后沿全局串行链执行（prompt 长任务依旧不占 mgmtQueue） */
export async function dispatchPrompt(reqId: string, msg: Record<string, unknown>) {
  const threadId = String(msg.threadId ?? "default");

  // 上一轮未结束（或队列非空）→ 进 FIFO 队列，前端经 data-queue chunk 渲染排队条。
  // 例外：活跃 turn 已被 Stop 中止、正在收尾（stopRequested 置位到链节 finally 之间）
  // 不算「真忙」——此刻到达的新 prompt 不进队列，直接沿链等收尾后执行。否则会出现
  // 「刚点了停止、新消息却显示排队中」，且用户再点一次 Stop 会把它连带取消（不执行）。
  // 串行性由 promptChain 保证，顺序与排队完全一致，只是不渲染排队条。
  const activeRun =
    activeTurnThreadId != null ? running.get(activeTurnThreadId) : undefined;
  const activeStopping = isTurnBusy() && activeRun?.stopRequested === true;
  const wasQueued = shouldQueue() && !activeStopping;
  if (wasQueued) {
    const enqueued = enqueueTurn(reqId, threadId, msg);
    if (!enqueued.ok) {
      sendChunk(reqId, {
        type: "error",
        errorText: `排队消息过多（上限 ${PROMPT_QUEUE_LIMIT} 条），请等当前对话完成后再发`,
      });
      return;
    }
  }

  // 沿链排队：前面每个 turn 完整跑完（含 finish 收尾）才轮到本节。
  // 链节是可互换的工人槽，开跑时取当前队首（queue_promote 重排后顺序依然正确）
  const tail = promptChain;
  let release!: () => void;
  promptChain = new Promise<void>((r) => (release = r));
  await tail;
  markTurnStart();
  try {
    let turnReqId = reqId;
    let turnThreadId = threadId;
    let turnMsg = msg;
    if (wasQueued) {
      const next = takeFrontEntry();
      // 本项已被取消（取消时流已收尾）或队列已空：静默让位
      if (!next) return;
      turnReqId = next.reqId;
      turnThreadId = next.threadId;
      turnMsg = next.msg;
      sendChunk(turnReqId, {
        type: "data-queue",
        id: queueChunkId(turnReqId),
        data: { phase: "active" },
      });
    }
    activeTurnThreadId = turnThreadId;
    await runPromptTurn(turnReqId, turnMsg, turnThreadId);
  } finally {
    activeTurnThreadId = null;
    markTurnEnd();
    release();
  }
}

/** 单个 prompt turn 的完整执行（原 dispatchPrompt 主体）：会话准备段入管理队列
 *  串行执行，agent.prompt 长任务在队列外运行 */
async function runPromptTurn(
  reqId: string,
  msg: Record<string, unknown>,
  threadId: string,
) {
  const task = mgmtQueue.then(() =>
    resolveSession(
      threadId,
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      typeof msg.cwd === "string" ? msg.cwd : undefined,
    ),
  );
  mgmtQueue = task.then(
    () => {},
    () => {},
  );

  let run;
  try {
    run = await task;
  } catch (err) {
    sendChunk(reqId, { type: "error", errorText: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!run.agent.state.model) {
    sendChunk(reqId, {
      type: "error",
      errorText:
        "No model with credentials available. Open Settings → Model and add an API key.",
    });
    return;
  }
  setCurrentReqId(reqId);
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
  // 新用户输入隐式关闭未决审批（未点批准/拒绝就直接发消息）
  closeProposalOnNewPrompt(run);
  // 逐工具审批/挂起提问理论上不会跨 turn 遗留（abort 已结算），兜底清理防挂起
  clearPendingToolApprovals(run);
  cancelPendingQuestions(threadId);
  sendChunk(reqId, { type: "start" });

  // 每段 prompt 是消息流里的一个 step；resume 段前重置内容 id，避免与上一段撞 id
  let stepStarted = false;
  // data-compaction 生命周期：start/complete/failed 复用同一个 part id，
  // AI SDK 按 id 就地更新 data part → 前端横幅从「正在压缩」原地变成「压缩完成」
  let compactionSeq = 0;
  const emitCompaction = (id: string, data: Record<string, unknown>) =>
    sendChunk(reqId, { type: "data-compaction", id, data });
  const runStep = async (text: string) => {
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
    beginRun();
    try {
      await run.agent.prompt(text);
    } catch (err) {
      // 排队链已在协议层消除并发 prompt；此处兜底 abort 收尾等极窄竞态窗口。
      // 守卫抛错时尚未产生任何事件，waitForIdle 后原地重试一次是干净的。
      if (!isAlreadyProcessingError(err)) throw err;
      logErr("agent.prompt hit active-run guard, retrying after idle");
      await run.agent.waitForIdle();
      beginRun();
      await run.agent.prompt(text);
    }
  };

  // 溢出恢复：stream.ts 吞掉溢出错误后置位 → 强制压缩后用同一文本重跑一次，
  // 重跑仍溢出不再恢复（直接报错），防循环
  const runStepWithRecovery = async (text: string) => {
    await runStep(text);
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
        sendChunk(reqId, {
          type: "error",
          errorText: `Context overflow, automatic compaction failed: ${outcome.message}`,
        });
      }
      return;
    }
    emitCompaction(cid, compactionChunkData(outcome));
    await runStep(text);
    if (run.pendingOverflowRecovery) {
      run.pendingOverflowRecovery = false;
      sendChunk(reqId, {
        type: "error",
        errorText: "Context overflow persisted after compaction. Start a new session.",
      });
    }
  };

  try {
    await runStepWithRecovery(String(msg.text ?? ""));
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
      await runStepWithRecovery(resume);
    }
  } catch (err) {
    sendChunk(reqId, { type: "error", errorText: err instanceof Error ? err.message : String(err) });
    // 父代理 turn 失败：中止遗留的后台子代理，让会话能回到空闲（D352）
    for (const d of run.delegations.values()) {
      if (d.status === "running") {
        d.stopRequested = true;
        d.abort();
      }
    }
  } finally {
    if (stepStarted) sendChunk(reqId, { type: "finish-step" });
    sendChunk(reqId, { type: "finish" });
    setCurrentReqId(null);
    persist(run);
  }
}

/** 中止单个线程的 run：父代理、后台子代理、挂起审批/提问与压缩请求全部结算 */
function abortRun(run: Running, threadId: string): void {
  run.stopRequested = true;
  clearPendingToolApprovals(run);
  cancelPendingQuestions(threadId);
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

export async function dispatch(reqId: string, msg: Record<string, unknown>) {
  switch (msg.type) {
    case "ping": {
      send({ id: reqId, type: "pong" });
      break;
    }
    case "abort": {
      // 用户 Stop：中止父代理与全部后台子代理，并让收敛循环退出；
      // 挂起的逐工具审批按拒绝结算、挂起提问按取消结算，避免永久悬挂；
      // 排队中的 prompt 一并取消（各自流立即 abort+finish 收尾，不再执行）
      for (const [threadId, run] of running.entries()) {
        abortRun(run, threadId);
      }
      cancelAllEntries();
      break;
    }
    case "queue_update": {
      // 修改排队项文本（仅 queued 状态可改；已开跑返回错误）
      const requestId = String(msg.requestId ?? "");
      const text = String(msg.text ?? "");
      if (!updateEntryText(requestId, text)) {
        throw new Error(`no queued prompt: ${requestId}`);
      }
      send({ id: reqId, type: "queue_updated", requestId });
      break;
    }
    case "queue_cancel": {
      // 删除单个排队项：其流立即 abort+finish 收尾（前端同步移除线程内消息）
      const requestId = String(msg.requestId ?? "");
      if (!cancelEntry(requestId)) {
        throw new Error(`no queued prompt: ${requestId}`);
      }
      send({ id: reqId, type: "queue_cancelled", requestId });
      break;
    }
    case "queue_promote": {
      // 立即发送：该项提到队首，中止当前活跃 turn（其余排队项保留）
      const requestId = String(msg.requestId ?? "");
      if (!promoteEntry(requestId)) {
        throw new Error(`no queued prompt: ${requestId}`);
      }
      if (activeTurnThreadId) {
        const active = running.get(activeTurnThreadId);
        if (active) abortRun(active, activeTurnThreadId);
      }
      send({ id: reqId, type: "queue_promoted", requestId });
      break;
    }
    case "compact": {
      // 手动压缩上下文：只在空闲回合边界做（prompt 在跑时拒绝），落 checkpoint 行
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
        // 带上 cwd：会话还没建时（比如先点了面板）也能绑上当前工作目录，
        // 不至于落到 homedir（见 sessions.ts rebindRunCwd）
        typeof msg.cwd === "string" ? msg.cwd : undefined,
      );
      if (isPromptActive()) {
        throw new Error("session is busy: wait for the current response to finish");
      }
      const outcome = await runCompaction(run, "manual");
      if (!outcome.ok) throw new Error(outcome.message);
      send({
        id: reqId,
        type: "compacted",
        generation: outcome.generation,
        tokensBefore: outcome.tokensBefore,
        summarized: outcome.summarized,
        summary: outcome.summary,
      });
      break;
    }
    case "get_todo_state": {
      const threadId = String(msg.threadId ?? "default");
      if (!running.has(threadId)) {
        const sessionId =
          typeof msg.sessionId === "string" ? msg.sessionId : "";
        if (!sessionId) throw new Error(`session not found: ${threadId}`);
        // 内存没有该线程：只读回放转录重建槽位（后续 prompt 直接续用）
        replayTodoFromMessages(
          threadId,
          readTranscript(sessionId).map((e) => e.agent),
        );
      }
      const state = getTodoState(threadId);
      send({
        id: reqId,
        type: "todo_state",
        tasks: state.tasks,
        nextId: state.nextId,
      });
      break;
    }
    case "context_info": {
      // 上下文面板读数：present 会话（含恢复）现算，运行中也可查询（只读不阻塞）
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
        typeof msg.cwd === "string" ? msg.cwd : undefined,
      );
      send({ id: reqId, type: "context_info", ...contextInfo(run) });
      break;
    }
    case "list_sessions": {
      // 索引经 hostdb（宿主 RPC），消息计数扫 JSONL 行数（个人桌面应用量级可接受）
      const sessions: SessionSummary[] = (await sessionList())
        .map((r) => {
          const file = sessionPath(r.id);
          let messageCount = 0;
          if (existsSync(file)) {
            const content = readFileSync(file, "utf8");
            for (const line of content.split("\n")) {
              if (line.includes('"type":"message"')) messageCount++;
            }
          }
          return {
            sessionId: r.id,
            name: r.title || undefined,
            firstMessage: r.first_message,
            messageCount,
            modified: r.updated_at,
            cwd: r.cwd,
            archived: r.archived === 1,
          };
        })
        .filter((s) => s.messageCount > 0);
      send({ id: reqId, type: "sessions", sessions });
      break;
    }
    case "new_session": {
      const threadId = String(msg.threadId ?? `thread-${Date.now()}`);
      const cwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
      const run = await resolveSession(threadId, undefined, cwd);
      send({ id: reqId, type: "session", sessionId: run.sessionId, threadId });
      break;
    }
    case "get_history": {
      const sessionId = String(msg.sessionId ?? "");
      // 从 agent 消息重建：text/reasoning 之外还带 tool part（input/output 对齐 live 流）；
      // 压缩检查点行重建为 data-compaction 分隔线 part，刷新后分隔线不丢
      const messages = historyToUiMessages(
        readTranscript(sessionId),
        readAllCompactions(sessionId),
      );
      send({ id: reqId, type: "history", messages });
      break;
    }
    case "delete_session": {
      const sessionId = String(msg.sessionId ?? "");
      for (const [tid, run] of running) {
        if (run.sessionId === sessionId) running.delete(tid);
      }
      await sessionDelete(sessionId);
      const file = sessionPath(sessionId);
      if (existsSync(file)) unlinkSync(file);
      send({ id: reqId, type: "deleted" });
      break;
    }
    case "rename_session": {
      const sessionId = String(msg.sessionId ?? "");
      const name = String(msg.name ?? "");
      await sessionRename(sessionId, name);
      send({ id: reqId, type: "renamed" });
      break;
    }
    case "archive_session": {
      const sessionId = String(msg.sessionId ?? "");
      const archived = msg.archived !== false;
      await sessionSetArchived(sessionId, archived);
      send({ id: reqId, type: "archived" });
      break;
    }
    case "list_models": {
      const models = getModels();
      const out: {
        provider: string;
        providerName: string;
        id: string;
        name: string;
        reasoning: boolean;
        /** 该模型实际支持的思考档位（pi-ai 按 reasoning + thinkingLevelMap 推导，不含 off） */
        supportedThinkingLevels: string[];
        /** 生效中的思考参数映射（目录原值 + 前端覆盖合并；编辑器种子） */
        thinkingLevelMap: Record<string, string | null> | null;
        contextWindow: number;
        maxTokens: number;
        input: string[];
        cost: Record<string, unknown>;
        enabled: boolean;
        authed: boolean;
      }[] = [];
      const providerMap = new Map<string, { id: string; name: string; authed: boolean }>();
      // models 表行：enabled 位 + 属性覆盖（属性已在启动/保存时合并进目录模型对象）。
      // 行语义是稀疏白名单：provider 有行时，行 enabled=1 可见、无行/enabled=0 隐藏；无任何行 = 全可见。
      const rows = await modelsAll();
      const enabledMap = new Map<string, boolean>();
      const hasRows = new Set<string>();
      for (const r of rows) {
        enabledMap.set(`${r.provider}/${r.modelId}`, r.enabled);
        hasRows.add(r.provider);
      }
      for (const p of models.getProviders()) {
        let authed = false;
        try {
          authed = (await models.getAuth(p.id)) !== undefined;
        } catch {
          authed = false;
        }
        providerMap.set(p.id, { id: p.id, name: p.name, authed });
        for (const m of p.getModels()) {
          out.push({
            provider: p.id,
            providerName: p.name,
            id: m.id,
            name: m.name,
            reasoning: m.reasoning,
            supportedThinkingLevels: getSupportedThinkingLevels(m).filter(
              (l) => l !== "off",
            ),
            thinkingLevelMap: (m.thinkingLevelMap ??
              null) as Record<string, string | null> | null,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            input: m.input,
            cost: m.cost as unknown as Record<string, unknown>,
            enabled: hasRows.has(p.id)
              ? (enabledMap.get(`${p.id}/${m.id}`) ?? false)
              : true,
            authed,
          });
        }
      }
      send({
        id: reqId,
        type: "models",
        models: out,
        providers: [...providerMap.values()],
      });
      break;
    }
    case "get_provider_filter": {
      const provider = String(msg.provider ?? "");
      const rows = await modelsList(provider);
      // 无行 = 从未设置过滤（目录全可见）；有行 = 勾选集为 enabled=1 的行
      const modelIds = rows.length
        ? rows.filter((r) => r.enabled).map((r) => r.modelId)
        : null;
      send({ id: reqId, type: "provider_filter", provider, models: modelIds });
      break;
    }
    case "set_provider_filter": {
      const provider = String(msg.provider ?? "");
      const checked = new Set(
        Array.isArray(msg.models)
          ? (msg.models as unknown[]).filter(
              (s): s is string => typeof s === "string" && !!s.trim(),
            )
          : [],
      );
      if (checked.size === 0) {
        // 空勾选 = 清除过滤记录（目录恢复全可见）
        await modelsDeleteProvider(provider);
        send({ id: reqId, type: "provider_filter", provider, models: null });
        break;
      }
      // 勾选集写 enabled=1 行（属性覆盖保留）；未勾选的既有行保留属性、enabled=0
      const existing = new Map(
        (await modelsList(provider)).map((r) => [r.modelId, r]),
      );
      const items: ModelReplaceItem[] = [];
      for (const id of checked) {
        const base = existing.get(id);
        items.push({
          modelId: id,
          enabled: true,
          name: base?.name ?? null,
          reasoning: base?.reasoning ?? null,
          contextWindow: base?.contextWindow ?? null,
          maxTokens: base?.maxTokens ?? null,
          input: base?.input ?? null,
          cost: base?.cost ?? null,
        });
      }
      for (const row of existing.values()) {
        if (checked.has(row.modelId)) continue;
        items.push({
          modelId: row.modelId,
          enabled: false,
          name: row.name,
          reasoning: row.reasoning,
          contextWindow: row.contextWindow,
          maxTokens: row.maxTokens,
          input: row.input,
          cost: row.cost,
        });
      }
      await modelsReplace(provider, items);
      // 新勾选的目录外模型（内置厂商手动添加的 modelId）按行挂进目录；既有模型重放覆盖
      for (const item of items) {
        applyRowToCatalogModel({
          provider,
          modelId: item.modelId,
          name: item.name ?? null,
          reasoning: item.reasoning ?? null,
          contextWindow: item.contextWindow ?? null,
          maxTokens: item.maxTokens ?? null,
          input: item.input ?? null,
          cost: item.cost ?? null,
        });
      }
      send({
        id: reqId,
        type: "provider_filter",
        provider,
        models: [...checked],
      });
      break;
    }
    case "set_model": {
      const provider = String(msg.provider ?? "");
      const modelId = String(msg.modelId ?? "");
      const model = getModels().getModel(provider, modelId);
      if (!model) throw new Error(`model not found: ${provider}/${modelId}`);
      const auth = await getModels().getAuth(provider).catch(() => undefined);
      if (!auth) throw new Error(`no credentials configured for ${provider}/${modelId}`);
      setCurrentModelKey({ provider, modelId });
      for (const run of running.values()) run.agent.state.model = model;
      send({ id: reqId, type: "model", provider, modelId });
      break;
    }
    case "get_model": {
      const mk = getCurrentModelKey();
      send({
        id: reqId,
        type: "model",
        provider: mk?.provider ?? "",
        modelId: mk?.modelId ?? "",
      });
      break;
    }
    case "set_thinking": {
      const level = String(msg.level ?? "");
      if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
        throw new Error(`unknown thinking level: ${level}`);
      }
      setCurrentThinkingLevel(level as ThinkingLevel);
      // 与 set_model 同款广播：活动 Agent 的 state 赋值对下一轮生效
      for (const run of running.values()) {
        run.agent.state.thinkingLevel = level as ThinkingLevel;
      }
      send({ id: reqId, type: "thinking", level });
      break;
    }
    case "set_thinking_maps": {
      // 模型级思考参数映射整包替换（前端 kv 是事实源，这里是内存副本）：
      // {"provider/modelId": {"off":"none","minimal":null,...}}，见 model-catalog
      const applied = setThinkingMapOverrides(msg.maps);
      send({ id: reqId, type: "thinking_maps", applied });
      break;
    }
    case "get_personalization": {
      send({ id: reqId, type: "personalization", settings: getPersonalization() });
      break;
    }
    case "usage_stats": {
      const stats = await aggregateUsageStats();
      send({ id: reqId, type: "usage_stats", stats });
      break;
    }
    case "set_personalization": {
      const settings = await applyPersonalization(msg.settings);
      // 与 set_thinking 同款广播：个性化段变了就整段重排系统提示词，活动会话
      // 下一轮请求即生效；composeModeSystemPrompt 内部读取当前设置
      for (const run of running.values()) {
        run.agent.state.systemPrompt = composeModeSystemPrompt(run.mode, run.cwd);
      }
      send({ id: reqId, type: "personalization", settings });
      break;
    }
    case "set_credential": {
      const provider = String(msg.provider ?? "");
      const apiKey = String(msg.apiKey ?? "");
      if (!provider || !apiKey) throw new Error("provider and apiKey are required");
      await credentialSet(provider, apiKey);
      send({ id: reqId, type: "credential", provider });
      break;
    }
    case "list_credentials": {
      const providers = await credentialList();
      const credentials = providers.map((providerId) => ({
        providerId,
        type: "api_key" as const,
      }));
      send({ id: reqId, type: "credentials", credentials });
      break;
    }
    case "delete_credential": {
      const provider = String(msg.provider ?? "");
      await credentialDelete(provider);
      send({ id: reqId, type: "credential_deleted", provider });
      break;
    }
    case "fetch_models": {
      // 拉取端点的模型列表（添加 AI 服务弹窗"获取列表"用），按接口格式区分：
      //   openai-chat / openai-responses → GET {baseUrl}/models（baseUrl 含 /v1），Bearer
      //   anthropic-messages → GET {baseUrl}/v1/models，x-api-key + anthropic-version
      const baseUrl = String(msg.baseUrl ?? "").trim().replace(/\/+$/, "");
      const apiKey = String(msg.apiKey ?? "").trim();
      const apiKind = normalizeApi(msg.api);
      if (!/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must start with http(s)://");
      const anthropic = apiKind === "anthropic-messages";
      const url = anthropic
        ? `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/models?limit=1000`
        : `${baseUrl}/models`;
      const res = await fetch(url, {
        headers: anthropic
          ? {
              ...(apiKey ? { "x-api-key": apiKey } : {}),
              "anthropic-version": "2023-06-01",
            }
          : apiKey
            ? { Authorization: `Bearer ${apiKey}` }
            : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`获取模型列表失败: HTTP ${res.status}`);
      const json = (await res.json()) as { data?: unknown };
      const raw = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      const ids = raw
        .map((m) => (typeof m === "string" ? m : (m as { id?: unknown })?.id))
        .filter((s): s is string => typeof s === "string" && !!s.trim());
      send({ id: reqId, type: "fetched_models", models: [...new Set(ids)] });
      break;
    }
    case "add_custom_provider": {
      const name = String(msg.name ?? "").trim();
      const baseUrl = String(msg.baseUrl ?? "").trim();
      const apiKey = String(msg.apiKey ?? "").trim();
      const modelSpecs = Array.isArray(msg.models)
        ? (msg.models as CustomModelSpec[]).filter(
            (m) => m && typeof m.id === "string" && m.id.trim(),
          )
        : [];
      if (!name) throw new Error("name is required");
      if (!/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must start with http(s)://");
      if (!modelSpecs.length) throw new Error("at least one model id is required");
      const api = normalizeApi(msg.api);
      // 注意：协议层 reqId 占用了 "id" 字段，编辑目标的业务 id 走 "providerId"
      const existingId = typeof msg.providerId === "string" ? msg.providerId.trim() : "";
      const id =
        existingId ||
        `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || randomUUID().slice(0, 8)}`;
      // 模型行统一存 models 表（custom_providers.models 旧列保持 '[]'，仅留 schema 兼容）
      await customProviderUpsert({ id, name, baseUrl, models: "[]", api });
      await modelsReplace(
        id,
        modelSpecs.map((m) => ({
          modelId: m.id.trim(),
          enabled: true,
          name: typeof m.name === "string" ? m.name : null,
          reasoning: typeof m.reasoning === "boolean" ? m.reasoning : null,
          contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : null,
          maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : null,
          input: Array.isArray(m.input) ? m.input : null,
          cost: m.cost && typeof m.cost === "object" && !Array.isArray(m.cost) ? m.cost : null,
        })),
      );
      // apiKey 留空表示保留原有凭据
      if (apiKey) {
        await credentialSet(id, apiKey);
      }
      // 停用的服务保存后保持停用：不注册进目录，并从目录移除
      const enabledRow = await customProviderGet(id);
      if (!enabledRow || enabledRow.enabled) {
        await registerCustomProvider(enabledRow ?? { id, name, baseUrl, api });
      } else {
        getModels().deleteProvider(id);
        if (getCurrentModelKey()?.provider === id) setCurrentModelKey(null);
      }
      // 已恢复会话若用旧的同名模型定义，同步刷新其 baseUrl 等字段
      if (getCurrentModelKey()?.provider === id) {
        const model = getModels().getModel(id, getCurrentModelKey()!.modelId);
        if (model) for (const run of running.values()) run.agent.state.model = model;
      }
      send({ id: reqId, type: "custom_provider", provider: id });
      break;
    }
    case "list_custom_providers": {
      const providers = await customProvidersList();
      const out = await Promise.all(
        providers.map(async (r) => {
          // 模型行读 models 表（enabled=1），属性缺省解析为注册默认值供编辑表单回填
          const specs: CustomModelSpec[] = (await modelsList(r.id))
            .filter((row) => row.enabled && row.modelId.trim())
            .map((row) => ({
              id: row.modelId,
              name: row.name?.trim() || row.modelId,
              reasoning: row.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning,
              contextWindow: row.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow,
              maxTokens: row.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens,
              input: parseModelInput(row.input) ?? [...CUSTOM_MODEL_DEFAULTS.input],
              cost: { ...(parseModelCost(row.cost) ?? CUSTOM_MODEL_DEFAULTS.cost) },
            }));
          // 明文返回 key 供编辑弹窗回填（仅存本地库）
          const keyRow = await credentialGet(r.id);
          return {
            providerId: r.id,
            name: r.name,
            baseUrl: r.baseUrl,
            models: specs,
            api: normalizeApi(r.api),
            hasApiKey: keyRow !== null,
            apiKey: keyRow?.apiKey,
            enabled: r.enabled,
          };
        }),
      );
      send({ id: reqId, type: "custom_providers", providers: out });
      break;
    }
    case "delete_custom_provider": {
      const provider = String(msg.provider ?? "");
      await customProviderDelete(provider);
      await modelsDeleteProvider(provider);
      await credentialDelete(provider);
      getModels().deleteProvider(provider);
      if (getCurrentModelKey()?.provider === provider) setCurrentModelKey(null);
      send({ id: reqId, type: "custom_provider_deleted", provider });
      break;
    }
    case "toggle_custom_provider": {
      // 启用/停用服务：停用时从模型目录移除，启用时重新注册（模型行读 models 表）
      const provider = String(msg.provider ?? "");
      const enabled = msg.enabled === true;
      await customProviderSetEnabled(provider, enabled);
      if (enabled) {
        const row = await customProviderGet(provider);
        if (row) await registerCustomProvider(row);
      } else {
        getModels().deleteProvider(provider);
        if (getCurrentModelKey()?.provider === provider) setCurrentModelKey(null);
      }
      send({ id: reqId, type: "custom_provider_toggled", provider, enabled });
      break;
    }
    case "update_model": {
      // 模型属性编辑：消息里携带的字段写入 models 表（null = 重置继承内置值，
      // 未携带 = 保留现值），并原地应用到目录模型对象
      const provider = String(msg.provider ?? "");
      const modelId = String(msg.modelId ?? "");
      if (!provider || !modelId) throw new Error("provider and modelId are required");
      const base = (await modelsList(provider)).find((r) => r.modelId === modelId);
      const pick = (key: string, fallback: unknown): unknown =>
        key in msg ? (msg[key] ?? null) : fallback;
      const item: ModelReplaceItem = {
        modelId,
        enabled: base?.enabled ?? true,
        name: pick("name", base?.name ?? null) as string | null,
        reasoning: pick("reasoning", base?.reasoning ?? null) as boolean | null,
        contextWindow: pick("contextWindow", base?.contextWindow ?? null) as number | null,
        maxTokens: pick("maxTokens", base?.maxTokens ?? null) as number | null,
        input: pick("input", base?.input ?? null) as unknown[] | null,
        cost: pick("cost", base?.cost ?? null) as Record<string, unknown> | null,
      };
      await modelsReplace(provider, [item]);
      applyRowToCatalogModel({
        provider,
        modelId,
        name: item.name ?? null,
        reasoning: item.reasoning ?? null,
        contextWindow: item.contextWindow ?? null,
        maxTokens: item.maxTokens ?? null,
        input: item.input ?? null,
        cost: item.cost ?? null,
      });
      send({ id: reqId, type: "model_updated", provider, modelId });
      break;
    }
    case "test_provider": {
      // 测试服务连通性：按接口格式发一条最小请求
      const baseUrl = String(msg.baseUrl ?? "").trim().replace(/\/+$/, "");
      const apiKey = String(msg.apiKey ?? "").trim();
      const model = String(msg.model ?? "").trim();
      const apiKind = normalizeApi(msg.api);
      if (!/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must start with http(s)://");
      if (!model) throw new Error("model is required");
      let url: string;
      let headers: Record<string, string>;
      let body: unknown;
      if (apiKind === "anthropic-messages") {
        url = `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/messages`;
        headers = {
          "content-type": "application/json",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          "anthropic-version": "2023-06-01",
        };
        body = { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
      } else if (apiKind === "openai-responses") {
        url = `${baseUrl}/responses`;
        headers = {
          "content-type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        };
        body = { model, input: "ping", max_output_tokens: 16 };
      } else {
        url = `${baseUrl}/chat/completions`;
        headers = {
          "content-type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        };
        body = { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        throw new Error(`连接失败: HTTP ${res.status}${text ? ` · ${text}` : ""}`);
      }
      send({ id: reqId, type: "tested", ok: true });
      break;
    }
    case "tool_confirm": {
      // 结算逐工具审批：approved = 放行执行，false = 拦截（模型收到 blocked 工具结果）
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      );
      const approvalId = String(msg.approvalId ?? "");
      if (!resolveToolApproval(run, approvalId, Boolean(msg.approved))) {
        throw new Error(`no pending tool approval: ${approvalId}`);
      }
      send({ id: reqId, type: "tool_confirmed", approvalId });
      break;
    }
    case "question_answer": {
      // 结算 Question 工具的挂起提问：execute 拿到答案后格式化回模型（toolCallId 全局唯一，无需按会话查 run）
      const questionId = String(msg.questionId ?? "");
      const answers = Array.isArray(msg.answers)
        ? (msg.answers as QuestionAnswerItem[])
        : [];
      if (!resolveQuestionAnswer(questionId, answers)) {
        throw new Error(`no pending question: ${questionId}`);
      }
      send({ id: reqId, type: "question_answered", questionId });
      break;
    }
    case "set_mode": {
      // 手动切换会话模式（agent/plan/goal），可选携带审批级别（agent 模式的
      // ask/auto-edit/auto 对应前端"变更前确认/自动编辑/完全访问"）；重建工具集与系统提示词
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
        typeof msg.cwd === "string" ? msg.cwd : undefined,
      );
      const mode = String(msg.mode ?? "agent");
      if (mode !== "agent" && mode !== "plan" && mode !== "goal") {
        throw new Error(`invalid mode: ${mode}`);
      }
      if (typeof msg.approvalLevel === "string") {
        if (msg.approvalLevel !== "ask" && msg.approvalLevel !== "auto-edit" && msg.approvalLevel !== "auto") {
          throw new Error(`invalid approval level: ${msg.approvalLevel}`);
        }
        run.approvalLevel = msg.approvalLevel;
      }
      applyMode(run, mode);
      send({ id: reqId, type: "mode_changed", ...planningPayload(run) });
      break;
    }
    case "approve_plan": {
      // 批准未决提案：回 agent 模式，由前端随后走正常 prompt 管道发批准消息
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      );
      if (run.planning !== "awaiting_approval" || !run.proposal) {
        throw new Error("no proposal awaiting approval");
      }
      run.proposal = null;
      applyMode(run, "agent");
      send({ id: reqId, type: "planning_state", ...planningPayload(run) });
      break;
    }
    case "reject_plan": {
      // 拒绝未决提案：留在当前模式继续修改（planning），用户输入反馈后重新提交
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      );
      if (run.planning !== "awaiting_approval" || !run.proposal) {
        throw new Error("no proposal awaiting approval");
      }
      run.proposal = null;
      run.planning = "planning";
      send({ id: reqId, type: "planning_state", ...planningPayload(run) });
      break;
    }
    default:
      logErr("unknown message type:", String(msg.type));
      send({ id: reqId, type: "error", errorText: `unknown message type: ${String(msg.type)}` });
  }
}
