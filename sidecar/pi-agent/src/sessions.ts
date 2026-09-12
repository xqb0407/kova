/**
 * 会话管理：threadId -> Agent 实例的内存映射与会话解析。
 * sessionId 提供时优先恢复该会话（重启续聊）；否则懒建新会话（索引行 + JSONL header）。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  defaultModel,
  getCurrentModelKey,
  getCurrentThinkingLevel,
  getModels,
  makePromptCacheKeyPayloadHook,
} from "./model-catalog";
import { buildTools } from "./tools";
import {
  approvalBeforeToolCall,
  composeModeSystemPrompt,
  toolsForMode,
} from "./modes";
import {
  captureProviderResponse,
  carriesRetryDelayHeaders,
  createProviderRetryStream,
  createRetryBudget,
  makeUiRetryController,
} from "./provider-retry";
import { getSubagentDefinitions } from "./subagent-definitions";
import { buildSubagentTools } from "./subagent";
import { readCompaction, readTranscript } from "./transcript";
import { checkpointGeneration, contextInfoFrom, projectRestoreContext, type ContextInfoResult } from "./context";
import { onAgentEvent } from "./stream";
import { clearTodoState, replayTodoFromMessages } from "./todo";
import { logErr } from "./log";
import { sessionPath } from "./storage";
import { sessionGet, sessionInsert, sessionUpdateCwd } from "./hostdb";
import type { Running } from "./types";

/** threadId -> 活动会话（每个前端线程一个 Agent 实例） */
export const running = new Map<string, Running>();

/* ----------------------- 会话驻留治理（迭代2 / P2） -----------------------
 * running 不再是"只进不出"：超过上限驱逐最久未访问的会话，被驱逐会话在
 * 前端重新打开时走本文件 resolveSession 的既有恢复路径（JSONL 是事实源，
 * 行为与重启续聊完全一致）。context_info 对未加载会话改走只读投影，
 * 不再为了看一眼面板而物化 Agent。
 */

/** 常驻 Agent 实例上限（个）。软上限：活跃/有跨轮用户意图的会话不可驱逐，
 *  全被跳过时宁可暂超也不踢掉干活中的会话。 */
export const MAX_RESIDENT_SESSIONS = 8;

/** 正在跑 prompt turn 的线程集合：protocol.ts dispatchPrompt 起止处通报。
 *  跑着 prompt 的会话永不驱逐（线程串行链，多线程可并行多个）。 */
const activeTurnThreads = new Set<string>();
export function noteActiveTurn(threadId: string, active: boolean): void {
  if (active) activeTurnThreads.add(threadId);
  else activeTurnThreads.delete(threadId);
}

/** 可驱逐判定：进行中的工作与跨轮的审批意图都要跳过。
 *  恢复路径不会带回 planning/proposal/pendingToolApprovals（resolveSession
 *  恒以初始态重建），所以这些状态在驻留期间被驱逐等于静默丢失。 */
function isEvictable(threadId: string, run: Running): boolean {
  if (activeTurnThreads.has(threadId)) return false;
  for (const d of run.delegations.values()) if (d.status === "running") return false;
  if (run.pendingToolApprovals.size > 0) return false;
  if (run.planning !== "inactive" || run.proposal !== null) return false;
  return true;
}

/** 访问即续龄（resolveSession 命中与 context_info live 路径共用） */
export function touchSession(threadId: string): void {
  const run = running.get(threadId);
  if (run) run.lastSeenAt = Date.now();
}

/** 驱逐/删除的旁路状态清理：todo 可由转录事件溯源回放重建（下次 resolve
 *  时 replayTodoFromMessages），驻留期清掉防止 per-thread Map 泄漏；
 *  approval 挂在 run 上、question 挂在轮内——两者所在会话不可驱逐，无残留。 */
export function forgetThreadStates(threadId: string): void {
  clearTodoState(threadId);
}

/** 超上限即从最久未访问处驱逐（justLoaded 线程豁免：它代表用户当前意图）。
 *  在 resolveSession 末尾调用，Agent 实例随 run 引用消失由 GC 回收。 */
function enforceResidency(justLoaded: string): void {
  let excess = running.size - MAX_RESIDENT_SESSIONS;
  if (excess <= 0) return;
  const doomed = [...running.entries()]
    .filter(([tid, run]) => tid !== justLoaded && isEvictable(tid, run))
    .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
  for (const [tid, run] of doomed) {
    if (excess <= 0) break;
    running.delete(tid);
    forgetThreadStates(tid);
    logErr("session-evict:", `${tid} -> ${run.sessionId}`);
    excess -= 1;
  }
}

/**
 * 给已存在的 run 补绑工作目录：工具闭包/系统提示词里的 cwd 是建会话时烘焙的，
 * 未选目录建立的会话（persistedCwd 空 → 运行 cwd 兜底主目录）一旦前端带上目录，
 * 必须整组重建工具并重排提示词，否则 write/bash 仍落在主目录（曾致代码写到 C:\Users）。
 * 只改 cwd 相关物，不动 mode/approval 状态。
 */
async function rebindRunCwd(run: Running, cwd: string, threadId: string): Promise<void> {
  run.persistedCwd = cwd;
  run.cwd = cwd;
  // 重建工具须沿用原 threadId：todo/question 工具按 threadId 归属，误传 sessionId 会挂错 key
  run.baseTools = buildTools(cwd, threadId);
  const { definitions } = await getSubagentDefinitions();
  run.subagentTools = buildSubagentTools(run, run.baseTools, definitions);
  run.agent.state.tools = toolsForMode(run);
  run.agent.state.systemPrompt = composeModeSystemPrompt(run.mode, cwd);
  // 回写索引行与 JSONL header（header 仅展示用，读端取首个 header 行，重写安全）
  await sessionUpdateCwd(run.sessionId, cwd);
  try {
    const file = sessionPath(run.sessionId);
    const lines = readFileSync(file, "utf8").split("\n");
    const head = lines[0] ? JSON.parse(lines[0]) : null;
    if (head?.type === "header") {
      lines[0] = JSON.stringify({ ...head, cwd });
      writeFileSync(file, lines.join("\n"));
    } else {
      appendFileSync(file, JSON.stringify({ type: "header", schema: 1, id: run.sessionId, cwd }) + "\n");
    }
  } catch {
    // 转录文件异常不阻断补绑（DB 已是事实源）
  }
}

/** 复刻 pi-agent-core createMutableAgentState 的 DEFAULT_MODEL 占位（core 未导出）：
 *  无凭据/无模型环境下，live run 的 state.model 由 core 补占位；
 *  resolveCurrentModel 显式补同一形状，保证 live 与只读投影两侧读数不分叉。
 *  （原行为 initialState.model=undefined ⇒ core 兜底同值，行为不变。） */
const CORE_DEFAULT_MODEL = {
  id: "unknown",
  name: "unknown",
  api: "unknown",
  provider: "unknown",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
};

/** 当前模型选择 → 模型对象（resolveSession 与只读投影共用同一取法，
 *  保证投影读数与稍后真正 resolve 出的 run 一致） */
async function resolveCurrentModel(): Promise<NonNullable<Awaited<ReturnType<typeof defaultModel>>>> {
  const mk = getCurrentModelKey();
  let model = mk ? getModels().getModel(mk.provider, mk.modelId) : undefined;
  if (!model) {
    // 已存选择在目录中不存在（模型被删/自定义提供商停用）：记日志并回落默认，
    // 避免 Agent 拿到 undefined 模型；前端 UI 侧经 get_model 校准真值
    if (mk) {
      logErr(
        "resolveSession: saved model missing from catalog, falling back to default:",
        `${mk.provider}/${mk.modelId}`,
      );
    }
    model = (await defaultModel()) ?? undefined;
  }
  return model ?? (CORE_DEFAULT_MODEL as NonNullable<Awaited<ReturnType<typeof defaultModel>>>);
}

/** 拿到 threadId 对应的 Agent；sessionId 提供时优先恢复该会话（重启续聊） */
export async function resolveSession(
  threadId: string,
  sessionId?: string,
  cwd?: string,
): Promise<Running> {
  const existing = running.get(threadId);
  if (existing) {
    // 会话已存在也要补绑：建会话时未选目录（persistedCwd 空）而这次请求带了
    // cwd —— 典型场景是先开了对话/先点了上下文面板，之后才选工作目录
    if (cwd && !existing.persistedCwd) await rebindRunCwd(existing, cwd, threadId);
    touchSession(threadId);
    return existing;
  }

  // 持久化 cwd = 用户选择的工作目录（空串 = 未选目录的任务会话）；
  // 运行 cwd 兜底主目录，仅影响 Agent 执行环境，不回写持久化
  let persistedCwd = cwd ?? "";
  let restoredMessages: import("@earendil-works/pi-ai").Message[] = [];
  let persistedSeq = 0;
  let jsonlSeq = 0;
  let compactionGeneration = 0;

  if (sessionId) {
    const row = await sessionGet(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);
    persistedCwd = row.cwd;
    const transcript = readTranscript(sessionId);
    const checkpoint = readCompaction(sessionId);
    let maxSeq = -1;
    for (const t of transcript) maxSeq = Math.max(maxSeq, t.seq);
    if (checkpoint) {
      maxSeq = Math.max(maxSeq, checkpoint.seq);
      compactionGeneration = checkpointGeneration(checkpoint.details);
    }
    restoredMessages = projectRestoreContext(transcript, checkpoint);
  // 任务清单恢复：事件溯源回放转录里最后一个 todo 快照（见 todo.ts）
  replayTodoFromMessages(threadId, restoredMessages);
    persistedSeq = restoredMessages.length;
    jsonlSeq = maxSeq + 1;
  } else {
    // 新会话：建索引行 + JSONL header
    sessionId = randomUUID();
    const now = new Date().toISOString();
    await sessionInsert(sessionId, persistedCwd);
    writeFileSync(
      sessionPath(sessionId),
      JSON.stringify({ type: "header", schema: 1, id: sessionId, cwd: persistedCwd, created_at: now }) + "\n",
    );
  }

  const resolvedCwd = persistedCwd || homedir();

  const model = await resolveCurrentModel();

  const baseTools = buildTools(resolvedCwd, threadId);
  // run 先占位再回填 agent：beforeToolCall 闭包按引用捕获 run，模式校验在运行期才解引用
  const run: Running = {
    agent: undefined as unknown as Agent,
    threadId,
    sessionId: sessionId!,
    cwd: resolvedCwd,
    persistedCwd,
    persistedSeq,
    jsonlSeq,
    compactionGeneration,
    pendingOverflowRecovery: false,
    providerRetry: createRetryBudget(),
    retryCapture: {},
    providerRetryChunkId: "retry-0",
    providerRetryActive: false,
    providerRetryTurnSeq: 0,
    delegations: new Map(),
    stopRequested: false,
    mode: "agent",
    approvalLevel: "ask",
    planning: "inactive",
    proposal: null,
    baseTools,
    subagentTools: [],
    pendingToolApprovals: new Map(),
    lastSeenAt: Date.now(),
  };

  const agent = new Agent({
    // sessionId 透传：OpenAI prompt_cache_key / Anthropic session-affinity（缓存路由）
    sessionId,
    // 自定义 OpenAI 兼容端点补发 prompt_cache_key（pi-ai 只对 api.openai.com 下发）
    onPayload: makePromptCacheKeyPayloadHook(sessionId),
    // 显式重试环包住 provider 流：流建立前失败按预算退避重发，
    // 过程以 data-retry chunk 推给前端（见 provider-retry.ts）
    streamFn: (m, context, options) => {
      // 诊断日志：思考档位是否真的随开关到达 provider 请求
      //（关着仍出思考时先看这行：reasoning: undefined 且模型默认开思考 = 缺显式关闭参数，
      //  用 设置→模型→支持深度思考 旁的「关闭时下发」补上，如 none）
      logErr(
        "provider-request:",
        `${m.provider}/${m.id}`,
        "reasoning:",
        (options as { reasoning?: string })?.reasoning,
        "model.reasoning:",
        m.reasoning,
      );
      run.retryCapture.status = undefined;
      run.retryCapture.headers = undefined;
      return createProviderRetryStream(
        m,
        context,
        {
          ...options,
          // 可选长缓存（Anthropic 1h TTL / OpenAI 24h retention），compat 守门自动降级
          ...(process.env.PI_CACHE_RETENTION === "long" ? { cacheRetention: "long" } : {}),
          // 捕获失败响应的 status/头（pi-ai 的 onResponse 不暴露失败 429），
          // 供分类与 Retry-After 退避使用
          fetch: captureProviderResponse(options?.fetch, (response) => {
            run.retryCapture.status = response?.status;
            run.retryCapture.headers = carriesRetryDelayHeaders(response?.status)
              ? response?.headers
              : undefined;
          }),
        },
        (retryOptions) => getModels().streamSimple(m, context, retryOptions),
        makeUiRetryController(run),
      );
    },
    initialState: {
      systemPrompt: composeModeSystemPrompt("agent", resolvedCwd),
      model,
      // 深度思考档位（全局，set_thinking 维护；off = 不发送 reasoning 参数）
      thinkingLevel: getCurrentThinkingLevel(),
      tools: baseTools,
      messages: restoredMessages,
    },
    beforeToolCall: async (context) => approvalBeforeToolCall(run, context),
  });
  run.agent = agent;

  const { definitions, diagnostics } = await getSubagentDefinitions();
  for (const d of diagnostics) logErr("subagent:", d);
  run.subagentTools = buildSubagentTools(run, baseTools, definitions);
  // 在基础工具目录上追加 Task 工具组 + 模式切换工具（delegate 的工具按定义从基础目录里取，
  // 绝不包含 Task 组，delegate 不能继续委派）
  agent.state.tools = toolsForMode(run);

  agent.subscribe((event) => onAgentEvent(event, run));
  running.set(threadId, run);
  // 恢复的历史会话同样补绑：老会话建时未选目录（row.cwd 空）而这次请求带了 cwd
  if (cwd && !persistedCwd) await rebindRunCwd(run, cwd, threadId);
  // 迭代2：本次 resolve 代表用户当前意图，豁免驱逐；驱逐从最久未访问处开始
  enforceResidency(threadId);
  return run;
}

/**
 * 未加载会话的 context_info 只读投影（迭代2 / P2）：
 * 从 JSONL 转录 + 压缩检查点直接计算，工具集/系统提示词按"该会话若被
 * resolveSession 物化后所处的初始态"（agent 模式、全局模型、索引行 cwd）
 * 组装——读数与随后真正打开该会话时逐字段一致，但不建 Agent、不写
 * running，点开上下文面板不再造成会话驻留。
 */
export async function projectContextInfo(
  threadId: string,
  sessionId: string,
): Promise<ContextInfoResult> {
  const row = await sessionGet(sessionId);
  if (!row) throw new Error(`session not found: ${sessionId}`);
  const transcript = readTranscript(sessionId);
  const checkpoint = readCompaction(sessionId);
  const messages = projectRestoreContext(transcript, checkpoint);
  const generation = checkpoint ? checkpointGeneration(checkpoint.details) : 0;
  const model = await resolveCurrentModel();

  const resolvedCwd = row.cwd || homedir();
  const baseTools = buildTools(resolvedCwd, threadId);
  const { definitions } = await getSubagentDefinitions();
  // 只借 toolsForMode/buildSubagentTools 的组装逻辑：它们的 execute 闭包
  // 运行期才解引用 run，投影下这些闭包永远不会被调用
  const stub = {
    mode: "agent",
    planning: "inactive",
    proposal: null,
    baseTools,
    subagentTools: [],
  } as unknown as Running;
  stub.subagentTools = buildSubagentTools(stub, baseTools, definitions);

  return contextInfoFrom({
    model,
    messages: messages as unknown as Parameters<typeof contextInfoFrom>[0]["messages"],
    systemPrompt: composeModeSystemPrompt("agent", resolvedCwd),
    tools: toolsForMode(stub),
    sessionId,
    compactionGeneration: generation,
  });
}
