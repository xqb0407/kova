"use client";

import { getPiChannel } from "@/lib/pi-channel";

/**
 * pi-agent 管理类请求-响应桥。
 * 具体传输由 PiChannel 决定（桌面 = Tauri invoke；远程网页 = WebSocket，见 pi-channel.ts），
 * 桥只负责类型定义与错误归一。
 */

export type PiSessionSummary = {
  sessionId: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  modified: string;
  cwd: string;
  archived?: boolean;
};

/** 每 token 单价（美元） */
export type PiModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** pi 可用模型（ModelRegistry.getAll + 凭据状态 + pi_models 过滤/属性） */
export type PiModelSummary = {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  reasoning: boolean;
  /** 该模型实际支持的思考档位（不含 off）；空数组 = 明确不支持推理 */
  supportedThinkingLevels?: string[];
  /** 生效中的思考参数映射（目录原值 + 前端覆盖合并；null = 无映射） */
  thinkingLevelMap?: Record<string, string | null> | null;
  contextWindow: number;
  /** 最大输出 tokens */
  maxTokens?: number;
  /** 支持的输入模态，如 ["text", "image"] */
  input?: string[];
  /** 每 token 单价 */
  cost?: PiModelCost;
  /** 目录可见性（false = 被模型过滤隐藏）；缺省视为可见 */
  enabled?: boolean;
  authed: boolean;
};

export type PiProviderSummary = {
  id: string;
  name: string;
  authed: boolean;
};

/** 已配置凭据（不含密钥本体） */
export type PiCredentialSummary = {
  providerId: string;
  type: "api_key";
};

/** 自定义 OpenAI 兼容提供商里的模型定义 */
export type PiCustomModelSpec = {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** 支持的输入模态，如 ["text", "image"] */
  input?: string[];
  /** 每 token 单价 */
  cost?: Partial<PiModelCost>;
};

/** 自定义提供商（OpenAI 兼容 baseUrl + 模型列表） */
export type PiCustomApiKind = "openai-chat" | "openai-responses" | "anthropic-messages";

export type PiCustomProviderSummary = {
  providerId: string;
  name: string;
  baseUrl: string;
  models: PiCustomModelSpec[];
  api: PiCustomApiKind;
  hasApiKey: boolean;
  /** 明文 key，仅供编辑弹窗回填（存本地 SQLite） */
  apiKey?: string;
  /** 启用状态；停用的服务不进模型目录 */
  enabled: boolean;
};

/** 会话累计用量（sidecar 从 JSONL assistant 消息行的 usage 聚合） */
export type PiUsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** 上下文面板读数（context_info 响应；sidecar 现算，零新增持久化） */
export type PiContextInfo = {
  type: "context_info";
  model: { provider: string; id: string; name: string } | null;
  /** 上下文容量（tokens） */
  contextWindow: number;
  /** 压缩阈值 = 容量 − 请求余量（与自动压缩同一公式） */
  hardLimit: number;
  messageTokens: number;
  systemPromptTokens: number;
  toolTokens: number;
  messageCount: number;
  /** 已发生的压缩代数（0 = 从未压缩） */
  generation: number;
  lastCompaction: {
    tokensBefore: number;
    summarized: boolean;
    createdAt: string;
  } | null;
  /** 当前占用是否已越过压缩阈值 */
  needsCompaction: boolean;
  usage: PiUsageTotals;
  /** 平均缓存命中率 0..1；无用量数据为 null */
  cacheHitRate: number | null;
  /** 逐请求缓存 miss 计数（旧 sidecar 无此字段时按缺省处理） */
  cacheMisses?: { requests: number; misses: number; rebuilds: number };
};

/** 手动压缩结果（compact 响应） */
export type PiCompacted = {
  type: "compacted";
  generation: number;
  tokensBefore: number;
  summarized: boolean;
  /** 本次压缩的摘要文本（分隔线下方「压缩摘要」可展开查看） */
  summary: string;
};

/** 回复风格档位（设置 → 个性化；提示词文案在 sidecar personalization.ts） */
export type PiPersonalizationStyle =
  | "default"
  | "professional"
  | "friendly"
  | "imaginative"
  | "blunt"
  | "guiding";

/** 个性化设置整包（结构化字段落 SQLite kv；persona/customInstructions 事实源在全局身份文件） */
export type PiPersonalization = {
  style: PiPersonalizationStyle;
  /** AI 对用户的称呼（空 = 不注入） */
  userName: string;
  /** AI 的名称（空 = 不注入） */
  assistantName: string;
  /** 人设 / 人格描述：事实源 ~/.xulux/soul.md，可外部编辑（空/缺失 = 不注入） */
  persona: string;
  /** 自定义指令：每次对话都携带，事实源 ~/.xulux/rules.md，可外部编辑（空/缺失 = 不注入） */
  customInstructions: string;
};

/** 身份文件绝对路径（sidecar 随 personalization 响应返回；设置页展示外部编辑入口用） */
export type PiPersonalizationPaths = { soul: string; rules: string };

/** 单日使用统计（本地时区；sidecar 扫全部会话转录聚合，日期升序） */
export type PiUsageStatsDay = {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cacheRead + cacheWrite */
  tokens: number;
  /** assistant 消息轮数 */
  messages: number;
  /** "provider/model" -> tokens */
  byModel: Record<string, number>;
};

/** 全局使用统计（usage_stats 响应） */
export type PiUsageStats = {
  /** 只含有活动的日子 */
  days: PiUsageStatsDay[];
  /** 有转录内容的会话数 */
  sessionCount: number;
  /** 首次活动日（YYYY-MM-DD），无任何活动为 null */
  firstActivity: string | null;
  /** 最长单会话跨度（毫秒，近似聊天时长） */
  longestChatMs: number;
};

/** 子智能体定义所在层（事实源在 sidecar：内置常量 / <app_data>/subagents / <cwd>/.xulux/subagents） */
export type PiSubagentScope = "builtin" | "system" | "workspace";

/** 子智能体定义条目（设置 → 子智能体；list/save/delete/开关/信任的应答共用清单形状） */
export type PiSubagentEntry = {
  name: string;
  description: string;
  tools: string[];
  maxTurns?: number;
  model?: string;
  prompt: string;
  scope: PiSubagentScope;
  /** 定义文件路径（内置无） */
  path?: string;
  /** YAML 原文（编辑器"YAML 视图"与 raw 保存回读用） */
  raw?: string;
  /** 当前是否挂载到 Task 工具组（开关 + 工作区信任共同决定） */
  enabled: boolean;
  /** 内置只读：不可编辑/删除，只能开关与复制 */
  editable: boolean;
};

/** 子智能体清单应答：设置页与所有变更命令共用（list/save/delete/开关的应答同形状） */
export type PiSubagentsResponse = {
  type: "subagents";
  agents: PiSubagentEntry[];
  workspaceCwd: string | null;
  diagnostics: string[];
};

/** 技能来源层（事实源在 sidecar：托管层 <cwd>/.xulux/skills 与 <app_data>/skills 可编辑，
 *  生态兼容层 .agents/skills（agentskills.io 标准）只读发现） */
export type PiSkillScope = "workspace" | "compat-workspace" | "system" | "compat";

/** 技能条目（设置 → 技能；list/save/delete/开关的应答共用清单形状） */
export type PiSkillEntry = {
  name: string;
  description: string;
  scope: PiSkillScope;
  /** true = 不出现在模型技能目录（agentskills 规范字段；仅手动/工具场景可用） */
  disableModelInvocation?: boolean;
  /** 开关（未记录 = 启用） */
  enabled: boolean;
  /** 被更高优先级同名技能遮蔽：enabled 但不生效 */
  shadowed: boolean;
  /** 生态层只读：不可编辑/删除，只能开关 */
  editable: boolean;
  /** 技能文件绝对路径（模型按需 read 的 location） */
  path: string;
  /** 正文（frontmatter 之后；编辑器回填用） */
  content: string;
  sizeBytes: number;
  updatedAt?: string;
};

/** 技能清单应答：设置页与所有变更命令共用（list/save/delete/开关的应答同形状） */
export type PiSkillsResponse = {
  type: "skills";
  skills: PiSkillEntry[];
  workspaceCwd: string | null;
  diagnostics: string[];
};

/** 记忆设置整包（设置 → 记忆；sidecar 持久化于 SQLite kv，活动会话热更新） */
export type PiMemoryConfig = {
  /** 总开关：关闭时不注入、memory_* 工具一律婉拒 */
  enabled: boolean;
  /** 全局记忆叠加开关（~/.xulux/memory，跨会话跨工作区） */
  global: boolean;
  /** 工作区记忆叠加开关（<cwd>/.xulux/memory，未信任工作区不生效） */
  workspace: boolean;
  /** 文件检索（memory_search 工具）开关 */
  fileSearch: boolean;
  /** 指定记忆开启：每作用域文件白名单；null = 全部启用（自动跟随新建文件） */
  enabledFiles: { global: string[] | null; workspace: string[] | null };
};

/** 记忆目录文件条目（设置 → 记忆的文件清单；daily 汇总行 bytes/mtime 为 0） */
export type PiMemoryFileEntry = { name: string; bytes: number; mtime: number };

/** 单作用域记忆目录状态（list_memory_files 应答） */
export type PiMemoryScopeState = {
  dir: string;
  files: PiMemoryFileEntry[];
};

/** 记忆两作用域清单（list_memory_files 应答；工作区未选时 workspace 为 null） */
export type PiMemoryFilesResponse = {
  type: "memory_files";
  scopes: {
    global: PiMemoryScopeState;
    workspace: PiMemoryScopeState | null;
  };
};

/** 协议自报图标（MCP 2025-11-25 serverInfo.icons；sidecar 已过滤为 http(s)/data src） */
export type PiMcpServerIcon = {
  src: string;
  /** 深浅色适配声明；缺省 = 通用 */
  theme?: "light" | "dark";
};

/** MCP 服务器连接状态（sidecar mcp-manager 实时状态；disabled 行恒为 idle） */
export type PiMcpServerStatus = {
  name: string;
  state: "idle" | "connecting" | "ready" | "backoff";
  toolCount: number;
  toolNames?: string[];
  /** 最近一次错误/截断说明（backoff/工具截断） */
  message?: string;
  /** 握手因 401/缺凭据失败：需要用户在设置页点「授权」走 OAuth 浏览器流程 */
  needsAuth?: boolean;
  /** 该 http 服务器的 URL 已存有 OAuth token（设置页据此呈现「取消授权」） */
  oauthAuthorized?: boolean;
  /** 服务器握手时自报的图标（从未握手成功则无，前端用默认图标） */
  icons?: PiMcpServerIcon[];
};

/** MCP 服务器条目（设置 → MCP；list/save/delete/开关的应答共用清单形状）。
 *  env/headers 明文返回仅供编辑弹窗回填（存本地配置文件，同 custom providers 的 key 策略） */
export type PiMcpServerEntry = {
  name: string;
  layer: "system" | "workspace";
  /** 定义所在文件绝对路径 */
  source: string;
  /** 来自工作区共享文件 .mcp.json（设置页不直接改写它，删除降级为提示） */
  fromStandard?: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  lifecycle?: "lazy" | "eager" | "keep-alive";
  idleTimeout?: number;
  /** 工具调用超时（毫秒），未配置用 sidecar 默认 120000 */
  callTimeout?: number;
  /** 工具名 glob 免审批 */
  approveTools?: string[];
  enabled: boolean;
  status: PiMcpServerStatus;
};

/** MCP 服务器清单应答：设置页与所有变更命令共用（list/save/delete/开关的应答同形状） */
export type PiMcpServersResponse = {
  type: "mcp_servers";
  servers: PiMcpServerEntry[];
  workspaceCwd: string | null;
  diagnostics: string[];
};

/** test_mcp_server 应答（强制重新握手后的状态） */
export type PiMcpServerTestResponse = {
  type: "mcp_server_test";
  status: PiMcpServerStatus;
};

/** MCP 连接错误日志一行（sidecar 环形缓冲，时间升序） */
export type PiMcpLogLine = { at: number; message: string };

/** get_mcp_server_log 应答 */
export type PiMcpServerLogResponse = {
  type: "mcp_server_log";
  name: string;
  lines: PiMcpLogLine[];
};

/** 单台 MCP 服务器的工具条目（参数 schema 不上行，设置页展开只展示名字+描述） */
export type PiMcpToolInfo = { name: string; description?: string };

/** get_mcp_server_tools 应答（sidecar 元数据缓存优先，缺失才握手） */
export type PiMcpServerToolsResponse = {
  type: "mcp_server_tools";
  name: string;
  tools: PiMcpToolInfo[];
};

/** MCP 观测审计事件种类（与 sidecar mcp-audit.ts 对齐） */
export type PiMcpAuditKind =
  | "connect"
  | "connect_fail"
  | "disconnect"
  | "call"
  | "truncate"
  | "auth"
  | "probe_fail";

/** 单条审计事件：只有元数据（服务器名/耗时/摘要），不含参数与结果 */
export type PiMcpAuditEvent = {
  at: number;
  server: string;
  kind: PiMcpAuditKind;
  ok?: boolean;
  ms?: number;
  detail?: string;
};

/** get_mcp_audit_log 应答（时间升序，跨重启持久） */
export type PiMcpAuditLogResponse = {
  type: "mcp_audit_log";
  events: PiMcpAuditEvent[];
};

export type PiResponse =
  | { type: "sessions"; sessions: PiSessionSummary[] }
  | { type: "session"; sessionId: string; threadId: string }
  | { type: "forked"; sessionId: string }
  | { type: "history"; messages: unknown[] }
  | { type: "deleted" }
  | { type: "renamed" }
  | { type: "archived" }
  | { type: "models"; models: PiModelSummary[]; providers: PiProviderSummary[] }
  | { type: "model"; provider: string; modelId: string }
  | { type: "thinking"; level: string }
  | { type: "thinking_maps"; applied: number }
  | {
      type: "personalization";
      settings: PiPersonalization;
      paths?: PiPersonalizationPaths;
    }
  | { type: "memory"; settings: PiMemoryConfig }
  | PiMemoryFilesResponse
  | { type: "memory_file"; file: string; content: string }
  | {
      type: "memory_file_saved";
      scope: "global" | "workspace";
      file: string;
      bytes: number;
    }
  | PiSubagentsResponse
  | PiSkillsResponse
  | PiMcpServersResponse
  | PiMcpServerTestResponse
  | PiMcpServerLogResponse
  | PiMcpServerToolsResponse
  | PiMcpAuditLogResponse
  | { type: "usage_stats"; stats: PiUsageStats }
  | { type: "todo_state"; tasks: unknown[]; nextId: number }
  | { type: "model_updated"; provider: string; modelId: string }
  | { type: "credential"; provider: string }
  | { type: "credentials"; credentials: PiCredentialSummary[] }
  | { type: "credential_deleted"; provider: string }
  | { type: "custom_provider"; provider: string }
  | { type: "custom_providers"; providers: PiCustomProviderSummary[] }
  | { type: "custom_provider_deleted"; provider: string }
  | { type: "custom_provider_toggled"; provider: string; enabled: boolean }
  | { type: "fetched_models"; models: string[] }
  | { type: "tested"; ok: true }
  | { type: "provider_filter"; provider: string; models: string[] | null }
  | {
      type: "mode_changed" | "planning_state";
      mode: "agent" | "plan";
      approvalLevel?: "ask" | "auto-edit" | "auto";
      planning: "inactive" | "planning";
    }
  | PiContextInfo
  | PiCompacted
  | { type: "error"; errorText: string }
  | { type: "tool_confirmed"; approvalId: string }
  | { type: "question_answered"; questionId: string };

export async function piRequest<T extends PiResponse>(
  payload: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<T> {
  const response = await getPiChannel().request(payload, timeoutMs);

  if (response.type === "error") {
    throw new Error(response.errorText);
  }
  return response as T;
}
