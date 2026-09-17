/**
 * 会话管理：threadId -> Agent 实例的内存映射与会话解析。
 * sessionId 提供时优先恢复该会话（重启续聊）；否则懒建新会话（索引行 + JSONL header）。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  defaultModel,
  getCurrentModelKey,
  getCurrentThinkingLevel,
  getModels,
  makePromptCacheKeyPayloadHook,
  makeSessionAffinityHeaders,
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
import { loadSubagentDefinitions, type SubagentDefinition } from "./subagent-definitions";
import { ensureSkillsLoaded } from "./skills";
import { buildSubagentTools } from "./subagent";
import { buildSkillMgmtTools } from "./skill-mgmt-tools";
import { buildSchedulerTools } from "./automation/mgmt-tools";
import { readCompaction, readTranscript } from "./transcript";
import { checkpointGeneration, contextInfoFrom, projectRestoreContext, type ContextInfoResult } from "./context";
import { isPromptActive, onAgentEvent, send } from "./stream";
import { isTurnBusy } from "./prompt-queue";
import {
  clearTodoState,
  migrateTodoState,
  replayTodoFromMessages,
} from "./todo";
import { logErr } from "./log";
import { sessionPath } from "./storage";
import { kvGet, sessionGet, sessionInsert, sessionUpdateCwd } from "./hostdb";
import { getAutomationPolicy } from "./automation/policy";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ApprovalLevel, Running, SessionMode } from "./types";

/** kv pi.mode 的载重（applyMode 写入的「最近一次使用的模式偏好」） */
type PlanningModePrefs = { mode: SessionMode; approvalLevel: ApprovalLevel };

/** threadId -> 活动会话（每个前端线程一个 Agent 实例） */
export const running = new Map<string, Running>();

/**
 * sessionId -> threadId 反查索引。
 * run 的驻留键是"发起 prompt 时的前端 thread id"：新草稿首条消息发出后，
 * 刷新使草稿 id 重随机、列表行以 sessionId 为 id——此时 tool_confirm /
 * abort 等后续请求带的都是新 id，只按 threadId 查 running 必然 miss。
 * 没有这个索引，resolveSession 会把同一会话从磁盘再物化出**第二个** Agent
 * （审批结算落到空表抛 no pending tool approval，原 run 的审批 Promise
 * 永久悬挂；双实例还会共写同一份转录）。
 */
const runningBySession = new Map<string, string>();

/** 登记/覆盖会话的反查键（resolveSession 物化 run 后调用） */
export function trackSessionRun(sessionId: string, threadId: string): void {
  runningBySession.set(sessionId, threadId);
}

/** 按 sessionId 找驻留 run；索引指向已消失的键时自愈清除 */
export function findRunBySession(
  sessionId: string,
): { threadId: string; run: Running } | undefined {
  const tid = runningBySession.get(sessionId);
  if (!tid) return undefined;
  const run = running.get(tid);
  if (!run) {
    runningBySession.delete(sessionId);
    return undefined;
  }
  return { threadId: tid, run };
}

/** 从驻留表移除线程，并同步清掉指向它的反查索引 */
export function dropRun(threadId: string): void {
  const run = running.get(threadId);
  running.delete(threadId);
  if (run && runningBySession.get(run.sessionId) === threadId) {
    runningBySession.delete(run.sessionId);
  }
}

/* ----------------------- 会话驻留治理（迭代2 / P2） -----------------------
 * running 不再是"只进不出"：超过上限驱逐最久未访问的会话，被驱逐会话在
 * 前端重新打开时走本文件 resolveSession 的既有恢复路径（JSONL 是事实源，
 * 行为与重启续聊完全一致）。context_info 对未加载会话改走只读投影，
 * 不再为了看一眼面板而物化 Agent。
 */

/** 常驻 Agent 实例上限（个）。软上限：活跃/有跨轮用户意图的会话不可驱逐，
 *  全被跳过时宁可暂超也不踢掉干活中的会话。 */
export const MAX_RESIDENT_SESSIONS = 8;

/** 正在跑 prompt turn 的线程 -> { 会话 id, 本轮 requestId }（sessionId 可为
 *  undefined：发起方未带 sessionId 且会话尚未 resolve；此类轮次不广播、不出现在
 *  list_running，本地前端不受影响——transport 每条 prompt 都携带 sessionId）。
 *  protocol.ts dispatchPrompt 起止处通报；跑着 prompt 的会话永不驱逐
 *  （线程串行链，多线程可并行多个）。
 *  起止同时广播 turn_changed 通知行（无 id，宿主原样转发给所有前端）：
 *  侧边栏"会话运行中"指示的实时信号；页面刷新后的水合走 list_running。
 *  requestId 供 list_running 的 turns 字段回给前端：webview 存储被清时前端
 *  按运行态真相重建在飞流登记（刷新续流不依赖 sessionStorage 存活）。 */
interface ActiveTurn {
  sessionId?: string;
  requestId?: string;
}
const activeTurns = new Map<string, ActiveTurn>();

/** whenThreadIdle 的等待者：threadId -> 唤醒回调（noteActiveTurn(false) 时结算） */
const idleWaiters = new Map<string, Array<() => void>>();

export function noteActiveTurn(
  threadId: string,
  active: boolean,
  sessionId?: string,
  requestId?: string,
): void {
  if (active) {
    const sid = sessionId ?? running.get(threadId)?.sessionId;
    activeTurns.set(threadId, { sessionId: sid, requestId });
    if (sid) send({ type: "turn_changed", sessionId: sid, active: true });
  } else {
    const sid = activeTurns.get(threadId)?.sessionId;
    activeTurns.delete(threadId);
    if (sid) send({ type: "turn_changed", sessionId: sid, active: false });
    const waiters = idleWaiters.get(threadId);
    if (waiters) {
      idleWaiters.delete(threadId);
      for (const wake of waiters) wake();
    }
  }
}

/** 该线程当前轮次彻底收尾（dispatchPrompt finally 走过 noteActiveTurn(false)）
 *  时 resolve；已空闲立即 resolve。刷新改绑要等旧键轮次跑完才动 run.threadId，
 *  见 protocol.runPromptTurn。busyThreads 一并判：markTurnStart 早于
 *  noteActiveTurn(true) 的间隙里 activeTurns 还没有条目，只看它会放改绑插进
 *  两节链之间把执行顺序倒过去；唤醒只挂在 noteActiveTurn(false) 上，而
 *  dispatchPrompt 的 finally 保证 markTurnStart 之后必然走到它（早退的链节
 *  也会 noteActiveTurn(false) 空转一次），等待者不会睡死。 */
export function whenThreadIdle(threadId: string): Promise<void> {
  if (!activeTurns.has(threadId) && !isTurnBusy(threadId)) return Promise.resolve();
  return new Promise((resolve) => {
    const list = idleWaiters.get(threadId);
    if (list) list.push(resolve);
    else idleWaiters.set(threadId, [resolve]);
  });
}

/** 当前正在跑 turn 的会话 id 清单（list_running 应答） */
export function listActiveTurnSessions(): string[] {
  return [...activeTurns.values()]
    .map((t) => t.sessionId)
    .filter((s): s is string => !!s);
}

/** 会话与请求 id 齐备的在跑轮次明细（list_running 应答 turns 字段） */
export function listActiveTurnDetails(): { sessionId: string; requestId: string }[] {
  return [...activeTurns.values()].flatMap((t) =>
    t.sessionId && t.requestId ? [{ sessionId: t.sessionId, requestId: t.requestId }] : [],
  );
}

/** 可驱逐判定：进行中的工作与跨轮的审批意图都要跳过。
 *  恢复路径不会带回 planning/pendingToolApprovals（resolveSession
 *  恒以初始态重建），所以这些状态在驻留期间被驱逐等于静默丢失。 */
function isEvictable(threadId: string, run: Running): boolean {
  if (activeTurns.has(threadId)) return false;
  for (const d of run.delegations.values()) if (d.status === "running") return false;
  if (run.pendingToolApprovals.size > 0) return false;
  if (run.planning !== "inactive") return false;
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
    dropRun(tid);
    forgetThreadStates(tid);
    logErr("session-evict:", `${tid} -> ${run.sessionId}`);
    excess -= 1;
  }
}

/**
 * agent 模式挂载的扩展工具组 = Task 组（含子智能体管理三件套）+ 技能管理三件套
 * + 排期管理组（scheduler_*，无人值守 run 自动为空）。都不进 baseTools：
 * delegate 按定义从基础目录取工具时结构性拿不到它们。
 * run.subagentTools 即本组（字段名沿用，语义为"Task 旁的扩展组"）。
 */
function buildAgentExtensions(
  run: Running,
  baseTools: AgentTool[],
  definitions: SubagentDefinition[],
): AgentTool[] {
  return [
    ...buildSubagentTools(run, baseTools, definitions, reloadSubagents),
    ...buildSkillMgmtTools(run, reloadSkills),
    ...buildSchedulerTools(run),
  ];
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
  const { definitions } = await loadSubagentDefinitions({ cwd });
  run.subagentTools = buildAgentExtensions(run, run.baseTools, definitions);
  run.agent.state.tools = toolsForMode(run);
  // 换了工作区：技能目录随 cwd 变，先预热新缓存再重组提示词
  await ensureSkillsLoaded(cwd);
  run.agent.state.systemPrompt = composeModeSystemPrompt(
    run.mode,
    cwd,
    run.agent.state.model,
  );
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

/** 线程静默判定：无在跑轮次（activeTurns/busyThreads）且无活跃请求路由
 *  （activeReqByThread）——三个 busy 窗口都覆盖才算静默，可安全改绑键。 */
function threadQuiescent(threadId: string): boolean {
  return !activeTurns.has(threadId) && !isTurnBusy(threadId) && !isPromptActive(threadId);
}

/**
 * 把驻留 run 改绑到新的前端 threadId（刷新后键漂移的唯一正确落点）。
 * 背景：刷新后同一会话的 threadId 从草稿本地 id 变成 sessionId，而
 * activeReqByThread 登记在新键上、事件路由（onAgentEvent/sendEventChunk）
 * 按 run.threadId 与工具闭包里烘死的 threadId 查——不改绑则全部内容/旁路
 * chunk 静默丢弃，只剩显式 reqId 发的 start/finish（"没回复但弹完成通知"）。
 * 仅在旧线程静默时调用（轮中改绑会把旧轮事件错路由进新请求流）。
 */
export async function rebindRunThread(
  run: Running,
  oldThreadId: string,
  newThreadId: string,
): Promise<void> {
  if (oldThreadId === newThreadId) return;
  running.delete(oldThreadId);
  running.set(newThreadId, run);
  run.threadId = newThreadId;
  trackSessionRun(run.sessionId, newThreadId);
  migrateTodoState(oldThreadId, newThreadId);
  // 工具整组重建：browser/question/todo/mcp 的闭包烘着 threadId，
  // 事件推送与挂起归属（cancelPending* 按 threadId 过滤）都靠它
  run.baseTools = buildTools(run.cwd, newThreadId);
  const { definitions } = await loadSubagentDefinitions({ cwd: run.cwd });
  run.subagentTools = buildAgentExtensions(run, run.baseTools, definitions);
  run.agent.state.tools = toolsForMode(run);
  run.lastSeenAt = Date.now();
  logErr("session-rebind:", `${oldThreadId} -> ${newThreadId} (${run.sessionId})`);
}

/**
 * 设置页改动（保存/删除/开关/信任）后的热重载：按各会话自己的 cwd 重取定义、
 * 重建 Task 工具组并重排工具目录（与 rebindRunCwd 同款手法）。
 * 运行中的 turn 不受影响（工具快照已发出），下一个 turn 即看到新集合；
 * 进行中的委派按启动时的定义跑完，报告照常投递。
 */
export async function reloadSubagents(): Promise<void> {
  for (const run of running.values()) {
    const { definitions, diagnostics } = await loadSubagentDefinitions({ cwd: run.cwd });
    for (const d of diagnostics) logErr("subagent:", d);
    run.subagentTools = buildAgentExtensions(run, run.baseTools, definitions);
    run.agent.state.tools = toolsForMode(run);
  }
}

/**
 * 设置页改动（保存/删除/开关）后的技能热重载：刷各会话 cwd 的技能缓存，
 * 重组系统提示词并热替换（与 applyMode 同款手法，轮中经 loopContext 立即生效）。
 * 目录签名没变时 ensureSkillsLoaded 零 IO；开关状态在 merge 时生效，无需失效目录。
 */
export async function reloadSkills(): Promise<void> {
  const cwds = new Set<string>();
  for (const run of running.values()) cwds.add(run.cwd);
  await Promise.all([...cwds].map((c) => ensureSkillsLoaded(c || undefined)));
  for (const run of running.values()) {
    const prompt = composeModeSystemPrompt(run.mode, run.cwd, run.agent.state.model);
    run.agent.state.systemPrompt = prompt;
    if (run.loopContext) run.loopContext.systemPrompt = prompt;
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
/**
 * 无目录任务会话的执行目录：应用数据目录下的 task-workspace（Rust 拉起时
 * 经 PI_TASK_CWD 注入），测试/裸跑兜底 ~/.xulux/task-workspace。
 * 绝不落家目录本体：agent 的文件读写不该散在 home，工作区作用域配置
 * （<cwd>/.xulux/*）也不能与全局层重叠——全局记忆/子智能体/MCP 恰好都在
 * ~/.xulux/*，用家目录兜底会让任务会话把它们同时当作"工作区层"再加载一遍。
 */
function defaultTaskCwd(): string {
  const dir = process.env.PI_TASK_CWD
    ? resolve(process.env.PI_TASK_CWD)
    : join(homedir(), ".xulux", "task-workspace");
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

  // 刷新后前端 thread id 变了（草稿重随机 / 行 id=sessionId）：按反查索引
  // 找回仍驻留的原 run。绝不允许同一会话物化出第二个 Agent（见索引注释）。
  if (sessionId) {
    const owner = findRunBySession(sessionId);
    if (owner) {
      // 键漂移即在此收口：旧线程静默时直接把 run 改绑到新 threadId；
      // 旧轮还在跑则保持原键（改绑会把旧轮事件错路由进新请求），
      // 由调用方 runPromptTurn 等旧轮收尾后补 rebindRunThread
      if (owner.threadId !== threadId && threadQuiescent(owner.threadId)) {
        await rebindRunThread(owner.run, owner.threadId, threadId);
      }
      if (cwd && !owner.run.persistedCwd) {
        // 用 run 的当前驻留键（改绑后即新键；未改绑仍是旧键）重建工具，
        // 保证工具闭包与 run.threadId 永远同键
        await rebindRunCwd(owner.run, cwd, owner.run.threadId);
      }
      // 按 run 的当前驻留键续龄（未改绑时新键不在 running 表里）
      touchSession(owner.run.threadId);
      return owner.run;
    }
  }

  // 持久化 cwd = 用户选择的工作目录（空串 = 未选目录的任务会话）；
  // 运行 cwd 兜底主目录，仅影响 Agent 执行环境，不回写持久化
  let persistedCwd = cwd ?? "";
  let restoredMessages: import("@earendil-works/pi-ai").Message[] = [];
  let persistedSeq = 0;
  let jsonlSeq = 0;
  let compactionGeneration = 0;
  /** 恢复的索引行（含会话级偏好）；新会话为 null */
  let restoredRow: Awaited<ReturnType<typeof sessionGet>> = null;

  if (sessionId) {
    const row = await sessionGet(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);
    restoredRow = row;
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

  const resolvedCwd = persistedCwd || defaultTaskCwd();

  // 会话级模式偏好：恢复的会话取偏好行（NULL = 从未变更过 → 默认），
  // 新会话跟随「最近一次使用」（kv pi.mode，applyMode 维护）。
  // 无人值守自动化 turn 强制 agent/ask：plan 模式的 HITL 会永久挂起。
  let initialMode: SessionMode = "agent";
  let initialApproval: ApprovalLevel = "ask";
  if (!getAutomationPolicy(threadId)) {
    if (restoredRow) {
      if (restoredRow.mode === "agent" || restoredRow.mode === "plan") {
        initialMode = restoredRow.mode;
      }
      if (
        restoredRow.approvalLevel === "ask" ||
        restoredRow.approvalLevel === "auto-edit" ||
        restoredRow.approvalLevel === "auto"
      ) {
        initialApproval = restoredRow.approvalLevel;
      }
    } else {
      try {
        const raw = await kvGet("pi.mode");
        const last = raw?.value ? (JSON.parse(raw.value) as Partial<PlanningModePrefs>) : null;
        if (last?.mode === "agent" || last?.mode === "plan") initialMode = last.mode;
        if (
          last?.approvalLevel === "ask" ||
          last?.approvalLevel === "auto-edit" ||
          last?.approvalLevel === "auto"
        ) {
          initialApproval = last.approvalLevel;
        }
      } catch {
        // kv 不可用/损坏：保持默认
      }
    }
  }

  // 会话级模型偏好：恢复的会话上次用哪个模型就继续用哪个（目录中已删除则回落全局）；
  // 新会话/自动化 turn 用全局当前选择（自动化的 per-task 模型由 runner 在 resolve 后覆盖）
  let model = await resolveCurrentModel();
  if (restoredRow && !getAutomationPolicy(threadId)) {
    const saved =
      restoredRow.modelProvider && restoredRow.modelId
        ? getModels().getModel(restoredRow.modelProvider, restoredRow.modelId)
        : undefined;
    if (saved) {
      model = saved;
    } else if (restoredRow.modelProvider && restoredRow.modelId) {
      logErr(
        "resolveSession: session model missing from catalog, falling back to current:",
        `${restoredRow.modelProvider}/${restoredRow.modelId}`,
      );
    }
  }

  // 技能目录预热（签名缓存，命中零 IO）：系统提示词的技能段从这里取数
  await ensureSkillsLoaded(resolvedCwd);

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
    lengthContinues: 0,
    mode: initialMode,
    approvalLevel: initialApproval,
    planning: initialMode === "plan" ? "planning" : "inactive",
    baseTools,
    subagentTools: [],
    pendingToolApprovals: new Map(),
    lastSeenAt: Date.now(),
  };

  const agent = new Agent({
    // sessionId 透传：OpenAI prompt_cache_key / Anthropic session-affinity（缓存路由）
    sessionId,
    // 批次执行开关（参考 pi 的 toolExecution 语义，上游默认 parallel）：
    // 部分 OpenAI 兼容端点前缀缓存经不起并发（实测 sensenova 同回合并行
    // 工具批次全部 miss），置 PI_TOOL_EXECUTION=sequential 整批串行
    toolExecution:
      process.env.PI_TOOL_EXECUTION === "sequential" ? "sequential" : "parallel",
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
          // 无条件补发会话亲和头（参考 opencode），让兼容端点把同会话请求
          // 路由到同一缓存分片；端点若已按 compat 下发同名头则同值覆盖
          headers: {
            ...options?.headers,
            ...makeSessionAffinityHeaders(sessionId),
          },
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
      systemPrompt: composeModeSystemPrompt(initialMode, resolvedCwd, model),
      model,
      // 深度思考档位（全局，set_thinking 维护；off = 不发送 reasoning 参数）
      thinkingLevel: getCurrentThinkingLevel(),
      tools: baseTools,
      messages: restoredMessages,
    },
    beforeToolCall: async (context) => approvalBeforeToolCall(run, context),
  });
  run.agent = agent;

  const { definitions, diagnostics } = await loadSubagentDefinitions({ cwd: run.cwd });
  for (const d of diagnostics) logErr("subagent:", d);
  run.subagentTools = buildAgentExtensions(run, baseTools, definitions);
  // 在基础工具目录上追加 Task 工具组（含子智能体/技能管理工具）+ 模式切换工具
  // （delegate 的工具按定义从基础目录里取，绝不包含本组，
  //   delegate 不能继续委派、也不能管理定义与技能）
  agent.state.tools = toolsForMode(run);

  agent.subscribe((event) => onAgentEvent(event, run));
  running.set(threadId, run);
  trackSessionRun(sessionId, threadId);
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

  const resolvedCwd = row.cwd || defaultTaskCwd();
  // 技能段预热：投影读数与随后真正打开该会话时逐字段一致（同款 ensureSkillsLoaded）
  await ensureSkillsLoaded(resolvedCwd);
  const baseTools = buildTools(resolvedCwd, threadId);
  const { definitions } = await loadSubagentDefinitions({ cwd: resolvedCwd });
  // 只借 toolsForMode/buildSubagentTools 的组装逻辑：它们的 execute 闭包
  // 运行期才解引用 run，投影下这些闭包永远不会被调用。
  // 模式取会话偏好行（与 resolveSession 的恢复口径一致；自动化 turn 的守卫
  // 不在此做——投影只读，且策略注册窗口与打开面板的时机本就不同步）
  const projectedMode: SessionMode = row.mode === "plan" ? "plan" : "agent";
  const stub = {
    mode: projectedMode,
    planning: projectedMode === "plan" ? "planning" : "inactive",
    baseTools,
    subagentTools: [],
  } as unknown as Running;
  stub.subagentTools = buildAgentExtensions(stub, baseTools, definitions);

  return contextInfoFrom({
    model,
    messages: messages as unknown as Parameters<typeof contextInfoFrom>[0]["messages"],
    systemPrompt: composeModeSystemPrompt(projectedMode, resolvedCwd, model),
    tools: toolsForMode(stub),
    sessionId,
    compactionGeneration: generation,
  });
}
