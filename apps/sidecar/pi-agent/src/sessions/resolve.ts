/**
 * 会话解析与装配：resolveSession（懒建/恢复/反查改绑/工具组装/钩子接线）、
 * 只读投影 projectContextInfo、重建 helpers（rebindRunCwd/rebindRunThread/
 * reloadSubagents/reloadSkills）。会话注册表与驻留治理见 registry.ts。
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isApprovalLevel } from "pi-protocol";
import { reviewFactsOf } from "../permissions/auto-review";
import { sandboxPlanForRun } from "../permissions/sandbox-plan";
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
import { KOVA_CLIENT_IDENTITY } from "../model/client-identity";
import { buildTools } from "../tools/tools";
import { getPtcConfig } from "../tools/ptc-config";
import {
  assembleSessionOrFallback,
  getCapabilityRegistry,
  runToolAfterHooks,
  runToolBeforeHooks,
  type SessionSnapshot,
} from "../agent/assembly";
import {
  configCwdFor,
  effectiveDirsForProject,
  projectExtraDirs,
  primaryFolder,
  projectById,
  projectHasFolder,
  projectIdForCwd,
  resolveProjectIdForCwd,
  saveProject as saveProjectRecord,
} from "../agent/projects";
import {
  approvalBeforeToolCall,
  composeModeSystemPrompt,
  rewriteRunPrompt,
  syncRunPrompt,
  toolsForMode,
} from "../agent/modes";
import { effectiveAppMode } from "../agent/app-mode";
import { isInside, realResolve } from "../agent/workspace-boundary";
import {
  captureProviderResponse,
  carriesRetryDelayHeaders,
  createProviderRetryStream,
  createRetryBudget,
  makeUiRetryController,
} from "../model/provider-retry";
import { imageModelKey, stripImagesFromContext } from "../model/image-rejection";
import { placeholderImagesForTextModel } from "../model/image-refs";
import { getVisionToolConfig } from "../tools/vision-tool-config";
import { loadSubagentDefinitions, type SubagentDefinition } from "../subagent/subagent-definitions";
import { hasEnabledMcpServersSync } from "../mcp/mcp-config";
import { ensureSkillsLoaded, skillsSnapshot } from "../skills/skills";
import { clearLoadedSkills } from "../secrets/secrets";
import { buildSubagentTools } from "../subagent/subagent";
import { buildSkillMgmtTools } from "../skills/skill-mgmt-tools";
import { buildPluginMgmtTools } from "../plugins/plugin-mgmt-tools";
import { buildSchedulerTools } from "../automation/mgmt-tools";
// 设计主题管理三件套已随设计模式 UI 一起下线（恢复时取消注释 mgmt-tools 注入与
// designThemeMgmtDeps）：
// import { buildDesignThemeMgmtTools, type DesignThemeMgmtDeps } from "../design-md/mgmt-tools";
// import {
//   applyThemeDelete,
//   applyThemeSave,
//   finishThemeMutation,
//   selectAndBroadcastSessionTheme,
// } from "../design-md/apply";
import { expandUserCommandMessages } from "../commands/commands";
import {
  isInjectedUserMessage,
  readCompaction,
  readTranscript,
  readTranscriptHeaderRemote,
  rewriteTranscriptHeaderCwd,
  scanTranscript,
  transcriptSeqFloor,
} from "./transcript";
import type { PendingInteraction } from "pi-protocol";
import {
  hasPendingInteractions,
  restoreUnsettled,
} from "./pending-interactions";
import { checkpointGeneration, contextInfoFrom, projectRestoreContext, repairDanglingToolCalls, type ContextInfoResult } from "../agent/context";
import { CacheWarmer, resolveCacheWarmingMode } from "../agent/cache-warmer";
import {
  isPromptActive,
  onAgentEvent,
  send,
  sendProjectsChanged,
  sendSessionsChanged,
} from "../protocol/stream";
import { wireSessionEvents } from "../protocol/thread-events";
import {
  enforceResidency,
  findRunBySession,
  running,
  threadQuiescent,
  touchSession,
  trackSessionRun,
} from "./registry";
import { isImThread } from "./im-thread";
import { migrateTodoState, replayTodoFromMessages } from "../todo/todo";
import { migrateBgTasks, reassignBgTasksOwner } from "../tools/bg-tasks";
import {
  migrateGoal,
  parseGoalAcceptanceModePref,
  parseGoalDurationPref,
  parseGoalMaxTurnsPref,
  restoreGoal,
} from "../goal/goal";
import { recordGoalToolResult } from "../goal/goal-evidence";
import { logErr } from "../log";
import { sessionPath } from "../storage/storage";
import {
  kvGet,
  sessionGet,
  sessionInsert,
  sessionList,
  sessionMetaSet,
  sessionPrefsSet,
  sessionSetProject,
  sessionUpdateCwd,
} from "../storage/hostdb";
import { buildHookPayload, fireHookEvent, runHooks } from "../agent/hooks";
import { getAutomationPolicy } from "../automation/policy";
import { EFFECT_FREE_TOOL_NAMES, tagDiagnostic } from "../agent/tool-diagnostics";
import { cleanupRecovered, scanRunningToolCalls } from "../tools/recovery-journal";
import { decodeThemeColumn, getLastUsedDesignTheme } from "../design-md/state";
import type { ThemeRef } from "../design-md/store";
import { sanitizeRemoteForHeader, type ApprovalLevel, type RemoteTarget, type Running, type SessionMode } from "../types";

/** kv pi.mode 的载重（applyMode 写入的「最近一次使用的模式偏好」） */
type PlanningModePrefs = { mode: SessionMode; approvalLevel: ApprovalLevel };

/**
 * buildTools 的项目虚拟目录参数（运行期读 run）。
 * 入参是 getter 而不是 run 本体：resolveSession 里 run 的声明在 buildTools
 * 调用之后，直接传 run 会踩 TDZ。
 */
function externalDirToolArgs(getRun: () => Running) {
  return [() => getRun().externalDirs ?? []] as const;
}

/** 会话级能力装配快照：只读事实，能力不接触 run/agent。 */
function capabilitySessionSnapshot(run: Running): SessionSnapshot {
  return {
    sessionId: run.sessionId,
    threadId: run.threadId,
    cwd: run.cwd,
    mode: run.mode,
    appMode: run.appMode,
    model: run.agent?.state?.model ?? null,
  };
}

/** 用能力装配包装种子工具；同时刷新 run.capabilitySystemSuffix。 */
async function withCapabilityTools(
  run: Running,
  seedTools: AgentTool[],
): Promise<AgentTool[]> {
  const plan = await assembleSessionOrFallback(
    getCapabilityRegistry(),
    capabilitySessionSnapshot(run),
    seedTools,
  );
  run.capabilitySystemSuffix = plan.systemSuffix;
  return plan.tools;
}

/** 会话行/偏好里的审批档 → 合法枚举；非法或缺省一律回落最严的 `ask`。
 *  合法清单的单源在 pi-protocol（APPROVAL_LEVELS），扩容时这里不用改。 */
function decodeApprovalLevel(raw: unknown): ApprovalLevel {
  return isApprovalLevel(raw) ? raw : "ask";
}

// 设计主题管理工具的生效链依赖已随设计模式 UI 一起下线（恢复时随 mgmt-tools
// 注入一并取消注释）：落盘后的重映射/刷快照/重排提示词/广播走 design-md/apply
//（与设置页 handler 同一条链）。在这里注入而不是让 mgmt-tools 直引 apply——
// apply 引 agent/modes，而 modes 要引 mgmt-tools 取审批名单，直引成环。
// function designThemeMgmtDeps(run: Running): DesignThemeMgmtDeps {
//   return {
//     afterSave: async (ref, options) => {
//       const mutation = await applyThemeSave(ref, options);
//       finishThemeMutation(mutation);
//       return mutation.snap;
//     },
//     afterDelete: async (id) => {
//       const mutation = await applyThemeDelete(id);
//       finishThemeMutation(mutation);
//       return mutation.snap;
//     },
//     applyToSession: (ref) => selectAndBroadcastSessionTheme(run, ref),
//   };
// }

/**
 * agent 模式挂载的扩展工具组 = Task 组（含子智能体管理三件套）+ 技能管理三件套
 * + 排期管理组（scheduler_*，无人值守 run 自动为空）。
 * 都不进 baseTools：delegate 按定义从基础目录取工具时结构性拿不到它们。
 * run.subagentTools 即本组（字段名沿用，语义为"Task 旁的扩展组"）。
 */
function buildAgentExtensions(
  run: Running,
  baseTools: AgentTool[],
  definitions: SubagentDefinition[],
): AgentTool[] {
  return [
    // 没有任何启用的子智能体时 Task 组不下发（设置页开关翻转由 reloadSubagents
    // 重建本组，天然跟随）
    ...(definitions.length > 0
      ? buildSubagentTools(run, baseTools, definitions, reloadSubagents)
      : []),
    ...buildSkillMgmtTools(run, reloadSkills),
    ...buildPluginMgmtTools(run, async () => {
      // 插件安装影响技能与子智能体两条链；MCP 连接池 diff 由工具内部直接做
      await reloadSkills();
      await reloadSubagents();
    }),
    // 设计主题管理三件套（design_themes_list / design_theme_save /
    // design_theme_delete）已随设计模式 UI 一起下线；恢复时取消注释：
    // ...buildDesignThemeMgmtTools(designThemeMgmtDeps(run)),
    ...buildSchedulerTools(run),
  ];
}

/**
 * 回写 cwd 到索引行与 JSONL header（不依赖驻留 run）。
 * header 仅展示用，读端取首个 header 行，重写安全；转录文件异常不阻断（DB 已是事实源）。
 */
async function persistSessionCwd(sessionId: string, cwd: string, remote?: RemoteTarget | null): Promise<void> {
  await sessionUpdateCwd(sessionId, cwd);
  try {
    // 原子改写（tmp + fsync + rename）：换目录时不能把中间态留在会话文件里。
    // header 仅展示/兜底用，DB 索引行始终是事实源。
    rewriteTranscriptHeaderCwd(sessionId, cwd, remote);
  } catch (err) {
    // 见上：损坏/只读不阻断移动，但留一行日志便于排查
    logErr(
      "persist-session-cwd: header rewrite skipped",
      sessionId,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * 给已存在的 run 换绑工作目录：工具闭包/系统提示词里的 cwd 是建会话时烘焙的，
 * 换目录必须整组重建工具并重排提示词，否则 write/bash 仍落在旧目录（曾致代码写到 C:\Users）。
 * cwd 传空串 = 解绑：持久化 cwd 清空、运行 cwd 回落按会话隔离的任务子目录
 * （与"建会话时就未选目录"的形态完全一致）。
 * 只改 cwd 相关物，不动 mode/approval 状态。
 */
async function rebindRunCwd(
  run: Running,
  cwd: string,
  threadId: string,
  /** 请求携带的远程绑定：draft 补绑 cwd 时一并附加（prompt/new_session）；
   *  undefined = 显式换目录/本地会话 → 清除绑定。已是远程的 run 不被覆盖。 */
  remote?: RemoteTarget,
): Promise<void> {
  const nextCwd = cwd || taskSessionCwd(run.sessionId);
  // 换 cwd 也会换项目：仍在原项目 folders 内则保持；离开原项目时按新 cwd
  // 的唯一归属重新绑定（共享目录不猜），没有唯一归属就解除项目上下文。
  const currentProject = run.projectId ? projectById(run.projectId) : null;
  const stillInProject = Boolean(
    currentProject && nextCwd && projectHasFolder(currentProject, nextCwd),
  );
  const nextProjectId = stillInProject
    ? (run.projectId ?? null)
    : (projectIdForCwd(nextCwd) ?? null);
  const effectiveDirs = effectiveDirsForProject(nextProjectId, nextCwd);
  // 先把可能失败的异步加载做完（subagent 定义 / 技能扫描都要读盘和 DB）：
  // 失败时 run 仍是旧目录，不会出现"界面提示移动失败、下一轮却已经在新目录
  // 里执行"的半绑定状态。
  const { definitions } = await loadSubagentDefinitions({
    cwd: configCwdFor(nextCwd, nextProjectId),
    extraDirs: projectExtraDirs(nextCwd, nextProjectId),
  });
  // 换了工作区：技能目录随 cwd 变，先预热新缓存（项目目录一并联入）
  await ensureSkillsLoaded(
    nextCwd,
    effectiveDirs.map((dir) => dir.path),
  );

  // DB 索引行 + header 先落盘（可能失败）。失败时 run 原样不动；成功后的
  // 内存提交全是同步构造，不会留下"界面已换、运行态还是旧目录"的半绑定。
  // 远程绑定：请求携带时附加（draft 补绑远程项目），否则清除（换绑 = 本地语义）
  await persistSessionCwd(run.sessionId, cwd, remote ?? null);

  // cwd 已落盘：项目归属跟着换（离开项目后不再加载原项目附加目录）。
  // 归属写失败只记日志——cwd 移动已生效，重启后按新 cwd 重新推导。
  if (nextProjectId !== (run.projectId ?? null)) {
    run.projectId = nextProjectId;
    try {
      await sessionSetProject(run.sessionId, nextProjectId);
    } catch (err) {
      logErr("session-project: rebind after cwd change failed:", err);
    }
  }

  // 移动已提交：清掉本线程的已加载技能台账（密钥注入判定按线程累积，
  // 旧目录的技能不应继续生效）
  clearLoadedSkills(threadId);

  // 提交内存状态：以下均为同步构造，不再有可失败点
  run.persistedCwd = cwd;
  run.cwd = nextCwd;
  run.remoteTarget = remote ?? null;
  run.externalDirs = effectiveDirs;
  // 解绑（清空工作目录）回落到任务工作区时同样不在此落盘：目录推迟到
  // agent 真用时才建（bash 派发前 / 写文件时自带 mkdir），见 ensureTaskSessionDir。
  // 重建工具须沿用原 threadId：todo/question 工具按 threadId 归属，误传 sessionId 会挂错 key
  run.baseTools = await withCapabilityTools(run, buildTools(
    nextCwd,
    threadId,
    () => run.designTheme ?? null,
    () => run.designThemeLoads,
    () => ensureTaskSessionDir(run),
    () => run.approvalLevel,
    () => reviewFactsOf(run),
    () => run.mode,
    ...externalDirToolArgs(() => run),
    () => sandboxPlanForRun(run),
    () => run.remoteTarget ?? null,
    () => run.sessionId,
    () => run.projectId,
  ));
  run.subagentTools = buildAgentExtensions(run, run.baseTools, definitions);
  run.agent.state.tools = toolsForMode(run);
  // 换目录是整体换绑：提示词整段重写，并同步 state/loopContext 首条。
  rewriteRunPrompt(run, run.agent.state.model);
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
    // 同目录 no-op：不重建工具/不重排提示词/不广播（前端也会先挡一层）
    if (owner.run.persistedCwd === cwd) return;
    // 挂起的审批/问题带着旧目录的工具参数：先结算再换目录，避免批准后
    // 在新工作区执行一个按旧目录审阅过的操作。驻留 run 的台账在物化时
    // 已由 restoreUnsettled 回放，直接查内存即可，不扫整份转录
    if (hasPendingInteractions(sessionId)) {
      throw new Error(
        "session has pending approvals/questions; resolve them before moving",
      );
    }
    await rebindRunCwd(owner.run, cwd, owner.run.threadId);
    return;
  }
  const row = await sessionGet(sessionId);
  if (!row) {
    throw new Error(`session not found: ${sessionId}`);
  }
  if (row.cwd === cwd) return;
  // 非驻留会话的挂起行只在转录里：扫一遍，别让重建后的审批落到新目录
  if (scanTranscript(sessionId).pending.length > 0) {
    throw new Error(
      "session has pending approvals/questions; resolve them before moving",
    );
  }
  // 显式换目录 = 回到本地语义，远程绑定一并清除（与 rebindRunCwd 同规）。
  // 项目归属同样跟着 cwd 走：仍在原项目内保持，否则按新 cwd 唯一归属重绑。
  const project = row.projectId ? projectById(row.projectId) : null;
  const stillInProject = Boolean(project && cwd && projectHasFolder(project, cwd));
  const nextProjectId = stillInProject
    ? row.projectId
    : (projectIdForCwd(cwd) ?? null);
  await persistSessionCwd(sessionId, cwd, null);
  if (nextProjectId !== (row.projectId ?? null)) {
    try {
      await sessionSetProject(sessionId, nextProjectId);
    } catch (err) {
      logErr("session-project: rebind after cwd change failed:", err);
    }
  }
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
  migrateGoal(oldThreadId, newThreadId);
  migrateBgTasks(oldThreadId, newThreadId);
  // 宿主归属同步改绑（3s 上限）：await 保证改绑窗口内模型的 task_output 不会
  // 被宿主按旧 owner 拒绝；失败（本地模式/宿主卡住）退化为探测失败兜底。
  await reassignBgTasksOwner(oldThreadId, newThreadId);
  // 工具整组重建：browser/question/todo/mcp 的闭包烘着 threadId，
  // 事件推送与挂起归属（cancelPending* 按 threadId 过滤）都靠它
  run.baseTools = await withCapabilityTools(run, buildTools(
    run.cwd,
    newThreadId,
    () => run.designTheme ?? null,
    () => run.designThemeLoads,
    () => ensureTaskSessionDir(run),
    () => run.approvalLevel,
    () => reviewFactsOf(run),
    () => run.mode,
    ...externalDirToolArgs(() => run),
    () => sandboxPlanForRun(run),
    () => run.remoteTarget ?? null,
    () => run.sessionId,
    () => run.projectId,
  ));
  const { definitions } = await loadSubagentDefinitions({ cwd: configCwdFor(run.cwd, run.projectId), extraDirs: projectExtraDirs(run.cwd, run.projectId) });
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
    const { definitions, diagnostics } = await loadSubagentDefinitions({ cwd: configCwdFor(run.cwd, run.projectId), extraDirs: projectExtraDirs(run.cwd, run.projectId) });
    for (const d of diagnostics) logErr("subagent:", d);
    run.subagentTools = buildAgentExtensions(run, run.baseTools, definitions);
    run.agent.state.tools = toolsForMode(run);
  }
}

/**
 * 整组重建一个驻留 run 的工具表与系统提示词。
 * 工具表只在"拨开关 / 切模式 / 换目录"时重建，装配层不按轮增删工具。
 *
 * keepPrompt=true 时只换工具表、不动首条 system：目录归属变化走
 * applyDirsToRun 的尾部隐藏更新（提示词缓存稳定性 e2e 的硬约束），
 * 工具表本身不属于 system 消息，单独换不破坏前缀缓存。
 */
async function rebuildRunTools(
  run: Running,
  opts?: { readonly keepPrompt?: boolean },
): Promise<void> {
  run.baseTools = await withCapabilityTools(run, buildTools(
    run.cwd,
    run.threadId,
    () => run.designTheme ?? null,
    () => run.designThemeLoads,
    () => ensureTaskSessionDir(run),
    () => run.approvalLevel,
    () => reviewFactsOf(run),
    () => run.mode,
    ...externalDirToolArgs(() => run),
    () => sandboxPlanForRun(run),
    () => run.remoteTarget ?? null,
    () => run.sessionId,
    () => run.projectId,
  ));
  const { definitions } = await loadSubagentDefinitions({ cwd: configCwdFor(run.cwd, run.projectId), extraDirs: projectExtraDirs(run.cwd, run.projectId) });
  run.subagentTools = buildAgentExtensions(run, run.baseTools, definitions);
  const tools = toolsForMode(run);
  run.agent.state.tools = tools;
  // 工具表重建属于模式/能力级变更：提示词整体重写，并同步 loopContext。
  if (!opts?.keepPrompt) rewriteRunPrompt(run, run.agent.state.model);
  if (run.loopContext) run.loopContext.tools = tools;
}

/** 整组重建的失败项（逐 run 隔离后汇总；设置已持久化时靠它回报半生效范围） */
export type RunToolsReloadFailure = {
  readonly threadId: string;
  readonly sessionId: string;
  readonly message: string;
};

/**
 * 所有驻留 run 的整组重建（工具开关/能力开关共用一条路径）。
 * 逐 run 隔离：单个 run 重建失败只记入 failures，不阻断其余 run——设置此刻
 * 已持久化，调用方（set_capabilities）需要把失败面回报给前端，而不是整个
 * 命令报错留下「重启才自愈」的半生效状态。
 */
export async function reloadRunTools(): Promise<readonly RunToolsReloadFailure[]> {
  const failures: RunToolsReloadFailure[] = [];
  for (const run of running.values()) {
    try {
      await rebuildRunTools(run);
    } catch (error) {
      failures.push({
        threadId: run.threadId,
        sessionId: run.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      logErr(
        `reloadRunTools: rebuild failed for ${run.threadId} (${run.sessionId}):`,
        error,
      );
    }
  }
  return failures;
}

/**
 * 记忆总开关翻转后的工具表热重建：记忆三件套在 buildTools 里按开关条件注册，
 * 翻转后活会话必须整组重建 baseTools（Task 组从 baseTools 按名取工具，一并重建），
 * 否则开关等于没拨——关不掉也开不出。轮中翻转同改 loopContext（与 applyMode
 * 同款手法）：本轮下一次请求即按新表走，不必等下一次 prompt。
 */
export async function reloadMemoryTools(): Promise<void> {
  await reloadRunTools();
}

/**
 * 视觉辅助开关翻转后的工具表热重建（与 reloadMemoryTools 同机制）：
 * see_image 在 buildTools 里按开关条件注册，翻转后活会话必须整组重建
 * baseTools，否则开关等于没拨。关闭后工具立即从工具表消失，提示词回到
 * 未引入该能力的状态；开启后下一次请求即可调用。
 */
export async function reloadVisionTools(): Promise<void> {
  await reloadRunTools();
}

/** 能力开关/参数变更后的整组重建：失败面随返回值上报（下一轮生效）。 */
export async function reloadCapabilityTools(): Promise<readonly RunToolsReloadFailure[]> {
  return reloadRunTools();
}

/**
 * MCP 服务器增删/启停后的条件重建：只有「工具表里有没有 mcp 网关」真的翻转
 * 的 run 才重建。启用集合从 1 台变 2 台时网关工具本身不变（索引在 execute
 * 内实时读配置），不必重写提示词、也不该打破别的工作区会话的前缀缓存。
 */
export async function reloadMcpToolsIfPresenceChanged(): Promise<
  readonly RunToolsReloadFailure[]
> {
  const failures: RunToolsReloadFailure[] = [];
  for (const run of running.values()) {
    const present = run.baseTools.some((tool) => tool.name === "mcp");
    if (present === hasEnabledMcpServersSync(run.cwd)) continue;
    try {
      await rebuildRunTools(run);
    } catch (error) {
      failures.push({
        threadId: run.threadId,
        sessionId: run.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      logErr(
        `reloadMcpTools: rebuild failed for ${run.threadId} (${run.sessionId}):`,
        error,
      );
    }
  }
  return failures;
}

/**
 * 单个驻留 run 的工具表重建（目录归属变化后调用）。
 * search_external_files 按「是否存在附加目录」条件注册：项目加/删目录、
 * 会话改归属后必须整表重建，否则目录从无到有调不到工具、从有到无还挂着
 * 一个只会返回“没有附加目录”的空工具。
 */
export async function reloadToolsForRun(run: Running): Promise<void> {
  // 提示词仍由调用方（applyDirsToRun）走尾部队列更新，保住首条 system 的字节稳定
  await rebuildRunTools(run, { keepPrompt: true });
}

/**
 * 设置页改动（保存/删除/开关）后的技能热重载：刷各会话 cwd 的技能缓存，
 * 再走提示词同步。技能列表只是事实清单，走尾部隐藏更新，不改写首条 system；
 * 轮中排队的更新由下一次 prepareNextTurn 投递，空闲时留给下一轮。
 * 目录签名没变时 ensureSkillsLoaded 零 IO；开关状态在 merge 时生效，无需失效目录。
 */
export async function reloadSkills(): Promise<void> {
  for (const run of running.values()) {
    const external = (run.externalDirs ?? []).map((dir) => dir.path);
    await ensureSkillsLoaded(run.cwd || undefined, external);
    // use_skill 按「是否有生效技能」条件注册：从 0 到 1 / 从 1 到 0 时重建
    // 工具表；只换工具、不重写首条 system（技能目录仍走尾部隐藏更新）。
    const present = run.baseTools.some((tool) => tool.name === "use_skill");
    const wanted =
      skillsSnapshot(run.cwd || undefined, external).activeSkills.length > 0;
    if (present !== wanted) await rebuildRunTools(run, { keepPrompt: true });
    syncRunPrompt(run, run.agent.state.model);
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
 * 会话模型真值（§6 M4 优先级，与 resolveSession 的恢复链同一口径）：
 * **转录 model_change 行 > SQLite 偏好行 > 全局当前选择**。
 *
 * resolveSession 一直在按这个优先级取模型；只读投影（非驻留会话的
 * context_info）曾经只取全局——于是「run 被驱逐 / 尚未物化」时，上下文面板
 * 会把头部、容量、占用百分比、压缩阈值整片按**别的模型**显示（线上实测：
 * 会话跑 custom-qoder/qfmodel，面板显示全局默认 agnes-3.0-flash + 524K 窗口，
 * 刷新后线程驻留才恢复正常）。投影与 live 读数必须逐字段一致，所以走同一条
 * 优先级链。
 */
export async function sessionModelFor(
  scanModel: { provider: string; modelId: string } | null,
  row: { modelProvider?: string | null; modelId?: string | null } | undefined,
): Promise<NonNullable<Awaited<ReturnType<typeof defaultModel>>>> {
  const key =
    scanModel ??
    (row?.modelProvider && row?.modelId
      ? { provider: row.modelProvider, modelId: row.modelId }
      : null);
  if (key) {
    const saved = getModels().getModel(key.provider, key.modelId);
    if (saved) return saved;
    logErr(
      "projectContextInfo: session model missing from catalog, falling back to current:",
      `${key.provider}/${key.modelId}`,
    );
  }
  return resolveCurrentModel();
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
 * 各会话的子目录（见 taskSessionCwd）。搜索索引器（search-index.ts）用同一
 * 根枚举各会话的产物目录。
 */
export function taskWorkspaceBase(): string {
  return process.env.PI_TASK_CWD
    ? resolve(process.env.PI_TASK_CWD)
    : join(homedir(), ".kova", "task-workspace");
}

/**
 * sessionId → 任务工作区子目录名：sessionId 可能是 IPC 传入的字符串，
 * 必须限为单个安全路径段才能拼进 join（真值恒为 randomUUID 的 UUID）。
 * 返回 null = 不是合法会话名（含分隔符/`..`/点开头序列等）。
 */
export function taskSessionSeg(sessionId: string): string | null {
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
 * 任务工作区目录的真正落盘点：agent 真要**用**这个目录的那一刻调用——
 * 目前唯一需要它已存在的消费点是 bash 工具（宿主用 current_dir(cwd) spawn，
 * 目录缺失直接失败），由 buildTools 的 ensureCwd 闭包在每次派发 bash 前调用。
 * 写文件路径（宿主 write 的 create_dir_all、imagegen/计划/附件的写时 mkdir）
 * 天然自带落盘，不经过这里。纯聊天、既没跑命令也没写文件的会话因此永远
 * 不会留下空壳目录。幂等（recursive），重复调用无副作用。
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
 *
 * Windows 上目录可能仍被句柄占用（工具子进程的 cwd、预览 webview 开着的
 * 文件、杀毒扫描），rm 会 EBUSY——这里绝不能抛：删会话是同步链，抛错等于
 * 整条 delete_session 失败（前端报「删除失败」，会话行却已删掉，只剩孤儿
 * 目录）。占用是暂态的，退化为后台延迟清扫，见 sweepLockedDirLater。
 */
export function removeTaskSessionDir(sessionId: string): void {
  const seg = taskSessionSeg(sessionId);
  if (!seg) return;
  const dir = join(taskWorkspaceBase(), seg);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    sweepLockedDirLater(dir);
  }
}

/**
 * 会话的产物目录（<task-workspace>/<sessionId>）是否已被**其它**会话选作
 * 工作目录（含落在其子目录下）。命中时删除该会话必须跳过目录清理——
 * 目录已改由项目会话持有，删了会把项目文件连带清掉（2026-11 修复：
 * persistableCwd 放行产物根下的目录作为项目 cwd 后出现的新归属形态）。
 * 供 delete_session 与单测使用；DB 不可用时返回 false（维持旧的删除行为）。
 */
export async function taskSessionDirSharedWithOtherSessions(sessionId: string): Promise<boolean> {
  const seg = taskSessionSeg(sessionId);
  if (!seg) return false;
  const dir = realResolve(join(taskWorkspaceBase(), seg));
  try {
    const rows = await sessionList();
    // realResolve 双侧解析：macOS /var → /private/var 这类软链会让字符串前缀
    // 形态分叉，纯字符串比较会漏判"被引用"然后误删目录
    return rows.some(
      (row) => row.id !== sessionId && row.cwd && isInside(dir, realResolve(row.cwd)),
    );
  } catch {
    return false;
  }
}

/** 被占用目录的延迟清扫：dir -> 已安排的重试次数 */
const sweepPending = new Map<string, number>();
/** 指数退避：占用方（子进程退出、webview 关闭、扫描完成）通常几秒内释放 */
const SWEEP_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000];

function sweepLockedDirLater(dir: string): void {
  const attempt = sweepPending.get(dir) ?? 0;
  if (attempt >= SWEEP_RETRY_DELAYS_MS.length) {
    sweepPending.delete(dir);
    logErr(`[sessions] task dir still locked after retries, left in place: ${dir}`);
    return;
  }
  sweepPending.set(dir, attempt + 1);
  setTimeout(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
      sweepPending.delete(dir);
    } catch {
      sweepLockedDirLater(dir);
    }
  }, SWEEP_RETRY_DELAYS_MS[attempt]);
}

/**
 * 启动清扫：task-workspace 下不属于任何存活会话的孤儿目录。来源有两类——
 * 历史版本 EBUSY 删除失败留下的（会话行已删、目录永挂「我的文件」）、以及
 * removeTaskSessionDir 延迟清扫彻底放弃的残留。清单以 DB 索引为准
 * （sessionList），目录段名校验复用 taskSessionSeg（非会话名一律不碰）。
 *
 * 活会话持久化的工作目录可能落在任务工作区内（产物根下的目录被显式选作
 * 项目，见 persistableCwd）：候选目录若是任一活 cwd 本身或其祖先，绝不删——
 * 否则续做旧任务产物 / 产物根里自建的项目会在下次启动被整树清掉。
 *
 * mtime 新于 10 分钟的目录不碰：行插入（resolveSession 建 DB 行）与首用
 * 建目录（ensureTaskSessionDir）之间有窗口，刚建的目录可能还"查无此会话"，
 * mtime 门槛把这个竞态挡掉。单次失败（占用/权限）只记日志，留待下次启动，
 * 绝不阻断启动流程。
 */
export async function sweepOrphanTaskDirs(): Promise<void> {
  const base = taskWorkspaceBase();
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return; // 根目录不存在 = 从未有过任务会话
  }
  let known: Set<string>;
  /** 活会话持久化的工作目录：候选目录含任一活 cwd（含祖先关系）时保留。
   *  realResolve 只在此做一次（候选侧逐目录做）；双侧解析防软链前缀分叉漏判 */
  let liveCwds: string[];
  try {
    const rows = await sessionList();
    known = new Set(rows.map((row) => row.id));
    liveCwds = rows.map((row) => row.cwd).filter(Boolean).map((cwd) => realResolve(cwd));
  } catch (err) {
    logErr("[sessions] orphan task dir sweep skipped, session list unavailable:", err);
    return;
  }
  const freshCutoffMs = Date.now() - 10 * 60_000;
  for (const name of names) {
    if (known.has(name)) continue;
    if (!taskSessionSeg(name)) continue;
    const dir = join(base, name);
    try {
      const st = statSync(dir);
      if (!st.isDirectory() || st.mtimeMs > freshCutoffMs) continue;
      if (liveCwds.some((cwd) => isInside(realResolve(dir), cwd))) continue;
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      logErr(`[sessions] orphan task dir sweep failed for ${name}:`, err);
    }
  }
}

/**
 * 前端送来的 cwd 里，哪些**可以**被持久化成会话工作目录。
 *
 * 只拦一个精确形态：本会话自己的任务兜底目录（<task-workspace>/<sessionId>）。
 * 它是运行时概念，绝不能落进会话行——一旦落进去，这个会话就从「任务」变成
 * 「项目」：侧边栏按目录名分组（组名就是那串 UUID）、全局工作区跟着它跑、
 * 之后每条 prompt 都带着它，永久回不去。触发过一次的真实路径：内部起轮
 * （goal 的 kickGoalLoop）曾把 run.cwd 当成请求 cwd 传进来，而 run.cwd 对
 * 无目录会话恰好就是这个兜底值（现已改为传 persistedCwd，这里留作兜底闸，
 * 拦"下一个忘了这件事的调用方"）。
 *
 * 任务工作区下的**其它**路径照常持久化：用户在新对话页显式选择产物根下的
 * 目录（继续加工上个任务的产物、产物根里自建的项目目录）是合法用法——
 * 会话照常成为「项目」，agent 真正在选中目录里执行。曾经的整树拦截会把
 * 这条链静默降级成普通任务（cwd 丢弃 + 运行目录回落兜底），2026-11 修复。
 *
 * 已知限制：用户事后在设置里切换任务产物根位置时，落在旧根内的项目 cwd
 * 会指向旧路径，按既有「目录缺失」逻辑降级（技能/检索跳过，不报错）。
 */
export function persistableCwd(cwd: string | undefined, sessionId?: string): string | undefined {
  if (!cwd) return undefined;
  if (sessionId && resolve(cwd) === resolve(taskSessionCwd(sessionId))) return undefined;
  return cwd;
}

/**
 * 补绑闸（"草稿会话"判定）：只有一条用户消息都没产生过的会话，才允许被
 * **请求携带的 cwd** 补绑工作目录。
 *
 * 为什么必须有这道闸：prompt 恒携带"当前全局 workspace"（前端 pi-client-base
 * 的 sendPrompt），而补绑会把 cwd 写进索引行与 JSONL header（数据库可见）。
 * 没有闸时：切到一个很久以前创建的无目录旧会话、发一条消息，它就被"此刻恰
 * 好打开的项目"永久收养——侧栏里从全局区跑进该项目分组，用户看到的就是
 * "全局会话莫名其妙进了项目"（2026-10 实报）。
 *
 * 保留的原始意图：先开对话（草稿）→ 之后才选工作目录 → 首条消息/上下文
 * 面板请求把目录补上。显式换目录通道（set_session_cwd）不受此闸约束。
 */
const hasNoUserTurn = (messages: readonly { role?: string; content?: unknown }[]): boolean =>
  !messages.some((m) => m.role === "user" && !isInjectedUserMessage(m));

/**
 * 远程绑定载ports清洗（new_session / prompt 共用）：只收白名单字段，
 * port 必须 1..65535（NaN 也是 number，不挡会拼出 `-p NaN`）。
 * 返回 undefined = 请求未携带远程绑定（本地会话语义）。
 */
export function sanitizeRemoteTargetInput(raw: unknown): RemoteTarget | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as {
    host?: unknown;
    port?: unknown;
    username?: unknown;
    privateKeyPath?: unknown;
    password?: unknown;
  };
  const host = String(r.host ?? "").trim();
  if (!host) return undefined;
  const port =
    typeof r.port === "number" && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535
      ? r.port
      : undefined;
  return {
    host,
    ...(port ? { port } : {}),
    ...(typeof r.username === "string" && r.username.trim() ? { username: r.username.trim() } : {}),
    ...(typeof r.privateKeyPath === "string" && r.privateKeyPath.trim()
      ? { privateKeyPath: r.privateKeyPath.trim() }
      : {}),
    // 密码认证：密码随请求下发（本地 IPC + 管道内明文，仅存内存；
    // header 落盘前由 sanitizeRemoteForHeader 剥离）
    ...(typeof r.password === "string" && r.password.length > 0 ? { password: r.password } : {}),
  };
}

/**
 * 同目录远程绑定补挂：「会话已按该 cwd 物化（persistedCwd 已定）但尚无远程
 * 绑定」而请求携带 remote 的时序兜底——先物化（set_mode/上下文面板）、后选
 * 远程项目的草稿不会走 rebind 分支（persistedCwd 已非空），没有这里就会
 * 永远本地执行。条件从严：目录精确匹配 + 该 run 从未绑过远程（绝不翻转
 * 已有绑定）。工具闭包运行期读 run.remoteTarget，无需重建工具表。
 */
async function attachRemoteIfMatched(
  run: Running,
  safeCwd: string | undefined,
  remote: RemoteTarget | undefined,
): Promise<void> {
  if (!remote || !safeCwd) return;
  if (run.remoteTarget) {
    // 已绑定：补缺失的密码（转录 header 不落密码；恢复的会话靠这里在每次
    // 请求携带的密码上回填）。请求载荷经主进程按主机记录重新解析注入，
    // 是权威事实源——主机端口/用户名被编辑过也以它为准；已带密码的 run
    // 不被覆盖（绝不翻转已有绑定）
    if (!run.remoteTarget.password && remote.password) {
      run.remoteTarget = { ...remote };
    }
    return;
  }
  if ((run.persistedCwd ?? "") !== safeCwd) return;
  run.remoteTarget = remote;
  try {
    await persistSessionCwd(run.sessionId, safeCwd, remote);
  } catch (err) {
    logErr("attach-remote: header rewrite failed:", err);
  }
}

export async function resolveSession(
  threadId: string,
  sessionId?: string,
  cwd?: string,
  /** 远程执行目标：新建会话写入 header；已有草稿会话补绑 cwd 时一并附加 */
  remote?: RemoteTarget,
  /** 项目归属：新建会话显式携带；恢复会话以 DB 行为准 */
  projectId?: string,
): Promise<Running> {
  const safeCwd = persistableCwd(cwd, sessionId);
  const existing = running.get(threadId);
  if (existing) {
    // 会话已存在也要补绑：建会话时未选目录（persistedCwd 空）而这次请求带了
    // cwd —— 典型场景是先开了对话/先点了上下文面板，之后才选工作目录。
    // 闸：仅草稿会话（hasNoUserTurn）——有过对话的旧会话不再被消息里的 cwd 收养。
    // 请求的 sessionId 可能不是真实 id（桌面 prompt 以 threadId 充数，草稿期是
    // __LOCALID_ 假 id），顶部的精确闸对不上——按 run 的真实 sessionId 复检，
    // 内部调用方误传 run.cwd（兜底目录）时这里仍要拦住
    const rebindCwd = persistableCwd(safeCwd, existing.sessionId);
    if (rebindCwd && !existing.persistedCwd && hasNoUserTurn(existing.agent.state.messages)) {
      await rebindRunCwd(existing, rebindCwd, threadId, remote);
    } else {
      // cwd 已定但没绑过远程：请求带 remote 且目录精确匹配时补挂
      await attachRemoteIfMatched(existing, safeCwd, remote);
    }
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
      if (
        safeCwd &&
        !owner.run.persistedCwd &&
        hasNoUserTurn(owner.run.agent.state.messages)
      ) {
        // 用 run 的当前驻留键（改绑后即新键；未改绑仍是旧键）重建工具，
        // 保证工具闭包与 run.threadId 永远同键
        await rebindRunCwd(owner.run, safeCwd, owner.run.threadId, remote);
      } else {
        await attachRemoteIfMatched(owner.run, safeCwd, remote);
      }
      // 按 run 的当前驻留键续龄（未改绑时新键不在 running 表里）
      touchSession(owner.run.threadId);
      return owner.run;
    }
  }

  // 持久化 cwd = 用户选择的工作目录（空串 = 未选目录的任务会话）；
  // 运行 cwd 兜底按会话隔离的任务子目录，仅影响 Agent 执行环境，不回写持久化
  // 新建会话：请求里的 cwd 就是这条会话的工作目录。任务工作区下只有**本会话
  // 自己的兜底目录**不算「用户选了目录」（persistableCwd 精确拦截），用户显式
  // 选择的产物目录照常持久化成项目会话
  let persistedCwd = safeCwd ?? "";
  /** 远程执行目标：恢复会话从转录 header 读回；新建会话随请求携带 */
  let resolvedRemote: RemoteTarget | null = null;
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
  /** 项目归属：恢复行优先；新会话用请求 projectId，未带时只在 cwd 唯一归属时自动绑定 */
  let resolvedProjectId: string | undefined;

  if (sessionId) {
    const row = await sessionGet(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);
    restoredRow = row;
    persistedCwd = row.cwd;
    // IM 驱动的旧会话补来源标：升级前的绑定/主进程启动补标失败时兜底。
    // 打上后 list_sessions 会带 origin:"im"，侧栏才肯把「cwd 不是注册项目」
    // 的会话按目录分组展示。side_chat 等其他 kind 不动。
    if (isImThread(threadId) && !row.kind) {
      try {
        await sessionMetaSet(sessionId, {
          kind: "im",
          parentSession: row.parentSession,
        });
        restoredRow = { ...row, kind: "im" };
        sendSessionsChanged("updated", sessionId);
      } catch (err) {
        logErr("im origin self-heal failed:", err);
      }
    }
    // DB 行为准；旧会话缺列时只在 cwd 唯一归属某个项目时回填并落库
    resolvedProjectId = row.projectId ?? projectIdForCwd(row.cwd) ?? undefined;
    if (!row.projectId && resolvedProjectId) {
      await sessionSetProject(sessionId, resolvedProjectId);
    }
    if (!resolvedProjectId && projectId) {
      resolvedProjectId = resolveProjectIdForCwd(projectId, row.cwd);
      await sessionSetProject(sessionId, resolvedProjectId ?? null);
    }
    // 远程绑定不存在 DB（Rust 宿主表无此列），事实源是转录 header（新建时写入）
    resolvedRemote = readTranscriptHeaderRemote(sessionId);
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
    // 崩溃恢复：工具执行中被杀会留下无结果的 toolCall，补 interrupted 结果
    // 保持上下文可继续；挂起交互的锚点跳过（那些卡还在等用户回答）。
    // 恢复日志（recovery-journal）：state=running 的调用 = 上次确实开始执行
    // 且未返回，repair 据此把文案升级为「上次执行被中断」。fail-open：journal
    // 读不到就是空集，文案与旧版逐字相同。
    // journal 按 threadId 记（hostTool 的 threadId 实参），恢复也按 threadId 扫——
    // sessionId 是落盘会话 id，与工具执行的 threadId 不同命名空间（见 L277 注释）
    const journalRunning = await scanRunningToolCalls(threadId);
    restoredMessages = repairDanglingToolCalls(
      projectRestoreContext(transcript, checkpoint),
      new Set(
        scan.pending
          .map((item) => item.anchorToolCallId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
      EFFECT_FREE_TOOL_NAMES,
      journalRunning,
    );
    // 修完消化：清掉本次已呈现过的 running 行，防跨重启反复命中同一文案
    // （journal 只增不清会永久残留）。fire-and-forget，fail-open 同上。
    void cleanupRecovered([threadId]);
    restoredPending = scan.pending;
    scanModel = scan.model;
    scanThinking = scan.thinkingLevel;
    // 索引行自愈：辅助会话的 kind/parentSession 由宿主写入——旧宿主期间创建的
    // 子会话行缺这两列，主列表过滤认不出它（发首条消息后会泄漏进侧边栏）。
    // 转录 header 是创建时的事实源，scanTranscript 顺带读出，在此补齐索引行。
    if (
      scan.header.kind &&
      (restoredRow.kind !== scan.header.kind ||
        (scan.header.parentSession &&
          restoredRow.parentSession !== scan.header.parentSession))
    ) {
      try {
        await sessionMetaSet(sessionId, {
          kind: scan.header.kind,
          parentSession: scan.header.parentSession ?? "",
        });
        restoredRow = {
          ...restoredRow,
          kind: scan.header.kind,
          parentSession: scan.header.parentSession ?? "",
        };
      } catch (error) {
        // 自愈失败不阻断恢复：行保持旧值（副作用只是主列表过滤/todo 回放
        // 退化到旧行为），下次物化再试
        logErr("side session meta self-heal failed:", error);
      }
    }
    // 任务清单恢复：事件溯源回放转录里最后一个 todo 快照（见 todo.ts）。
    // 辅助会话的转录含继承的父历史，回放会把父会话 todo 复活到副屏——跳过。
    if (restoredRow?.kind !== "side_chat") {
      replayTodoFromMessages(threadId, restoredMessages);
    }
    // 目标恢复：同款事件溯源（goal_state 行，last-wins）。回放出的 active 由
    // restoreGoal 内部降级为 paused——驱动那个循环的 run 随进程一起没了，原样
    // 带回来的 active 是谎报（见 docs/goal-mode-design.md「状态是 active ≠ 循环在跑」）。
    // 辅助会话不承载 goal（goal_state 行也不随复制进入 child），保险起见一并跳过。
    if (restoredRow?.kind !== "side_chat") {
      restoreGoal(threadId, sessionId!);
    }
    persistedSeq = restoredMessages.length;
    // 截断过的会话用号段下限兜住：maxSeq 只看现存行，被删的尾部号段必须
    // 跳过，否则重发会复用轮次 seq（前端 pi-msg:<seq> 键随之复用，时长
    // 台账把重试认成同一轮继续累加）
    jsonlSeq = Math.max(maxSeq + 1, transcriptSeqFloor(sessionId));
  } else {
    // 新会话：建索引行 + JSONL header
    sessionId = randomUUID();
    if (remote && projectId) {
      throw new Error("Remote sessions cannot belong to a local project.");
    }
    // 项目会话未显式给 cwd：用 primary folder；显式 projectId 时校验 cwd 属于项目
    if (projectId) {
      const project = projectById(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      if (!persistedCwd) persistedCwd = primaryFolder(project);
    }
    resolvedProjectId = resolveProjectIdForCwd(projectId, persistedCwd);
    // 新对话唤回项目：用户在原目录重新开聊时，被移除（隐藏）或归档的项目
    // 自动回到侧栏。只恢复项目卡本身——归档会话保持归档（设置 → 归档 仍可
    // 逐条恢复），非归档会话随项目卡自然回到分组里。
    if (resolvedProjectId) {
      const revived = projectById(resolvedProjectId);
      if (revived && (revived.archived || revived.hiddenFromSidebar)) {
        try {
          await saveProjectRecord({
            id: revived.id,
            ...(revived.archived ? { archived: false } : {}),
            ...(revived.hiddenFromSidebar
              ? { hiddenFromSidebar: false }
              : {}),
          });
          sendProjectsChanged("saved", revived.id);
        } catch (err) {
          // 唤回失败不阻断新对话：会话照常创建，项目卡等下次保存/恢复再回来
          logErr("new_session: revive project failed:", err);
        }
      }
    }
    const now = new Date().toISOString();
    await sessionInsert(sessionId, persistedCwd, {
      projectId: resolvedProjectId ?? null,
      // IM 通道创建的会话打来源标：侧栏据此让「cwd 不是注册项目」的会话
      // 也按目录分组展示（否则 list 里有、侧栏分组时被隐藏，用户完全看不到）
      ...(isImThread(threadId) ? { kind: "im" } : {}),
    });
    sendSessionsChanged("created", sessionId);
    writeFileSync(
      sessionPath(sessionId),
      JSON.stringify({
        type: "header",
        schema: 1,
        id: sessionId,
        cwd: persistedCwd,
        created_at: now,
        // 远程项目会话：绑定随请求写入 header（恢复时读回，DB 无此列）；
        // 密码等秘密绝不落盘
        ...(remote ? { remote: sanitizeRemoteForHeader(remote) } : {}),
      }) + "\n",
    );
    resolvedRemote = remote ?? null;
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
      // 四档都要在这里：漏一档的症状是「重启后回到默认档」——偏好行里明明存着，
      // 却因为白名单少一个字符串被静默丢掉（goal 档曾经就漏在这里）
      if (
        restoredRow.mode === "agent" ||
        restoredRow.mode === "plan" ||
        restoredRow.mode === "ask" ||
        restoredRow.mode === "goal"
      ) {
        initialMode = restoredRow.mode;
      }
      // 档位收口在 decodeApprovalLevel（单源 pi-protocol 的 APPROVAL_LEVELS）：
      // 这里再抄一份 `=== "..."` 白名单就是下一个「重启后回到默认档」的漏改点
      initialApproval = decodeApprovalLevel(restoredRow.approvalLevel);
    } else {
      try {
        const raw = await kvGet("pi.mode");
        const last = raw?.value ? (JSON.parse(raw.value) as Partial<PlanningModePrefs>) : null;
        if (
          last?.mode === "agent" ||
          last?.mode === "plan" ||
          last?.mode === "ask" ||
          last?.mode === "goal"
        ) {
          initialMode = last.mode;
        }
        initialApproval = decodeApprovalLevel(last?.approvalLevel);
      } catch {
        // kv 不可用/损坏：保持默认
      }
      // 生效档位当场落进偏好行。不落的话这两列会一直是 NULL，而 NULL 在重建时
      // 按 decodeApprovalLevel 解码回 ask——同一条对话就出现「被驱逐重建后突然
      // 开始弹卡」「重启后从完全访问变回变更前确认」这类漂移。落的是 run 真正
      // 要用的值，从此建会话（kv）、重建（偏好行）、UI 水合三处读的是同一个数。
      // 失败只记日志：档位本身已经生效，落不上退化为旧行为（重建后按 NULL 兜底）
      void sessionPrefsSet(sessionId!, {
        mode: initialMode,
        approvalLevel: initialApproval,
      }).catch((err) =>
        logErr(`new session mode prefs seed failed (session=${sessionId}):`, err),
      );
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

  // 会话级工作模式：sessions.app_mode 偏好列的合法值优先，NULL/脏值跟随全局默认
  // （kv pi.app_mode）。从未在本会话切过档的（含新会话）显示与运行都跟默认档；
  // 切过档就只认自己的列——A 会话切档不牵连 B 会话（定靶写入见 handlers/preferences.ts）
  const initialAppMode = effectiveAppMode(restoredRow?.appMode);

  // 会话级目标轮数上限：与 app_mode 同型，定靶列优先、NULL 跟随默认 300。
  // 建目标时用它（用户在条上填的值优先于这里），用户改上限时回写本列——
  // 下一个目标就从上次的数开始，不用每次重新估
  const initialGoalMaxTurns = parseGoalMaxTurnsPref(restoredRow?.goalMaxTurns);
  // 验收标准启动模式与活跃时长上限：同样定靶列优先，NULL 跟随默认
  const initialGoalAcceptanceMode = parseGoalAcceptanceModePref(restoredRow?.goalAcceptanceMode);
  const initialGoalMaxDurationSeconds = parseGoalDurationPref(restoredRow?.goalMaxDuration);

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

  // 技能目录预热（签名缓存，命中零 IO）：系统提示词的技能段从这里取数。
  // 项目虚拟目录（多代码工程合并）随 cwd 求值；普通任务会话为空
  const effectiveDirs = effectiveDirsForProject(resolvedProjectId, resolvedCwd);
  await ensureSkillsLoaded(
    resolvedCwd,
    effectiveDirs.map((dir) => dir.path),
  );

  // use_design_theme 按引用读 run.designTheme（会话内切主题即时换缺省目标；
  // run 此刻尚未回填字段，闭包运行期才解引用，与 beforeToolCall 同款手法）。
  // 附加目录是唯一在 buildTools 里按「有没有目录」决策是否注册工具的入参，
  // 必须在种子装配时给出实值（不能是 () => run.externalDirs：run 还没初始化）。
  const seedTools = buildTools(
    resolvedCwd,
    threadId,
    () => run.designTheme ?? null,
    () => run.designThemeLoads,
    () => ensureTaskSessionDir(run),
    () => run.approvalLevel,
    () => reviewFactsOf(run),
    () => run.mode,
    () => effectiveDirs,
    () => sandboxPlanForRun(run),
    () => run.remoteTarget ?? null,
    () => run.sessionId,
    () => run.projectId,
  );
  // 会话级能力装配：默认无能力时 tools 与 seedTools 逐项相同、后缀为空串。
  const initialCapabilityPlan = await assembleSessionOrFallback(
    getCapabilityRegistry(),
    {
      sessionId: sessionId!,
      threadId,
      cwd: resolvedCwd,
      mode: initialMode,
      appMode: initialAppMode,
      model,
    },
    seedTools,
  );
  const baseTools = initialCapabilityPlan.tools;
  // run 先占位再回填 agent：beforeToolCall 闭包按引用捕获 run，模式校验在运行期才解引用
  const run: Running = {
    agent: undefined as unknown as Agent,
    threadId,
    sessionId: sessionId!,
    sessionKind: restoredRow?.kind ?? "",
    cwd: resolvedCwd,
    persistedCwd,
    remoteTarget: resolvedRemote,
    externalDirs: effectiveDirs,
    projectId: resolvedProjectId ?? null,
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
    // 会话生效工作模式（偏好列 ?? 全局默认）：系统提示词模式段的事实源
    appMode: initialAppMode,
    // 本会话的目标轮数上限偏好（null = 从未定过）：建目标时作为兜底预设
    goalMaxTurns: initialGoalMaxTurns,
    goalAcceptanceMode: initialGoalAcceptanceMode,
    goalMaxDurationSeconds: initialGoalMaxDurationSeconds,
    // 目标 token 账的现累器（message_end / 子代理结算累加，目标轮边界取走清零）
    usagePending: 0,
    // 全文加载台账：每次新建 run 都是空表（恢复/压缩后宁可重贴不谎报已加载）
    designThemeLoads: new Map<string, string>(),
    planning: initialMode === "plan" ? "planning" : "inactive",
    baseTools,
    // PTC 开关快照：已有会话不随设置页翻转换工具表，新会话才生效
    ptcEnabled: getPtcConfig().enabled,
    capabilitySystemSuffix: initialCapabilityPlan.systemSuffix,
    subagentTools: [],
    pendingToolApprovals: new Map(),
    lastSeenAt: Date.now(),
  };

  // prompt cache 保活器：streamFn 每次会话请求喂 start，轮收尾喂 onAgentSettled，
  // 会话驱逐经 dropRun cancel（见 agent/cache-warmer.ts）
  run.cacheWarmer = new CacheWarmer({
    streamSimple: (model, context, warmOptions) =>
      getModels().streamSimple(model, context, warmOptions),
    getMode: resolveCacheWarmingMode,
  });

  const agent = new Agent({
    // 请求时展开自定义命令：用户消息以 /name 原文落盘与展示（气泡可读、编辑
    // 重发拿回原文），发请求前经 transformContext 展开成模板——展示与请求两条
    // 路径分离，转录不被模板文本污染。闭包读 run 的活字段（rebindRunCwd /
    // 远程绑定后立即生效）；返回新数组，状态消息对象不原地改。
    transformContext: async (messages) =>
      expandUserCommandMessages(
        messages,
        configCwdFor(run.cwd, run.projectId),
        {
          skipWorkspace: Boolean(run.remoteTarget),
        },
      ),
    // sessionId 透传：OpenAI prompt_cache_key / Anthropic session-affinity（缓存路由）
    sessionId,
    // 对外身份：UA 自报 kova、不继承 pi 的归因（见 model/client-identity.ts）。
    // Agent 层的 identity 会盖掉 pi-agent-core 的 DEFAULT_AGENT_IDENTITY
    identity: KOVA_CLIENT_IDENTITY,
    // 多条「并入当前回复」在同一模型边界一起送达：默认 one-at-a-time 会让每条
    // 并入各触发一轮请求。相邻两条只要都在边界前到达（都在 steering 队列里），
    // 就会同批；promote（立即发送）不经过这个队列，语义保持不变。
    steeringMode: "all",
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
      // 视觉辅助开关打开时：纯文本模型的 image 块换成带 imageId 的占位文本，
      // 让模型可以主动调用 see_image 查看（见 model/image-refs.ts）。开关关闭时
      // 完全不走这段——请求上下文与未引入该能力前逐字节一致（防提示词污染）。
      // 终极 fail-open：占位替换无论抛什么（理论上是纯同步映射，不应发生）都
      // 回落原 context——视觉辅助的任何内部故障都不允许影响聊天主链路，
      // 最坏退化为「模型看不到图」的既有现状。
      const imageKey = imageModelKey(m);
      let effectiveContext = context;
      if (getVisionToolConfig().enabled) {
        try {
          effectiveContext = placeholderImagesForTextModel(m, context);
        } catch (err) {
          logErr(
            "vision bridge: placeholder transform failed, falling back to raw context:",
            err,
          );
        }
      }
      // 拒图 sticky 命中（该模型已被证实拒图，见 model/image-rejection.ts）：
      // 入口直接剥图，免掉每轮一次的必败首请求。剥后消息换新对象，
      // cacheWarmer 的前缀身份检查自然不命中，不会重放剥图上下文。
      // （占位替换先行：纯文本模型的请求里已无 image 块，这里是幂等 no-op；
      //   元数据标成支持图像却真拒图的模型不走占位，仍由此剥图兜底。）
      // 开关打开且有图的会话：占位替换生成新消息对象，cacheWarmer 的前缀身份
      // 检查自然不命中（该会话期间不暖缓存）——imageId 内容寻址保证占位文本
      // 跨请求稳定，正式请求的前缀缓存不受影响，属可接受代价。
      if (run.imageRejectionModels?.has(imageKey)) {
        effectiveContext = stripImagesFromContext(effectiveContext);
      }
      // 轨迹内容捕获：本次请求的上下文快照（附加到随后打开的 llm_call span）
      run.trace?.noteRequest(effectiveContext);
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
      const requestOptions = {
        ...options,
        // 无条件补发会话亲和头（参考 opencode），让兼容端点把同会话请求
        // 路由到同一缓存分片；端点若已按 compat 下发同名头则同值覆盖
        headers: {
          ...options?.headers,
          ...makeSessionAffinityHeaders(sessionId),
        },
        // 可选长缓存（Anthropic 1h TTL / OpenAI 24h retention），compat 守门自动降级
        ...(process.env.PI_CACHE_RETENTION === "long"
          ? { cacheRetention: "long" as const }
          : {}),
        // 捕获失败响应的 status/头（pi-ai 的 onResponse 不暴露失败 429），
        // 供分类与 Retry-After 退避使用
        fetch: captureProviderResponse(options?.fetch, (response) => {
          run.retryCapture.status = response?.status;
          run.retryCapture.headers = carriesRetryDelayHeaders(response?.status)
            ? response?.headers
            : undefined;
        }),
      };
      // 缓存保活：只认本会话的请求（compaction/summary 走独立通道不经这里），
      // 记住"这次请求"供 TTL 到期前原样重放；isCurrent = 模型未换且本次请求的
      // 消息仍是当前转录的前缀（pi 同款，防重放已失效的旧前缀）
      if ((options as { sessionId?: string } | undefined)?.sessionId === sessionId) {
        run.cacheWarmer?.start(
          { model: m, context: effectiveContext, options: requestOptions },
          () => {
            const state = run.agent.state;
            return (
              state.model?.provider === m.provider &&
              state.model?.id === m.id &&
              state.messages.length >= effectiveContext.messages.length &&
              effectiveContext.messages.every((msg, index) => state.messages[index] === msg)
            );
          },
        );
      }
      return createProviderRetryStream(
        m,
        effectiveContext,
        requestOptions,
        (retryOptions, ctx) => getModels().streamSimple(m, ctx, retryOptions),
        makeUiRetryController(run, {
          // 拒图修复重试成功出流：记账 sticky，后续轮次入口预剥图
          onImageFallbackRecovered: () => {
            (run.imageRejectionModels ??= new Set()).add(imageKey);
          },
        }),
      );
    },
    initialState: {
      systemPrompt: composeModeSystemPrompt(
        initialMode,
        resolvedCwd,
        initialAppMode,
        model,
        initialDesignTheme,
        undefined,
        effectiveDirs,
        initialCapabilityPlan.systemSuffix,
        false,
        configCwdFor(resolvedCwd, resolvedProjectId),
      ),
      model,
      // 深度思考档位：转录行回放，无行跟随全局（set_thinking 维护；off = 不发送 reasoning 参数）
      thinkingLevel: initialThinking,
      tools: baseTools,
      messages: restoredMessages,
    },
    // Claude Code 式 PreToolUse 钩子：能力策略 → block/approve 决策 → 审批链
    beforeToolCall: async (context) => {
      const capabilityDecision = await runToolBeforeHooks(run.turnCapabilities, context);
      if (capabilityDecision?.block) return capabilityDecision;
      const decision = await runHooks(
        "PreToolUse",
        buildHookPayload({
          event: "PreToolUse",
          sessionId: sessionId!,
          threadId,
          toolName: context.toolCall.name,
          toolArgs: context.args,
        }),
        { workspace: configCwdFor(run.cwd, run.projectId) },
      );
      if (decision?.decision === "block") {
        return { block: true, reason: tagDiagnostic(decision.reason ?? "Blocked by hook", "policy_denied") };
      }
      // approve = 跳过审批直接放行（CC 语义），undefined 交回审批链
      if (decision?.decision === "approve") return undefined;
      return approvalBeforeToolCall(run, context);
    },
    // PostToolUse / PostToolUseFailure（isError 分流）：能力先收敛结果，
    // 目标证据与用户钩子看到的是收敛后的最终值。
    afterToolCall: async (context) => {
      const capabilityOverride = await runToolAfterHooks(run.turnCapabilities, context);
      const effectiveContext = capabilityOverride
        ? {
            ...context,
            result: {
              ...context.result,
              ...(capabilityOverride.content !== undefined
                ? { content: capabilityOverride.content }
                : {}),
              ...(capabilityOverride.details !== undefined
                ? { details: capabilityOverride.details }
                : {}),
            },
            isError: capabilityOverride.isError ?? context.isError,
          }
        : context;
      // 目标证据台账：在钩子通知之前记，保证本轮工具结果落定即可被 goal_complete
      // 引用。失败也记（isError=true），避免模型拿失败调用冒充成功。
      await recordGoalToolResult(run, effectiveContext).catch((err) =>
        logErr("goal-evidence: record failed:", err),
      );
      const summary = effectiveContext.result.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      fireHookEvent(
        effectiveContext.isError ? "PostToolUseFailure" : "PostToolUse",
        buildHookPayload({
          event: effectiveContext.isError ? "PostToolUseFailure" : "PostToolUse",
          sessionId: sessionId!,
          threadId,
          toolName: context.toolCall.name,
          toolArgs: context.args,
          isError: effectiveContext.isError,
          resultSummary: summary,
        }),
        { workspace: configCwdFor(run.cwd, run.projectId) },
      );
      return capabilityOverride;
    },
  });
  run.agent = agent;
  // persistedSeq 按 state.messages 索引对齐：0.99 起 Agent 构造时在转录头
  // unshift leading system 消息（提示词进转录），恢复/新建两侧都以构造后的
  // 实际长度为准，避免首条错位造成尾部重复或漏盘（system 行落盘时跳过）
  run.persistedSeq = agent.state.messages.length;

  const { definitions, diagnostics } = await loadSubagentDefinitions({ cwd: configCwdFor(run.cwd, run.projectId), extraDirs: projectExtraDirs(run.cwd, run.projectId) });
  for (const d of diagnostics) logErr("subagent:", d);
  run.subagentTools = buildAgentExtensions(run, baseTools, definitions);
  // 在基础工具目录上追加 Task 工具组（含子智能体/技能管理工具）+ 模式切换工具
  // （delegate 的工具按定义从基础目录里取，绝不包含本组，
  //   delegate 不能继续委派、也不能管理定义与技能）
  agent.state.tools = toolsForMode(run);

  agent.subscribe((event) => onAgentEvent(event, run));
  // 原生事件通道（react-pi 迁移阶段 3）：AgentEvent → thread_event 帧
  //（delta 化），桌面端 旧桌面壳PiClient 订阅重建流式状态
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
    { workspace: configCwdFor(run.cwd, run.projectId) },
  );
  // 恢复的历史会话同样补绑：老会话建时未选目录（row.cwd 空）而这次请求带了 cwd。
  // 闸：仅草稿会话——有对话记录的旧会话被恢复时，不再让请求里的 cwd 改写归属
  if (safeCwd && !persistedCwd && hasNoUserTurn(restoredMessages)) {
    await rebindRunCwd(run, safeCwd, threadId);
  }
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
  // 单遍扫描同取消息行与 model_change 行（转录真值，§6 M4）
  const scan = scanTranscript(sessionId);
  const transcript = scan.messages;
  const checkpoint = readCompaction(sessionId);
  const messages = projectRestoreContext(transcript, checkpoint);
  const generation = checkpoint ? checkpointGeneration(checkpoint.details) : 0;
  // 会话模型真值：转录行 > 偏好列 > 全局（与 resolveSession 同口径）。
  // 只取全局的话，非驻留会话的面板头部/容量/阈值百分比会整片显示成别的模型。
  const model = await sessionModelFor(scan.model, row);

  const resolvedCwd = row.cwd || taskSessionCwd(sessionId);
  // 项目虚拟目录与 resolveSession 同口径（普通任务会话为空）
  const projectedExternalDirs = effectiveDirsForProject(
    row.projectId,
    resolvedCwd,
  );
  // 技能段预热：投影读数与随后真正打开该会话时逐字段一致（同款 ensureSkillsLoaded）
  await ensureSkillsLoaded(
    resolvedCwd,
    projectedExternalDirs.map((dir) => dir.path),
  );
  // 主题读数同恢复链口径（偏好列先行，NULL 回落最近使用），投影读数逐字段一致
  const projectedFromColumn = decodeThemeColumn(row.designTheme);
  const projectedTheme =
    projectedFromColumn === undefined ? getLastUsedDesignTheme() : projectedFromColumn;
  // 工作模式读数同恢复链口径（偏好列合法值 ?? 全局默认），投影读数逐字段一致
  const projectedAppMode = effectiveAppMode(row.appMode);
  // 模式取会话偏好行（与 resolveSession 的恢复口径一致；自动化 turn 的守卫
  // 不在此做——投影只读，且策略注册窗口与打开面板的时机本就不同步）
  const projectedMode: SessionMode =
    row.mode === "plan" || row.mode === "ask" ? row.mode : "agent";
  // 投影也要走能力装配：否则一旦能力贡献了工具/系统段，未驻留会话的用量
  // 读数会与真正物化后的工具表漂移（读数偏低）
  const projectedPlan = await assembleSessionOrFallback(
    getCapabilityRegistry(),
    {
      sessionId,
      threadId,
      cwd: resolvedCwd,
      mode: projectedMode,
      appMode: projectedAppMode,
      model,
    },
    buildTools(
      resolvedCwd,
      threadId,
      () => projectedTheme,
      undefined,
      undefined,
      // 投影下 MCP 审批闭包不会被调用，仍按行里的真实档位投影：万一这个前提
      // 哪天不成立，一个 `auto` 会话也不该因为投影缺省而退化成逐次询问
      () => decodeApprovalLevel(row.approvalLevel),
      undefined,
      () => projectedMode,
      // 投影也要把外部目录检索工具算进工具面（读数与实际物化后的工具表一致）
      () => projectedExternalDirs,
      // 投影只读；沙箱闭包不会被调用。
      () => null,
      // 投影不含远程分流信息（只影响读数场景的工具列表体积）
      () => null,
    ),
  );
  const baseTools = projectedPlan.tools;
  const { definitions } = await loadSubagentDefinitions({
    cwd: configCwdFor(resolvedCwd, row.projectId),
    extraDirs: projectExtraDirs(resolvedCwd, row.projectId),
  });
  // 只借 toolsForMode/buildSubagentTools 的组装逻辑：它们的 execute 闭包
  // 运行期才解引用 run，投影下这些闭包永远不会被调用。
  const stub = {
    mode: projectedMode,
    planning: projectedMode === "plan" ? "planning" : "inactive",
    appMode: projectedAppMode,
    baseTools,
    // 与物化 run 同口径：投影读数要包含 run_code 的工具占用
    ptcEnabled: getPtcConfig().enabled,
    subagentTools: [],
  } as unknown as Running;
  stub.subagentTools = buildAgentExtensions(stub, baseTools, definitions);

  return contextInfoFrom({
    model,
    messages: messages as unknown as Parameters<typeof contextInfoFrom>[0]["messages"],
    systemPrompt: composeModeSystemPrompt(
      projectedMode,
      resolvedCwd,
      projectedAppMode,
      model,
      projectedTheme,
      undefined,
      projectedExternalDirs,
      projectedPlan.systemSuffix,
      false,
      configCwdFor(resolvedCwd, row.projectId),
    ),
    tools: toolsForMode(stub),
    sessionId,
    compactionGeneration: generation,
  });
}
