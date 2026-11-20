/**
 * 数据访问层门面（双模式，统一 async 接口）。物理布局：
 * - ./hostdb/transport.ts  host 模式传输策略（stdout host_query RPC + 取消/超时/挂起登记）
 * - ./hostdb/local.ts      local 模式实现（bun:sqlite，建表/迁移与 Rust data.rs 镜像，仅测试/冒烟）
 * - 本文件                 模式初始化 + 类型化表 API（session/credential/custom_provider/models/kv/usage/tool）
 *
 * 双模式说明：
 * - host 模式（生产）：业务表由 Rust 宿主持有（原 Rust 宿主/src/data.rs），本侧经 stdout 上的
 *   host_query RPC 读写，宿主从 stdin 回写 host_result。
 * - local 模式（测试/冒烟）：直接用 bun:sqlite 打开本地库。
 *
 * 双模式是为了 bun test 在无宿主环境可跑；生产路径上 Rust 是业务表唯一写入方，
 * 消除此前 bun:sqlite / rusqlite 双进程共写同一 state.db 的隐患。
 * 会话 JSONL 正文不在本层（transcript.ts 直写文件，所有权在 sidecar）。
 */
import {
  getTransport,
  toolRpcTimeoutMs,
  type RpcOptions,
} from "./hostdb/transport";
import type { SandboxPlan } from "pi-sandbox";

export { initHostTransport, resolveHostResult, type RpcOptions } from "./hostdb/transport";
export {
  initLocalStorage,
  isLocalStorage,
  getLocalDb,
  resetStorageForTest,
} from "./hostdb/local";

/* -------------------------------- 类型化出口 -------------------------------- */

async function query<T>(
  kind: string,
  params: Record<string, unknown> = {},
  opts?: RpcOptions,
): Promise<T> {
  const transport = getTransport();
  if (!transport) throw new Error("storage not initialized (initHostTransport/initLocalStorage)");
  return (await transport(kind, params, opts)) as T;
}

const nowIso = () => new Date().toISOString();

export type SessionRow = {
  id: string;
  title: string;
  first_message: string;
  cwd: string;
  archived: number;
  /** 归档时刻（ISO；旧数据/未归档为 null）——检查点 GC 按它判断归档时长 */
  archivedAt?: string | null;
  updated_at: string;
  /** 迭代 4：JSONL 消息行数（列表展示用；session_touch 增量维护） */
  message_count: number;
  /** 会话类型："" = 普通任务；"side_chat" = 划词辅助会话（不进主列表） */
  kind: string;
  /** 辅助会话的父会话 id；普通会话为空串 */
  parentSession: string;
  /** 会话级偏好（NULL = 从未变更过；session_prefs_set 维护） */
  mode: string | null;
  approvalLevel: string | null;
  modelProvider: string | null;
  modelId: string | null;
  /** 思考档位偏好（NULL = 从未定靶选过，跟随默认档位；定靶 set_thinking 维护） */
  thinkingLevel: string | null;
  /** 设计主题偏好：JSON 字符串 {scope,id}；NULL = 从未设置；"" = 显式不使用主题 */
  designTheme: string | null;
  /** 工作模式偏好（work|code|design）：NULL = 本会话从未切换过，跟随全局默认 */
  appMode: string | null;
  /** 目标轮数上限偏好（文本存数字）：NULL = 本会话从未定过（建目标回落默认 300）；
   *  "0" = 不限。两态必须分得开——「不限」也是一个要记住的选择 */
  goalMaxTurns: string | null;
  /** 验收标准启动模式偏好（auto|manual|skip）：NULL = 从未定过（新目标默认 auto） */
  goalAcceptanceMode: string | null;
  /** 目标活跃时长上限偏好（文本存分钟）：NULL = 从未定过；"0" = 不限 */
  goalMaxDuration: string | null;
  /** 项目归属（NULL = 普通任务/旧会话/远程会话） */
  projectId: string | null;
};

export type CustomProviderRow = {
  id: string;
  name: string;
  baseUrl: string;
  /** JSON 字符串（CustomModelSpec[]） */
  models: string;
  api: string;
  enabled: boolean;
  /** 动态模型发现开关：开启时注册合并发现缓存里的 AUTO 模型 */
  autoDiscover: boolean;
  /** 自定义请求头（JSON 对象字符串；"{}" = 无） */
  headers: string;
};

/** 会话持久化行：cwd/title + 会话级偏好（mode/approvalLevel/model/thinkingLevel/designTheme/appMode；NULL = 从未变更过） */
export type SessionPrefsRow = {
  cwd: string;
  title: string;
  /** 会话类型："" = 普通任务；"side_chat" = 划词辅助会话 */
  kind: string;
  /** 辅助会话的父会话 id；普通会话为空串 */
  parentSession: string;
  mode: string | null;
  approvalLevel: string | null;
  modelProvider: string | null;
  modelId: string | null;
  /** 思考档位偏好：NULL = 从未定靶选过（跟随默认档位） */
  thinkingLevel: string | null;
  /** 设计主题：JSON 字符串 {scope,id}；NULL = 从未设置（恢复链退到最近使用 kv）；"" = 显式不使用主题 */
  designTheme: string | null;
  /** 工作模式偏好：NULL = 本会话从未切换过（恢复链退到全局默认 kv pi.app_mode） */
  appMode: string | null;
  /** 目标轮数上限：NULL = 本会话从未定过（建目标回落默认 300）；"0" = 不限 */
  goalMaxTurns: string | null;
  /** 验收标准启动模式：NULL = 从未定过（新目标默认 auto） */
  goalAcceptanceMode: string | null;
  /** 目标活跃时长上限：NULL = 从未定过；"0" = 不限（分钟字符串） */
  goalMaxDuration: string | null;
  /** 项目归属（NULL = 普通任务/旧会话/远程会话） */
  projectId: string | null;
};

export const sessionGet = (sessionId: string) =>
  query<SessionPrefsRow | null>("session_get", { sessionId });

/** 会话级偏好写入：只更新携带的字段（host/local 均 COALESCE 语义），其余保持原值。
 *  designTheme 传 JSON 字符串（主题）或 ""（显式清除为无主题）；不传 = 不动该列 */
export const sessionPrefsSet = (
  sessionId: string,
  prefs: {
    mode?: string;
    approvalLevel?: string;
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: string;
    designTheme?: string;
    /** 会话级工作模式（work|code|design）：定靶 set_app_mode 只写被点名会话 */
    appMode?: string;
    /** 会话级目标轮数上限（数字字符串；"0" = 不限）：定靶写入只动本会话 */
    goalMaxTurns?: string;
    /** 会话级验收标准启动模式（auto|manual|skip） */
    goalAcceptanceMode?: string;
    /** 会话级目标活跃时长上限（分钟字符串；"0" = 不限） */
    goalMaxDuration?: string;
  },
) => query("session_prefs_set", { sessionId, ...prefs });

/** 索引行会话类型自愈：header 写了 kind/parentSession 而索引行缺失时补齐
 *  （旧宿主期间创建的辅助会话行；见 resolve.ts 的恢复分支） */
export const sessionMetaSet = (
  sessionId: string,
  meta: { kind: string; parentSession: string },
) => query("session_meta_set", { sessionId, ...meta });

export const sessionInsert = (
  sessionId: string,
  cwd: string,
  opts: { kind?: string; parentSession?: string; projectId?: string | null } = {},
) =>
  query("session_insert", {
    sessionId,
    cwd,
    now: nowIso(),
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.parentSession ? { parentSession: opts.parentSession } : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  });

/** 补写会话绑定目录（建会话时未选目录、后来选了：见 sessions.ts rebindRunCwd） */
export const sessionUpdateCwd = (sessionId: string, cwd: string) =>
  query("session_update_cwd", { sessionId, cwd });

/** 显式改会话项目归属（项目移动/迁移/rebind） */
export const sessionSetProject = (
  sessionId: string,
  projectId: string | null,
) => query("session_set_project", { sessionId, projectId });

/* ------------------------------- projects ------------------------------- */

export type HostProjectFolder = {
  path: string;
  sortOrder: number;
  isPrimary: boolean;
};

export type HostProject = {
  id: string;
  displayName: string | null;
  nameIsCustom: boolean;
  appearanceJson: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  showWhenEmpty: boolean;
  /** 侧栏已移除（仅隐藏项目卡；设置页仍可见、可恢复显示） */
  hiddenFromSidebar: boolean;
  folders: HostProjectFolder[];
};

export type SaveHostProjectInput = {
  id?: string;
  displayName?: string | null;
  nameIsCustom?: boolean;
  appearanceJson?: string | null;
  archived?: boolean;
  showWhenEmpty?: boolean;
  hiddenFromSidebar?: boolean;
  folders: { path: string; isPrimary?: boolean }[];
  primaryPath?: string;
};

export const projectList = (includeArchived = false) =>
  query<{ projects: HostProject[] }>("project_list", { includeArchived });

export const projectSave = (project: SaveHostProjectInput) =>
  query<{ project: HostProject }>("project_save", { project });

export const projectDelete = (projectId: string) =>
  query("project_delete", { projectId });

/** 彻底删除项目实体（folders 一并删除；会话由调用方解绑） */
export const projectPurge = (projectId: string) =>
  query("project_purge", { projectId });

export const sessionList = () => query<SessionRow[]>("session_list");

export const sessionDelete = (sessionId: string) => query("session_delete", { sessionId });

export const sessionRename = (sessionId: string, name: string) =>
  query("session_rename", { sessionId, name });

/** 归档 / 取消归档：列表默认隐藏归档会话，正文不动 */
export const sessionSetArchived = (sessionId: string, archived: boolean) =>
  query("session_set_archived", { sessionId, archived });

/** added：本轮新 append 进 JSONL 的消息行数（迭代 4：计数随 touch 增量维护） */
export const sessionTouch = (
  sessionId: string,
  title: string,
  firstMessage: string,
  added = 0,
) => query("session_touch", { sessionId, now: nowIso(), title, firstMessage, added });

export const credentialGet = (provider: string) =>
  query<{ apiKey: string } | null>("credential_get", { provider });

export const credentialList = () => query<string[]>("credential_list");

export const credentialSet = (provider: string, apiKey: string) =>
  query("credential_set", { provider, apiKey, now: nowIso() });

export const credentialDelete = (provider: string) => query("credential_delete", { provider });

/** 非模型 provider 的凭据命名空间（网页搜索等）：模型账户 UI 与 pi-ai
 *  credential 枚举必须过滤掉这个前缀，否则会多出伪 provider。 */
export const WEBSEARCH_CREDENTIAL_PREFIX = "websearch:";

/* 凭据的非密钥补充字段（如 Cloudflare 网关的 Account/Gateway ID）：
 * credentials 表只有 api_key 一列，这类值不进密钥库，挂 kv
 * （key = credential.env.<provider>，值 = JSON 对象）。空串 = 已清除。 */
const credentialEnvKey = (provider: string) => `credential.env.${provider}`;

/** 读凭据补充字段（无值/空/解析失败都返回空对象，语义 = 无补充字段） */
export const credentialEnvGet = async (
  provider: string,
): Promise<Record<string, string>> => {
  const row = await kvGet(credentialEnvKey(provider));
  if (!row?.value) return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k && typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
};

/** 整体替换凭据补充字段（传空对象 = 清空） */
export const credentialEnvSet = (provider: string, env: Record<string, string>) =>
  kvSet(credentialEnvKey(provider), JSON.stringify(env));

/** 删除服务的凭据补充字段（删除凭据时同步调用，不留孤儿行） */
export const credentialEnvDelete = (provider: string) =>
  kvSet(credentialEnvKey(provider), "");

/* ------------------------------ secrets（加密密钥库） ------------------------------ */

/** 密钥清单行：**无明文**（值在 Rust 侧加密落盘，这里只有掩码与可读性标记）。
 *  scope: "global" | "workspace:<cwd>" */
export type SecretRow = {
  name: string;
  scope: string;
  /** `****` + 后四位；解不开时为 `****` */
  masked: string;
  /** false = 密文解不开（换机 / 主密钥丢失），UI 据此提示需重填 */
  readable: boolean;
  updatedAt: string;
};

/** 密钥清单（只回名字与掩码）。明文没有 RPC 出口：Rust 侧不提供 secret_get，
 *  注入路径也只在 Rust 进程内解密，见 docs/secrets-env-design.md §1.1 */
export const secretList = () => query<SecretRow[]>("secret_list");

export const secretSet = (name: string, scope: string, value: string) =>
  query("secret_set", { name, scope, value, now: nowIso() });

export const secretDelete = (name: string, scope: string) =>
  query("secret_delete", { name, scope });

export type SecretCipherBackend =
  | "system-keychain"
  | "local-key-file"
  | "unavailable";

/** 主密钥保护方式（Electron 主进程返回；旧宿主/测试环境可能回 unavailable） */
export const secretCipherStatus = () =>
  query<{ backend: SecretCipherBackend }>("secret_cipher_status");

/** MCP 子进程的密钥注入请求：envName 是子进程里的变量名，name 是密钥库里的名字。
 *  只允许 global 作用域（连接池跨工作区共享，工作区值会有归属歧义）。 */
export type McpSecretEnvRequest = {
  envName: string;
  name: string;
  scope: "global";
};

/**
 * 宿主解密一组 MCP 密钥并回 env 映射。**这是唯一把明文送回 sidecar 的路径**：
 * stdio MCP 子进程由 sidecar 拉起，宿主无法像 bash 那样直接注入，只能把值
 * 交给它；sidecar 只在内存里保留到连接断开，用于子进程环境与输出脱敏。
 */
export const secretEnvResolve = (server: string, requests: McpSecretEnvRequest[]) =>
  query<{ env: Record<string, string> }>("secret_env_resolve", { server, requests });


export const customProvidersList = () => query<CustomProviderRow[]>("custom_providers_list");

export const customProviderGet = (id: string) =>
  query<CustomProviderRow | null>("custom_provider_get", { id });

export const customProviderUpsert = (row: {
  id: string;
  name: string;
  baseUrl: string;
  models: string;
  api: string;
  /** 动态模型发现开关（缺省 false） */
  autoDiscover?: boolean;
  /** 自定义请求头（JSON 对象字符串；"{}" = 无） */
  headers?: string;
}) => query("custom_provider_upsert", { ...row });

export const customProviderDelete = (id: string) => query("custom_provider_delete", { id });

export const customProviderSetEnabled = (id: string, enabled: boolean) =>
  query("custom_provider_set_enabled", { id, enabled });

/* ------------------------------ models（统一模型目录） ------------------------------ */

/** models 行（Rust models_query 返回结构；NULL attrs = 继承内置值） */
export type ModelRow = {
  provider: string;
  modelId: string;
  name: string | null;
  reasoning: boolean | null;
  contextWindow: number | null;
  maxTokens: number | null;
  /** 结构化 JSON（数组），NULL = 未覆盖 */
  input: unknown[] | null;
  /** 结构化 JSON（对象），NULL = 未覆盖 */
  cost: Record<string, unknown> | null;
  /** 结构化 JSON（对象），NULL = 未覆盖：prompt cache TTL（秒）。
   *  cache warmer 只对声明过的模型工作（pi 同款），未声明 = 不暖。 */
  promptCache: { short?: number; long?: number } | null;
  enabled: boolean;
};

export const modelsAll = () => query<ModelRow[]>("models_all");

export const modelsList = (provider: string) =>
  query<ModelRow[]>("models_list", { provider });

/** 整包替换该 provider 的模型行（items 见 ModelReplaceItem；attrs 缺省 = NULL） */
export type ModelReplaceItem = {
  modelId: string;
  enabled?: boolean;
  name?: string | null;
  reasoning?: boolean | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  input?: unknown[] | null;
  cost?: Record<string, unknown> | null;
  promptCache?: { short?: number; long?: number } | null;
};

export const modelsReplace = (provider: string, items: ModelReplaceItem[]) =>
  query("models_replace", { provider, models: JSON.stringify(items) });

export const modelsDeleteProvider = (provider: string) =>
  query("models_delete_provider", { provider });

/** 服务端明确上下文上限后的自动校准：只改该模型行，不碰其它属性。 */
export const modelsSetContextWindow = (
  provider: string,
  modelId: string,
  contextWindow: number,
) => query("models_set_context_window", { provider, modelId, contextWindow });

/* ------------------------------ kv（应用级设置） ------------------------------ */

/** 应用级 kv 读取（生产 = Rust 的 state.db kv 表；value 为 JSON 字符串），无值返回 null */
export const kvGet = (key: string) => query<{ value: string } | null>("kv_get", { key });

/** 应用级 kv 写入（Rust 是唯一写入方；本侧经 host_query RPC 落库） */
export const kvSet = (key: string, value: string) => query("kv_set", { key, value });

/* ---------------------- usage（使用统计物化表） ---------------------- */

/** usage_scan 行（每会话扫描水位：JSONL mtime + 首末消息时间戳） */
export type UsageScanRow = {
  sessionId: string;
  mtime: number;
  firstTs: number;
  lastTs: number;
};

/** usage_daily 行（会话 × 本地日聚合；byModel 为 JSON 字符串） */
export type UsageDailyRow = {
  sessionId: string;
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  messages: number;
  byModel: string;
};

export type UsageDailyRowInput = {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  messages: number;
  /** JSON 字符串：{ "provider/model": tokens } */
  byModel: string;
};

export const usageScanList = () => query<UsageScanRow[]>("usage_scan_list");

/** 整会话替换聚合行（幂等：先删后插 + upsert 扫描水位） */
export const usageDailyReplace = (
  sessionId: string,
  rows: UsageDailyRowInput[],
  mtime: number,
  firstTs: number,
  lastTs: number,
) =>
  query("usage_daily_replace", {
    sessionId,
    rows: JSON.stringify(rows),
    mtime,
    firstTs,
    lastTs,
  });

export const usageDailyQuery = () => query<UsageDailyRow[]>("usage_daily_query");

/** 清除已删会话的聚合行与扫描水位，返回清理的聚合行数 */
export const usageDailyCleanup = () =>
  query<{ removed: number }>("usage_daily_cleanup");

/* ---------------------- search（会话内容搜索索引） ----------------------
 * 正文真值在 JSONL 转录；session_blocks 是索引器派生的可弃投影，search_scan
 * 是 mtime 水位（语义与 usage_scan 同族）。needle 由索引器转义/小写化。 */

/** 单条消息命中（session_search 返回行） */
export type SessionSearchMessageHit = {
  sessionId: string;
  seq: number;
  role: string;
  preview: string;
  title: string;
  cwd: string;
  archived: boolean;
  updatedAt: string;
};

/** 会话标题/首条消息命中（session_search 返回行） */
export type SessionSearchSessionHit = {
  sessionId: string;
  title: string;
  firstMessage: string;
  cwd: string;
  archived: boolean;
  updatedAt: string;
};

export type SessionSearchResult = {
  sessions: SessionSearchSessionHit[];
  messages: SessionSearchMessageHit[];
  artifacts: SessionSearchArtifactHit[];
  truncated: boolean;
};

/** 产物/资料库文件命中（session_search.artifacts 行） */
export type SessionSearchArtifactHit = {
  /** 归属键：sessionId（任务产物）或 __library__（资料库根） */
  sessionId: string;
  /** 相对归属根的 POSIX 路径 */
  rel: string;
  name: string;
  preview: string;
  /** 归属会话标题（资料库行为 null） */
  title: string | null;
  cwd: string;
  archived: boolean;
};

/** 全量替换一个会话的索引块行（调用方先整扫转录再一次性送入） */
export const searchBlocksUpsert = (
  sessionId: string,
  rows: Array<{ seq: number; role: string; preview: string; searchText: string }>,
) =>
  query("search_blocks_upsert", {
    sessionId,
    rows: JSON.stringify(rows),
  });

/** 清除会话的索引块行与扫描水位（会话删除时调用） */
export const searchBlocksDelete = (sessionId: string) =>
  query("search_blocks_delete", { sessionId });

export type SearchScanRow = { sessionId: string; mtime: number };

export const searchBlocksScanList = () =>
  query<SearchScanRow[]>("search_blocks_scan_list");

export const searchBlocksScanSet = (sessionId: string, mtime: number) =>
  query("search_blocks_scan_set", { sessionId, mtime });

/**
 * 搜索入口：needle 传**原始**查询词（原样小写化即可）。
 * 宿主侧两条路径需要不同形态——LIKE 要转义后的（配合 SQL 的 ESCAPE '\'），
 * instr 要原始的（转义后的 `100\%` 在正文里永远匹配不到）。转义在这里做，
 * 调用方不必关心 SQL 细节。
 */
export const sessionSearch = (needle: string, limit = 200) =>
  query<SessionSearchResult>("session_search", {
    needle,
    // 无条件 replace（不是 test 再 replace）：带 g 标志的正则 test 会推进
    // lastIndex，连续查询时偶发不转义，`%`/`_` 会被当通配符。
    likeNeedle: needle.replace(/[\\%_]/g, (ch) => `\\${ch}`),
    limit,
  });

/* -------------------- 产物/资料库文件索引（artifact_blocks） --------------------
 * 与 session_blocks 同一套水位模式；ownerKey = sessionId（任务产物，根 =
 * <task-workspace>/<sessionId>）或 __library__（资料库根）。文件级一行，
 * search_text 是该文件全文抽取（截断）投影；文件删除由索引器对账处理。 */

/** 资料库行的归属哨兵（不是合法 UUID，永不与会话撞键） */
export const ARTIFACT_OWNER_LIBRARY = "__library__";

/** 当前资料库根（宿主权威值；换根后无需重启 sidecar） */
export const libraryRootGet = () =>
  query<{ root: string }>("library_root_get");

/* ------------------------------ 知识使用记录 ------------------------------ */

export type KnowledgeRefInput = {
  sessionId: string;
  source: "library" | "project" | "memory";
  scopeId: string;
  path: string;
  ts?: number;
};

export const knowledgeRefsRecord = (input: KnowledgeRefInput) =>
  query("knowledge_refs_record", { ...input });

export type KnowledgeRefStat = { count: number; lastTs: number | null };

export const knowledgeRefsStats = (input: {
  source: string;
  scopeId: string;
  path: string;
}) => query<KnowledgeRefStat>("knowledge_refs_stats", { ...input });

export type KnowledgeRefRow = {
  sessionId: string;
  ts: number;
  title: string | null;
  cwd: string;
};

export const knowledgeRefsForPath = (input: {
  source: string;
  scopeId: string;
  path: string;
  limit?: number;
}) => query<KnowledgeRefRow[]>("knowledge_refs_for_path", { ...input });

/** 单归属键的文件检索（kb_search 的 library scope 专用） */
export type ArtifactSearchHit = {
  rel: string;
  name: string;
  preview: string;
};

export const artifactSearch = (
  ownerKey: string,
  needle: string,
  limit = 30,
) =>
  query<{ hits: ArtifactSearchHit[]; truncated: boolean }>("artifact_search", {
    ownerKey,
    needle,
    likeNeedle: needle.replace(/[\\%_]/g, (ch) => `\\${ch}`),
    limit,
  });

export type ArtifactIndexRow = {
  rel: string;
  name: string;
  preview: string;
  searchText: string;
};

export type ArtifactScanRow = { ownerKey: string; mtime: number };

/** 全量替换一个归属键下的文件索引行（调用方先整扫目录再一次性送入） */
export const searchArtifactsUpsert = (ownerKey: string, rows: ArtifactIndexRow[]) =>
  query("search_artifacts_upsert", { ownerKey, rows: JSON.stringify(rows) });

/** 清除归属键下的文件索引行与水位（会话删除/资料库换根时调用） */
export const searchArtifactsDelete = (ownerKey: string) =>
  query("search_artifacts_delete", { ownerKey });

export const searchArtifactsScanList = () =>
  query<ArtifactScanRow[]>("search_artifacts_scan_list");

export const searchArtifactsScanSet = (ownerKey: string, mtime: number) =>
  query("search_artifacts_scan_set", { ownerKey, mtime });

/** 默认页最近文件：artifact_blocks 按插入序（rowid）取头部，带会话上下文 */
export const searchArtifactsRecent = (limit = 10) =>
  query<SessionSearchArtifactHit[]>("search_artifacts_recent", { limit });

/* ------------------------------ 搜索历史 ------------------------------ */

export type SearchHistoryRow = { query: string; createdAt: string };

export const searchHistoryList = (limit = 12) =>
  query<SearchHistoryRow[]>("search_history_list", { limit });

/** 同查询去重（保留最新），整表保 100 条 */
export const searchHistoryAdd = (text: string) =>
  query("search_history_add", { query: text, now: new Date().toISOString() });

export const searchHistoryClear = () => query("search_history_clear");

/** 主机工具调用（仅 host 模式可用；bash/read/write/edit/http 由 Rust 执行）；
 *  signal 中断时向宿主发 host_cancel（bash 会立即杀进程树）。
 *  owner = 发起线程 id：宿主用它给跨回合存活的后台任务（bash runInBackground）
 *  打归属标记，task_output / task_stop 只认本线程的任务——否则宿主那张全局
 *  任务表就是所有线程共用的，任意线程凭猜测的 id 就能读别人命令的输出或杀掉
 *  别人的进程。 */
export type HostSandboxInfo = {
  tier: "workspace";
  backend: "seatbelt" | "host" | "none";
  network: "allow" | "deny";
  denied?: "write" | "read" | "network" | "unavailable";
};

export const hostToolCall = (
  name: string,
  cwd: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  owner?: string,
  sandbox?: SandboxPlan,
) =>
  query<{ output: string; truncated?: boolean; exitCode?: number | null; totalLines?: number;
    sandbox?: HostSandboxInfo;
    /** read 命中图片时 Rust 附加（≤2MiB）：sidecar 转成 image 内容块 */
    base64?: string; mimeType?: string; bytes?: number;
    /** browser_shot 成功信封附加（browser_shot.rs）：像素照尺寸 */
    width?: number; height?: number;
    /** bash 超时转后台（tool-exec.ts）：诊断码与模型指引共用 */
    cancelled?: boolean; timedOut?: boolean; taskId?: number; running?: boolean;
    /** bash 截断全量落盘（tool-exec.ts）：suffix 给路径，details 透传给 UI */
    fullOutputPath?: string }>(
    "tool",
    { name, cwd, owner, params, sandbox },
    { signal, timeoutMs: toolRpcTimeoutMs(name, params) },
  );

/** 宿主后台任务表的一行（bg_tasks_list）：宿主内存表是后台任务存活的一手
 *  事实源，sidecar 重启后靠它把台账重建回来（见 tools/bg-tasks.ts 的对账）。 */
export type HostBgTaskRow = {
  taskId: number;
  command: string;
  source: "explicit" | "timeout";
  startedAt: number;
  running: boolean;
  exitCode: number | null;
};

/** 按发起线程列宿主后台任务（owner 为空串 = 全量；宿主侧 owner 精确匹配）。
 *  纯内存读：给短超时——水合在管理队列上，宿主卡住时不能让队列等满 15s。 */
export const bgTasksList = (owner: string) =>
  query<HostBgTaskRow[]>("bg_tasks_list", { owner }, { timeoutMs: 5_000 });

/** 线程键改绑（刷新后草稿 id → sessionId）：宿主侧任务归属跟着线程走。
 *  短超时：调用方（rebindRunThread）在会话恢复路径上，宿主卡住不能拖住恢复。 */
export const bgTasksReown = (oldOwner: string, newOwner: string) =>
  query<{ moved: number }>(
    "bg_tasks_reown",
    { oldOwner, newOwner },
    { timeoutMs: 3_000 },
  );

/** Rust handle_http（tool_exec.rs）的返回结构 */
export type HostHttpData = {
  /** 文本类响应 = utf-8 正文；二进制 = base64（见 encoding） */
  output: string;
  status: number;
  statusText: string;
  ok: boolean;
  /** 跟随重定向后的最终 URL */
  url: string;
  contentType: string;
  headers: Record<string, string>;
  totalBytes: number;
  truncated: boolean;
  encoding: "utf-8" | "base64";
  sandbox?: HostSandboxInfo;
};

/** WebFetch/WebSearch 的网络执行出口（仅 host 模式；超时/截断/编码在 Rust 侧完成） */
export const hostHttpCall = (
  cwd: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  sandbox?: SandboxPlan,
) =>
  query<HostHttpData>("tool", { name: "http", cwd, params, sandbox }, {
    signal,
    timeoutMs: toolRpcTimeoutMs("http", params),
  });

/** Rust handle_screenshot（tool_exec.rs）的返回结构：JPEG 已按内联预算压好 */
export type HostScreenshotData = {
  /** 压缩后 JPEG 的 base64（无 data: 前缀） */
  base64: string;
  /** 固定 "image/jpeg"（Rust 侧统一转码） */
  mimeType: string;
  /** 解码后字节数（Rust 据此判定预算；投影层还会再校 2MiB 闸门） */
  bytes: number;
  /** 成像像素尺寸，供 alt 文案；读取失败为 0 */
  width: number;
  height: number;
};

/** 屏幕截图执行出口（仅 host 模式；screencapture + sips 在 Rust 侧完成，macOS only） */
export const hostScreenshotCall = (
  cwd: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) =>
  query<HostScreenshotData>("tool", { name: "screenshot", cwd, params }, {
    signal,
    timeoutMs: toolRpcTimeoutMs("screenshot", params),
  });

/** 调度器独立进程的 RPC 出口（host 模式）：宿主把请求转发给 kova-automation。 */
export const hostAutomationRpc = <T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> => query<T>("automation_rpc", { method, params });
