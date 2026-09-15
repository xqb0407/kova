/**
 * pi-agent sidecar 协议层：stdin/stdout 上的 NDJSON。
 *
 * 输入（stdin，每行一个 JSON）：
 *   { "type": "prompt", "id": "<reqId>", "text": "...", "threadId": "...", "sessionId": "...", "cwd": "..." }
 *       sessionId = 会话 id（索引表/JSONL 文件名）；提供则恢复该会话（跨重启），缺省则按 threadId 懒建新会话
 *       cwd = workspace 目录；仅在需要新建会话时使用，缺省为用户主目录
 *       prompt 结束后若有后台子代理（Task 委派）仍在运行，等待其完成并在同一条
 *       reqId 消息流内注入恢复 prompt 投递报告（多 step 收敛），再发 finish
 *   { "type": "abort", "threadId"? }   中止线程（缺省全局）的父代理与后台子代理，
 *       并取消该范围内全部排队 prompt；threadId 提供时只影响该线程
 *   { "type": "queue_update", "id", "requestId", "text" }   → { id, type: "queue_updated", requestId }
 *       修改排队中的 prompt 文本（仅 queued 状态可改；requestId 为原 prompt 的 reqId）
 *   { "type": "queue_cancel", "id", "requestId" }           → { id, type: "queue_cancelled", requestId }
 *       删除单个排队项，其 prompt 流立即 abort + finish 收尾（不执行）
 *   { "type": "queue_promote", "id", "requestId" }          → { id, type: "queue_promoted", requestId }
 *       立即发送：该项提到所属线程队首并中止该线程当前活跃 turn（其余排队项保留）
 *   prompt 排队（prompt-queue.ts）：队列按线程隔离，线程内上一轮未结束时到达的
 *       prompt 进该线程 FIFO 队列（多线程并行互不阻塞），
 *       流上先发 { chunk: { type: "data-queue", id: "queue-<reqId>", data: { phase: "queued", position } } }，
 *       轮到时同 id 原地更新 { phase: "active" }；线程内顺序由该线程串行链保证
 *   { "type": "ping", "id" }                                  → { id, type: "pong" }
 *   { "type": "list_sessions", "id" }                         → { id, type: "sessions", sessions: [...] }
 *   { "type": "list_running", "id" }                          → { id, type: "running", sessionIds: [...], turns: [{sessionId,requestId}] }
 *       当前正在跑 prompt turn 的会话清单（前端刷新/启动后水合侧边栏"运行中"指示）；
 *       turns 为会话与请求 id 齐备的子集，供前端在 webview 存储丢失时重建在飞流登记
 *   { "type": "get_subagent_activity", "id", "delegationId" } → { id, type: "subagent_activity_snapshot", record, items }
 *       子代理一次委派的运行活动快照（Task 委派的全局内存索引，delegationId 接受 ≥4 位前缀）；
 *       record = { agentName, description?, status, startedAt, completedAt?, turns, toolCalls, report? }，
 *       items = SubagentActivityItem[]（见 types.ts）；记录不存在（重启/被清理）回 error
 *   { "type": "new_session", "id", "threadId", "cwd" }        → { id, type: "session", sessionId, threadId }
 *   { "type": "fork_session", "id", "sessionId" }             → { id, type: "forked", sessionId: <新会话> }
 *       分支对话：把源会话转录复制到全新 sessionId（seq 沿用、header 重写），
 *       索引行标题加「（分支）」后缀；与源会话此后再无关联
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
 *   { "type": "get_personalization", "id" }                   → { id, type: "personalization", settings, paths }（个性化设置：回复风格/称呼/人设/自定义指令；paths = 人设/指令身份文件绝对路径）
 *   { "type": "set_personalization", "id", "settings" }       → { id, type: "personalization", settings, paths }（人设/指令落全局身份文件、结构化字段落 SQLite kv + 活动会话系统提示词热替换）
 *   { "type": "get_memory", "id" }                            → { id, type: "memory", settings }（记忆设置：总开关/作用域叠加/文件检索/指定文件白名单）
 *   { "type": "set_memory", "id", "settings" }                → { id, type: "memory", settings }（落 SQLite kv + 活动会话系统提示词热替换，同 personalization）
 *   { "type": "list_memory_files", "id", "cwd"? }             → { id, type: "memory_files", scopes: { global, workspace } }
 *       两作用域记忆目录路径与文件清单（工作区未选时 workspace 为 null）；设置 → 记忆页渲染用
 *   { "type": "read_memory_file", "id", "scope", "cwd"?, "file" } → { id, type: "memory_file", file, content }
 *       读单个记忆文件（相对记忆目录，允许 daily/...；路径越界回 missing）；设置页点开文件预览/编辑用
 *   { "type": "write_memory_file", "id", "scope", "cwd"?, "file", "content" } → { id, type: "memory_file_saved", scope, file, bytes }
 *       保存设置页编辑的记忆文件（整体覆盖，根级 .md），成功后热替换活动会话提示词
 *   { "type": "list_subagents", "id", "cwd"? }                → { id, type: "subagents", agents, workspaceCwd, diagnostics }
 *   { "type": "save_subagent", "id", "scope", "cwd"?, ("definition"|"raw"), "name"? } → 校验后写 <app_data>/subagents 或 <cwd>/.xulux/subagents 的 YAML + 热重载 → 同款 subagents 应答（name=编辑前原名，改名时清旧文件）
 *   { "type": "delete_subagent", "id", "scope", "name", "cwd"? } → 删文件 + 热重载 → 同款 subagents 应答（内置不可删）
 *   { "type": "set_subagent_enabled", "id", "scope", "name", "cwd"?, "enabled" } → 开关落 kv + 热重载 → 同款 subagents 应答
 *   { "type": "automation_list", "id" }                        → { id, type: "automation_list", tasks }
 *   { "type": "automation_save", "id", "task" }                → 无 task.id 建 / 有则全量覆盖（排期经 resolveScheduledTaskDefinition 校验）→ automation_list 应答
 *   { "type": "automation_delete", "id", "taskId" }            → 删任务 → automation_list 应答
 *   { "type": "automation_set_enabled", "id", "taskId", "enabled" } → 开关排期 → automation_list 应答
 *   { "type": "automation_run_now", "id", "taskId" }           → 立即触发一次（结果经 automation_run_done 自发帧）→ automation_list 应答
 *   { "type": "automation_preview", "id", "scheduleType", "schedule", "count"? } → { id, type: "automation_preview", runs } 或 { id, type: "automation_preview", error }（排期校验红字提示，不占调度器）
 *   { "type": "automation_templates", "id" }                   → { id, type: "automation_templates", templates }（预置模板清单，见 automation/templates.ts）
 *   { "type": "list_skills", "id", "cwd"? }                   → { id, type: "skills", skills, workspaceCwd, diagnostics }
 *       技能清单（<cwd>/.xulux/skills、<app_data>/skills 可编辑 + 生态 .agents/skills 只读合并，
 *       同名遮蔽 工作区>生态·工作区>系统>生态·用户）；设置 → 技能页渲染用
 *   { "type": "save_skill", "id", "scope", "cwd"?, ("definition"|"raw"), "fallbackName"?, "name"? }
 *                                                            → 校验后写 <app_data>/skills 或 <cwd>/.xulux/skills 的
 *       技能 .md 文档（frontmatter+正文）+ 热重载 → 同款 skills 应答（name=编辑前原名，改名时清旧文件）
 *   { "type": "delete_skill", "id", "scope", "name", "cwd"? } → 删文件 + 热重载 → 同款 skills 应答（生态只读不可删）
 *   { "type": "set_skill_enabled", "id", "scope", "name", "cwd"?, "enabled" } → 开关落 kv + 热重载 → 同款 skills 应答
 *   { "type": "set_skills_enabled", "id", "targets": [{ "scope", "name" }...], "cwd"?, "enabled" }
 *       批量开关（设置页「全部启用 / 全部关闭」快捷）：targets 整表置为目标状态、一次性落盘 + 热重载 → 同款 skills 应答
 *   { "type": "list_mcp_servers", "id", "cwd"? }             → { id, type: "mcp_servers", servers, workspaceCwd, diagnostics }
 *       MCP 服务器清单（系统 ~/.xulux/mcp.json + 工作区 .mcp.json/.xulux/mcp.json 合并，
 *       含每台连接状态）；设置 → MCP 页渲染用
 *   { "type": "save_mcp_server", "id", "layer", "cwd"?, ("definition"), "name"? } → 校验后写系统/工作区覆盖文件
 *       + 断连重载 → 同款 mcp_servers 应答（name=编辑前原名，改名时清旧条目）
 *   { "type": "delete_mcp_server", "id", "layer", "name", "cwd"? } → 删条目 + 断连 → 同款应答
 *   { "type": "set_mcp_server_enabled", "id", "layer", "name", "cwd"?, "enabled" } → 开关落 kv + 断连重载 → 同款应答
 *   { "type": "test_mcp_server", "id", "layer", "name", "cwd"? } → { id, type: "mcp_server_test", status }
 *   { "type": "get_mcp_server_tools", "id", "name", "cwd"? } → { id, type: "mcp_server_tools", name, tools }
 *     （工具清单：优先元数据缓存，缺失才握手——展开懒服务器可能等几秒）
 *       强制重新握手（先断后连），设置页"测试连接"用
 *   { "type": "authorize_mcp_server", "id", "name", "cwd"? } → { id, type: "mcp_servers", ... }
 *       HTTP 服务器 OAuth 2.1 授权：开浏览器 + 本地回调等用户批准（可达数分钟，
 *       前端需长超时），完成后同款 mcp_servers 应答刷新全部行状态
 *   { "type": "revoke_mcp_server_auth", "id", "name", "cwd"? } → { id, type: "mcp_servers", ... }
 *       取消 OAuth 授权：清掉该服务器 URL 的存量凭据并断开（下次握手回到 needsAuth）
 *   { "type": "get_mcp_audit_log", "id", "name"?, "limit"? } → { id, type: "mcp_audit_log", events }
 *       观测审计事件（连接/断开/调用/截断/授权/健康探测，跨重启持久，时间升序）
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
 *   { "type": "set_mode", "id", "threadId", "sessionId"?, "mode" }       → { id, type: "mode_changed", mode, planning }
 *       mode = agent | plan；切换会热替换工具集与系统提示词
 *   { "type": "get_planning_state", "id", "threadId", "sessionId"? }     → { id, type: "planning_state", mode, planning }
 *       拉取当前模式快照（前端刷新/切线程后恢复模式选择器用）
 *   { "type": "tool_confirm", "id", "threadId", "sessionId"?, "approvalId", "approved" } → { id, type: "tool_confirmed", approvalId }
 *       结算逐工具审批（bash/write/edit 执行前）与 plan_exit 的模式退出确认
 *       （prompt 流内 data-toolApproval chunk 发起）
 *   { "type": "question_answer", "id", "threadId", "questionId", "answers": [{ questionId, selectedIds, otherText?, skipped? }] } → { id, type: "question_answered", questionId }
 *       结算 Question 工具的挂起提问（prompt 流内 data-question chunk 发起，前端 AskUserQuestions 卡片作答）
 *   { "type": "context_info", "id", "threadId", "sessionId"? } → { id, type: "context_info", ... }
 *       上下文面板读数：容量/阈值/消息/系统提示词/工具占用 + 平均缓存命中率（现算，零持久化）
 *   { "type": "compact", "id", "threadId", "sessionId"? }     → { id, type: "compacted", generation, tokensBefore, summarized }
 *       手动压缩上下文（仅空闲回合边界；prompt 运行中拒绝）
 *   { "type": "test_provider", "id", "baseUrl", "apiKey", "api", "model" } → { id, type: "tested", ok: true }
 *   { "type": "delete_custom_provider", "id", "provider" }    → { id, type: "custom_provider_deleted", provider }
 *   prompt 流内模式推送：{ id, chunk: { type: "data-planningState", data: { mode, approvalLevel, planning } } }
 *                 委派绑定：{ id, chunk: { type: "data-subagentDelegation", data: { toolCallId, delegationId, agentName, description? } } }
 *                 （Task 工具启动委派时发起：前端把消息里的 Task 行绑到 delegationId，点击开面板「子智能体」tab）
 *                 审批请求：{ id, chunk: { type: "data-toolApproval", data: { approvalId, toolCallId, toolName, input } } }
 *                 （toolName = plan_exit 时 input 带 { rationale, title, markdown, filePath }，前端渲染计划审批卡）
 *                 面板唤起：{ id, chunk: { type: "data-panelOpen", data: { type: "browser", url? } } }
 *                 （browser_* 工具动作时发起，前端把浏览器 tab 推到前台并展开面板）
 *
 * prompt 流（stdout）：{ "id": "<reqId>", "chunk": { ...AI SDK UIMessageChunk } }
 *
 * 自发通知（stdout，无 id，宿主原样广播给所有前端）：
 *   { "type": "turn_changed", "sessionId": "...", "active": true|false }
 *       某会话一轮 turn 开跑/收尾；发起方未带 sessionId 的轮次不广播
 *   { "type": "subagent_activity", "delegationId": "...", "item": SubagentActivityItem }
 *       子代理运行活动（思考/正文增量、工具起止、轮次、结算终态）；父 turn 已结束后
 *       后台委派继续广播；前端 store 按 delegationId 归并，面板 tab 流式渲染
 *   { "type": "automation_fired", "taskId", "taskName", "taskType", "runId", "firedAt" }
 *       定时任务触发开始运行（调度器 onTaskStarted 钩子，见 automation/runtime.ts）
 *   { "type": "automation_run_done", "taskId", "taskName", "runId", "ok",
 *     "sessionId"?, "error"?, "finishedAt" }
 *       该次运行结算（成功/失败）；sessionId 为本次新建的真实 agent 会话
 *       （onTaskFailed 的调度错误路径可能缺省）
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  sessionInsert,
  sessionList,
  sessionPrefsSet,
  sessionRename,
  sessionSetArchived,
  sessionTouch,
  kvSet,
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
  scanTranscript,
  persist,
  historyToUiMessages,
} from "./transcript";
import { contextInfo, needsCompaction, runCompaction } from "./context";
import {
  dropRun,
  findRunBySession,
  forgetThreadStates,
  listActiveTurnDetails,
  listActiveTurnSessions,
  noteActiveTurn,
  projectContextInfo,
  rebindRunThread,
  reloadSkills,
  reloadSubagents,
  resolveSession,
  running,
  whenThreadIdle,
} from "./sessions";
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
  getDelegationSnapshot,
  runningDelegations,
} from "./subagent";
import {
  beginRun,
  isPromptActive,
  send,
  sendChunk,
  setActiveReqId,
} from "./stream";
import {
  applyMode,
  clearPendingToolApprovals,
  composeModeSystemPrompt,
  planningPayload,
  resolveToolApproval,
} from "./modes";
import {
  applyPersonalization,
  getPersonalization,
  rulesFilePath,
  soulFilePath,
} from "./personalization";
import {
  applyMemoryConfig,
  getMemoryConfig,
  memoryScopesPayload,
  readMemoryFile,
  writeMemoryFile,
  type MemoryScope,
} from "./memory";
import {
  deleteSubagentDefinition,
  loadSubagentDefinitions,
  parseSubagentDraftYaml,
  saveSubagentDefinition,
  setSubagentEnabled,
  type SubagentDraft,
  type SubagentScope,
} from "./subagent-definitions";
import {
  deleteSkillDoc,
  ensureSkillsLoaded,
  MAX_SKILL_BATCH_TARGETS,
  parseSkillDoc,
  saveSkillDoc,
  setSkillEnabled,
  setSkillsEnabled,
  skillsSnapshot,
  type SkillScope,
} from "./skills";
import { aggregateUsageStats } from "./usage-stats";
import {
  cancelPendingMcpApprovals,
  resolveMcpApproval,
} from "./mcp-tools";
import { mcpManager } from "./mcp-manager";
import { getValidTools } from "./mcp-cache";
import { clearOAuthForServer } from "./mcp-oauth";
import { readMcpAudit } from "./mcp-audit";
import {
  activeMcpServers,
  deleteMcpServer,
  loadMcpServers,
  saveMcpServer,
  setMcpServerEnabled,
  type McpDraft,
} from "./mcp-config";
import {
  cancelPendingQuestions,
  resolveQuestionAnswer,
  type QuestionAnswerItem,
} from "./question-tools";
import {
  automationDeletePayload,
  automationListPayload,
  automationPreviewPayload,
  automationRunNowPayload,
  automationSavePayload,
  automationSetEnabledPayload,
  automationTemplatesPayload,
} from "./automation/commands";
import type { CustomModelSpec, Running, SessionSummary } from "./types";

/** 子智能体清单应答负载：设置页与所有变更命令共用同一形状（改后即见） */
async function subagentsPayload(cwd?: string) {
  const r = await loadSubagentDefinitions({ cwd });
  return {
    agents: r.entries.map((e) => ({
      name: e.name,
      description: e.description,
      tools: e.tools,
      ...(e.maxTurns !== undefined ? { maxTurns: e.maxTurns } : {}),
      ...(e.model ? { model: e.model } : {}),
      prompt: e.prompt,
      scope: e.scope,
      ...(e.path ? { path: e.path } : {}),
      ...(e.raw ? { raw: e.raw } : {}),
      enabled: e.enabled,
      editable: e.editable,
    })),
    workspaceCwd: cwd ?? null,
    diagnostics: r.diagnostics,
  };
}

/** 技能 scope 字段校验：四个来源层之外回 null */
function skillScopeFrom(value: unknown): SkillScope | null {
  return value === "workspace" ||
    value === "compat-workspace" ||
    value === "system" ||
    value === "compat"
    ? (value as SkillScope)
    : null;
}

/** 技能清单应答负载：设置页与所有变更命令共用同一形状（改后即见） */
async function skillsPayload(cwd?: string) {
  await ensureSkillsLoaded(cwd);
  const r = skillsSnapshot(cwd);
  return {
    skills: r.entries.map((e) => ({
      name: e.name,
      description: e.description,
      scope: e.scope,
      ...(e.disableModelInvocation ? { disableModelInvocation: true } : {}),
      enabled: e.enabled,
      shadowed: e.shadowed,
      editable: e.editable,
      path: e.path,
      content: e.content,
      sizeBytes: e.sizeBytes,
      ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
    })),
    workspaceCwd: cwd ?? null,
    diagnostics: r.diagnostics,
  };
}

/** MCP 服务器清单应答负载：设置页与所有变更命令共用同一形状（改后即见） */
async function mcpServersPayload(cwd?: string) {
  const r = await loadMcpServers(cwd);
  const statuses = new Map(mcpManager.listStatuses(r.defs).map((s) => [s.name, s]));
  return {
    servers: r.defs.map((def) => ({
      name: def.name,
      layer: def.layer,
      source: def.source,
      ...(def.fromStandard ? { fromStandard: true } : {}),
      transport: def.transport,
      ...(def.command ? { command: def.command } : {}),
      ...(def.args?.length ? { args: def.args } : {}),
      ...(def.env && Object.keys(def.env).length > 0 ? { env: def.env } : {}),
      ...(def.url ? { url: def.url } : {}),
      ...(def.headers && Object.keys(def.headers).length > 0 ? { headers: def.headers } : {}),
      ...(def.description ? { description: def.description } : {}),
      ...(def.lifecycle ? { lifecycle: def.lifecycle } : {}),
      ...(def.idleTimeout !== undefined ? { idleTimeout: def.idleTimeout } : {}),
      ...(def.callTimeout !== undefined ? { callTimeout: def.callTimeout } : {}),
      ...(def.approveTools?.length ? { approveTools: def.approveTools } : {}),
      enabled: r.enabledBy.get(def.name) === true,
      status: statuses.get(def.name) ?? { name: def.name, state: "idle", toolCount: 0 },
    })),
    workspaceCwd: cwd ?? null,
    diagnostics: r.diagnostics,
  };
}

/** 变更后的连接池热重载：以当前启用集合 diff，断开被删/改/禁用的服务器 */
async function reloadMcpConnections(cwd?: string): Promise<void> {
  const defs = await activeMcpServers(cwd);
  mcpManager.applyConfig(defs);
  // eager 服务器即时预连（fire-and-forget）：新加/改配置的 eager 不用等首次调用
  mcpManager.prewarm(defs);
}

/** 从消息里解析 MCP 草稿（save 用）；字段宽松规整，校验交给 saveMcpServer */
function mcpDraftFromMessage(raw: unknown): McpDraft {
  const d = (raw ?? {}) as Record<string, unknown>;
  const transport = d.transport === "http" ? "http" : "stdio";
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const map = (v: unknown) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const arr = (v: unknown) =>
    Array.isArray(v) ? v.map(String).filter((s) => s.trim()) : undefined;
  return {
    name: String(d.name ?? "").trim(),
    transport,
    ...(transport === "stdio"
      ? {
          command: str(d.command),
          ...(arr(d.args)?.length ? { args: arr(d.args) } : {}),
          ...(map(d.env) ? { env: map(d.env) } : {}),
        }
      : {
          url: str(d.url),
          ...(map(d.headers) ? { headers: map(d.headers) } : {}),
        }),
    ...(str(d.description) ? { description: str(d.description) } : {}),
    ...(typeof d.lifecycle === "string" && ["lazy", "eager", "keep-alive"].includes(d.lifecycle)
      ? { lifecycle: d.lifecycle as McpDraft["lifecycle"] }
      : {}),
    ...(typeof d.idleTimeout === "number" && Number.isFinite(d.idleTimeout)
      ? { idleTimeout: d.idleTimeout }
      : {}),
    ...(typeof d.callTimeout === "number" && Number.isFinite(d.callTimeout)
      ? { callTimeout: d.callTimeout }
      : {}),
    ...(arr(d.approveTools)?.length ? { approveTools: arr(d.approveTools) } : {}),
  };
}

/** stdin 关闭（父进程写完）不等于任务处理完毕，等挂起请求清零再退出 */
let stdinClosed = false;
let pendingOps = 0;
let exiting = false;

function maybeExit() {
  if (exiting || !stdinClosed || pendingOps > 0) return;
  exiting = true;
  // 退出前断开全部 MCP 连接（stdio 子进程随 SDK close 收尾，避免孤儿进程）
  mcpManager.disposeAll();
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

/** prompt turn 串行链：每线程一条（队列按线程隔离，不同线程并行跑 turn）。
 *  每节 = 一个 turn 的完整生命周期（会话准备 → runStepWithRecovery →
 *  委派收敛循环 → finally finish），跑完才放行该线程下一节 */
const promptChains = new Map<string, Promise<void>>();

/** "Agent is already processing a prompt" 兜底识别（pi-agent-core 守卫文案） */
function isAlreadyProcessingError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return text.includes("Agent is already processing");
}

/** turn 结算结果（onOutcome 回传给调用方；错误以 chunk 下发、不抛出，
 *  无人值守 runner 需要程序化判定成败时经此回调观察） */
export type PromptTurnOutcome = { ok: boolean; errorText?: string };

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
      // 本项已被取消（取消时流已收尾）或队列已空：静默让位
      if (!next) return;
      turnReqId = next.reqId;
      turnMsg = next.msg;
      sendChunk(turnReqId, {
        type: "data-queue",
        id: queueChunkId(turnReqId),
        data: { phase: "active" },
      });
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
    beginRun(threadId);
    try {
      await run.agent.prompt(text);
    } catch (err) {
      // 线程串行链已消除本线程并发 prompt；此处兜底 abort 收尾等极窄竞态窗口。
      // 守卫抛错时尚未产生任何事件，waitForIdle 后原地重试一次是干净的。
      if (!isAlreadyProcessingError(err)) throw err;
      logErr("agent.prompt hit active-run guard, retrying after idle");
      await run.agent.waitForIdle();
      beginRun(threadId);
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
        turnError = `Context overflow, automatic compaction failed: ${outcome.message}`;
        sendChunk(reqId, { type: "error", errorText: turnError });
      } else {
        turnError = "run aborted by stop request";
      }
      return;
    }
    emitCompaction(cid, compactionChunkData(outcome));
    await runStep(text);
    if (run.pendingOverflowRecovery) {
      run.pendingOverflowRecovery = false;
      turnError = "Context overflow persisted after compaction. Start a new session.";
      sendChunk(reqId, { type: "error", errorText: turnError });
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
    sendChunk(reqId, { type: "finish" });
    setActiveReqId(threadId, null);
    persist(run);
    // Stop 中止可能不带 error chunk（abort() 让 prompt 静默收敛）：按失败结算
    onOutcome?.(
      turnError
        ? { ok: false, errorText: turnError }
        : run.stopRequested
          ? { ok: false, errorText: "run aborted by stop request" }
          : { ok: true },
    );
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
  const task = mgmtQueue.then(() => resolveSession(threadId, sessionId, cwd));
  mgmtQueue = task.then(
    () => {},
    () => {},
  );
  return task;
}

/** 中止单个线程的 run：父代理、后台子代理、挂起审批/提问与压缩请求全部结算 */
function abortRun(run: Running, threadId: string): void {
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

export async function dispatch(reqId: string, msg: Record<string, unknown>) {
  switch (msg.type) {
    case "ping": {
      send({ id: reqId, type: "pong" });
      break;
    }
    case "abort": {
      // 用户 Stop：中止线程（threadId 提供时仅该线程，缺省全局兜底）的父代理
      // 与全部后台子代理，并让收敛循环退出；挂起的逐工具审批按拒绝结算、
      // 挂起提问按取消结算，避免永久悬挂；该范围的排队 prompt 一并取消
      // （各自流立即 abort+finish 收尾，不再执行）
      const threadId = typeof msg.threadId === "string" ? msg.threadId : "";
      if (threadId) {
        // 刷新后前端 thread id 即 sessionId，而 run 可能仍驻留在旧草稿键下：
        // 反查索引兜底，否则续流会话上的 Stop 只杀前端流、sidecar 照跑
        const owner = running.has(threadId)
          ? { threadId, run: running.get(threadId)! }
          : findRunBySession(threadId);
        if (owner) abortRun(owner.run, owner.threadId);
        cancelAllEntries(threadId);
        if (owner && owner.threadId !== threadId) cancelAllEntries(owner.threadId);
      } else {
        for (const [tid, run] of running.entries()) {
          abortRun(run, tid);
        }
        cancelAllEntries();
      }
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
      // 立即发送：该项提到所属线程队首，中止该线程当前活跃 turn（其余排队项保留；
      // 其他线程的活跃 turn 不受影响，各自并行）
      const requestId = String(msg.requestId ?? "");
      const entry = promoteEntry(requestId);
      if (!entry) {
        throw new Error(`no queued prompt: ${requestId}`);
      }
      if (isTurnBusy(entry.threadId)) {
        const active = running.get(entry.threadId);
        if (active) abortRun(active, entry.threadId);
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
      if (isPromptActive(String(msg.threadId ?? "default"))) {
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
      // 上下文面板读数：运行中也可查询（只读不阻塞）。
      // 迭代2（P2）：未驻留的会话走只读投影（不建 Agent、不写 running）；
      // 已驻留的现算——顺带保留旧语义（含"请求带 cwd 时补绑"）。
      // 无 sessionId（新线程首开面板）：维持原 resolveSession 落会话的行为。
      const threadId = String(msg.threadId ?? "default");
      const sessionId =
        typeof msg.sessionId === "string" ? msg.sessionId : undefined;
      const cwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
      if (sessionId && !running.has(threadId)) {
        send({
          id: reqId,
          type: "context_info",
          ...(await projectContextInfo(threadId, sessionId)),
        });
      } else {
        const run = await resolveSession(threadId, sessionId, cwd);
        send({ id: reqId, type: "context_info", ...contextInfo(run) });
      }
      break;
    }
    case "list_sessions": {
      // 迭代 4（P4）：消息计数改读索引表 message_count 列（session_touch
      // 增量维护 + Rust 启动一次性回填），不再逐会话读 JSONL。
      const sessions: SessionSummary[] = (await sessionList())
        .map((r) => ({
          sessionId: r.id,
          name: r.title || undefined,
          firstMessage: r.first_message,
          messageCount: r.message_count,
          modified: r.updated_at,
          cwd: r.cwd,
          archived: r.archived === 1,
          // 会话级偏好（undefined = 从未变更过）：切回会话时前端据此恢复 mode/model
          mode: r.mode === "agent" || r.mode === "plan" ? r.mode : undefined,
          approvalLevel:
            r.approvalLevel === "ask" || r.approvalLevel === "auto-edit" || r.approvalLevel === "auto"
              ? r.approvalLevel
              : undefined,
          modelProvider: r.modelProvider ?? undefined,
          modelId: r.modelId ?? undefined,
        }))
        .filter((s) => s.messageCount > 0);
      send({ id: reqId, type: "sessions", sessions });
      break;
    }
    case "list_running": {
      // 纯内存快照且同步发出（不 await mgmtQueue）：响应行必然写在其后
      // 发生的 turn_changed 之前，前端"先订阅后种子"的合并无空窗
      send({
        id: reqId,
        type: "running",
        sessionIds: listActiveTurnSessions(),
        turns: listActiveTurnDetails(),
      });
      break;
    }
    case "get_subagent_activity": {
      // 子代理运行活动快照（面板 tab 补水合：刷新后/点开已完成的委派）。
      // delegationId 接受完整 uuid 或 ≥4 位前缀；查不到（sidecar 重启/记录被清）报错。
      const delegationId = String(msg.delegationId ?? "");
      const snapshot = getDelegationSnapshot(delegationId);
      if (!snapshot) throw new Error(`delegation not found: ${delegationId}`);
      send({ id: reqId, type: "subagent_activity_snapshot", ...snapshot });
      break;
    }
    case "new_session": {
      const threadId = String(msg.threadId ?? `thread-${Date.now()}`);
      const cwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
      const run = await resolveSession(threadId, undefined, cwd);
      send({ id: reqId, type: "session", sessionId: run.sessionId, threadId });
      break;
    }
    case "fork_session": {
      const sourceId = String(msg.sessionId ?? "");
      // 源会话元数据走 session_list（host 模式 session_get 只回 cwd，没有 title）
      const src = (await sessionList()).find((r) => r.id === sourceId);
      if (!src) throw new Error(`session not found: ${sourceId}`);
      const sourceFile = sessionPath(sourceId);
      if (!existsSync(sourceFile))
        throw new Error(`transcript not found: ${sourceId}`);
      // 逐行复制转录（header 行不拷、撕裂尾行丢弃、未知行型不拷）；
      // 数据行原样保留 seq——seq 是文件内编号空间，跨会话不冲突
      const dataLines: string[] = [];
      let messageCount = 0;
      for (const line of readFileSync(sourceFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let row: { type?: string; seq?: number; agent?: unknown };
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!row || row.type === "header" || typeof row.seq !== "number")
          continue;
        if (row.type === "message") {
          if (!row.agent) continue;
          messageCount += 1;
        } else if (row.type !== "compaction") {
          continue;
        }
        dataLines.push(line);
      }
      const newId = randomUUID();
      writeFileSync(
        sessionPath(newId),
        JSON.stringify({
          type: "header",
          schema: 1,
          id: newId,
          cwd: src.cwd,
          created_at: new Date().toISOString(),
        }) + "\n" + (dataLines.length ? dataLines.join("\n") + "\n" : ""),
      );
      await sessionInsert(newId, src.cwd);
      // 索引行补写：标题加「（分支）」后缀（无名会话用首轮消息行兜底，与
      // list_sessions 的标题回退一致）；first_message 拷贝源值；计数按实拷行数
      const srcTitle = src.title || src.first_message.slice(0, 60);
      await sessionTouch(
        newId,
        srcTitle ? `${srcTitle}（分支）` : "",
        src.first_message,
        messageCount,
      );
      send({ id: reqId, type: "forked", sessionId: newId });
      break;
    }
    case "get_history": {
      const sessionId = String(msg.sessionId ?? "");
      // 从 agent 消息重建：text/reasoning 之外还带 tool part（input/output 对齐 live 流）；
      // 压缩检查点行重建为 data-compaction 分隔线 part，刷新后分隔线不丢。
      // 迭代 4：单遍 scanTranscript 同时取消息行与检查点行（此前读两遍文件）
      const scan = scanTranscript(sessionId);
      const messages = historyToUiMessages(scan.messages, scan.compactions);
      send({ id: reqId, type: "history", messages });
      break;
    }
    case "delete_session": {
      const sessionId = String(msg.sessionId ?? "");
      for (const [tid, run] of running) {
        if (run.sessionId === sessionId) {
          dropRun(tid);
          forgetThreadStates(tid); // 迭代2：删会话同样清 per-thread 旁路态（todo）
        }
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
      // 模型选择持久化到 kv（sidecar 侧写，应用重启后由 initCurrentModelKey 恢复；
      // 前端只在桌面模式重复写同一份，远程网页模式由此获得持久化）
      void kvSet("pi.model", JSON.stringify({ provider, modelId })).catch(() => {});
      // 模型行是系统提示词环境段的一部分：换模型后整段重排，活动会话即时生效；
      // 顺带把模型写进各活动会话的偏好行（与会话级记忆一致）
      for (const run of running.values()) {
        run.agent.state.model = model;
        run.agent.state.systemPrompt = composeModeSystemPrompt(
          run.mode,
          run.cwd,
          model,
        );
        void sessionPrefsSet(run.sessionId, { modelProvider: provider, modelId }).catch(
          () => {},
        );
      }
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
      send({
        id: reqId,
        type: "personalization",
        settings: getPersonalization(),
        paths: { soul: soulFilePath(), rules: rulesFilePath() },
      });
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
        run.agent.state.systemPrompt = composeModeSystemPrompt(
          run.mode,
          run.cwd,
          run.agent.state.model,
        );
      }
      send({
        id: reqId,
        type: "personalization",
        settings,
        paths: { soul: soulFilePath(), rules: rulesFilePath() },
      });
      break;
    }
    case "get_memory": {
      send({ id: reqId, type: "memory", settings: getMemoryConfig() });
      break;
    }
    case "set_memory": {
      const settings = await applyMemoryConfig(msg.settings);
      // 与 set_personalization 同款广播：记忆段变了就整段重排系统提示词；
      // 工具表常驻不重建（execute 内实时读配置门控）
      for (const run of running.values()) {
        run.agent.state.systemPrompt = composeModeSystemPrompt(
          run.mode,
          run.cwd,
          run.agent.state.model,
        );
      }
      send({ id: reqId, type: "memory", settings });
      break;
    }
    case "list_memory_files": {
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      send({ id: reqId, type: "memory_files", scopes: memoryScopesPayload(cwd) });
      break;
    }
    case "read_memory_file": {
      // 预览/编辑入口：不设总开关门控——关闭记忆也应能查看已有内容再决定
      const scope: MemoryScope = msg.scope === "workspace" ? "workspace" : "global";
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      if (scope === "workspace" && !cwd) throw new Error("read_memory_file: workspace scope requires cwd");
      const file = String(msg.file ?? "");
      if (!file.trim()) throw new Error("read_memory_file: file is required");
      const res = await readMemoryFile(getMemoryConfig(), scope, cwd ?? "", file);
      if (res.kind !== "text") throw new Error(`memory file not found: ${file}`);
      send({ id: reqId, type: "memory_file", file, content: res.content });
      break;
    }
    case "write_memory_file": {
      const scope: MemoryScope = msg.scope === "workspace" ? "workspace" : "global";
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      if (scope === "workspace" && !cwd) throw new Error("write_memory_file: workspace scope requires cwd");
      const file = String(msg.file ?? "");
      const content = String(msg.content ?? "");
      // 整体覆盖保存（设置页编辑语义）；文件名/路径校验在 writeMemoryFile 内
      const saved = await writeMemoryFile(scope, cwd ?? "", file, content, "overwrite");
      // 内容可能正被注入：与 set_memory 同款热替换活动会话提示词
      for (const run of running.values()) {
        run.agent.state.systemPrompt = composeModeSystemPrompt(
          run.mode,
          run.cwd,
          run.agent.state.model,
        );
      }
      send({ id: reqId, type: "memory_file_saved", scope, file: saved.rel, bytes: saved.bytes });
      break;
    }
    case "list_subagents": {
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      send({ id: reqId, type: "subagents", ...(await subagentsPayload(cwd)) });
      break;
    }
    case "save_subagent": {
      const scope: SubagentScope | null =
        msg.scope === "workspace" ? "workspace" : msg.scope === "system" ? "system" : null;
      if (!scope) throw new Error('save_subagent: scope must be "system" or "workspace"');
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      if (scope === "workspace" && !cwd) {
        throw new Error("save_subagent: workspace scope requires cwd");
      }
      // 两种载荷：表单结构体（definition）或 YAML 原文（raw，走同一解析校验）
      let draft: SubagentDraft;
      if (typeof msg.raw === "string") {
        const parsed = parseSubagentDraftYaml(msg.raw, scope);
        if (!parsed.ok) throw new Error(parsed.errors.join("; "));
        draft = parsed.draft;
      } else {
        const d = (msg.definition ?? {}) as Record<string, unknown>;
        draft = {
          name: String(d.name ?? ""),
          description: String(d.description ?? ""),
          tools: Array.isArray(d.tools) ? d.tools.map((t) => String(t).toLowerCase()) : [],
          prompt: String(d.prompt ?? ""),
          ...(typeof d.maxTurns === "number" ? { maxTurns: d.maxTurns } : {}),
          ...(typeof d.model === "string" && d.model.trim() ? { model: d.model.trim() } : {}),
        };
      }
      // name = 编辑前的原名（改名时据此清掉旧文件；新建省略）
      const replaceName =
        typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : undefined;
      await saveSubagentDefinition(scope, draft, { cwd, replaceName });
      await reloadSubagents();
      send({ id: reqId, type: "subagents", ...(await subagentsPayload(cwd)) });
      break;
    }
    case "delete_subagent": {
      const scope: SubagentScope | null =
        msg.scope === "workspace" ? "workspace" : msg.scope === "system" ? "system" : null;
      if (!scope) throw new Error('delete_subagent: scope must be "system" or "workspace"');
      const name = String(msg.name ?? "");
      if (!name) throw new Error("delete_subagent: name is required");
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      if (scope === "workspace" && !cwd) {
        throw new Error("delete_subagent: workspace scope requires cwd");
      }
      await deleteSubagentDefinition(scope, name, { cwd });
      await reloadSubagents();
      send({ id: reqId, type: "subagents", ...(await subagentsPayload(cwd)) });
      break;
    }
    case "set_subagent_enabled": {
      const scope: SubagentScope | null =
        msg.scope === "builtin" || msg.scope === "system" || msg.scope === "workspace"
          ? msg.scope
          : null;
      if (!scope) throw new Error("set_subagent_enabled: invalid scope");
      const name = String(msg.name ?? "");
      if (!name) throw new Error("set_subagent_enabled: name is required");
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      const enabled = msg.enabled === true;
      await setSubagentEnabled(scope, name, enabled, cwd);
      await reloadSubagents();
      send({ id: reqId, type: "subagents", ...(await subagentsPayload(cwd)) });
      break;
    }
    // —— 自动化定时任务（管理页表单与后续 M3 消费；载荷层见 automation/commands.ts）——
    case "automation_list": {
      const r = await automationListPayload();
      send({ id: reqId, type: r.type, tasks: r.tasks });
      break;
    }
    case "automation_save": {
      const r = await automationSavePayload(msg);
      send({ id: reqId, type: r.type, tasks: r.tasks });
      break;
    }
    case "automation_delete": {
      const r = await automationDeletePayload(msg);
      send({ id: reqId, type: r.type, tasks: r.tasks });
      break;
    }
    case "automation_set_enabled": {
      const r = await automationSetEnabledPayload(msg);
      send({ id: reqId, type: r.type, tasks: r.tasks });
      break;
    }
    case "automation_run_now": {
      const r = await automationRunNowPayload(msg);
      send({ id: reqId, type: r.type, tasks: r.tasks });
      break;
    }
    case "automation_preview": {
      send({ id: reqId, ...automationPreviewPayload(msg) });
      break;
    }
    case "automation_templates": {
      send({ id: reqId, ...automationTemplatesPayload() });
      break;
    }
    case "list_skills": {
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      send({ id: reqId, type: "skills", ...(await skillsPayload(cwd)) });
      break;
    }
    case "save_skill": {
      const scope: "system" | "workspace" | null =
        msg.scope === "workspace" ? "workspace" : msg.scope === "system" ? "system" : null;
      if (!scope) throw new Error('save_skill: scope must be "system" or "workspace"');
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      if (scope === "workspace" && !cwd) {
        throw new Error("save_skill: workspace scope requires cwd");
      }
      // 两种载荷：表单结构体（definition）或文档原文（raw，走同一解析校验；
      // raw 缺 frontmatter name 时以 fallbackName（导入文件名 stem）兜底）
      let draft;
      if (typeof msg.raw === "string") {
        const fallbackName =
          typeof msg.fallbackName === "string" ? msg.fallbackName : undefined;
        const parsed = parseSkillDoc(msg.raw, {
          ...(fallbackName ? { fallbackName } : {}),
        });
        if (!parsed.ok) throw new Error(parsed.errors.join("；"));
        draft = parsed.draft;
      } else {
        const d = (msg.definition ?? {}) as Record<string, unknown>;
        draft = {
          name: String(d.name ?? ""),
          description: String(d.description ?? ""),
          content: String(d.content ?? ""),
          ...(d.disableModelInvocation === true ? { disableModelInvocation: true } : {}),
        };
      }
      // name = 编辑前的原名（改名时据此清掉旧文件；新建省略）
      const replaceName =
        typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : undefined;
      await saveSkillDoc(scope, draft, { cwd, ...(replaceName ? { replaceName } : {}) });
      await reloadSkills();
      send({ id: reqId, type: "skills", ...(await skillsPayload(cwd)) });
      break;
    }
    case "delete_skill": {
      const scope: "system" | "workspace" | null =
        msg.scope === "workspace" ? "workspace" : msg.scope === "system" ? "system" : null;
      if (!scope) throw new Error('delete_skill: scope must be "system" or "workspace"');
      const name = String(msg.name ?? "");
      if (!name) throw new Error("delete_skill: name is required");
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      if (scope === "workspace" && !cwd) {
        throw new Error("delete_skill: workspace scope requires cwd");
      }
      await deleteSkillDoc(scope, name, { cwd });
      await reloadSkills();
      send({ id: reqId, type: "skills", ...(await skillsPayload(cwd)) });
      break;
    }
    case "set_skill_enabled": {
      const scope = skillScopeFrom(msg.scope);
      if (!scope) throw new Error("set_skill_enabled: invalid scope");
      const name = String(msg.name ?? "");
      if (!name) throw new Error("set_skill_enabled: name is required");
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      const enabled = msg.enabled === true;
      await setSkillEnabled(scope, name, enabled, cwd);
      await reloadSkills();
      send({ id: reqId, type: "skills", ...(await skillsPayload(cwd)) });
      break;
    }
    case "set_skills_enabled": {
      // 批量开关（设置页「全部启用 / 全部关闭」快捷）：整表置为目标态，一次落盘
      const rawTargets = Array.isArray(msg.targets) ? msg.targets : [];
      if (rawTargets.length === 0) throw new Error("set_skills_enabled: targets is required");
      if (rawTargets.length > MAX_SKILL_BATCH_TARGETS) {
        throw new Error(
          `set_skills_enabled: too many targets (max ${MAX_SKILL_BATCH_TARGETS})`,
        );
      }
      const targets: Array<{ scope: SkillScope; name: string }> = [];
      for (const item of rawTargets) {
        const t = (item ?? {}) as Record<string, unknown>;
        const scope = skillScopeFrom(t.scope);
        if (!scope) throw new Error("set_skills_enabled: invalid scope");
        const name = String(t.name ?? "");
        if (!name) throw new Error("set_skills_enabled: name is required");
        targets.push({ scope, name });
      }
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      const enabled = msg.enabled === true;
      await setSkillsEnabled(targets, enabled, cwd);
      await reloadSkills();
      send({ id: reqId, type: "skills", ...(await skillsPayload(cwd)) });
      break;
    }
    case "list_mcp_servers": {
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
      break;
    }
    case "save_mcp_server": {
      const layer: "system" | "workspace" | null =
        msg.layer === "workspace" ? "workspace" : msg.layer === "system" ? "system" : null;
      if (!layer) throw new Error('save_mcp_server: layer must be "system" or "workspace"');
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      if (layer === "workspace" && !cwd) {
        throw new Error("save_mcp_server: workspace layer requires cwd");
      }
      const draft = mcpDraftFromMessage(msg.definition);
      // name = 编辑前的原名（改名时据此清掉旧条目；新建省略）
      const replaceName =
        typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : undefined;
      await saveMcpServer(layer, draft, { cwd, replaceName });
      await reloadMcpConnections(cwd);
      send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
      break;
    }
    case "delete_mcp_server": {
      const layer: "system" | "workspace" | null =
        msg.layer === "workspace" ? "workspace" : msg.layer === "system" ? "system" : null;
      if (!layer) throw new Error('delete_mcp_server: layer must be "system" or "workspace"');
      const name = String(msg.name ?? "");
      if (!name) throw new Error("delete_mcp_server: name is required");
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      if (layer === "workspace" && !cwd) {
        throw new Error("delete_mcp_server: workspace layer requires cwd");
      }
      // 先记下待删条目：清凭据要用它的 URL
      const { defs: beforeDefs } = await loadMcpServers(cwd);
      const gone = beforeDefs.find((d) => d.name === name && d.layer === layer);
      await deleteMcpServer(layer, name, { cwd });
      await reloadMcpConnections(cwd);
      // 删掉最后一台共用该 URL 的 http 服务器时顺带清 OAuth 凭据：
      // 凭据按 URL 键控，不清的话删除重加仍拿存量 token 静默连，用户无从重置授权
      if (gone?.transport === "http" && gone.url) {
        const url = String(gone.url);
        const { defs: afterDefs } = await loadMcpServers(cwd);
        const stillUsed = afterDefs.some(
          (d) => d.transport === "http" && String(d.url ?? "") === url,
        );
        if (!stillUsed) clearOAuthForServer(url);
      }
      send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
      break;
    }
    case "set_mcp_server_enabled": {
      const layer: "system" | "workspace" | null =
        msg.layer === "workspace" ? "workspace" : msg.layer === "system" ? "system" : null;
      if (!layer) throw new Error("set_mcp_server_enabled: invalid layer");
      const name = String(msg.name ?? "");
      if (!name) throw new Error("set_mcp_server_enabled: name is required");
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      const enabled = msg.enabled === true;
      await setMcpServerEnabled(layer, name, enabled, cwd);
      await reloadMcpConnections(cwd);
      send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
      break;
    }
    case "test_mcp_server": {
      const layer: "system" | "workspace" | null =
        msg.layer === "workspace" ? "workspace" : msg.layer === "system" ? "system" : null;
      if (!layer) throw new Error("test_mcp_server: invalid layer");
      const name = String(msg.name ?? "");
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      const { defs } = await loadMcpServers(cwd);
      const def = defs.find((d) => d.name === name && d.layer === layer);
      if (!def) throw new Error(`mcp server not found: ${name}`);
      // 强制重新握手：先断开（清掉退避期与失败状态），再按当前定义连接。
      // 应答直接取 statusFor 的完整状态，不要手拼字段——前端测试后把该行状态
      // 整段覆盖写回快照，手拼漏掉的字段（如 oauthAuthorized：「取消授权」按钮
      // 判据，凭据按 URL 键控与刚是否握手无关）会凭空消失。
      mcpManager.disconnect(name);
      try {
        await mcpManager.ensureConnected(def);
        send({ id: reqId, type: "mcp_server_test", status: mcpManager.statusFor(def) });
      } catch (err) {
        // 握手失败的 needsAuth（401 需 OAuth）与协议图标一并透出，前端据 needsAuth 显示「授权」
        const s = mcpManager.statusFor(def);
        send({
          id: reqId,
          type: "mcp_server_test",
          status: {
            ...s,
            state: "backoff",
            toolCount: 0,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
      break;
    }
    case "authorize_mcp_server": {
      const name = String(msg.name ?? "");
      if (!name) throw new Error("authorize_mcp_server: name is required");
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      const { defs } = await loadMcpServers(cwd);
      const def = defs.find((d) => d.name === name);
      if (!def) throw new Error(`mcp server not found: ${name}`);
      // 交互式 OAuth：sidecar 开浏览器 + 本地回调等用户批准，可能长达几分钟
      await mcpManager.authorize(def);
      send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
      break;
    }
    case "revoke_mcp_server_auth": {
      const name = String(msg.name ?? "");
      if (!name) throw new Error("revoke_mcp_server_auth: name is required");
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      const { defs } = await loadMcpServers(cwd);
      const def = defs.find((d) => d.name === name);
      if (!def) throw new Error(`mcp server not found: ${name}`);
      mcpManager.revokeAuth(def);
      send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
      break;
    }
    case "get_mcp_server_tools": {
      const name = String(msg.name ?? "");
      if (!name) throw new Error("get_mcp_server_tools: name is required");
      const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
      const { defs } = await loadMcpServers(cwd);
      const def = defs.find((d) => d.name === name);
      if (!def) throw new Error(`mcp server not found: ${name}`);
      // 元数据缓存优先（断开态也可读），缺失才握手——懒服务器首次展开会真连一次
      const tools = getValidTools(def) ?? (await mcpManager.ensureConnected(def));
      send({
        id: reqId,
        type: "mcp_server_tools",
        name,
        tools: tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
        })),
      });
      break;
    }
    case "get_mcp_server_log": {
      const name = String(msg.name ?? "");
      if (!name) throw new Error("get_mcp_server_log: name is required");
      send({ id: reqId, type: "mcp_server_log", name, lines: mcpManager.logFor(name) });
      break;
    }
    case "get_mcp_audit_log": {
      const name = typeof msg.name === "string" && msg.name.trim() ? msg.name : undefined;
      const limit =
        typeof msg.limit === "number" && msg.limit > 0 ? Math.min(msg.limit, 1000) : 200;
      send({ id: reqId, type: "mcp_audit_log", events: readMcpAudit({ server: name, limit }) });
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
      const approvalId = String(msg.approvalId ?? "");
      // MCP 网关工具的审批挂起不在 run 内（模块级表，见 mcp-tools.ts）：先查它，
      // 命中即结算返回，不去 resolveSession（审批期间会话可能尚未落库）
      if (resolveMcpApproval(approvalId, Boolean(msg.approved))) {
        send({ id: reqId, type: "tool_confirmed", approvalId });
        break;
      }
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      );
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
      // 手动切换会话模式（agent/plan），可选携带审批级别（agent 模式的
      // ask/auto-edit/auto 对应前端"变更前确认/自动编辑/完全访问"）；重建工具集与系统提示词
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
        typeof msg.cwd === "string" ? msg.cwd : undefined,
      );
      const mode = String(msg.mode ?? "agent");
      if (mode !== "agent" && mode !== "plan") {
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
    case "get_planning_state": {
      // 模式快照拉取：前端刷新/切线程后恢复模式选择器（plan_exit 的执行确认
      // 挂起属于 toolApproval 通道，不在此快照内）
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      );
      send({ id: reqId, type: "planning_state", ...planningPayload(run) });
      break;
    }
    default:
      logErr("unknown message type:", String(msg.type));
      send({ id: reqId, type: "error", errorText: `unknown message type: ${String(msg.type)}` });
  }
}
