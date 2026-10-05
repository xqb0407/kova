/**
 * 数据访问层门面（双模式，统一 async 接口）。物理布局：
 * - ./hostdb/transport.ts  host 模式传输策略（stdout host_query RPC + 取消/超时/挂起登记）
 * - ./hostdb/local.ts      local 模式实现（bun:sqlite，建表/迁移与 Rust data.rs 镜像，仅测试/冒烟）
 * - 本文件                 模式初始化 + 类型化表 API（session/credential/custom_provider/models/kv/usage/tool）
 *
 * 双模式说明：
 * - host 模式（生产）：业务表由 Rust 宿主持有（src-tauri/src/data.rs），本侧经 stdout 上的
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
  updated_at: string;
  /** 迭代 4：JSONL 消息行数（列表展示用；session_touch 增量维护） */
  message_count: number;
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
};

export type CustomProviderRow = {
  id: string;
  name: string;
  baseUrl: string;
  /** JSON 字符串（CustomModelSpec[]） */
  models: string;
  api: string;
  enabled: boolean;
};

/** 会话持久化行：cwd/title + 会话级偏好（mode/approvalLevel/model/thinkingLevel/designTheme/appMode；NULL = 从未变更过） */
export type SessionPrefsRow = {
  cwd: string;
  title: string;
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
  },
) => query("session_prefs_set", { sessionId, ...prefs });

export const sessionInsert = (sessionId: string, cwd: string) =>
  query("session_insert", { sessionId, cwd, now: nowIso() });

/** 补写会话绑定目录（建会话时未选目录、后来选了：见 sessions.ts rebindRunCwd） */
export const sessionUpdateCwd = (sessionId: string, cwd: string) =>
  query("session_update_cwd", { sessionId, cwd });

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


export const customProvidersList = () => query<CustomProviderRow[]>("custom_providers_list");

export const customProviderGet = (id: string) =>
  query<CustomProviderRow | null>("custom_provider_get", { id });

export const customProviderUpsert = (row: {
  id: string;
  name: string;
  baseUrl: string;
  models: string;
  api: string;
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
};

export const modelsReplace = (provider: string, items: ModelReplaceItem[]) =>
  query("models_replace", { provider, models: JSON.stringify(items) });

export const modelsDeleteProvider = (provider: string) =>
  query("models_delete_provider", { provider });

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

/** 主机工具调用（仅 host 模式可用；bash/read/write/edit/http 由 Rust 执行）；
 *  signal 中断时向宿主发 host_cancel（bash 会立即杀进程树）。
 *  owner = 发起线程 id：宿主用它给跨回合存活的后台任务（bash runInBackground）
 *  打归属标记，task_output / task_stop 只认本线程的任务——否则宿主那张全局
 *  任务表就是所有线程共用的，任意线程凭猜测的 id 就能读别人命令的输出或杀掉
 *  别人的进程。 */
export const hostToolCall = (
  name: string,
  cwd: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  owner?: string,
) =>
  query<{ output: string; truncated?: boolean; exitCode?: number | null; totalLines?: number;
    /** read 命中图片时 Rust 附加（≤2MiB）：sidecar 转成 image 内容块 */
    base64?: string; mimeType?: string; bytes?: number;
    /** browser_shot 成功信封附加（browser_shot.rs）：像素照尺寸 */
    width?: number; height?: number }>(
    "tool",
    { name, cwd, owner, params },
    { signal, timeoutMs: toolRpcTimeoutMs(name, params) },
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
};

/** WebFetch/WebSearch 的网络执行出口（仅 host 模式；超时/截断/编码在 Rust 侧完成） */
export const hostHttpCall = (
  cwd: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) =>
  query<HostHttpData>("tool", { name: "http", cwd, params }, {
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
