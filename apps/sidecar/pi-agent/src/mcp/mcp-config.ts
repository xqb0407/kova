/**
 * MCP 服务器配置（设置 → MCP）：来源、合并、校验与写路径。
 *
 * 三层来源，同名按 id 字段级合并，后层覆盖前层（工作区覆盖层 > 工作区标准层 > 系统）：
 * - 系统：`~/.kova/mcp.json`（PI_MCP_CONFIG 可覆盖，测试用），完整 schema
 * - 工作区标准层：`<cwd>/.mcp.json`，生态标准格式（mcpServers map），随仓库共享，
 *   只认 command/args/env/url/headers/type；adapter 专属字段在此层被忽略
 * - 工作区覆盖层：`<cwd>/.kova/mcp.json`，kova 专属字段（approveTools/lifecycle…），
 *   与 .kova/subagents 同族；设置页对工作区层的写入只落这个文件，从不改写 .mcp.json
 *
 * 字段级合并是有意的：覆盖层可以只给标准层的条目补 approveTools 而不必重抄 command。
 * 安全约束：合并后 url 与低层不同时，不继承低层的 headers（认证材料跟着旧端点走
 * 是偷换指向攻击的收益面，照抄 pi-mcp-adapter 的 URL_BOUND_AUTH 防护）。
 *
 * 启用开关是"本机的运行时决定"，不写进配置文件（工作区文件在 git 里）：整包存
 * SQLite kv（key = ENABLED_KV_KEY），键规则与 subagents 一致（工作区按 cwd 隔离）。
 * **工作区来源默认关闭**（系统层/插件层默认开）：服务器命令在首次调用时就会被拉起，
 * 早于任何审批，所以"仓库带来的服务器"要由用户在本机显式启用后才运行。
 *
 * 动态化：每次加载对三份文件做签名（mtime+大小），签名没变用缓存——设置页保存/
 * 删除后缓存自然失效；网关工具每次 execute 前重载，改动即时生效，无需重启。
 */
import { homedir } from "node:os";
import { configCwdFor, projectExtraDirs } from "../agent/projects";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  activePlugins,
  currentPluginsStateVersion,
  pluginDataRootFor,
  resolvePluginComponents,
} from "../plugins/plugins";
import { expandPluginValue } from "../plugins/expand";
import { applyPluginConfigEnv, initPluginConfig } from "../plugins/plugin-config";
import type {
  PluginConfigField,
  PluginManifest,
  PluginManifestKind,
} from "../plugins/manifest";
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";

export type McpServerName = string;

/** 服务器定义（合并与校验后的运行时形状；协议/manager/缓存共用） */
export type McpServerDef = {
  name: McpServerName;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Codex 插件 stdio 的进程 cwd（绝对路径；只用插件层，已做包含性校验） */
  cwd?: string;
  /** Codex env_vars：从宿主环境透传的变量名（stdio） */
  envVars?: string[];
  /** Codex env_http_headers：header 名 → 环境变量名（http） */
  envHttpHeaders?: Record<string, string>;
  /** Codex bearer_token_env_var：从环境变量取 Bearer token（http） */
  bearerTokenEnvVar?: string;
  /** Codex startup_timeout_sec/ms：握手与首次 tools/list 的超时 */
  startupTimeoutMs?: number;
  /** Codex disabled_tools：在 enabledTools 之后再剔除的工具 glob */
  disabledTools?: string[];
  /** Codex `.mcp.json` 的 enabled:false：保留定义但绝不连接 */
  manifestDisabled?: boolean;
  /** 插件层来源根（注入 PLUGIN_ROOT / PLUGIN_DATA，解析占位符用） */
  pluginRoot?: string;
  pluginDataRoot?: string;
  description?: string;
  /** lazy（默认，空闲断开）| eager / keep-alive（保持连接，不空闲回收） */
  lifecycle?: "lazy" | "eager" | "keep-alive";
  idleTimeout?: number;
  /** 工具调用超时（毫秒），未配置用 MCP_CALL_TIMEOUT_MS 兜底 */
  callTimeout?: number;
  /**
   * 工具名 glob 免审批（对 gateway 的 call 动作）。
   *
   * ⚠️ **只有非工作区层才是授权**：工作区层（`.mcp.json` / `.kova/mcp.json`，都跟着
   * 仓库走）里的这份声明不产生豁免效力，只作为审批卡上「这个项目请求放行 X」的说明
   * ——clone 一个别人的项目不该让那个仓库给自己的工具免审批。判定的收口点在
   * mcp-tools 的 executeCall（isToolApprovedBy 仍是纯匹配函数）。
   */
  approveTools?: string[];
  /**
   * 工具白名单（M2.2）：glob 列表，只放行匹配的工具进索引/调用面。与
   * approveTools（免审批）语义相反——这是授权面收窄，生效规则与 approveTools
   * 相同：只有非工作区层产生效力（仓库文件不能决定本机连什么工具）。
   */
  enabledTools?: string[];
  /**
   * 工具暴露方式（opt-in）：gateway（默认，全部走 `mcp` 网关）| direct
   * （服务器工具按 `mcp__server__tool` 直接声明给模型，网关仍保留给其余动作）。
   * 与 approveTools/enabledTools 同规矩：只有非工作区层产生效力。
   */
  expose?: "gateway" | "direct";
  /**
   * Connector 目录身份（M1.4）：由桌面 Connectors 市场安装时写入，sidecar 只做
   * 透传与持久化，不做任何语义判定（目录是前端事实源）。标准层 .mcp.json 不认。
   */
  connectorId?: string;
  /** 所属层与来源文件，设置页展示与写路径用（plugin 层只读：插件市场贡献） */
  layer: "system" | "workspace" | "plugin";
  source: string;
  /** 最终生效定义来自工作区标准层 .mcp.json（该文件设置页从不改写） */
  fromStandard?: boolean;
  /** layer = "plugin" 时来源插件身份（stateKey 命名空间） */
  pluginId?: string;
};

/** 每文件条目上限：坏目录不该撑爆搜索结果，与 subagents 的层上限同哲学 */
const MAX_PER_FILE = 32;

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const MAX_VALUE_BYTES = 4096;

const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

/** MCP 配置条目是否为普通对象（非数组/null） */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Codex 插件层 `.mcp.json` 认得、但当前只做诊断的字段 */
const CODEX_PLUGIN_FIELDS = new Set([
  "http_headers",
  "env_http_headers",
  "env_vars",
  "cwd",
  "bearer_token_env_var",
  "startup_timeout_sec",
  "startup_timeout_ms",
  "tool_timeout_sec",
  "enabled",
  "enabled_tools",
  "disabled_tools",
  "default_tools_approval_mode",
  "required",
  "startup_readiness",
  "supports_parallel_tool_calls",
  "omit_tools_from",
  "tool_input_schema_max_bytes",
  "scopes",
  "oauth",
  "oauth_resource",
  "environment_id",
  "tools",
]);

const CODEX_UNSUPPORTED_FIELDS = new Set([
  "default_tools_approval_mode",
  "required",
  "startup_readiness",
  "supports_parallel_tool_calls",
  "omit_tools_from",
  "tool_input_schema_max_bytes",
  "scopes",
  "oauth",
  "oauth_resource",
  "environment_id",
  "tools",
]);

function resolvePluginCwd(
  raw: string,
  root: string,
  dataRoot: string | undefined,
  label: string,
  warnings: string[],
): string | undefined {
  // Codex Agent Plugins 的 cwd 允许 `./`（相对插件根）、`${PLUGIN_ROOT}` 或
  // `${PLUGIN_DATA}`（后者在插件根之外）。相对路径以实际占位符的根为基准。
  const usingData = raw.includes("${PLUGIN_DATA}") && !raw.includes("${PLUGIN_ROOT}");
  const base = usingData && dataRoot ? dataRoot : root;
  const expanded = raw
    .split("${PLUGIN_ROOT}")
    .join(root)
    .split("${PLUGIN_DATA}")
    .join(dataRoot ?? root);
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
  const allowedRoots = [root, ...(dataRoot ? [dataRoot] : [])];
  const inside = allowedRoots.some((allowed) => {
    const prefix = allowed.endsWith(sep) ? allowed : allowed + sep;
    return abs === allowed || abs.startsWith(prefix);
  });
  if (inside) return abs;
  warnings.push(`${label}: cwd 必须落在插件根或插件数据目录内（"${raw}"），已回退插件根`);
  return undefined;
}

const LAUNCHER_FILE_RE =
  /\.(?:mjs|cjs|js|ts|mts|cts|sh|bash|zsh|fish|py|rb|pl|ps1|cmd|bat)$/i;

/**
 * stdio 启动命令里指向插件内的脚本是否真的存在。
 *
 * 市场镜像经常只搬清单和技能，漏掉 `dist/`、`scripts/`（例如 awesome-codex-plugins
 * 的 .gitignore 全局忽略 dist/）；装完再连只会得到 "Connection closed"。这里在
 * 解析阶段就把「声明了但文件不在」变成可读诊断。
 */
function missingLauncherFiles(
  def: McpServerDef,
  root: string,
  dataRoot: string | undefined,
): string[] {
  const base = def.cwd ?? root;
  const expand = (value: string) =>
    value
      .split("${PLUGIN_ROOT}")
      .join(root)
      .split("${PLUGIN_DATA}")
      .join(dataRoot ?? root);
  const insidePlugin = (abs: string): boolean => {
    const roots = [root, ...(dataRoot ? [dataRoot] : [])];
    return roots.some((allowed) => {
      const prefix = allowed.endsWith(sep) ? allowed : allowed + sep;
      return abs === allowed || abs.startsWith(prefix);
    });
  };
  const check = (raw: string): string | undefined => {
    const token = expand(raw.trim());
    // 空值 / flag / 整段 shell 命令（`sh -c "..."`）都不是可直接 stat 的路径
    if (!token || token.startsWith("-") || /\s/.test(token)) return undefined;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return undefined;
    const absolute = isAbsolute(token);
    const looksLikeFile =
      token.startsWith("./") ||
      token.startsWith("../") ||
      LAUNCHER_FILE_RE.test(token) ||
      (absolute && insidePlugin(resolve(token)));
    if (!looksLikeFile) return undefined;
    const abs = absolute ? resolve(token) : resolve(base, token);
    // 插件外的绝对路径来自用户环境，不属于插件包完整性
    if (absolute && !insidePlugin(abs)) return undefined;
    return existsSync(abs) ? undefined : raw;
  };
  const missing: string[] = [];
  const command = typeof def.command === "string" ? check(def.command) : undefined;
  if (command) missing.push(command);
  for (const arg of def.args ?? []) {
    const hit = check(arg);
    if (hit) missing.push(hit);
  }
  return missing;
}

/**
 * Codex 插件层 MCP 字段归一化。只对 layer="plugin" 生效：系统/工作区
 * `.mcp.json` 保持既有的 Claude 生态语义，不因为 Codex 兼容而放宽。
 */
function applyCodexPluginFields(
  def: McpServerDef,
  r: RawEntry,
  label: string,
  warnings: string[],
): void {
  const root = def.pluginRoot;
  const dataRoot = def.pluginDataRoot;
  if (!root) return;

  // stdio: cwd / env_vars / enabled
  if (def.transport === "stdio") {
    if (typeof r.cwd === "string" && r.cwd.trim()) {
      const cwd = resolvePluginCwd(r.cwd.trim(), root, dataRoot, label, warnings);
      if (cwd) def.cwd = cwd;
    }
    const missingLaunchers = missingLauncherFiles(def, root, dataRoot);
    if (missingLaunchers.length > 0) {
      warnings.push(
        `${label}: 启动文件不存在：${missingLaunchers.join("、")}（插件包不完整，市场镜像可能漏拷 scripts/ 或 dist/），MCP 将无法启动`,
      );
    }
    if (Array.isArray(r.env_vars)) {
      const names: string[] = [];
      for (const item of r.env_vars) {
        if (typeof item === "string" && ENV_KEY_RE.test(item)) {
          if (!names.includes(item)) names.push(item);
          continue;
        }
        if (isPlainRecord(item)) {
          const name = typeof item.name === "string" ? item.name.trim() : "";
          const source = typeof item.source === "string" ? item.source.trim() : undefined;
          if (!name || !ENV_KEY_RE.test(name)) {
            warnings.push(`${label}: env_vars 条目缺少合法 name，已忽略`);
            continue;
          }
          if (source && source !== "local") {
            warnings.push(`${label}: env_vars "${name}" 的 source=${source} 暂不支持，已忽略`);
            continue;
          }
          if (!names.includes(name)) names.push(name);
          continue;
        }
        warnings.push(`${label}: env_vars 条目必须是字符串或 {name,source}，已忽略`);
      }
      if (names.length) def.envVars = names;
    } else if (r.env_vars !== undefined) {
      warnings.push(`${label}: env_vars 必须是数组，已忽略`);
    }
  } else {
    if (r.cwd !== undefined) warnings.push(`${label}: http 服务器忽略 cwd`);
    if (r.env_vars !== undefined) warnings.push(`${label}: http 服务器忽略 env_vars`);
    // http: env_http_headers / bearer_token_env_var
    if (isPlainRecord(r.env_http_headers)) {
      const headers: Record<string, string> = {};
      for (const [header, envName] of Object.entries(r.env_http_headers)) {
        if (!HEADER_KEY_RE.test(header)) {
          warnings.push(`${label}: env_http_headers 键 "${header}" 不是合法 HTTP 头名，已忽略`);
          continue;
        }
        if (typeof envName !== "string" || !ENV_KEY_RE.test(envName)) {
          warnings.push(`${label}: env_http_headers["${header}"] 必须是环境变量名，已忽略`);
          continue;
        }
        headers[header] = envName;
      }
      if (Object.keys(headers).length) def.envHttpHeaders = headers;
    } else if (r.env_http_headers !== undefined) {
      warnings.push(`${label}: env_http_headers 必须是键值对象，已忽略`);
    }
    if (typeof r.bearer_token_env_var === "string" && r.bearer_token_env_var.trim()) {
      const name = r.bearer_token_env_var.trim();
      if (ENV_KEY_RE.test(name)) def.bearerTokenEnvVar = name;
      else warnings.push(`${label}: bearer_token_env_var "${name}" 不是合法环境变量名，已忽略`);
    }
  }

  // 共用：enabled / 超时 / 工具过滤
  if (r.enabled === false) def.manifestDisabled = true;
  else if (r.enabled !== undefined && typeof r.enabled !== "boolean") {
    warnings.push(`${label}: enabled 必须是布尔值，已忽略`);
  }

  const startupMs =
    typeof r.startup_timeout_ms === "number" && Number.isFinite(r.startup_timeout_ms)
      ? Math.floor(r.startup_timeout_ms)
      : typeof r.startup_timeout_sec === "number" && Number.isFinite(r.startup_timeout_sec)
        ? Math.floor(r.startup_timeout_sec * 1000)
        : undefined;
  if (startupMs !== undefined) {
    def.startupTimeoutMs = Math.min(Math.max(startupMs, 1_000), 300_000);
  }
  if (typeof r.tool_timeout_sec === "number" && Number.isFinite(r.tool_timeout_sec)) {
    def.callTimeout = Math.min(Math.max(Math.floor(r.tool_timeout_sec * 1000), 5_000), 600_000);
  }
  const toolGlobs = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return out.length ? out.map((item) => item.trim()).slice(0, 64) : undefined;
  };
  if (r.enabled_tools !== undefined) {
    const tools = toolGlobs(r.enabled_tools);
    if (tools) def.enabledTools = tools;
    else warnings.push(`${label}: enabled_tools 必须是字符串数组，已忽略`);
  }
  if (r.disabled_tools !== undefined) {
    const tools = toolGlobs(r.disabled_tools);
    if (tools) def.disabledTools = tools;
    else warnings.push(`${label}: disabled_tools 必须是字符串数组，已忽略`);
  }
  for (const key of Object.keys(r)) {
    if (CODEX_UNSUPPORTED_FIELDS.has(key)) {
      warnings.push(`${label}: [codex compat] 字段 "${key}" 暂不支持，已忽略`);
    }
  }
}

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/** 系统级配置文件（应用数据目录，与 ~/.kova/subagents 同族） */
export function systemMcpConfigPath(): string {
  if (process.env.PI_MCP_CONFIG) return process.env.PI_MCP_CONFIG;
  return join(homedir(), ".kova", "mcp.json");
}

/** 工作区标准层（生态共享格式） */
export function workspaceStandardMcpPath(cwd: string): string {
  return join(cwd, ".mcp.json");
}

/** 工作区覆盖层（kova 专属字段；设置页工作区写路径） */
export function workspaceOverrideMcpPath(cwd: string): string {
  return join(cwd, ".kova", "mcp.json");
}

// ---------------------------------------------------------------------------
// 解析与校验
// ---------------------------------------------------------------------------

type RawEntry = Record<string, unknown>;

/** 标准层（.mcp.json）只认的字段；其余（approveTools 等）静默忽略并记诊断 */
const STANDARD_FIELDS = new Set(["command", "args", "env", "url", "headers", "type"]);

function transportOf(
  raw: RawEntry,
  label: string,
  errors: string[],
): "stdio" | "http" | null {
  const hasCommand = typeof raw.command === "string" && raw.command.trim().length > 0;
  const hasUrl = typeof raw.url === "string" && raw.url.trim().length > 0;
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  if (type === "http" || type === "sse" || type === "streamable-http") return "http";
  if (type === "stdio") return "stdio";
  if (hasCommand && hasUrl) {
    errors.push(`${label}: command 与 url 只能二选一`);
    return null;
  }
  if (hasUrl) return "http";
  if (hasCommand) return "stdio";
  errors.push(`${label}: 缺少 command（stdio）或 url（http）`);
  return null;
}

function stringMap(
  raw: unknown,
  keyRe: RegExp,
  label: string,
  cap: number,
  errors: string[],
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`${label}: 必须是键值对象`);
    return undefined;
  }
  // 无原型：工作区 .mcp.json 可写任意合法 env 名，`__proto__` 不能变成
  // 对对象原型的赋值（否则该条 env 会静默丢失，还可能污染后续读取）。
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      errors.push(`${label}.${k}: 值必须是字符串`);
      continue;
    }
    if (!keyRe.test(k)) {
      errors.push(`${label} 键 "${k}" 不符合命名规则`);
      continue;
    }
    if (byteLen(v) > MAX_VALUE_BYTES) {
      errors.push(`${label}.${k}: 值超过 ${MAX_VALUE_BYTES} 字节`);
      continue;
    }
    out[k] = v;
  }
  if (Object.keys(out).length > cap) {
    errors.push(`${label}: 条目超过上限 ${cap}`);
  }
  return out;
}

/**
 * 解析一个 mcpServers 条目。格式错误进 errors（该条目丢弃），可疑但可降级的进
 * warnings（standard 之外的字段在标准层是「忽略」，在 kova 层是「未知字段」）。
 * 复用于设置页保存的草稿校验（source 传空串，错误文案不带文件前缀）。
 */
function parseEntry(
  name: string,
  raw: unknown,
  opts: {
    layer: "system" | "workspace" | "plugin";
    source: string;
    standard: boolean;
    pluginId?: string;
    pluginRoot?: string;
    manifestKind?: PluginManifestKind;
  },
  errors: string[],
  warnings: string[],
): McpServerDef | null {
  const label = `[${name}]`;
  if (!NAME_RE.test(name)) {
    errors.push(`${label}: 名称需匹配 [a-zA-Z0-9_-]{1,64}`);
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`${label}: 必须是对象`);
    return null;
  }
  const r = raw as RawEntry;
  const transport = transportOf(r, label, errors);
  if (!transport) return null;

  const isPlugin = opts.layer === "plugin";
  const codexLike = isPlugin && isCodexPluginKind(opts.manifestKind);
  const def: McpServerDef = {
    name,
    transport,
    layer: opts.layer,
    source: opts.source,
    ...(opts.pluginId ? { pluginId: opts.pluginId } : {}),
    ...(isPlugin && opts.pluginRoot
      ? {
          pluginRoot: opts.pluginRoot,
          ...(opts.pluginId && codexLike
            ? { pluginDataRoot: pluginDataRootFor(opts.pluginId) }
            : {}),
        }
      : {}),
  };

  if (transport === "stdio") {
    if (r.url !== undefined || r.headers !== undefined) {
      errors.push(`${label}: stdio 服务器不能设置 url/headers`);
      return null;
    }
    const command = String(r.command ?? "").trim();
    if (!command) {
      errors.push(`${label}: stdio 服务器需要 command`);
      return null;
    }
    if (command.includes("..")) {
      errors.push(`${label}: command 不能包含 ".."`);
      return null;
    }
    if (byteLen(command) > MAX_VALUE_BYTES) {
      errors.push(`${label}: command 超过 ${MAX_VALUE_BYTES} 字节`);
      return null;
    }
    def.command = command;
    if (r.args !== undefined) {
      if (!Array.isArray(r.args) || r.args.some((a) => typeof a !== "string")) {
        errors.push(`${label}: args 必须是字符串数组`);
        return null;
      }
      if (r.args.length > 64) {
        errors.push(`${label}: args 超过 64 项`);
        return null;
      }
      def.args = r.args as string[];
    }
    const env = stringMap(r.env, ENV_KEY_RE, `${label} env`, 64, errors);
    if (env) def.env = env;
  } else {
    if (r.command !== undefined || r.args !== undefined || r.env !== undefined) {
      errors.push(`${label}: http 服务器不能设置 command/args/env`);
      return null;
    }
    const url = String(r.url ?? "").trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      errors.push(`${label}: url 不是合法绝对地址`);
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push(`${label}: url 仅支持 http/https`);
      return null;
    }
    def.url = url;
    let headers = stringMap(r.headers, HEADER_KEY_RE, `${label} headers`, 32, errors);
    // Codex 的 HTTP header 字段叫 http_headers；显式 headers 优先，两者合并。
    if (codexLike && r.http_headers !== undefined) {
      const codexHeaders = stringMap(
        r.http_headers,
        HEADER_KEY_RE,
        `${label} http_headers`,
        32,
        errors,
      );
      if (codexHeaders) headers = { ...codexHeaders, ...(headers ?? {}) };
    }
    if (headers && Object.keys(headers).length > 0) def.headers = headers;
  }

  if (typeof r.description === "string" && r.description.trim()) {
    if (byteLen(r.description) > MAX_VALUE_BYTES) warnings.push(`${label}: description 过长已忽略`);
    else def.description = r.description.trim();
  }

  // kova 专属字段（标准层一律忽略：警告后不赋值）。与纯补丁条目共用同一份实现
  applyKovaFields(def, r, label, opts.standard, warnings);
  // Codex 字段只对 Codex / Agent Plugins 生效；Claude/Kova 插件的 MCP 行为保持原样
  if (codexLike) {
    applyCodexPluginFields(def, r, label, warnings);
    // Codex 插件 MCP 默认以插件根为进程 cwd（相对脚本/资源按此解析）
    if (def.transport === "stdio" && def.pluginRoot && def.cwd === undefined) {
      def.cwd = def.pluginRoot;
    }
  }

  for (const key of Object.keys(r)) {
    const known =
      STANDARD_FIELDS.has(key) ||
      ["description", "lifecycle", "idleTimeout", "callTimeout", "approveTools"].includes(key) ||
      (codexLike && CODEX_PLUGIN_FIELDS.has(key));
    if (!known) warnings.push(`${label}: 忽略未知字段 "${key}"`);
  }
  return def;
}

type LayerParse = {
  defs: McpServerDef[];
  diagnostics: string[];
};

/**
 * kova 专属字段：标准层 `.mcp.json` 不认（见 STANDARD_FIELDS 的注释）。
 * `description` 不在此列——它在标准层也生效，所以不构成「这是补丁条目」的信号。
 */
const KOVA_ONLY_FIELDS = [
  "lifecycle",
  "idleTimeout",
  "callTimeout",
  "approveTools",
  "enabledTools",
  "expose",
  /** Connector 目录身份（M1.4）：只在系统/覆盖层生效，标准层一律忽略 */
  "connectorId",
] as const;

/**
 * 这条 raw 是不是「纯补丁条目」：非标准层、不带任何标准字段、且至少带一个
 * kova 专属字段。
 *
 * 标准层（`.mcp.json`）不走这条：那是生态共享格式，条目缺 command/url 就是
 * 写错了，静默当成补丁会让一个坏文件看起来生效了。插件层虽然也是非标准层，
 * 但它同样要自带完整定义（插件市场贡献的是服务器本身，不是对别人的补丁）。
 */
function isKovaPatchEntry(raw: unknown, standard: boolean): boolean {
  if (standard) return false;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  const hasStandard = ["command", "args", "env", "url", "headers", "type"].some(
    (k) => r[k] !== undefined,
  );
  if (hasStandard) return false;
  return KOVA_ONLY_FIELDS.some((k) => r[k] !== undefined);
}

/**
 * 解析纯补丁条目。transport 留空（`""`）标记「从低层继承」——mergeEntry 见
 * 到空 transport 会保留低层的 transport 与全部标准字段，只叠加上层显式给出的
 * 字段。低层没有同名条目时这条无处可继承，由合并阶段报诊断。
 *
 * 字段的取用与校验全部委托 `applyKovaFields`，与 parseEntry 同一份实现——
 * 两处各写一遍 inevitably 会漂，而漂的方向是某个字段在补丁里被静默忽略。
 */
function parseKovaPatchEntry(
  name: string,
  raw: unknown,
  opts: { layer: "system" | "workspace" | "plugin"; source: string; pluginId?: string },
  warnings: string[],
): McpServerDef | null {
  const label = `[${name}]`;
  if (!NAME_RE.test(name)) {
    warnings.push(`${label}: 名称需匹配 [a-zA-Z0-9_-]{1,64}`);
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`${label}: 必须是对象`);
    return null;
  }
  const def: McpServerDef = {
    name,
    transport: "" as unknown as McpServerDef["transport"],
    layer: opts.layer,
    source: opts.source,
    ...(opts.pluginId ? { pluginId: opts.pluginId } : {}),
  };
  applyKovaFields(def, raw as RawEntry, label, false, warnings);
  return def;
}

/**
 * kova 专属字段（description/lifecycle/idleTimeout/callTimeout/approveTools）
 * 的取用与校验。两个解析路径共用：完整条目与纯补丁条目对同一字段必须给出
 * 同样的判定，否则「在覆盖层里改不动」会变成一类查不出来的怪问题。
 */
function applyKovaFields(
  def: McpServerDef,
  r: RawEntry,
  label: string,
  standard: boolean,
  warnings: string[],
): void {
  const extra = (key: string): unknown => {
    if (r[key] === undefined) return undefined;
    if (standard) {
      warnings.push(`${label}: 标准层忽略 kova 专属字段 "${key}"`);
      return undefined;
    }
    return r[key];
  };
  const description = extra("description");
  if (typeof description === "string" && description.trim()) {
    def.description = description.trim();
  }
  const lifecycle = extra("lifecycle");
  if (typeof lifecycle === "string" && ["lazy", "eager", "keep-alive"].includes(lifecycle)) {
    def.lifecycle = lifecycle as McpServerDef["lifecycle"];
  } else if (lifecycle !== undefined) {
    warnings.push(`${label}: 忽略非法 lifecycle "${String(lifecycle)}"`);
  }
  const idleTimeout = extra("idleTimeout");
  if (typeof idleTimeout === "number" && Number.isFinite(idleTimeout) && idleTimeout >= 5_000) {
    def.idleTimeout = Math.floor(idleTimeout);
  } else if (idleTimeout !== undefined) {
    warnings.push(`${label}: 忽略非法 idleTimeout（需 ≥5000 的毫秒数）`);
  }
  const callTimeout = extra("callTimeout");
  if (typeof callTimeout === "number" && Number.isFinite(callTimeout) && callTimeout >= 5_000) {
    def.callTimeout = Math.floor(callTimeout);
  } else if (callTimeout !== undefined) {
    warnings.push(`${label}: 忽略非法 callTimeout（需 ≥5000 的毫秒数）`);
  }
  const approve = extra("approveTools");
  if (Array.isArray(approve) && approve.every((g) => typeof g === "string" && g.trim())) {
    // 条数封顶：这份列表可能来自仓库里的文件，而每次判定都要按 glob 编正则；
    // 畸形的长列表不该把工具调用拖成开销（同 write-roots 的 MAX_ROOTS）
    def.approveTools = (approve as string[]).map((g) => g.trim()).slice(0, MAX_APPROVE_TOOLS);
    if ((approve as unknown[]).length > MAX_APPROVE_TOOLS) {
      warnings.push(`${label}: approveTools 超出 ${MAX_APPROVE_TOOLS} 条，多余的已忽略`);
    }
  } else if (approve === true) {
    def.approveTools = ["*"];
  } else if (approve !== undefined) {
    warnings.push(`${label}: 忽略非法 approveTools（需 glob 字符串数组）`);
  }
  const connectorId = extra("connectorId");
  if (typeof connectorId === "string" && connectorId.trim()) {
    def.connectorId = connectorId.trim().slice(0, 64);
  } else if (connectorId !== undefined) {
    warnings.push(`${label}: 忽略非法 connectorId（需非空字符串）`);
  }
  const enabled = extra("enabledTools");
  if (Array.isArray(enabled) && enabled.every((g) => typeof g === "string" && g.trim())) {
    def.enabledTools = (enabled as string[]).map((g) => g.trim()).slice(0, MAX_APPROVE_TOOLS);
    if ((enabled as unknown[]).length > MAX_APPROVE_TOOLS) {
      warnings.push(`${label}: enabledTools 超出 ${MAX_APPROVE_TOOLS} 条，多余的已忽略`);
    }
  } else if (enabled !== undefined) {
    warnings.push(`${label}: 忽略非法 enabledTools（需 glob 字符串数组）`);
  }
  const expose = extra("expose");
  if (expose === "gateway" || expose === "direct") {
    def.expose = expose;
  } else if (expose !== undefined) {
    warnings.push(`${label}: 忽略非法 expose "${String(expose)}"（gateway|direct）`);
  }
}

/** 单份配置里 approveTools 的条数上限（判定时逐条编 glob 正则，必须有界） */
const MAX_APPROVE_TOOLS = 64;

function fileSignature(path: string): string {
  try {
    const st = statSync(path);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return "";
  }
}

/** 插件层上下文：占位符展开用（仅 plugin 层有；用户/系统层配置保持字面量） */
export type PluginLayerCtx = {
  pluginId: string;
  /** 插件根目录（绝对）—— `${PLUGIN_ROOT}` 的展开值；缺省时不展开该占位符 */
  root?: string;
  /** 清单类型：只有 Codex / Agent Plugins 启用 Codex 字段与插件根默认 cwd */
  manifestKind?: PluginManifestKind;
  /** 会话工作区（loadSync 收到的 cwd）—— `${WORKSPACE}` 的展开值 */
  workspace?: string;
};

/** Codex 语义只对 Codex / Agent Plugins 生效；Claude/Kova 保持原有 MCP 行为 */
function isCodexPluginKind(kind: PluginManifestKind | undefined): boolean {
  return kind === "codex" || kind === "agent";
}

/**
 * 插件层 stdio 条目占位符展开（command / args / env 的字符串值）：
 * - `${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` → 插件根绝对路径（插件自带的 server
 *   脚本由此定位；后者是 Claude 生态 hooks.json 的写法，作同义别名同等对待）
 * - `${WORKSPACE}`   → 会话工作区（MCP server 据此解析工作区相对路径）
 * - `${BUN}`         → 应用内置 JS/TS 运行时（process.execPath）；命中时自动补
 *   `BUN_BE_BUN=1`——编译态 sidecar 二进制由此充当完整 bun CLI（真实 bun 上该
 *   变量无副作用），插件因而无需用户机器预装 node/bun。
 * 展开只在插件层发生：用户/系统层配置里的同名写法保持字面量，语义不意外。
 *
 * 实现已移至 plugins/expand（与插件 hooks 命令串共用，且避免 mcp-config ↔
 * plugins/store 循环依赖）；此处保留转发，既有导入路径不变。
 */
export { expandPluginValue };

/** 就地展开一个插件层 stdio 定义；缺展开值的占位符保留原样并记诊断 */
function expandPluginDef(def: McpServerDef, ctx: PluginLayerCtx, diagnostics: string[]): void {
  if (def.transport !== "stdio") return;
  const missing = new Set<string>();
  let usedBun = false;
  const expandCtx = {
    root: ctx.root,
    ...(def.pluginDataRoot ? { dataRoot: def.pluginDataRoot } : {}),
    ...(ctx.workspace ? { workspace: ctx.workspace } : {}),
  };
  const apply = (v: string): string => {
    const r = expandPluginValue(v, expandCtx);
    for (const m of r.missing) missing.add(m);
    if (r.usedBun) usedBun = true;
    return r.value;
  };
  if (def.command !== undefined) def.command = apply(def.command);
  if (def.args) def.args = def.args.map(apply);
  if (def.cwd !== undefined) def.cwd = apply(def.cwd);
  if (def.env) {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(def.env)) next[k] = apply(v);
    def.env = next;
  }
  if (usedBun) def.env = { ...(def.env ?? {}), BUN_BE_BUN: "1" };
  for (const m of missing) {
    diagnostics.push(
      `[${def.name}] 占位符 ${m} 无展开值（工作区未就绪或插件根缺失），保持原样`,
    );
  }
}

function parseLayer(
  path: string,
  layer: "system" | "workspace" | "plugin",
  standard: boolean,
  plugin?: PluginLayerCtx,
): LayerParse {
  const diagnostics: string[] = [];
  if (!existsSync(path)) return { defs: [], diagnostics };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    diagnostics.push(`${path}: 解析失败（${err instanceof Error ? err.message : String(err)}）`);
    return { defs: [], diagnostics };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    diagnostics.push(`${path}: 顶层必须是对象`);
    return { defs: [], diagnostics };
  }
  const rootDoc = doc as Record<string, unknown>;
  let servers = rootDoc.mcpServers;
  // Codex 插件 MCP 文件还接受「裸 server map」形状（{"srv": {...}}）。
  // 仅 Codex/Agent 插件层启用；工作区/系统/Claude/Kova 层仍要求 mcpServers 包装，
  // 避免把配置顶层键误当服务器。
  if (
    servers === undefined &&
    layer === "plugin" &&
    isCodexPluginKind(plugin?.manifestKind)
  ) {
    const keys = Object.keys(rootDoc);
    if (keys.length > 0 && !keys.includes("$schema")) servers = rootDoc;
  }
  if (servers === undefined) return { defs: [], diagnostics };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    diagnostics.push(`${path}: mcpServers 必须是键值对象`);
    return { defs: [], diagnostics };
  }
  const defs: McpServerDef[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let names = Object.keys(servers as Record<string, unknown>);
  if (names.length > MAX_PER_FILE) {
    diagnostics.push(`${path}: 条目超过 ${MAX_PER_FILE}，超出部分丢弃`);
    names = names.slice(0, MAX_PER_FILE);
  }
  for (const name of names) {
    if (seen.has(name)) {
      warnings.push(`${path}: [${name}] 同文件内重名，丢弃后者`);
      continue;
    }
    seen.add(name);
    const raw = (servers as Record<string, unknown>)[name];
    // 非标准层的「纯补丁条目」：只带 kova 专属字段（approveTools/lifecycle…），
    // 不带 command/url。存在的意义就是给低层同名条目补字段——要求重抄 command
    // 会让「只想加一条 approveTools」这件事变成一次复制粘贴，而复制的那份
    // command 迟早与插件实际使用的脱节（插件升级换路径就静默失效）。
    // transport 留空由 mergeEntry 从低层继承；低层也没有同名条目时报错，
    // 不产出一条无 transport 的悬空定义。
    const def = isKovaPatchEntry(raw, standard)
      ? parseKovaPatchEntry(
          name,
          raw,
          { layer, source: path, ...(plugin ? { pluginId: plugin.pluginId } : {}) },
          warnings,
        )
      : parseEntry(
          name,
          raw,
          {
            layer,
            source: path,
            standard,
            ...(plugin
              ? {
                  pluginId: plugin.pluginId,
                  pluginRoot: plugin.root,
                  manifestKind: plugin.manifestKind,
                }
              : {}),
          },
          errors,
          warnings,
        );
    if (def) {
      if (layer === "plugin" && plugin) expandPluginDef(def, plugin, diagnostics);
      defs.push(def);
    }
  }
  for (const e of errors) diagnostics.push(`${path}: ${e}`);
  for (const w of warnings) diagnostics.push(`${path}: ${w}`);
  return { defs, diagnostics };
}

/** 解析 manifest 内联 mcpServers 对象（Codex 插件清单的另一种形状） */
export function parseInlineMcpServers(
  inline: Record<string, unknown>,
  plugin: PluginLayerCtx,
): LayerParse {
  const source = `${plugin.root ?? "<plugin>"}/.codex-plugin/plugin.json#mcpServers`;
  const diagnostics: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const defs: McpServerDef[] = [];
  const allNames = Object.keys(inline);
  if (allNames.length > MAX_PER_FILE) {
    diagnostics.push(`${source}: 条目超过 ${MAX_PER_FILE}，超出部分丢弃`);
  }
  for (const name of allNames.slice(0, MAX_PER_FILE)) {
    const def = parseEntry(
      name,
      inline[name],
      {
        layer: "plugin",
        source,
        standard: true,
        pluginId: plugin.pluginId,
        ...(plugin.root ? { pluginRoot: plugin.root } : {}),
        ...(plugin.manifestKind ? { manifestKind: plugin.manifestKind } : {}),
      },
      errors,
      warnings,
    );
    if (def) {
      expandPluginDef(def, plugin, diagnostics);
      defs.push(def);
    }
  }
  for (const e of errors) diagnostics.push(`${source}: ${e}`);
  for (const w of warnings) diagnostics.push(`${source}: ${w}`);
  return { defs, diagnostics };
}

// ---------------------------------------------------------------------------
// 合并（字段级，URL 变更丢认证）
// ---------------------------------------------------------------------------

/** URL 变更时不得从低层继承的认证材料 */
const URL_BOUND_FIELDS = ["headers"] as const;

function mergeEntry(base: McpServerDef, next: McpServerDef): McpServerDef {
  const merged: McpServerDef = { ...base, ...next };
  // 纯补丁条目（覆盖层只补 kova 字段、不重抄 command）：空 transport 是「从低层
  // 继承」的标记。补丁条目压根不带 command/args/env/url/headers 这些键，
  // 展开时低层的值原样留下——**不需要**（也不能）在这里 delete 任何标准字段。
  // 这里必须早于下面的换型判断：空串与低层 transport 必然「不同」，
  // 若不先返回，换型分支会把低层的 command/args/env 全删掉，正好把补丁反做掉
  if ((next.transport as string) === "") {
    // 补丁条目没有自己的运行时定义，但**层语义仍跟补丁所在层走**：
    // 工作区文件里的 approveTools 只能算「项目请求」，不能借底层是系统/插件
    // 服务器就继承系统层的免审批效力。代价是该服务器会按工作区来源默认关闭，
    // 需用户在本机显式启用——这正是"仓库文件只能提议、不能授权"的边界。
    merged.transport = base.transport;
    return merged;
  }
  // 插件定义只是「默认供给」：用户/系统的完整定义同名接管时，不能把插件的
  // pluginRoot/pluginId/注入 env 带进用户服务器（否则插件能改用户配置的解析根）。
  // 接管即整条替换；需要微调插件的用户应显式重写 command/args。
  if (base.pluginId && !next.pluginId) {
    return { ...next };
  }
  // transport 换型：低层字段全部不继承（stdio/env 与 http/headers 是不同世界）
  if (base.transport !== next.transport) {
    if (next.transport === "stdio") {
      delete merged.url;
      delete merged.headers;
    } else {
      delete merged.command;
      delete merged.args;
      delete merged.env;
    }
    return merged;
  }
  if (next.transport === "http" && base.url && next.url && base.url !== next.url) {
    // 指向被改：认证材料（headers）只认新层显式给出的值
    for (const field of URL_BOUND_FIELDS) {
      merged[field] = next[field];
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 启用开关（kv 整包，键规则同 subagents）
// ---------------------------------------------------------------------------

/**
 * 启用开关的本机状态（kv 整包，键规则同 subagents）。
 *
 * 两个映射而不是一个 `disabled`：**工作区来源的服务器默认关闭**——`.mcp.json` /
 * `.kova/mcp.json` 跟着仓库走，clone 一个别人的项目不该让那个仓库决定"本机跑什么
 * 进程"（服务器命令在首次调用时就会被拉起，早于任何审批）。默认关闭 + 显式启用
 * = 唯一能授权的状态在你自己机器上，与可写根清单的纪律同一套。
 * `enabled` 记的就是那个显式启用（也是"这台机器上我认过这个服务器"的唯一凭据）。
 */
export type McpEnabledState = {
  disabled: Record<string, true>;
  enabled: Record<string, true>;
};

export const MCP_ENABLED_KV_KEY = "pi.mcp";

let enabledState: McpEnabledState = { disabled: {}, enabled: {} };
let enabledLoad: Promise<void> | undefined;

export function mcpStateKey(
  layer: "system" | "workspace" | "plugin",
  name: string,
  cwd?: string,
  pluginId?: string,
): string {
  if (layer === "plugin") return `plugin:${pluginId ?? ""}::${name}`;
  return layer === "workspace" ? `workspace:${cwd ?? ""}::${name}` : `system:${name}`;
}

/**
 * 该服务器在本机是否启用：显式禁用 > 显式启用 > 层默认。
 * 层默认：系统层（`~/.kova/mcp.json`）与插件层默认开——那是你自己装的；
 * 工作区层默认关——那是仓库里的文件。
 */
function isEnabledByState(
  layer: "system" | "workspace" | "plugin",
  name: string,
  cwd?: string,
  pluginId?: string,
): boolean {
  const key = mcpStateKey(layer, name, cwd, pluginId);
  if (enabledState.disabled[key] === true) return false;
  if (enabledState.enabled[key] === true) return true;
  return layer !== "workspace";
}

/** 启动装配调一次（index.ts 闸门内）；幂等 */
export function initMcpEnabledState(): Promise<void> {
  enabledLoad ??= (async () => {
    try {
      const row = await kvGet(MCP_ENABLED_KV_KEY);
      if (row?.value) {
        const parsed = JSON.parse(row.value) as Partial<McpEnabledState>;
        // 旧载荷只有 disabled（工作区条目当时默认开）：照读，缺的 enabled 视作空集
        enabledState = {
          disabled: (parsed.disabled ?? {}) as Record<string, true>,
          enabled: (parsed.enabled ?? {}) as Record<string, true>,
        };
      }
    } catch (err) {
      logErr("mcp-state:", err instanceof Error ? err.message : String(err));
    }
    // 历史键迁移：workspace:<附加目录> → workspace:<项目主目录>
    if (migrateWorkspaceEnabledKeys()) await persistEnabledState();
  })();
  return enabledLoad;
}

/** 历史工作区启用键迁移；主目录已有同名键时以主目录为准 */
function migrateWorkspaceEnabledKeys(): boolean {
  let changed = false;
  const migrate = (map: Record<string, true>) => {
    for (const key of Object.keys(map)) {
      if (!key.startsWith("workspace:")) continue;
      const sep = key.indexOf("::");
      if (sep < 0) continue;
      const cwd = key.slice("workspace:".length, sep);
      const target = configCwdFor(cwd);
      if (!target || target === cwd) continue;
      const next = `workspace:${target}::${key.slice(sep + 2)}`;
      if (!(next in map)) map[next] = true;
      delete map[key];
      changed = true;
    }
  };
  migrate(enabledState.disabled);
  migrate(enabledState.enabled);
  return changed;
}

async function persistEnabledState(): Promise<void> {
  try {
    await kvSet(MCP_ENABLED_KV_KEY, JSON.stringify(enabledState));
  } catch (err) {
    logErr("mcp-state save:", err instanceof Error ? err.message : String(err));
  }
}

export async function setMcpServerEnabled(
  layer: "system" | "workspace" | "plugin",
  name: string,
  enabled: boolean,
  cwd?: string,
  pluginId?: string,
): Promise<void> {
  await initMcpEnabledState();
  const key = mcpStateKey(layer, name, cwd, pluginId);
  // 两侧都写：留下的那条就是用户的显式决定，另一条要删掉——否则
  // "先禁用再启用"会被旧的 disabled 记录压住（反之亦然）
  if (enabled) {
    enabledState.enabled[key] = true;
    delete enabledState.disabled[key];
  } else {
    enabledState.disabled[key] = true;
    delete enabledState.enabled[key];
  }
  await persistEnabledState();
  loadCache.clear();
}

/** 测试钩子：清掉 kv 装载与文件签名缓存 */
export function resetMcpConfigForTest(): void {
  enabledState = { disabled: {}, enabled: {} };
  enabledLoad = undefined;
  loadCache.clear();
}

// ---------------------------------------------------------------------------
// 三层加载（签名缓存）
// ---------------------------------------------------------------------------

export type McpLoadResult = {
  /** 合并后的全部定义（含被禁用的；enabledBy 单独给） */
  defs: McpServerDef[];
  /** name -> 是否启用（禁用 = kv 显式关闭） */
  enabledBy: Map<McpServerName, boolean>;
  diagnostics: string[];
};

const loadCache = new Map<string, { sig: string; result: McpLoadResult }>();

function loadSync(cwd: string | undefined, extraDirs: readonly string[] = []): McpLoadResult {
  const systemPath = systemMcpConfigPath();
  const stdPath = cwd ? workspaceStandardMcpPath(cwd) : "";
  const ovrPath = cwd ? workspaceOverrideMcpPath(cwd) : "";
  // 历史兼容：项目附加目录的 .mcp.json / .kova/mcp.json 作为低优先级只读层
  const extraPaths = extraDirs
    .filter((dir) => dir && dir !== cwd)
    .map((dir) => ({
      dir,
      std: workspaceStandardMcpPath(dir),
      ovr: workspaceOverrideMcpPath(dir),
    }));
  // 插件层签名：启用插件集合 + 各自文件签名（安装/卸载/开关立即失效缓存）
  const pluginSources = activePlugins()
    .map((p) => ({
      pluginId: p.pluginId,
      root: p.manifest.root,
      manifestKind: p.manifest.manifestKind,
      files: resolvePluginComponents(p.manifest, "mcpServers").filter((file) => existsSync(file)),
      inline: p.manifest.components.mcpServersInline,
      config: p.manifest.config,
    }))
    .filter((p) => p.files.length > 0 || p.inline !== undefined);
  const sig = [
    fileSignature(systemPath),
    cwd ? fileSignature(stdPath) : "",
    cwd ? fileSignature(ovrPath) : "",
    ...extraPaths.flatMap((e) => [fileSignature(e.std), fileSignature(e.ovr)]),
    pluginSources
      .map(
        (p) =>
          `${p.pluginId}=${p.files.map((file) => fileSignature(file)).join(",")}|${p.inline ? JSON.stringify(p.inline) : ""}`,
      )
      .join("|"),
    `v${currentPluginsStateVersion()}`,
  ].join("|");
  const cached = loadCache.get(cwd ?? "");
  if (cached && cached.sig === sig) return cached.result;

  const system = parseLayer(systemPath, "system", false);
  const standard = cwd
    ? parseLayer(stdPath, "workspace", true)
    : { defs: [], diagnostics: [] };
  const override = cwd
    ? parseLayer(ovrPath, "workspace", false)
    : { defs: [], diagnostics: [] };
  const extraLayers = extraPaths.map((entry) => ({
    standard: parseLayer(entry.std, "workspace", true),
    override: parseLayer(entry.ovr, "workspace", false),
    dir: entry.dir,
  }));
  const diagnostics = [
    ...system.diagnostics,
    ...extraLayers.flatMap((entry) => [
      ...entry.standard.diagnostics.map((d) => `[附加目录 ${entry.dir}] ${d}`),
      ...entry.override.diagnostics.map((d) => `[附加目录 ${entry.dir}] ${d}`),
    ]),
    ...standard.diagnostics,
    ...override.diagnostics,
  ];

  // 插件层（垫底，只读）：standard=true——插件只认标准字段，kova 专属字段
  // （approveTools 等）不可由插件携带；同名先到先得（pluginId 排序保证确定性）
  const pluginDefs: McpServerDef[] = [];
  const seenPluginNames = new Set<string>();
  for (const p of pluginSources) {
    const ctx = {
      pluginId: p.pluginId,
      root: p.root,
      manifestKind: p.manifestKind,
      workspace: cwd,
    };
    const parsedList = p.files.map((file) => parseLayer(file, "plugin", true, ctx));
    if (p.inline) parsedList.push(parseInlineMcpServers(p.inline, ctx));
    for (const parsed of parsedList) {
      diagnostics.push(...parsed.diagnostics.map((d) => `[plugin ${p.pluginId}] ${d}`));
      for (const def of parsed.defs) {
        if (seenPluginNames.has(def.name)) {
          diagnostics.push(`[plugin ${p.pluginId}] [${def.name}] 与其他插件服务器重名，忽略本条`);
          continue;
        }
        seenPluginNames.add(def.name);
        // 装后配置注入：非敏感值 → stdio 并入 def.env / http 并入 def.headers
        // （secret 不经 def，走绑定通道在握手时解密注入）
        applyPluginConfigEnv(p.config, p.pluginId, def);
        pluginDefs.push(def);
      }
    }
  }

  // 合并顺序：插件（默认供给）→ 系统 → 附加目录 → 主目录标准 → 主目录覆盖。
  // 后者字段级覆盖前者：用户自己的系统/工作区配置天然压过插件，插件不能靠
  // 重名把用户服务器的 command/args/cwd 顶掉，也不能把默认关闭的工作区服务器
  // 借 plugin 层重新启用（enabledBy 跟最终提供者层走）。
  const extraWorkspaceDefs = extraLayers.flatMap((entry) => [
    ...entry.standard.defs,
    ...entry.override.defs,
  ]);
  const byName = new Map<McpServerName, McpServerDef>();
  for (const def of [
    ...pluginDefs,
    ...system.defs,
    ...extraWorkspaceDefs,
    ...standard.defs,
    ...override.defs,
  ]) {
    const base = byName.get(def.name);
    if (!base) {
      // 补丁条目没有低层可继承：留着它会得到一条 transport 为空的定义，
      // 而它既连不上也不报错——只是让设置页多出一个点不动的条目。报诊断丢弃
      if (def.transport === ("") as unknown as McpServerDef["transport"]) {
        diagnostics.push(
          `${def.source}: [${def.name}] 只声明了 kova 专属字段（approveTools/lifecycle 等），` +
            `但没有任何一层定义过这个服务器——补丁必须有可继承的底子`,
        );
        continue;
      }
      byName.set(def.name, { ...def });
      continue;
    }
    // 插件条目被用户配置整条接管：明确告知，避免"装了插件却还是旧服务器"的困惑
    if (base.pluginId && !def.pluginId && (def.transport as string) !== "") {
      diagnostics.push(
        `[plugin ${base.pluginId}] [${def.name}] 与 ${def.layer} 层同名服务器冲突，已保留非插件配置，插件条目未生效`,
      );
    }
    byName.set(def.name, mergeEntry(base, def));
  }
  // 合并优先级是插件垫底（用户配置才能接管），但列表展示顺序保持原来的
  // 系统 → 附加 → 标准 → 覆盖 → 插件，避免设置页条目顺序因安全修复而跳动。
  const orderedDefs: McpServerDef[] = [];
  const emitted = new Set<McpServerName>();
  for (const def of [
    ...system.defs,
    ...extraWorkspaceDefs,
    ...standard.defs,
    ...override.defs,
    ...pluginDefs,
  ]) {
    if (emitted.has(def.name)) continue;
    const mergedDef = byName.get(def.name);
    if (!mergedDef) continue;
    emitted.add(def.name);
    orderedDefs.push(mergedDef);
  }
  // 兜底：后续新增来源时也不漏条目
  for (const [name, def] of byName) {
    if (emitted.has(name)) continue;
    emitted.add(name);
    orderedDefs.push(def);
  }
  // 层语义跟最终提供者走；标准层条目保留 fromStandard 标记（设置页据此降级删除入口）
  const standardSources = new Set([
    ...(stdPath ? [stdPath] : []),
    ...extraPaths.map((entry) => entry.std),
  ]);
  for (const def of orderedDefs) {
    def.fromStandard =
      def.layer === "workspace" && cwd && standardSources.has(def.source)
        ? true
        : undefined;
  }

  const enabledBy = new Map<McpServerName, boolean>();
  for (const def of orderedDefs) {
    enabledBy.set(
      def.name,
      !def.manifestDisabled &&
        isEnabledByState(
          def.layer,
          def.name,
          def.layer === "workspace" ? cwd : undefined,
          def.pluginId,
        ),
    );
  }

  const result: McpLoadResult = { defs: orderedDefs, enabledBy, diagnostics };
  loadCache.set(cwd ?? "", { sig, result });
  return result;
}

/** 设置页清单：全部定义 + 启用态（协议消息与网关工具共用）。
 *  cwd 属于项目时收敛到项目主目录：MCP 配置是项目级，附加目录只做代码上下文。 */
export async function loadMcpServers(cwd?: string | null): Promise<McpLoadResult> {
  await initMcpEnabledState();
  await initPluginConfig();
  const scoped = cwd?.trim() ? configCwdFor(cwd.trim()) : undefined;
  const extraDirs = scoped ? projectExtraDirs(scoped) : [];
  return loadSync(scoped, extraDirs);
}

/**
 * 同步加载：假定 initMcpEnabledState 已完成（index.ts 启动闸门内调用过）。
 * 供系统提示词组合（composeModeSystemPrompt 是同步链）等无法 await 的路径使用；
 * kv 未初始化的极早期调用会按全启用处理，与"默认开启"语义一致。
 */
export function loadMcpServersSync(cwd?: string | null): McpLoadResult {
  const scoped = cwd?.trim() ? configCwdFor(cwd.trim()) : undefined;
  const extraDirs = scoped ? projectExtraDirs(scoped) : [];
  return loadSync(scoped, extraDirs);
}

/**
 * 工具表是否应该包含 MCP 网关：没有任何启用服务器时不下发（否则模型会先白调
 * 一次才拿到空清单）。buildTools 与 MCP 变更后的条件重建共用同一口径。
 */
export function hasEnabledMcpServersSync(cwd?: string | null): boolean {
  const { defs, enabledBy } = loadMcpServersSync(cwd);
  return defs.some((def) => enabledBy.get(def.name) === true);
}

/** 网关工具用：当前生效（启用）的定义集合 */
export async function activeMcpServers(cwd?: string | null): Promise<McpServerDef[]> {
  const { defs, enabledBy } = await loadMcpServers(cwd);
  return defs.filter((def) => enabledBy.get(def.name) === true);
}

// ---------------------------------------------------------------------------
// 写路径（设置页 → 系统文件 / 工作区覆盖文件）
// ---------------------------------------------------------------------------

export type McpDraft = {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  lifecycle?: "lazy" | "eager" | "keep-alive";
  idleTimeout?: number;
  callTimeout?: number;
  approveTools?: string[];
  enabledTools?: string[];
  expose?: "gateway" | "direct";
  connectorId?: string;
};

/** 草稿校验：复用条目解析（source 为空串，错误文案不带文件前缀）；返回错误列表 */
export function validateMcpDraft(draft: McpDraft): string[] {
  const errors: string[] = [];
  const warnings: string[] = [];
  parseEntry(
    draft.name,
    draft as unknown as RawEntry,
    { layer: "system", source: "", standard: false },
    errors,
    warnings,
  );
  return errors;
}

function readJsonDoc(path: string): Record<string, RawEntry> {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (doc && typeof doc === "object" && !Array.isArray(doc)) {
      return doc as Record<string, RawEntry>;
    }
  } catch {
    /* 新文件/坏文件：按空对象重建 */
  }
  return {};
}

/** 写盘条目：与加载解析对齐的形状（type 字段显式标注 transport） */
function emitEntry(draft: McpDraft): RawEntry {
  const entry: RawEntry = { type: draft.transport };
  if (draft.transport === "stdio") {
    entry.command = draft.command;
    if (draft.args?.length) entry.args = draft.args;
    if (draft.env && Object.keys(draft.env).length > 0) entry.env = draft.env;
  } else {
    entry.url = draft.url;
    if (draft.headers && Object.keys(draft.headers).length > 0) entry.headers = draft.headers;
  }
  if (draft.description?.trim()) entry.description = draft.description.trim();
  if (draft.lifecycle) entry.lifecycle = draft.lifecycle;
  if (draft.idleTimeout !== undefined) entry.idleTimeout = draft.idleTimeout;
  if (draft.callTimeout !== undefined) entry.callTimeout = draft.callTimeout;
  if (draft.approveTools?.length) entry.approveTools = draft.approveTools;
  if (draft.enabledTools?.length) entry.enabledTools = draft.enabledTools;
  if (draft.expose) entry.expose = draft.expose;
  if (draft.connectorId?.trim()) entry.connectorId = draft.connectorId.trim();
  return entry;
}

export type McpWriteOptions = {
  /** workspace 层必填 */
  cwd?: string;
  /** 测试注入：覆盖系统文件路径 */
  systemPath?: string;
  /** 编辑时改名：旧名条目一并移除 */
  replaceName?: string;
};

function targetPathFor(
  layer: "system" | "workspace",
  options: McpWriteOptions,
): { path: string; standard?: string } {
  if (layer === "system") {
    return { path: options.systemPath ?? systemMcpConfigPath() };
  }
  const cwd = options.cwd?.trim();
  if (!cwd) throw new Error("workspace 层保存需要工作区目录（cwd）");
  return { path: workspaceOverrideMcpPath(cwd), standard: workspaceStandardMcpPath(cwd) };
}

/** 保存（新增或同名覆盖）到系统/工作区覆盖文件；工作区覆盖层可接管标准层同名条目 */
export async function saveMcpServer(
  layer: "system" | "workspace",
  draft: McpDraft,
  options: McpWriteOptions = {},
): Promise<void> {
  const errors = validateMcpDraft(draft);
  if (errors.length > 0) throw new Error(errors.join("；"));
  const { path } = targetPathFor(layer, options);
  const doc = readJsonDoc(path);
  const servers = (doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)
    ? (doc.mcpServers as Record<string, RawEntry>)
    : (doc.mcpServers = {}));
  const replaceName = options.replaceName?.trim();
  if (replaceName && replaceName !== draft.name) delete servers[replaceName];
  servers[draft.name] = emitEntry(draft);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  loadCache.clear();
}

/** 删除一份定义；只动本层文件（系统文件 / 工作区覆盖文件），从不改写标准层 .mcp.json */
export async function deleteMcpServer(
  layer: "system" | "workspace",
  name: string,
  options: McpWriteOptions = {},
): Promise<void> {
  const { path, standard } = targetPathFor(layer, options);
  const doc = readJsonDoc(path);
  const servers = doc.mcpServers as Record<string, RawEntry> | undefined;
  if (!servers || !(name in servers)) {
    if (standard && existsSync(standard)) {
      throw new Error(
        `"${name}" 来自工作区共享文件 ${standard}，设置页不直接改写它：` +
          `可在覆盖层保存同名条目接管，或手工编辑该文件`,
      );
    }
    throw new Error(`未找到${layer === "system" ? "系统" : "工作区"}服务器 "${name}"`);
  }
  delete servers[name];
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  loadCache.clear();
}

/** 插件 MCP 组件清单（插件详情页用）：解析指定文件并叠加当前开关状态。
 *  url 一并带出：前端拿它与连接器目录比对，把组件行升级为「应用」身份（MiniMax 形态）。 */
export type PluginMcpEntry = {
  name: string;
  transport: "stdio" | "http";
  description?: string;
  url?: string;
  enabled: boolean;
};

/** 插件 MCP 组件清单（全部 MCP 文件 + manifest 内联对象 + 解析诊断） */
export async function listPluginMcpComponents(
  manifest: PluginManifest,
  pluginId: string,
): Promise<{ servers: PluginMcpEntry[]; diagnostics: string[] }> {
  await initMcpEnabledState();
  const ctx = {
    pluginId,
    root: manifest.root,
    manifestKind: manifest.manifestKind,
  };
  const parsedList = resolvePluginComponents(manifest, "mcpServers").map((file) =>
    parseLayer(file, "plugin", true, ctx),
  );
  if (manifest.components.mcpServersInline) {
    parsedList.push(parseInlineMcpServers(manifest.components.mcpServersInline, ctx));
  }
  const seen = new Set<string>();
  const servers: PluginMcpEntry[] = [];
  for (const def of parsedList.flatMap((parsed) => parsed.defs)) {
    if (seen.has(def.name)) continue;
    seen.add(def.name);
    servers.push({
      name: def.name,
      transport: def.transport,
      ...(def.description ? { description: def.description } : {}),
      ...(def.url ? { url: def.url } : {}),
      enabled:
        !def.manifestDisabled &&
        enabledState.disabled[mcpStateKey("plugin", def.name, undefined, pluginId)] !== true,
    });
  }
  return { servers, diagnostics: parsedList.flatMap((parsed) => parsed.diagnostics) };
}

/** 单文件版本（兼容旧调用；新代码用 listPluginMcpComponents 拿完整形状与诊断） */
export async function listPluginMcpEntries(
  file: string,
  pluginId: string,
): Promise<PluginMcpEntry[]> {
  await initMcpEnabledState();
  const parsed = parseLayer(file, "plugin", true, { pluginId });
  return parsed.defs.map((def) => ({
    name: def.name,
    transport: def.transport,
    ...(def.description ? { description: def.description } : {}),
    ...(def.url ? { url: def.url } : {}),
    enabled:
      !def.manifestDisabled &&
      enabledState.disabled[mcpStateKey("plugin", def.name, undefined, pluginId)] !== true,
  }));
}
