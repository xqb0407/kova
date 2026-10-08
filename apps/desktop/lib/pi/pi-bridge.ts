"use client";

import { getPiChannel } from "@/lib/pi/pi-channel";
import type {
  Compacted,
  ContextInfo,
  ErrorPayload,
  GoalState,
  SessionSummary,
  UsageTotals,
} from "pi-protocol";

/**
 * pi-agent 管理类请求-响应桥。
 * 具体传输由 PiChannel 决定（桌面 = Tauri invoke；远程网页 = WebSocket，见 pi-channel.ts），
 * 桥只负责类型定义与错误归一。跨端载荷单源 pi-protocol（设计文档 §1），
 * 本地保留 Pi* 惯用名。
 */

/** 会话列表摘要行（list_sessions 响应；SQLite 索引投影 + 会话级偏好镜像） */
export type PiSessionSummary = SessionSummary;

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
  /** 仍由 sidecar 缺省猜测值占位的属性（如 ["contextWindow","maxTokens"]；空 = 目录真值或用户已填） */
  defaultedAttrs?: string[];
  /** 支持的输入模态，如 ["text", "image"] */
  input?: string[];
  /** 每 token 单价 */
  cost?: PiModelCost;
  /** 目录可见性（false = 被模型过滤隐藏）；缺省视为可见 */
  enabled?: boolean;
  authed: boolean;
  /** 用户标记"可生成图片"（设置 → 模型属性勾选，存 imagegen 配置覆盖层）；
   *  文生图默认模型下拉按它过滤 */
  t2i?: boolean;
};

export type PiProviderSummary = {
  id: string;
  name: string;
  authed: boolean;
};

/**
 * 按 modelId 反查内置目录得到的属性种子（lookup_thinking_seed 应答）。
 * 自定义端点/目录外新增模型的属性弹窗预填用；未命中目录时为 null。
 * 思考参数之外还带 contextWindow/maxTokens/input/cost 目录真值，
 * 与 sidecar 注册（registerCustomProvider）的兜底口径一致。
 */
export type PiThinkingSeed = {
  reasoning: boolean;
  /** 目录整理的下发映射（含 off 显式关闭值，如 "none"） */
  thinkingLevelMap?: Record<string, string | null>;
  /** 可用的思考档位（不含 off） */
  supportedThinkingLevels: string[];
  /** 同名目录模型的上下文容量 */
  contextWindow: number;
  /** 同名目录模型的最大输出 tokens */
  maxTokens: number;
  /** 同名目录模型的输入模态 */
  input: string[];
  /** 同名目录模型的单价 */
  cost: PiModelCost;
};

/** 已配置凭据（不含密钥本体；env = 非密钥补充字段，如 Cloudflare 网关的 Account/Gateway ID） */
export type PiCredentialSummary = {
  providerId: string;
  type: "api_key";
  env?: Record<string, string>;
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
  /** 展示掩码（****+后4位）；明文 key 不再回传渲染进程，编辑弹窗留空 = 保持原 key */
  apiKeyMasked?: string;
  /** 启用状态；停用的服务不进模型目录 */
  enabled: boolean;
};

/** 外部工具导入来源（镜像 sidecar src/model/import/types.ts 的 ImportSource） */
export type PiImportSource = "opencode" | "codex" | "zcode" | "ccswitch";

/**
 * 归一化后的可导入服务（镜像 sidecar ImportedProvider）。解析在 sidecar 做，
 * 前端只认这个形状。
 *
 * apiKey 是**明文**：写进钥匙串必需，因此这一项是"明文不回传渲染进程"的
 * 有意例外——只在导入弹窗内使用、掩码展示，不落任何持久化存储。
 */
export type PiImportedProvider = {
  source: PiImportSource;
  /** 来源内的稳定标识（opencode 的 slug / Codex 的 model_providers 键 / ZCode 的 providerId） */
  sourceKey: string;
  sourceLabel: string;
  name: string;
  baseUrl: string;
  api: PiCustomApiKind;
  apiKey?: string;
  /** 该来源记录在案的模型；空数组合法（导入后在编辑弹窗点「获取列表」现拉）。
   *  contextWindow 只有来源真记了才有（cc-switch 的 modelCatalog 会给） */
  models: { id: string; name?: string; contextWindow?: number }[];
  /** 来源侧已停用（如 opencode 的 disabled_providers），导入后默认停用 */
  disabled: boolean;
};

/** 单个来源的扫描结果：文件不存在是常态，此时 foundPath 为 null 且 error 为 null */
export type PiImportSourceStatus = {
  source: PiImportSource;
  paths: string[];
  foundPath: string | null;
  count: number;
  error: string | null;
};

/** 会话累计用量（sidecar 从 JSONL assistant 消息行的 usage 聚合） */
export type PiUsageTotals = UsageTotals;

/** 上下文面板读数（context_info 响应；sidecar 现算，零新增持久化） */
export type PiContextInfo = ContextInfo;

/** 手动压缩结果（compact 响应） */
export type PiCompacted = Compacted;

/** 内置回复风格档位（设置 → 个性化；提示词文案在 sidecar personalization.ts） */
export type PiPersonalizationBuiltinStyle =
  | "default"
  | "professional"
  | "friendly"
  | "imaginative"
  | "blunt"
  | "guiding";

/** 回复风格 id：内置档位，或 `custom:<id>` 引用 styles 中的自定义风格 */
export type PiPersonalizationStyle =
  | PiPersonalizationBuiltinStyle
  | `custom:${string}`;

/** 用户自定义回复风格：name 用于设置页展示，prompt 原样注入系统提示词 */
export type PiPersonalizationCustomStyle = {
  id: string;
  name: string;
  prompt: string;
};

/** 内置档位的覆盖记录（改名/改写/隐藏皆写记录，删除记录即恢复默认）。
 *  稀疏存储：name 空用默认标签、prompt 空用内置文案，hidden 单独控制网格是否展示 */
export type PiPersonalizationStyleOverride = {
  id: PiPersonalizationBuiltinStyle;
  name: string;
  prompt: string;
  hidden: boolean;
};

/** 个性化设置整包（结构化字段含自定义风格列表落 SQLite kv；persona/customInstructions 事实源在全局身份文件） */
export type PiPersonalization = {
  style: PiPersonalizationStyle;
  /** 自定义风格列表（style 可指向其中 `custom:<id>`；旧版 sidecar 响应可能缺省） */
  styles?: PiPersonalizationCustomStyle[];
  /** 内置档位覆盖记录（无记录 = 原样内置；旧版 sidecar 响应可能缺省） */
  styleOverrides?: PiPersonalizationStyleOverride[];
  /** AI 对用户的称呼（空 = 不注入） */
  userName: string;
  /** AI 的名称（空 = 不注入） */
  assistantName: string;
  /** 人设 / 人格描述：事实源 ~/.kova/soul.md，可外部编辑（空/缺失 = 不注入） */
  persona: string;
  /** 自定义指令：每次对话都携带，事实源 ~/.kova/rules.md，可外部编辑（空/缺失 = 不注入） */
  customInstructions: string;
};

/** 身份文件绝对路径（sidecar 随 personalization 响应返回；设置页展示外部编辑入口用） */
export type PiPersonalizationPaths = { soul: string; rules: string };

/** 全局工作模式（设置 → 通用）：work = 非工程协作（提示词附加段 + git UI 隐藏 +
 *  工具行轻量摘要）；design = UI 设计（设计稿/高保真原型导向 + git UI 隐藏，工具行
 *  保持展开，切档需 ui-design 插件已启用）；code = 默认，行为与旧版一致 */
export type PiAppMode = "work" | "code" | "design";

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

/* ------------------------ Agent 调用轨迹（trace_query） ------------------------ */

export type PiTraceSpanKind = "turn" | "llm_call" | "tool_call" | "retry";
export type PiTraceStatus = "ok" | "error" | "aborted";

/** 轨迹 span（sidecar trace.ts 的 TraceSpan 镜像；树形，仅 turn 持有 children） */
export type PiTraceSpan = {
  /** v2 身份：面板/导出直接用；旧记录缺失时回退到顺序派生 */
  spanId?: string;
  /** 父 span 的 spanId（同轮子 span 指向所属 turn；turn 省略 = 挂在 run 根下） */
  parentSpanId?: string;
  kind: PiTraceSpanKind;
  name?: string;
  startMs: number;
  endMs: number;
  status: PiTraceStatus;
  attrs?: Record<string, string | number | boolean>;
  children?: PiTraceSpan[];
  /** 内容详情（llm_call）：请求上下文与回复正文的截断渲染 */
  detail?: { request?: string; response?: string };
};

/** 一次 prompt run 的完整轨迹（traces/<sessionId>.jsonl 的一行） */
export type PiTraceRun = {
  /** v2 根身份（面板/OTLP 的 traceId）；旧记录缺失时回退 runId */
  traceId?: string;
  runId: string;
  /** 父 run 的 traceId（subagent 委派回填父 run，跨 run 因果边） */
  parentRunId?: string;
  /** 触发本 run 的父 span：父 run 里那次 Task tool_call 的 spanId */
  parentSpanId?: string;
  sessionId: string;
  source: "ui" | "automation" | "subagent";
  startMs: number;
  endMs: number;
  status: PiTraceStatus;
  model?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  spans: PiTraceSpan[];
};

/** 子智能体定义所在层（事实源在 sidecar：内置常量 / <app_data>/subagents / <cwd>/.kova/subagents） */
export type PiSubagentScope = "builtin" | "system" | "workspace" | "plugin";

/** 子智能体记忆档位：none = 无记忆（缺省）；private = 私有命名空间；shared = 与主代理共享工作区记忆 */
export type PiSubagentMemoryMode = "none" | "private" | "shared";

/** 声明式知识源：就是一份文档（glob 指向）。外部系统走 mcpServers 授予，不经这里 */
export type PiKnowledgeSource = {
  name: string;
  /** 工作区相对 glob */
  path: string;
};

/** 子智能体定义条目（设置 → 子智能体；list/save/delete/开关/信任的应答共用清单形状） */
export type PiSubagentEntry = {
  name: string;
  description: string;
  tools: string[];
  maxTurns?: number;
  model?: string;
  prompt: string;
  scope: PiSubagentScope;
  /** 技能白名单（按名）；未声明即不可见 */
  skills?: string[];
  /** MCP 服务器白名单；未声明即不可达 */
  mcpServers?: string[];
  /** 声明式知识源 */
  knowledge?: PiKnowledgeSource[];
  /** 记忆档位；缺省/none = 无记忆 */
  memory?: PiSubagentMemoryMode;
  /** 定义文件路径（内置无） */
  path?: string;
  /** YAML 原文（编辑器"YAML 视图"与 raw 保存回读用） */
  raw?: string;
  /** 当前是否挂载到 Task 工具组（开关 + 工作区信任共同决定） */
  enabled: boolean;
  /** 内置只读：不可编辑/删除，只能开关与复制 */
  editable: boolean;
  /** scope = "plugin" 时来源插件身份 */
  pluginId?: string;
};

/** 子智能体清单应答：设置页与所有变更命令共用（list/save/delete/开关的应答同形状）。
 * pluginAgents = scope "plugin" 条目（子智能体设置页不渲染，`@` 提及与插件详情消费） */
export type PiSubagentsResponse = {
  type: "subagents";
  agents: PiSubagentEntry[];
  pluginAgents: PiSubagentEntry[];
  workspaceCwd: string | null;
  diagnostics: string[];
  /** 可授予工具目录（后端唯一事实源）；旧版 sidecar 缺此字段时前端回落旧 6 项 */
  grantableTools?: string[];
};

/** 技能来源层（事实源在 sidecar：托管层 <cwd>/.kova/skills 与 <app_data>/skills 可编辑，
 *  生态兼容层 .agents/skills（agentskills.io 标准）只读发现，插件层经 pluginSkills 单列） */
export type PiSkillScope = "workspace" | "compat-workspace" | "system" | "compat" | "plugin";

/** 技能条目（设置 → 技能；list/save/delete/开关的应答共用清单形状） */
export type PiSkillEntry = {
  name: string;
  description: string;
  scope: PiSkillScope;
  /** scope = "plugin" 时来源插件身份（开关走 plugin 命名空间 stateKey） */
  pluginId?: string;
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

/** 技能清单应答：设置页与所有变更命令共用（list/save/delete/开关的应答同形状）。
 * pluginSkills = scope "plugin" 的条目（技能设置页不渲染，`/` 菜单与插件详情消费） */
export type PiSkillsResponse = {
  type: "skills";
  skills: PiSkillEntry[];
  pluginSkills: PiSkillEntry[];
  workspaceCwd: string | null;
  diagnostics: string[];
};

// ---------------------------------------------------------------------------
// 设计主题（设置 → 智能体 → 设计主题；composer 主题胶囊）。事实源在 sidecar
// design-md/：内置层 = 主题包 zip（只读，首启解压/版本化升级），用户层 =
// <root>/user/<slug>.md（可编辑，同名遮蔽内置）。会话级选中落 sessions.design_theme。
// ---------------------------------------------------------------------------

/** 主题层：builtin = 内置主题包（不可删，可 fork）；user = 我的主题 */
export type PiThemeScope = "builtin" | "user";

/** 主题引用（选中态；JSON 落会话列与 kv） */
export type PiThemeRef = { scope: PiThemeScope; id: string };

/** 主题清单条目（list/save/delete 应答共用；与 sidecar DesignThemeEntry 同形） */
export type PiDesignThemeEntry = {
  scope: PiThemeScope;
  id: string;
  name: string;
  desc: string;
  /** 代表色（胶囊/卡片色板点，最多 4） */
  accents: string[];
  /** 内置条目：存在同名用户主题遮蔽 */
  shadowed?: boolean;
  /** 用户条目：正文字节数 */
  sizeBytes?: number;
};

/** 主题清单应答（list_design_themes / save / delete 共用形状；active 仅带 threadId 时回） */
export type PiDesignThemesResponse = {
  type: "design_themes";
  entries: PiDesignThemeEntry[];
  /** 主题包 catalog.version */
  version: string;
  builtinCount: number;
  userCount: number;
  /** 主题包装载错误（坏 zip），不致命 */
  error: string | null;
  active?: PiThemeRef | null;
};

/** 取全文应答（编辑回填 / 预览 / fork）：user 含 frontmatter 原文，builtin 为包内 DESIGN.md 原文 */
export type PiDesignThemeDocResponse = {
  type: "design_theme_doc";
  ref: PiThemeRef;
  entry: PiDesignThemeEntry;
  doc: string;
};

/** 保存应答：ref = 保存后的主题引用（改名编辑时 id 会变），其余同清单形状 */
export type PiDesignThemeSavedResponse = {
  type: "design_theme_saved";
  ref: PiThemeRef;
  entries: PiDesignThemeEntry[];
  version: string;
  builtinCount: number;
  userCount: number;
  error: string | null;
};

/** 会话选中应答 */
export type PiDesignThemeSetResponse = {
  type: "design_theme_set";
  sessionId: string;
  theme: PiThemeRef | null;
};

// ---------------------------------------------------------------------------
// 插件系统（插件市场；事实源在 sidecar plugins.ts，scope/layer="plugin" 的
// 组件条目不进 skills/MCP/子智能体设置页清单，只在插件详情页展示与开关）
// ---------------------------------------------------------------------------

/** 插件组件摘要条目（list_plugins 应答内嵌） */
export type PiPluginComponentEntry = {
  name: string;
  description: string;
  enabled: boolean;
  /** MCP 服务器专用 */
  transport?: "stdio" | "http";
  path?: string;
};

/** 一条 UI 面板贡献（panels.json 规范化产物；插件详情页与右侧面板 + 菜单消费） */
export type PiPluginPanelEntry = {
  id: string;
  title: string;
  /** 已解析的可显示 src（远程 URL 原样 / 本地文件 data URL；无图标缺省） */
  icon?: string;
  /** 文档打开路由 glob（workspace 相对路径匹配，如 "*.canvas.json"） */
  opens: string[];
  /** 桥权限白名单子集：document/export/agent/notify */
  permissions: string[];
};

/** 一条已装插件（cache 物化 + 清单规范化产物） */
export type PiPluginEntry = {
  pluginId: string;
  name: string;
  marketplaceId: string;
  marketplaceName: string;
  version: string;
  revision?: string;
  installedAt: string;
  description?: string;
  icon?: string;
  category?: string;
  /** 清单探测来源：kova 原生或生态规范化 */
  manifestKind: "kova" | "claude" | "codex";
  /** 来源市场已移除（插件保留可用，仅无更新通道） */
  sourceMissing: boolean;
  /** 链接安装（dev 模式）：cache 条目 symlink 直指源目录，读路径实时命中源码 */
  linked?: boolean;
  /** linked 项的源目录绝对路径 */
  sourcePath?: string;
  enabled: boolean;
  components: {
    skills: PiPluginComponentEntry[];
    mcpServers: PiPluginComponentEntry[];
    subagents: PiPluginComponentEntry[];
    panels: PiPluginPanelEntry[];
  };
  diagnostics: string[];
};

/** list_plugins / set_plugin_enabled / uninstall_plugin 应答 */
export type PiPluginsResponse = {
  type: "plugins";
  plugins: PiPluginEntry[];
  workspaceCwd: string | null;
};

/** get_plugin_panel_asset 应答：面板 entry 单文件 HTML（base64）+ 版本指纹 */
export type PiPluginPanelAssetResponse = {
  type: "plugin_panel_asset";
  pluginId: string;
  panelId: string;
  contentType: string;
  base64: string;
  /** entry 文件 mtime+size 指纹：变更即换 URL 重载 iframe */
  rev: string;
};

/** 组件类别：技能 / MCP 服务器 / 子智能体（面板不走这条，见 plugin_panel_asset） */
export type PiPluginComponentKind = "skill" | "mcp" | "subagent";

/** get_plugin_component_doc 应答：单个组件的原文（详情页"查看内容"用）。
 *  正文按需现取而非随 list_plugins 下发：技能/子智能体正文动辄几十 KB，
 *  一个插件十几条组件，全量带在清单里每次刷新都要搬运一遍。 */
export type PiPluginComponentDocResponse = {
  type: "plugin_component_doc";
  kind: PiPluginComponentKind;
  name: string;
  /** 来源文件绝对路径（技能/子智能体为定义文件，MCP 为 mcpServers 文件） */
  path: string;
  /** 技能 SKILL.md 全文 / 子智能体 YAML / MCP 条目 JSON */
  content: string;
  /** 超上限被截断 */
  truncated: boolean;
};

/** get_plugin_panel_rev 应答：入口文件轻量指纹（只 stat），宿主 dev 自动重载轮询用 */
export type PiPluginPanelRevResponse = {
  type: "plugin_panel_rev";
  pluginId: string;
  panelId: string;
  /** null = 面板当前不可用（未装/禁用/入口缺失），宿主停止本轮比对 */
  rev: string | null;
  /** 仅链接安装（dev 模式）面板允许宿主自动重载 iframe */
  linked: boolean;
};

/** 市场目录条目（marketplace.json plugins[] 规范化） */
export type PiMarketplaceCatalogEntry = {
  name: string;
  version?: string;
  description?: string;
  icon?: string;
  category?: string;
  keywords?: string[];
  /** 相对市场根的插件目录 */
  path: string;
};

/**
 * 一条已添加市场（list_marketplaces 应答）。除登记表市场外还可能出现两个
 * 伪市场条目：`id: "local"`（本地安装，随装随生成）与 `id: "builtin"`
 * （内置插件，随 app 分发、不可卸载/刷新/链接装）——两者都呈 "directory"
 * 形状，UI 按 id 门禁。
 */
export type PiMarketplaceEntry = {
  id: string;
  name: string;
  type: "directory" | "git";
  path?: string;
  repo?: string;
  addedAt: string;
  lastRefresh?: string;
  revision?: string;
  /** 从未成功刷新过：目录为空，需先 refresh */
  needsRefresh: boolean;
  plugins: PiMarketplaceCatalogEntry[];
};

/** list_marketplaces / remove_marketplace 应答 */
export type PiMarketplacesResponse = {
  type: "marketplaces";
  marketplaces: PiMarketplaceEntry[];
};

/** 耗时操作受理应答（add/refresh/install）：结果经 plugin_op_result 自发帧送达 */
export type PiPluginOpAccepted = {
  type: "plugin_op_accepted";
  opId: string;
  op: "add_marketplace" | "refresh_marketplace" | "install_plugin" | "install_plugin_local";
};

/** 耗时操作结果帧（无 id 自发；成功时携带刷新后的 plugins+marketplaces 双清单） */
export type PiPluginOpResultFrame = {
  type: "plugin_op_result";
  opId: string;
  op: "add_marketplace" | "refresh_marketplace" | "install_plugin" | "install_plugin_local";
  ok: boolean;
  errorText?: string;
  /** 安装类操作成功时附带目标插件名（成功提示用；旧端无此字段） */
  name?: string;
  plugins?: PiPluginEntry[];
  marketplaces?: PiMarketplaceEntry[];
  workspaceCwd?: string | null;
};

/** 记忆设置整包（设置 → 记忆；sidecar 持久化于 SQLite kv，活动会话热更新） */
export type PiMemoryConfig = {
  /** 总开关：关闭时不注入、memory_* 工具一律婉拒 */
  enabled: boolean;
  /** 全局记忆叠加开关（~/.kova/memory，跨会话跨工作区） */
  global: boolean;
  /** 工作区记忆叠加开关（<cwd>/.kova/memory，未信任工作区不生效） */
  workspace: boolean;
  /** 文件检索（memory_search 工具）开关 */
  fileSearch: boolean;
  /** 指定记忆开启：每作用域文件白名单；null = 全部启用（自动跟随新建文件） */
  enabledFiles: { global: string[] | null; workspace: string[] | null };
};

/** 浏览器驱动开关整包（设置 → 通用 → 智能体工具；sidecar 持久化于 SQLite kv） */
export type PiBrowserConfig = {
  /** 浏览器驱动总开关：关闭时 browser_* 工具一律婉拒（面板浏览器仍可用） */
  enabled: boolean;
  /** 像素截图：browser_shot 用一次性无头 Chrome 拍页面画面。默认关 */
  pixelShot: boolean;
  /** 屏幕截图：screenshot 读用户真实屏幕。默认关——唯一越界的能力 */
  screenShot: boolean;
};

/** 访问加速配置整包（设置 → 系统 → 访问加速；sidecar 持久化于 SQLite kv）。
 *  改写规则与边界见 sidecar tools/url-mirror.ts：只改写 GitHub 的
 *  raw/发行包/源码包地址，带凭据的链接与 git push 一律不动。 */
export type PiMirrorConfig = {
  /** 总开关 */
  enabled: boolean;
  /** GitHub 加速前缀（ghproxy 系，如 https://ghfast.top）；空串 = 不改写 GitHub */
  githubPrefix: string;
  /** bash 里 git clone/fetch 走镜像（insteadOf 环境变量）；push 始终不受影响 */
  gitInsteadOf: boolean;
  /** 自定义 from→to 规则，优先于内建 GitHub 规则 */
  customRules: { from: string; to: string }[];
};

/** 文生图配置整包（设置 → 模型 → 文生图；sidecar 持久化于 SQLite kv）。
 *  provider/modelId 指向已配置的模型目录（OpenAI 兼容端点），密钥走「模型」页的
 *  provider 凭据，这里不存；关闭/未配置时 generate_image 工具婉拒。 */
export type PiImageGenConfig = {
  /** 总开关：关闭时 generate_image 一律婉拒（默认关：生图按张计费） */
  enabled: boolean;
  /** 生图模型所属 provider id（"" = 未配置） */
  provider: string;
  /** 生图模型 id */
  modelId: string;
  /** 默认尺寸（透传 images 协议 size："1024x1024" 等，"auto" 由服务端定） */
  size: string;
  /** 标记"可生图"的模型清单（"provider/modelId"）：在模型属性弹窗勾选；
   *  list_models 按它给每行透出 t2i，文生图默认模型下拉只列 t2i 模型 */
  imageModels: string[];
};

/** 密钥清单行（设置 → 智能体 → 密钥）：**没有明文**。
 *  值的加密与掩码都在 Rust 侧完成（enc:v1: 密文 + OS keychain 主密钥），
 *  明文不存在于任何应答帧里。见 docs/secrets-env-design.md §1.1 */
export type PiSecretEntry = {
  name: string;
  /** "global" | "workspace:<cwd>" */
  scope: string;
  /** `****` + 后四位 */
  masked: string;
  /** false = 密文解不开（换机 / 主密钥丢失），需重填 */
  readable: boolean;
  updatedAt: string;
};

/** 一条绑定：把密钥授给哪些技能（["*"] = 任意 bash 调用；空数组 = 不注入） */
export type PiSecretBinding = {
  name: string;
  scope: "global" | "workspace";
  skills: string[];
};

/** 密钥页整包（清单 + 绑定策略 + 总开关） */
export type PiSecretsResponse = {
  type: "secrets";
  entries: PiSecretEntry[];
  enabled: boolean;
  bindings: PiSecretBinding[];
};

/** 可观测性导出配置整包（设置 → 系统 → 追踪；sidecar 持久化于 SQLite kv） */
export type PiObservabilityConfig = {
  /** 总开关：关闭时 run 记录只落本地 traces 文件，不外发 */
  enabled: boolean;
  /** OTLP/HTTP traces 端点（Langfuse: https://<host>/api/public/otel/v1/traces） */
  endpoint: string;
  /** 附加请求头（鉴权等；Langfuse: Authorization: Basic base64(公钥:私钥)） */
  headers: Record<string, string>;
  /** 采样率 0~1，按 run 粒度 */
  sampleRate: number;
  /** 内容脱敏：true = 只上传元数据，不上传 prompt 与工具正文 */
  redactContent: boolean;
};

/** test_observability 探针应答：sidecar 向 endpoint 发一条探针 span 的结果 */
export type PiObservabilityTestResult = {
  ok: boolean;
  status?: number;
  errorText?: string;
};

/** Claude Code 式生命周期钩子事件名（与 sidecar hooks.ts 1:1 对齐） */
export type PiHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop";

/** 单条生命周期钩子配置（事实源在 sidecar kv，经 set_hooks/get_hooks 推拉） */
export type PiHookConfig = {
  id: string;
  name: string;
  command: string;
  /** shell 命令类型的解释器，空 = 系统默认（$SHELL）；仅 type="shell" 生效 */
  shell?: string;
  args?: string[];
  /** "shell"（整串交 shell 解释，默认）| "process"（argv 直接执行） */
  type?: "process" | "shell";
  event: PiHookEventName;
  /** 工具名过滤：逗号分隔精确名（"Write, Edit, Bash"）或单个正则；空 = 全部 */
  matcher?: string;
  /** 单命令超时 ms，sidecar 钳制 [1s, 120s]，默认 10s */
  timeoutMs?: number;
  /** 后台运行：不等待命令结束（决策类事件视为无决策） */
  background?: boolean;
  enabled: boolean;
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

/** 版本来源：设置页保存 / AI 工具写入 / 外部编辑器改动补录 / 从历史恢复 / 删除前留档 */
export type PiMemoryVersionSource = "page" | "agent" | "external" | "restore" | "delete";

/** 记忆文件的一个历史版本（list_memory_versions 应答项；id 即版本文件名） */
export type PiMemoryVersionEntry = {
  id: string;
  /** 记录时间（毫秒） */
  ts: number;
  source: PiMemoryVersionSource;
  bytes: number;
};

/** 回收站条目（list_memory_trash 应答项；id 即回收站文件名） */
export type PiMemoryTrashEntry = {
  id: string;
  /** 原文件名 */
  name: string;
  /** 移入回收站时间（毫秒） */
  ts: number;
  bytes: number;
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
  /** plugin 层条目单列在 pluginServers（设置页不渲染，`/` 菜单与插件详情消费） */
  layer: "system" | "workspace" | "plugin";
  /** 定义所在文件绝对路径 */
  source: string;
  /** 来自工作区共享文件 .mcp.json（设置页不直接改写它，删除降级为提示） */
  fromStandard?: boolean;
  /** layer = "plugin" 时来源插件身份 */
  pluginId?: string;
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
  /** layer "plugin" 条目（MCP 设置页不渲染，`/` 菜单与插件详情消费） */
  pluginServers: PiMcpServerEntry[];
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

/** 自动化定时任务条目（sidecar 事实源 <sessionsDir>/automation/tasks.json，
 *  字段镜像 vendored ScheduledTask；list/save/delete/开关/run_now 应答共用清单形状） */
export type PiAutomationTask = {
  id: string;
  /** 创建来源会话（对话里让 agent 建的任务用于跳回上下文；表单建的是 "automation-manual"） */
  sessionId: string;
  name?: string;
  description?: string;
  /** 触发时投给 agent 的提示词（无人值守运行） */
  prompt: string;
  type: "cron" | "once" | "interval";
  /** cron 表达式 / once 的 ISO 时刻 / interval 的 "30s"|"5m" 原样文本 */
  schedule: string;
  intervalSeconds: number;
  enabled: boolean;
  /** provider/model 留空 = 运行时跟随默认模型 */
  model: { provider: string; model: string };
  /** 无人值守工具档位：read-only | workspace-write | full（事实源校验在 sidecar） */
  toolPolicyProfile: string;
  /** 任务工作目录（空 = 主目录兜底） */
  workspaceDir?: string;
  /** 单次运行超时 ms（空 = 默认 10 分钟） */
  timeoutMs?: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  runCount: number;
  lastStatus?: string;
  lastError?: string;
  runHistory?: {
    id: string;
    status: string;
    createdAt: string;
    sessionId?: string;
    message?: string;
  }[];
};

/** 任务清单应答（变更命令成功后同形状回全量，前端不做 diff） */
export type PiAutomationListResponse = {
  type: "automation_list";
  tasks: PiAutomationTask[];
};

/** 排期预览应答：runs = 未来触发点 ISO（cron/interval 多个，once 一个）；非法排期回 error */
export type PiAutomationPreviewResponse = {
  type: "automation_preview";
  runs?: string[];
  error?: string;
};

/** 预置模板条目（sidecar automation/templates.ts 的只读镜像，用于「从模板新建」） */
export type PiAutomationTemplate = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  type: "cron" | "once" | "interval";
  schedule: string;
  toolPolicyProfile: string;
};

/** automation_templates 应答 */
export type PiAutomationTemplatesResponse = {
  type: "automation_templates";
  templates: PiAutomationTemplate[];
};

export type PiResponse =
  | { type: "sessions"; sessions: PiSessionSummary[] }
  | { type: "running"; sessionIds: string[] }
  | { type: "session"; sessionId: string; threadId: string }
  | { type: "forked"; sessionId: string }
  // PiClient 契约快照应答（react-pi 迁移阶段 2）：形状单源 pi-runtime/types
  | {
      type: "thread_snapshot";
      snapshot: import("@/lib/pi/pi-runtime/types").PiThreadSnapshot;
    }
  | {
      type: "history";
      messages: unknown[];
      pending?: unknown[];
      /** §6 分页窗元数据：窗口首/末行的转录 seq；往上翻页用 beforeSeq=firstSeq */
      firstSeq?: number | null;
      lastSeq?: number | null;
      /** 窗口之前还有更早的历史 */
      hasMore?: boolean;
    }
  // 挂起交互权威拉取应答（§4）：items = PendingInteraction[]（类型收窄在调用方）
  | { type: "pending"; items: unknown[] }
  | PiAutomationListResponse
  | PiAutomationPreviewResponse
  | PiAutomationTemplatesResponse
  | { type: "deleted" }
  | { type: "renamed" }
  | { type: "archived" }
  | { type: "session_cwd_set"; sessionId: string; cwd: string }
  | { type: "models"; models: PiModelSummary[]; providers: PiProviderSummary[] }
  | { type: "model"; provider: string; modelId: string }
  | { type: "thinking"; level: string }
  | { type: "thinking_seed"; seed: PiThinkingSeed | null }
  | { type: "thinking_maps"; applied: number }
  | {
      type: "personalization";
      settings: PiPersonalization;
      paths?: PiPersonalizationPaths;
    }
  | { type: "app_mode"; mode: PiAppMode }
  | { type: "memory"; settings: PiMemoryConfig }
  | { type: "browser"; settings: PiBrowserConfig }
  | { type: "mirror"; settings: PiMirrorConfig }
  | { type: "imagegen"; settings: PiImageGenConfig }
  | PiSecretsResponse
  | { type: "observability"; settings: PiObservabilityConfig }
  | { type: "observability_tested"; result: PiObservabilityTestResult }
  | { type: "hooks_saved" }
  | { type: "hooks"; hooks: PiHookConfig[] }
  | PiMemoryFilesResponse
  | { type: "memory_file"; file: string; content: string }
  | {
      type: "memory_file_saved";
      scope: "global" | "workspace";
      file: string;
      bytes: number;
    }
  | { type: "memory_versions"; file: string; versions: PiMemoryVersionEntry[] }
  | { type: "memory_version"; file: string; versionId: string; content: string }
  | {
      type: "memory_version_restored";
      scope: "global" | "workspace";
      file: string;
      bytes: number;
      versionId: string;
    }
  | { type: "memory_version_deleted"; file: string; versionId: string }
  | {
      type: "memory_file_trashed";
      scope: "global" | "workspace";
      file: string;
      trashId: string;
    }
  | {
      type: "memory_trash";
      scope: "global" | "workspace";
      entries: PiMemoryTrashEntry[];
    }
  | {
      type: "memory_trash_restored";
      scope: "global" | "workspace";
      file: string;
      trashId: string;
    }
  | { type: "memory_trash_deleted"; scope: "global" | "workspace"; trashId: string }
  | { type: "memory_trash_emptied"; scope: "global" | "workspace"; removed: number }
  | PiSubagentsResponse
  | PiSkillsResponse
  | PiDesignThemesResponse
  | PiDesignThemeDocResponse
  | PiDesignThemeSavedResponse
  | PiDesignThemeSetResponse
  | PiMcpServersResponse
  | PiMcpServerTestResponse
  | PiMcpServerLogResponse
  | PiMcpServerToolsResponse
  | PiMcpAuditLogResponse
  | PiPluginsResponse
  | PiPluginPanelAssetResponse
  | PiPluginComponentDocResponse
  | PiPluginPanelRevResponse
  | PiMarketplacesResponse
  | PiPluginOpAccepted
  | { type: "usage_stats"; stats: PiUsageStats }
  | { type: "trace_query"; runs: PiTraceRun[] }
  | { type: "todo_state"; tasks: unknown[]; nextId: number }
  | { type: "goal_state"; goal: GoalState["goal"] }
  | { type: "model_updated"; provider: string; modelId: string }
  | { type: "credential"; provider: string }
  | { type: "credentials"; credentials: PiCredentialSummary[] }
  | { type: "credential_deleted"; provider: string }
  | { type: "custom_provider"; provider: string }
  | { type: "custom_providers"; providers: PiCustomProviderSummary[] }
  | { type: "custom_provider_deleted"; provider: string }
  | { type: "custom_provider_toggled"; provider: string; enabled: boolean }
  | {
      type: "provider_import_candidates";
      candidates: PiImportedProvider[];
      sources: PiImportSourceStatus[];
    }
  | { type: "fetched_models"; models: string[] }
  | { type: "tested"; ok: true }
  | { type: "provider_filter"; provider: string; models: string[] | null }
  | {
      type: "mode_changed" | "planning_state";
      mode: "agent" | "plan" | "ask" | "goal";
      approvalLevel?: "ask" | "workspace-write" | "auto-edit" | "auto";
      planning: "inactive" | "planning";
    }
  | PiContextInfo
  | PiCompacted
  // 提示词优化（lib/pi/pi-prompt-optimize）：optimize_prompt 的晚响应与请求
  // 共用 reqId（sidecar handlers/optimize.ts 派活即返回）；cancelled 是任务
  // 自己被取消的终态帧，cancel 只是取消命令的即时回执
  | {
      type: "prompt_optimized";
      jobId: string;
      text: string;
      chipCount: number;
      model: string;
    }
  | { type: "prompt_optimize_cancelled"; jobId: string }
  | { type: "prompt_optimize_cancel"; jobId: string }
  // §8 加性结构化归因：errorText 仍是兜底文案，error 缺省 = 旧端未升级
  | { type: "error"; errorText: string; error?: ErrorPayload }
  | { type: "tool_confirmed"; approvalId: string }
  | { type: "question_answered"; questionId: string }
  | {
      type: "subagent_activity_snapshot";
      record: {
        /** 规范全量 id（按前缀查询时前端据此迁移别名条目） */
        delegationId: string;
        agentName: string;
        description?: string;
        status: string;
        startedAt: number;
        completedAt?: number;
        turns: number;
        toolCalls: number;
        report?: string;
      };
      items: unknown[];
    };

/**
 * 工具图片投影 part 的 data 载荷（镜像 sidecar types.ts 同名类型）。
 * prompt 流 chunk `{type:"data-image", id, data}` / get_history 同构 part；
 * 投影闸门单点在 sidecar image-parts.ts，设计 docs/image-part-design.md。
 */
export type PiImagePartData = {
  /** 内联 data URL：`data:<mimeType>;base64,...` */
  src: string;
  mimeType: string;
  /** 解码后原始字节（base64 长度 ×3/4 近似；渲染角标用） */
  bytes: number;
  /** 产出该图的工具调用 id；非工具来源（P1 模型直出）为 null */
  toolCallId: string | null;
  /** 产出图的工具名 */
  toolName?: string;
  /** 可访问名：结果首个文本块首行（≤120 字符） */
  alt?: string;
};

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
