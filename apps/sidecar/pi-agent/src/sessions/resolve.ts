/**
 * 会话解析与装配：resolveSession（懒建/恢复/反查改绑/工具组装/钩子接线）、
 * 只读投影 projectContextInfo、重建 helpers（rebindRunCwd/rebindRunThread/
 * reloadSubagents/reloadSkills）。会话注册表与驻留治理见 registry.ts。
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  defaultModel,
  getCurrentModelKey,
  getCurrentThinkingLevel,
  getModels,
  makePromptCacheKeyPayloadHook,
  makeSessionAffinityHeaders,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../model/model-catalog";
import { buildTools } from "../tools/tools";
import {
  approvalBeforeToolCall,
  composeModeSystemPrompt,
  toolsForMode,
} from "../agent/modes";
import {
  captureProviderResponse,
  carriesRetryDelayHeaders,
  createProviderRetryStream,
  createRetryBudget,
  makeUiRetryController,
} from "../model/provider-retry";
import { loadSubagentDefinitions, type SubagentDefinition } from "../subagent/subagent-definitions";
import { ensureSkillsLoaded } from "../skills/skills";
import { buildSubagentTools } from "../subagent/subagent";
import { buildSkillMgmtTools } from "../skills/skill-mgmt-tools";
import { buildPluginMgmtTools } from "../plugins/plugin-mgmt-tools";
import { buildSchedulerTools } from "../automation/mgmt-tools";
import { readCompaction, readTranscript, scanTranscript } from "./transcript";
import type { PendingInteraction } from "pi-protocol";
import { restoreUnsettled } from "./pending-interactions";
import { checkpointGeneration, contextInfoFrom, projectRestoreContext, setLeadingSystemMessage, type ContextInfoResult } from "../agent/context";
import { isPromptActive, onAgentEvent, send } from "../protocol/stream";
import { wireSessionEvents } from "../protocol/thread-events";
import {
  enforceResidency,
  findRunBySession,
  running,
  threadQuiescent,
  touchSession,
  trackSessionRun,
} from "./registry";
import { migrateTodoState, replayTodoFromMessages } from "../todo/todo";
import { logErr } from "../log";
import { sessionPath } from "../storage/storage";
import {
  kvGet,
  sessionGet,
  sessionInsert,
  sessionPrefsSet,
  sessionUpdateCwd,
} from "../storage/hostdb";
import { buildHookPayload, fireHookEvent, runHooks } from "../agent/hooks";
import { getAutomationPolicy } from "../automation/policy";
import { decodeThemeColumn, getLastUsedDesignTheme } from "../design-md/state";
import type { ThemeRef } from "../design-md/store";
import type { ApprovalLevel, Running, SessionMode } from "../types";

/** kv pi.mode 的载重（applyMode 写入的「最近一次使用的模式偏好」） */
type PlanningModePrefs = { mode: SessionMode; approvalLevel: ApprovalLevel };

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
    ...buildPluginMgmtTools(run, async () => {
      // 插件安装影响技能与子智能体两条链；MCP 连接池 diff 由工具内部直接做
      await reloadSkills();
      await reloadSubagents();
    }),
    ...buildSchedulerTools(run),
  ];
}

/**
 * 回写 cwd 到索引行与 JSONL header（不依赖驻留 run）。
 * header 仅展示用，读端取首个 header 行，重写安全；转录文件异常不阻断（DB 已是事实源）。
 */
async function persistSessionCwd(sessionId: string, cwd: string): Promise<void> {
  await sessionUpdateCwd(sessionId, cwd);
  try {
    const file = sessionPath(sessionId);
    const lines = readFileSync(file, "utf8").split("\n");
    const head = lines[0] ? JSON.parse(lines[0]) : null;
    if (head?.type === "header") {
      lines[0] = JSON.stringify({ ...head, cwd });
      writeFileSync(file, lines.join("\n"));
    } else {
      appendFileSync(file, JSON.stringify({ type: "header", schema: 1, id: sessionId, cwd }) + "\n");
    }
  } catch {
    // 见上
  }
}

/**
 * 给已存在的 run 换绑工作目录：工具闭包/系统提示词里的 cwd 是建会话时烘焙的，
 * 换目录必须整组重建工具并重排提示词，否则 write/bash 仍落在旧目录（曾致代码写到 C:\Users）。
 * cwd 传空串 = 解绑：持久化 cwd 清空、运行 cwd 回落按会话隔离的任务子目录
 * （与"建会话时就未选目录"的形态完全一致）。
 * 只改 cwd 相关物，不动 mode/approval 状态。
 */
async function rebindRunCwd(run: Running, cwd: string, threadId: string): Promise<void> {
  run.persistedCwd = cwd;
  run.cwd = cwd || taskSessionCwd(run.sessionId);
  // 解绑（清空工作目录）会回落到任务工作区，而回落目标此刻可能尚未落盘
  // （建目录已推迟到轮初）。会话还在跑、工具随后的每一次文件操作都要它存在，
  // 故这里补建——自选了工作目录的会话内部判断自动跳过。
  ensureTaskSessionDir(run);
  // 重建工具须沿用原 threadId：todo/question 工具按 threadId 归属，误传 sessionId 会挂错 key
  run.baseTools = buildTools(run.cwd, threadId, () => run.designTheme ?? null, () => run.designThemeLoads);
  const { definitions } = await loadSubagentDefinitions({ cwd: run.cwd });
  run.subagentTools = buildAgentExtensions(run, run.baseTools, definitions);
  run.agent.state.tools = toolsForMode(run);
  // 换了工作区：技能目录随 cwd 变，先预热新缓存再重组提示词
  await ensureSkillsLoaded(run.cwd);
  setLeadingSystemMessage(
    run.agent.state.messages,
    composeModeSystemPrompt(
      run.mode,
      run.cwd,
      run.agent.state.model,
      run.designTheme,
    ),
  );
  await persistSessionCwd(run.sessionId, cwd);
}

/**
 * 中途换/清会话工作目录（set_session_cwd 命令的服务端内核；cwd=""=解绑）。
 * 经 handleLine 的 mgmt 串行队列与 prompt 的会话准备段互斥，这里的检查与写入
 * 之间不会有轮次插队。规则：
 * - 驻留 run：完整换绑（重建工具/技能/提示词 + 回写索引/header），下一轮即生效；
 * - 不驻留：只改索引行 + header，下次 resolveSession 物化时自然按新值装配；
 * - 本轮在跑：拒绝——prompt 上下文里的工具与提示词已按旧目录烘焙，中途改会执行分裂。
 * 注意：已写进转录的旧绝对路径不会改写，模型若在历史里引用旧路径属固有限制。
 */
export async function setSessionCwd(sessionId: string, cwd: string): Promise<void> {
  const owner = findRunBySession(sessionId);
  if (owner) {
    if (isPromptActive(owner.run.threadId)) {
      throw new Error("session is busy: wait for the current response to finish");
    }
    await rebindRunCwd(owner.run, cwd, owner.run.threadId);
    return;
  }
  if (!(await sessionGet(sessionId))) {
    throw new Error(`session not found: ${sessionId}`);
  }
  await persistSessionCwd(sessionId, cwd);
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
  run.baseTools = buildTools(run.cwd, newThreadId, () => run.designTheme ?? null, () => run.designThemeLoads);
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
    const prompt = composeModeSystemPrompt(run.mode, run.cwd, run.agent.state.model, run.designTheme);
    setLeadingSystemMessage(run.agent.state.messages, prompt);
    if (run.loopContext) setLeadingSystemMessage(run.loopContext.messages, prompt);
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

/**
 * 「模型不可用」的判定：模型对象缺失，或上面那个 CORE_DEFAULT_MODEL 占位
 * （provider 为 "unknown"）。
 *
 * resolveCurrentModel 恒返回 truthy 对象（真模型 → 目录里第一个有凭据的模型 →
 * 占位），所以调用方不能只判 `!model`——那对「一个凭据都没有」的环境恒假，
 * 请求会带着 unknown/unknown 的假模型打 provider，报出与真实原因无关的错误。
 * 上层要区分「发得出去但用的不是用户选的模型」与「根本发不了」，只能靠这里。
 */
export function isModelUnavailable(
  model: { provider?: string } | undefined | null,
): boolean {
  return !model || model.provider === CORE_DEFAULT_MODEL.provider;
}

/** 拿到 threadId 对应的 Agent；sessionId 提供时优先恢复该会话（重启续聊） */
/**
 * 任务工作区根：应用数据目录下的 task-workspace（Rust 拉起时经 PI_TASK_CWD
 * 注入），测试/裸跑兜底 ~/.kova/task-workspace。本身不建目录——惰性建的是
 * 各会话的子目录（见 taskSessionCwd）。
 */
function taskWorkspaceBase(): string {
  return process.env.PI_TASK_CWD
    ? resolve(process.env.PI_TASK_CWD)
    : join(homedir(), ".kova", "task-workspace");
}

/**
 * sessionId → 任务工作区子目录名：sessionId 可能是 IPC 传入的字符串，
 * 必须限为单个安全路径段才能拼进 join（真值恒为 randomUUID 的 UUID）。
 * 返回 null = 不是合法会话名（含分隔符/`..`/点开头序列等）。
 */
function taskSessionSeg(sessionId: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sessionId) || sessionId === "..") return null;
  return sessionId;
}

/**
 * 无目录任务会话的执行目录：<任务工作区根>/<sessionId>，**只算路径、不建目录**。
 * 每个全局会话独享一个目录：产物互不混堆、互不覆盖，删会话可连目录一起收走；
 * 桌面端「我的文件」与产物预览以同源规则（根 + sessionId）定位。
 * 绝不落家目录本体：agent 的文件读写不该散在 home，工作区作用域配置
 * （<cwd>/.kova/*）也不能与全局层重叠——全局记忆/子智能体/MCP 恰好都在
 * ~/.kova/*，用家目录兜底会让任务会话把它们同时当作"工作区层"再加载一遍。
 *
 * 刻意不在这里 mkdir：会话是被**解析**出来的，不是被**使用**出来的。启动时
 * 草稿线程也会走一遍新建分支（此刻还没有任何东西要落盘），无条件建目录会让
 * 每次启动都留一个空壳目录——「我的文件」面板里那堆 UUID 夹就是这么来的
 * （实测 dev 侧已积 219 个目录、其中 157 个全空）。真正的落盘推迟到
 * ensureTaskSessionDir。
 */
function taskSessionCwd(sessionId: string): string {
  // 兜底转写只可能来自被篡改的 IPC（真值恒为 UUID）：加前缀保证单段、无穿越
  const seg = taskSessionSeg(sessionId) ?? `_${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  return join(taskWorkspaceBase(), seg);
}

/**
 * 任务工作区目录的真正落盘点：这一轮确实要开始跑、agent 可能往里写产物时调用。
 * 幂等（recursive），重复调用无副作用。
 *
 * 调用点必须自我设防：只有当 run 的 cwd **就是**任务目录时才建。用户自选了
 * 工作目录的会话（persistedCwd 非空）不该在这里凭空多出一个目录，而它们的
 * cwd 恰好不等于 taskSessionCwd，故天然被这一判断挡掉。
 */
export function ensureTaskSessionDir(run: { cwd: string; sessionId: string }): void {
  if (run.cwd !== taskSessionCwd(run.sessionId)) return;
  mkdirSync(run.cwd, { recursive: true });
}

/**
 * 删除无目录会话的产物目录（删会话时调用）：递归删；force 容忍目录不存在
 * （从未跑过的会话、或早已改绑工作目录、以及项目会话都是空操作）。
 * 非法会话名直接拒绝——这里是删除路径，宁可空操作也不越界。
 */
export function removeTaskSessionDir(sessionId: string): void {
  const seg = taskSessionSeg(sessionId);
  if (!seg) return;
  rmSync(join(taskWorkspaceBase(), seg), { recursive: true, force: true });
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
  // 运行 cwd 兜底按会话隔离的任务子目录，仅影响 Agent 执行环境，不回写持久化
  let persistedCwd = cwd ?? "";
  let restoredMessages: import("@earendil-works/pi-ai").Message[] = [];
  /** 未结算挂起交互行（§4）：物化后重放进台账，挂起卡跨重启不丢 */
  let restoredPending: PendingInteraction[] = [];
  let persistedSeq = 0;
  let jsonlSeq = 0;
  let compactionGeneration = 0;
  /** 恢复的索引行（含会话级偏好）；新会话为 null */
  let restoredRow: Awaited<ReturnType<typeof sessionGet>> = null;
  /** 转录设定行回放值（§6 M4 真值迁移）：null = 无行，旧会话回落偏好/全局 */
  let scanModel: { provider: string; modelId: string } | null = null;
  let scanThinking: string | null = null;

  if (sessionId) {
    const row = await sessionGet(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);
    restoredRow = row;
    persistedCwd = row.cwd;
    // M2：单遍扫描同取消息行/检查点/未结算交互（替代 readTranscript+readCompaction 两读文件）
    const scan = scanTranscript(sessionId);
    const transcript = scan.messages;
    const checkpoint = scan.compactions.at(-1);
    let maxSeq = -1;
    for (const t of transcript) maxSeq = Math.max(maxSeq, t.seq);
    if (checkpoint) {
      maxSeq = Math.max(maxSeq, checkpoint.seq);
      compactionGeneration = checkpointGeneration(checkpoint.details);
    }
    restoredMessages = projectRestoreContext(transcript, checkpoint);
    restoredPending = scan.pending;
    scanModel = scan.model;
    scanThinking = scan.thinkingLevel;
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

  // 运行 cwd = 用户目录，或（未选目录时）按会话隔离的任务子目录；均不回写持久化
  const resolvedCwd = persistedCwd || taskSessionCwd(sessionId!);

  // 会话级模式偏好：恢复的会话取偏好行（NULL = 从未变更过 → 默认），
  // 新会话跟随「最近一次使用」（kv pi.mode，applyMode 维护）。
  // 无人值守自动化 turn 强制 agent/ask：plan 模式的 HITL 会永久挂起。
  let initialMode: SessionMode = "agent";
  let initialApproval: ApprovalLevel = "ask";
  if (!getAutomationPolicy(threadId)) {
    if (restoredRow) {
      if (restoredRow.mode === "agent" || restoredRow.mode === "plan" || restoredRow.mode === "ask") {
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
        if (last?.mode === "agent" || last?.mode === "plan" || last?.mode === "ask") {
          initialMode = last.mode;
        }
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

  // 会话级设计主题：偏好列先行（NULL = 从未设置 → 回落最近使用 kv；""/损坏 = 显式不使用主题），
  // 新会话取最近使用（与 pi.mode「新会话初始模式取最近一次」同型；变更见 handlers/design-md.ts）
  let initialDesignTheme: ThemeRef | null;
  if (restoredRow) {
    const fromColumn = decodeThemeColumn(restoredRow.designTheme);
    initialDesignTheme = fromColumn === undefined ? getLastUsedDesignTheme() : fromColumn;
  } else {
    initialDesignTheme = getLastUsedDesignTheme();
  }

  // 会话级模型：恢复的会话上次用哪个模型就继续用哪个（目录中已删除则回落全局）；
  // 新会话/自动化 turn 用全局当前选择（自动化的 per-task 模型由 runner 在 resolve 后覆盖）。
  // 真值优先级（§6 M4）：转录 model_change 行 > SQLite 偏好行（旧会话无行，回落投影）> 全局
  let model = await resolveCurrentModel();
  if ((scanModel || restoredRow) && !getAutomationPolicy(threadId)) {
    const savedKey = scanModel
      ? scanModel
      : restoredRow?.modelProvider && restoredRow?.modelId
        ? { provider: restoredRow.modelProvider, modelId: restoredRow.modelId }
        : null;
    const saved = savedKey
      ? getModels().getModel(savedKey.provider, savedKey.modelId)
      : undefined;
    if (saved) {
      model = saved;
    } else if (savedKey) {
      logErr(
        "resolveSession: session model missing from catalog, falling back to current:",
        `${savedKey.provider}/${savedKey.modelId}`,
      );
    }
  }

  // 思考档位回放（§6 M4）："重开会话上次档位还在"由行历史回答；
  // 未知档位（被收窄/下线的枚举值）回落全局默认档位（kv pi.thinking）
  const initialThinking: ThinkingLevel =
    scanThinking && (THINKING_LEVELS as readonly string[]).includes(scanThinking)
      ? (scanThinking as ThinkingLevel)
      : getCurrentThinkingLevel();
  // 偏好列回填（会话化档位上线的一次性收敛）：广播时代 set_thinking 给所有驻留
  // 会话都落过行，但从不写 thinking_level 偏好列——行存在而列缺失时按行补列，
  // 列表水合（前端读偏好列）与转录真值即刻对齐；此后默认档变更不再殃及该会话
  if (restoredRow && !restoredRow.thinkingLevel && scanThinking && !getAutomationPolicy(threadId)) {
    void sessionPrefsSet(sessionId!, { thinkingLevel: scanThinking }).catch(() => {});
  }

  // 技能目录预热（签名缓存，命中零 IO）：系统提示词的技能段从这里取数
  await ensureSkillsLoaded(resolvedCwd);

  // use_design_theme 按引用读 run.designTheme（会话内切主题即时换缺省目标；
  // run 此刻尚未回填字段，闭包运行期才解引用，与 beforeToolCall 同款手法）
  const baseTools = buildTools(
    resolvedCwd,
    threadId,
    () => run.designTheme ?? null,
    () => run.designThemeLoads,
  );
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
    designTheme: initialDesignTheme,
    // 全文加载台账：每次新建 run 都是空表（恢复/压缩后宁可重贴不谎报已加载）
    designThemeLoads: new Map<string, string>(),
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
      // 轨迹内容捕获：本次请求的上下文快照（附加到随后打开的 llm_call span）
      run.trace?.noteRequest(context);
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
      systemPrompt: composeModeSystemPrompt(initialMode, resolvedCwd, model, initialDesignTheme),
      model,
      // 深度思考档位：转录行回放，无行跟随全局（set_thinking 维护；off = 不发送 reasoning 参数）
      thinkingLevel: initialThinking,
      tools: baseTools,
      messages: restoredMessages,
    },
    // Claude Code 式 PreToolUse 钩子：block/approve 决策优先于审批链；
    // 无决策时落回既有审批管线（modes.approvalBeforeToolCall）
    beforeToolCall: async (context) => {
      const decision = await runHooks(
        "PreToolUse",
        buildHookPayload({
          event: "PreToolUse",
          sessionId: sessionId!,
          threadId,
          toolName: context.toolCall.name,
          toolArgs: context.args,
        }),
      );
      if (decision?.decision === "block") {
        return { block: true, reason: decision.reason ?? "Blocked by hook" };
      }
      // approve = 跳过审批直接放行（CC 语义），undefined 交回审批链
      if (decision?.decision === "approve") return undefined;
      return approvalBeforeToolCall(run, context);
    },
    // PostToolUse / PostToolUseFailure（isError 分流）：通知式，不改写工具结果
    afterToolCall: async (context) => {
      const summary = context.result.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      fireHookEvent(
        context.isError ? "PostToolUseFailure" : "PostToolUse",
        buildHookPayload({
          event: context.isError ? "PostToolUseFailure" : "PostToolUse",
          sessionId: sessionId!,
          threadId,
          toolName: context.toolCall.name,
          toolArgs: context.args,
          isError: context.isError,
          resultSummary: summary,
        }),
      );
      return undefined;
    },
  });
  run.agent = agent;
  // persistedSeq 按 state.messages 索引对齐：0.99 起 Agent 构造时在转录头
  // unshift leading system 消息（提示词进转录），恢复/新建两侧都以构造后的
  // 实际长度为准，避免首条错位造成尾部重复或漏盘（system 行落盘时跳过）
  run.persistedSeq = agent.state.messages.length;

  const { definitions, diagnostics } = await loadSubagentDefinitions({ cwd: run.cwd });
  for (const d of diagnostics) logErr("subagent:", d);
  run.subagentTools = buildAgentExtensions(run, baseTools, definitions);
  // 在基础工具目录上追加 Task 工具组（含子智能体/技能管理工具）+ 模式切换工具
  // （delegate 的工具按定义从基础目录里取，绝不包含本组，
  //   delegate 不能继续委派、也不能管理定义与技能）
  agent.state.tools = toolsForMode(run);

  agent.subscribe((event) => onAgentEvent(event, run));
  // 原生事件通道（react-pi 迁移阶段 3）：AgentEvent → thread_event 帧
  //（delta 化），桌面端 TauriPiClient 订阅重建流式状态
  wireSessionEvents(run);
  running.set(threadId, run);
  // 水印播种：号段接续转录行号（设计文档 §3；jsonlSeq 是"下一个待分配"）
  trackSessionRun(sessionId, threadId, jsonlSeq - 1);
  // 挂起交互重放（§4）：转录里的未结算项进台账（陈旧条目，无活 promise），
  // 前端 get_history/list_pending 拉回挂起卡；用户结算落行解禁，会话解禁驱逐
  if (restoredPending.length) restoreUnsettled(sessionId, threadId, restoredPending);
  // Claude Code 式 SessionStart 钩子：create = 新建会话，resume = 恢复历史
  fireHookEvent(
    "SessionStart",
    buildHookPayload({
      event: "SessionStart",
      sessionId: sessionId!,
      threadId,
      source: restoredMessages.length > 0 ? "resume" : "create",
    }),
  );
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

  const resolvedCwd = row.cwd || taskSessionCwd(sessionId);
  // 技能段预热：投影读数与随后真正打开该会话时逐字段一致（同款 ensureSkillsLoaded）
  await ensureSkillsLoaded(resolvedCwd);
  // 主题读数同恢复链口径（偏好列先行，NULL 回落最近使用），投影读数逐字段一致
  const projectedFromColumn = decodeThemeColumn(row.designTheme);
  const projectedTheme =
    projectedFromColumn === undefined ? getLastUsedDesignTheme() : projectedFromColumn;
  const baseTools = buildTools(resolvedCwd, threadId, () => projectedTheme);
  const { definitions } = await loadSubagentDefinitions({ cwd: resolvedCwd });
  // 只借 toolsForMode/buildSubagentTools 的组装逻辑：它们的 execute 闭包
  // 运行期才解引用 run，投影下这些闭包永远不会被调用。
  // 模式取会话偏好行（与 resolveSession 的恢复口径一致；自动化 turn 的守卫
  // 不在此做——投影只读，且策略注册窗口与打开面板的时机本就不同步）
  const projectedMode: SessionMode =
    row.mode === "plan" || row.mode === "ask" ? row.mode : "agent";
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
    systemPrompt: composeModeSystemPrompt(projectedMode, resolvedCwd, model, projectedTheme),
    tools: toolsForMode(stub),
    sessionId,
    compactionGeneration: generation,
  });
}
