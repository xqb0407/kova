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

/** 个性化设置整包（sidecar 持久化于 SQLite kv，活动会话热更新） */
export type PiPersonalization = {
  style: PiPersonalizationStyle;
  /** AI 对用户的称呼（空 = 不注入） */
  userName: string;
  /** AI 的名称（空 = 不注入） */
  assistantName: string;
  /** 人设 / 人格描述（空 = 不注入） */
  persona: string;
  /** 自定义指令：每次对话都携带（空 = 不注入） */
  customInstructions: string;
};

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

/** 工作区发现但未信任、待批准的定义 */
export type PiSubagentPending = {
  name: string;
  description: string;
  tools: string[];
  path?: string;
};

/** subagents 应答：清单 + 待信任 + 加载诊断 */
export type PiSubagentsResponse = {
  type: "subagents";
  agents: PiSubagentEntry[];
  pendingWorkspace: PiSubagentPending[];
  trustedWorkspace: boolean;
  workspaceCwd: string | null;
  diagnostics: string[];
};

export type PiResponse =
  | { type: "sessions"; sessions: PiSessionSummary[] }
  | { type: "session"; sessionId: string; threadId: string }
  | { type: "history"; messages: unknown[] }
  | { type: "deleted" }
  | { type: "renamed" }
  | { type: "archived" }
  | { type: "models"; models: PiModelSummary[]; providers: PiProviderSummary[] }
  | { type: "model"; provider: string; modelId: string }
  | { type: "thinking"; level: string }
  | { type: "thinking_maps"; applied: number }
  | { type: "personalization"; settings: PiPersonalization }
  | PiSubagentsResponse
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
