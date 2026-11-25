/**
 * 插件清单解析与生态兼容规范化（纯函数，无运行时状态）：
 * 清单三态探测（.kova-plugin / .claude-plugin / .codex-plugin）、组件路径
 * 包含性校验、hooks 文件形状判定与读取。市场/安装的写路径见 marketplaces.ts，
 * 运行时启停与扫描缓存见 store.ts，市场登记表见 registry.ts。
 */
import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { HookConfig, HookEventName } from "../agent/hooks";
import { pluginDepsStatus } from "./plugin-deps";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 清单探测来源：kova 原生，或生态清单规范化而来 */
export type PluginManifestKind = "kova" | "codex" | "claude" | "cursor" | "agent";

/** 可多实例的组件种类（生态清单支持字符串数组：多个 skills/命令目录、多个 hooks 文件） */
export type PluginMultiComponentKind =
  | "skills"
  | "mcpServers"
  | "hooks"
  | "subagents"
  | "commands";

/** 规范化后的组件相对路径（全部经过包含性校验；未声明/非法的不出现） */
export type PluginComponents = {
  skills?: string[];
  mcpServers?: string[];
  /** Codex 清单内联 mcpServers 对象（路径声明之外的另一种形状） */
  mcpServersInline?: Record<string, unknown>;
  hooks?: string[];
  /** Codex 清单内联 hooks（HooksFile 对象或对象数组） */
  hooksInline?: unknown[];
  subagents?: string[];
  /** 自定义命令目录（*.md 提示词模板；形状见 commands/commands.ts） */
  commands?: string[];
  /** UI 面板声明文件（JSON 数组，形状见 readPluginPanelsFile） */
  panels?: string;
  /** Codex apps 声明路径（当前只记诊断，不加载） */
  apps?: string;
};

export type PluginConfigFieldType = "string" | "secret" | "enum";

/**
 * 插件装后配置字段声明（清单 `config` 块规范化产物）。
 *
 * 值由平台统一存储与注入（非敏感进 kv 并合并进插件 MCP 进程 env；secret 进
 * hostdb 密钥库并自动建 MCP/技能两层绑定），插件不再自行读配置文件或钥匙串。
 */
export type PluginConfigField = {
  /** 稳定 id（插件内唯一；密钥名 `plugin.<pluginId>.<key>` 与 kv 键都用它） */
  key: string;
  /** 展示名 */
  title: string;
  description?: string;
  type: PluginConfigFieldType;
  /** enum 的候选值 */
  options?: string[];
  /** 必填：缺值时 configState = missing，装后自动弹配置弹窗 */
  required?: boolean;
  /** 非敏感字段的缺省值（secret 类型禁止给 default） */
  default?: string;
  /** 注入插件 MCP 进程的环境变量名（非敏感直接进 env；secret 走密钥绑定） */
  env?: string;
  /** 注入 http 服务器请求头的头名（secret 专用；走 mcp-secrets headers 绑定通道） */
  header?: string;
};

export type PluginManifest = {
  /** 稳定标识（ASCII，且须与目录名一致）：pluginId、cache 路径与状态键都用它 */
  name: string;
  /** 展示名（可中文）：UI 优先显示；缺省回退 name */
  displayName?: string;
  version: string;
  description?: string;
  author?: { name?: string; url?: string };
  icon?: string;
  category?: string;
  keywords?: string[];
  homepage?: string;
  license?: string;
  manifestKind: PluginManifestKind;
  /** 插件根（绝对路径；安装后即 cache 目录） */
  root: string;
  components: PluginComponents;
  /** 装后配置字段声明（无声明或缺省 = 插件无需配置） */
  config?: PluginConfigField[];
  /** 生态清单里 v1 不支持的组件（agents 等），提示性诊断 */
  unsupported: string[];
  /** 清单级诊断（未知字段、组件路径不存在等；不阻断安装） */
  diagnostics: string[];
};

export type InstalledPlugin = {
  pluginId: string;
  mktId: string;
  mktName: string;
  name: string;
  /** 市场目录条目名（清单 name 与条目名可以不同；用于更新时定位条目） */
  catalogName?: string;
  version: string;
  /** git 来源的短 revision（目录来源为内容签名，仅展示用） */
  revision?: string;
  installedAt: string;
  /** 来源市场已不在登记表中（插件保留可用，仅无更新通道） */
  sourceMissing: boolean;
  /** 链接安装（dev 模式，目录市场专属）：cache 条目是指向源目录的符号链接，
   *  读路径全部实时命中源码——改完插件重建产物即可生效，无需再走市场安装 */
  linked?: boolean;
  /** 源目录绝对路径：linked 项为链接目标；本地安装（拷贝）项为 installed.json 记录的来源 */
  sourcePath?: string;
  enabled: boolean;
  manifest: PluginManifest;
  diagnostics: string[];
};

export type MarketplaceType = "directory" | "git";

export type MarketplaceRecord = {
  id: string;
  /** 市场名（marketplace.json 的 name；解析前用 id 兜底） */
  name: string;
  type: MarketplaceType;
  /** directory：市场根绝对路径 */
  path?: string;
  /** git：仓库地址（clone 到 repos/<id>/） */
  repo?: string;
  /**
   * 市场 source 的解析根：manifest 在 `.agents/plugins/` / `.claude-plugin/`
   * 等布局下时，source 相对的是布局上层的市场根（可能与登记路径不同）。
   * 缺省回退 path / repo 工作副本。
   */
  sourceBase?: string;
  /** 内置市场（Codex personal marketplace 自动发现）：只读登记，不落盘、不可移除 */
  builtin?: boolean;
  addedAt: string;
  lastRefresh?: string;
};

/** 市场条目 source 的远程 git 形态（Codex `git` / `git-subdir` / `url`） */
export type CatalogGitSource = {
  kind: "git";
  url: string;
  /** 仓库内子目录（缺省 = 仓库根） */
  path?: string;
  /** 分支/标签 */
  ref?: string;
  /** 固定 commit（7-40 位 hex） */
  sha?: string;
};

export type CatalogPluginEntry = {
  name: string;
  /** 展示名（可中文）；目录未声明时回退读插件清单的 displayName */
  displayName?: string;
  version?: string;
  description?: string;
  icon?: string;
  category?: string;
  keywords?: string[];
  /** 相对市场根的插件目录（本地 source）；git source 时为仓库内子目录 */
  path: string;
  /** 远程 git source；缺省 = 本地 source（path 相对市场根） */
  source?: CatalogGitSource;
  /** Codex policy.authentication：安装时授权 / 使用时授权 */
  authPolicy?: "on_install" | "on_use";
};

export type MarketplaceCatalog = {
  name: string;
  displayName?: string;
  plugins: CatalogPluginEntry[];
  /** 目录解析诊断（不支持的 source 类型、被跳过的条目等） */
  diagnostics?: string[];
};

export type MarketplaceCatalogCache = {
  catalog: MarketplaceCatalog;
  /** git 来源的短 revision */
  revision?: string;
  /** 市场 source 解析根（同 MarketplaceRecord.sourceBase） */
  sourceBase?: string;
  readAt: string;
};

// ---------------------------------------------------------------------------
// 路径解析（测试经 PI_PLUGINS_DIR 钉住；生产从 PI_DB_PATH 同级推导）
// ---------------------------------------------------------------------------

export function pluginsRootDir(): string {
  if (process.env.PI_PLUGINS_DIR) return resolve(process.env.PI_PLUGINS_DIR);
  const db = process.env.PI_DB_PATH;
  if (db) return join(resolve(db), "..", "plugins");
  return join(homedir(), ".kova", "plugins");
}

export function marketplacesFilePath(): string {
  return join(pluginsRootDir(), "marketplaces.json");
}

export function installedPluginDir(mktId: string, name: string): string {
  return join(pluginsRootDir(), "cache", mktId, name);
}

/** 插件数据目录（Codex `PLUGIN_DATA` 语义；跨插件更新持久） */
export function pluginDataRootFor(pluginId: string): string {
  const safe = pluginId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(pluginsRootDir(), "plugin-data", safe);
}

/**
 * AI 脚手架的专属 dev 市场（plugins_scaffold 落盘目标）：固定在本机插件根下，
 * 首次 scaffold 时自动登记为 directory 市场，之后用户在市场 UI 一键刷新安装。
 */
export function devMarketplaceDir(): string {
  return join(pluginsRootDir(), "dev-marketplace");
}

/**
 * 「本地安装」内置伪市场：不经登记，直接把任意含清单的插件目录物化到
 * cache/local/<name>/，身份仍是 `name@local`。登记表里没有它的记录（不参与
 * add/remove/refresh），目录视图由已装 local 条目现场合成（见 buildLocalCatalog）；
 * "更新" = 从 installed.json 记的 sourcePath 重新拷贝。
 */
export const LOCAL_MKT_ID = "local";
export const LOCAL_MKT_NAME = "本地安装";

// ---------------------------------------------------------------------------
// 清单解析与生态兼容规范化
// ---------------------------------------------------------------------------

export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Codex 生态名字：大小写字母/数字/`._-`，但点只能作为分隔符（不允许开头/结尾/连续点） */
const ECOSYSTEM_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const AGENT_PLUGIN_NAME_RE = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
/** Agent Plugins v1 清单规范（根 plugin.json 的 $schema） */
const AGENT_PLUGIN_SCHEMA_PREFIX = "https://agent-plugins.org/schemas/";
const AGENT_PLUGIN_SCHEMA_URI = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const MANIFEST_PROBES: Array<{ kind: PluginManifestKind; dir: string; file: string }> = [
  // kova 原生永远最优先；生态内部按 Codex 的探测顺序（codex → claude → cursor）
  { kind: "kova", dir: ".kova-plugin", file: "plugin.json" },
  { kind: "codex", dir: ".codex-plugin", file: "plugin.json" },
  { kind: "claude", dir: ".claude-plugin", file: "plugin.json" },
  { kind: "cursor", dir: ".cursor-plugin", file: "plugin.json" },
];

const MANIFEST_NAME_KEY = "name";

/** 组件字段 → 规范化后的路径数组（未声明返回空数组） */
export function pluginComponentPaths(
  components: PluginComponents,
  kind: PluginMultiComponentKind,
): string[] {
  const value = components[kind];
  return Array.isArray(value) ? value : [];
}

/** 组件路径解析的公共入口（供 store/mcp/skills/commands/subagents 共同使用） */
export function pluginComponentRelPath(
  components: PluginComponents,
  kind: PluginMultiComponentKind,
): string | undefined {
  return pluginComponentPaths(components, kind)[0];
}

function ecosystemNameError(name: string): string | undefined {
  if (!ECOSYSTEM_NAME_RE.test(name)) return "name 只能包含 ASCII 字母、数字、`_`、`-`、`.`";
  if (name === "." || name === ".." || name.includes("..")) return "name 的点必须分隔非空片段";
  if (name.startsWith(".") || name.endsWith(".")) return "name 不能以点开头或结尾";
  return undefined;
}

function agentPluginNameError(name: string): string | undefined {
  if (name.length > 64) return "name 不能超过 64 字符";
  if (name.includes("--") || name.includes("..")) return "name 不能包含 `--` 或 `..`";
  if (!AGENT_PLUGIN_NAME_RE.test(name)) {
    return "name 只能包含小写字母、数字、`.`、`-`，且首尾必须是字母或数字";
  }
  return undefined;
}

/** 根 plugin.json 是否为 Agent Plugins v1 清单（只看 $schema 前缀，避免误吞普通文件） */
function isAgentPluginManifestDoc(doc: Record<string, unknown>): boolean {
  const schema = asString(doc.$schema);
  return Boolean(schema && schema.startsWith(AGENT_PLUGIN_SCHEMA_PREFIX));
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * 组件相对路径包含性校验：拒绝绝对路径与 ".." 逃逸。返回规整后的相对路径
 * （正斜杠、去 "./" 前缀）；非法返回 undefined 并记诊断。
 */
export function containedRelPath(
  root: string,
  raw: string,
  label: string,
  diagnostics: string[],
): string | undefined {
  const trimmed = raw.trim().replace(/^\.\//, "").replace(/[\\/]+$/, "");
  if (!trimmed) {
    diagnostics.push(`${label}: 组件路径为空`);
    return undefined;
  }
  if (isAbsolute(trimmed) || trimmed.split(/[\\/]/).includes("..")) {
    diagnostics.push(`${label}: 组件路径必须相对且不得逃逸插件根（"${raw}"）`);
    return undefined;
  }
  const abs = resolve(root, trimmed);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    diagnostics.push(`${label}: 组件路径逃逸插件根（"${raw}"）`);
    return undefined;
  }
  return trimmed.split("\\").join("/");
}

/** 目录存在性探测（默认路径兜底用） */
function dirExists(root: string, rel: string): boolean {
  const p = resolve(root, rel);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return existsSync(p) && statSync(p).isDirectory() && p.startsWith(rootWithSep);
}

function fileExists(root: string, rel: string): boolean {
  const p = resolve(root, rel);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return existsSync(p) && statSync(p).isFile() && p.startsWith(rootWithSep);
}

// ---------------------------------------------------------------------------
// 装后配置字段（kova 清单 config 块 / codex interface.userConfig）规范化
// ---------------------------------------------------------------------------

const PLUGIN_CONFIG_LIMIT = 16;
const PLUGIN_CONFIG_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** env 名：与 mcp-secrets 的 ENV 名同款（值将成为子进程环境变量名） */
const PLUGIN_CONFIG_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** header 名：RFC 7230 token（与 mcp-secrets 的 HEADER_NAME_RE 同款，允许连字符） */
const PLUGIN_CONFIG_HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

const CONFIG_TYPE_ALIASES: Record<string, PluginConfigFieldType> = {
  string: "string",
  text: "string",
  url: "string",
  password: "secret",
  secret: "secret",
  token: "secret",
  apikey: "secret",
  enum: "enum",
  select: "enum",
};

/**
 * 归一配置声明。source 标签用于诊断（kova=config / codex=interface.userConfig）。
 * 非法整条丢弃并记诊断（不阻断安装）；返回 undefined = 无有效声明。
 * 生态形状宽容解析：数组或「key → 字段」映射均可，type 同义词归一
 * （password/token/apikey → secret、select → enum）。
 */
function normalizePluginConfig(
  raw: unknown,
  source: string,
  diagnostics: string[],
): PluginConfigField[] | undefined {
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : isRecord(raw)
      ? Object.entries(raw).map(([key, v]) => ({ key, ...(isRecord(v) ? v : {}) }))
      : [];
  if (items.length === 0) {
    if (raw !== undefined) diagnostics.push(`${source}: 应为字段数组，已忽略`);
    return undefined;
  }
  if (items.length > PLUGIN_CONFIG_LIMIT) {
    diagnostics.push(`${source}: 字段数超过上限 ${PLUGIN_CONFIG_LIMIT}，截断`);
    items.length = PLUGIN_CONFIG_LIMIT;
  }
  const out: PluginConfigField[] = [];
  const seen = new Set<string>();
  for (const [i, item] of items.entries()) {
    if (!isRecord(item)) {
      diagnostics.push(`${source}[${i}]: 必须是对象，已忽略`);
      continue;
    }
    const key = asString(item.key) ?? asString(item.name) ?? asString(item.id);
    if (!key) {
      diagnostics.push(`${source}[${i}]: 缺少 key，已忽略`);
      continue;
    }
    if (!PLUGIN_CONFIG_KEY_RE.test(key)) {
      diagnostics.push(`${source}.${key}: key 需匹配 ${PLUGIN_CONFIG_KEY_RE.source}，已忽略`);
      continue;
    }
    if (seen.has(key)) {
      diagnostics.push(`${source}.${key}: key 重复，已忽略`);
      continue;
    }
    const rawType = asString(item.type)?.toLowerCase();
    const type: PluginConfigFieldType =
      (rawType && CONFIG_TYPE_ALIASES[rawType]) || "string";
    const options = Array.isArray(item.options)
      ? item.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0)
      : undefined;
    if (type === "enum" && (!options || options.length === 0)) {
      diagnostics.push(`${source}.${key}: enum 类型必须给 options，已忽略`);
      continue;
    }
    const title = asString(item.title) ?? asString(item.label) ?? key;
    const description = asString(item.description);
    const env = asString(item.env);
    const header = asString(item.header);
    const def = asString(item.default);
    if (def && type === "secret") {
      diagnostics.push(`${source}.${key}: secret 类型禁止 default，已丢弃`);
    }
    if (def && type === "enum" && options && !options.includes(def)) {
      diagnostics.push(`${source}.${key}: default 不在 options 内，已丢弃`);
    }
    // 注入目标：env（stdio 进程环境变量）或 header（http 请求头）。两类类型
    // 都二选一即可；与服务器 transport 的错配在注入/绑定层按 def.transport 路由
    if (!env && !header) {
      diagnostics.push(`${source}.${key}: 缺少 env 或 header（配置值需要注入目标），已忽略`);
      continue;
    }
    if (env && !PLUGIN_CONFIG_ENV_RE.test(env)) {
      diagnostics.push(`${source}.${key}: env 名需匹配 ${PLUGIN_CONFIG_ENV_RE.source}，已忽略`);
      continue;
    }
    if (header && !PLUGIN_CONFIG_HEADER_RE.test(header)) {
      diagnostics.push(`${source}.${key}: header 名需为合法 HTTP 头名（RFC 7230 token），已忽略`);
      continue;
    }
    seen.add(key);
    out.push({
      key,
      title,
      ...(description ? { description } : {}),
      type,
      ...(type === "enum" && options ? { options } : {}),
      ...(item.required === true ? { required: true } : {}),
      ...(def && type !== "secret" ? { default: def } : {}),
      ...(env ? { env } : {}),
      // header 对两类类型都有意义：非敏感 → http def.headers 直注入；
      // secret → mcp-secrets headers 绑定（握手时解密注入）
      ...(header ? { header } : {}),
    });
  }
  return out.length ? out : undefined;
}

/**
 * 解析插件根目录的清单（三态探测 + 兼容规范化）。
 * 硬错误（无清单/坏 JSON/名字非法或与目录名不一致）抛出；
 * 软问题进 unsupported / diagnostics。
 */
export function parsePluginManifest(
  root: string,
  options: { /** 测试注入：覆盖目录名一致性比对的基准名 */ dirName?: string } = {},
): PluginManifest {
  const diagnostics: string[] = [];
  const unsupported: string[] = [];

  // 探测顺序：kova 原生 → 根 Agent Plugins v1 → codex → claude → cursor。
  // Agent 清单只在根 plugin.json 带 agent-plugins.org schema 时成立，避免把
  // 普通项目的 package/plugin.json 误认成清单。
  const probes: Array<{ kind: PluginManifestKind; file: string; path: string }> = [];
  const kovaProbe = MANIFEST_PROBES[0]!;
  probes.push({
    kind: kovaProbe.kind,
    file: `${kovaProbe.dir}/${kovaProbe.file}`,
    path: join(root, kovaProbe.dir, kovaProbe.file),
  });
  if (fileExists(root, "plugin.json")) {
    try {
      const candidate = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")) as unknown;
      if (isRecord(candidate) && isAgentPluginManifestDoc(candidate)) {
        probes.push({ kind: "agent", file: "plugin.json", path: join(root, "plugin.json") });
      }
    } catch {
      // 根 plugin.json 坏掉不阻断其它生态清单探测
    }
  }
  for (const p of MANIFEST_PROBES.slice(1)) {
    probes.push({ kind: p.kind, file: `${p.dir}/${p.file}`, path: join(root, p.dir, p.file) });
  }
  const probe = probes.find((p) => existsSync(p.path));
  if (!probe) {
    throw new Error(
      `${root}: 未找到插件清单（已探测 ${probes.map((p) => p.file).join(" / ")}）`,
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(probe.path, "utf8"));
  } catch (err) {
    throw new Error(
      `${probe.file}: 解析失败（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  if (!isRecord(doc)) throw new Error(`${probe.file}: 顶层必须是对象`);

  const dirName = options.dirName ?? basename(root);
  const isKova = probe.kind === "kova";
  let name = asString(doc[MANIFEST_NAME_KEY]);
  if (isKova) {
    if (!name) throw new Error(`${probe.file}: 缺少 name`);
    if (!PLUGIN_NAME_RE.test(name)) {
      throw new Error(`${probe.file}: name 需匹配 ${PLUGIN_NAME_RE.source}`);
    }
    if (dirName !== name) {
      throw new Error(`${probe.file}: name（${name}）须与插件目录名（${dirName}）一致`);
    }
  } else {
    if (probe.kind === "agent") {
      if (!name) throw new Error(`${probe.file}: 缺少 name`);
      const error = agentPluginNameError(name);
      if (error) throw new Error(`${probe.file}: ${error}（"${name}"）`);
    } else {
      // Codex/Claude/Cursor 允许 name 缺省（回退目录/条目名），也允许目录名与
      // 清单名不同（市场条目/下载目录经常如此）。身份以清单 name 为准。
      name = name ?? dirName;
      const error = ecosystemNameError(name);
      if (error) throw new Error(`${probe.file}: ${error}（"${name}"）`);
      if (dirName !== name && options.dirName === undefined) {
        diagnostics.push(`name（${name}）与目录名（${dirName}）不一致，已按清单名处理`);
      }
    }
  }
  const pluginName = name ?? dirName;

  const version = asString(doc.version) ?? "0.0.0";
  const authorRaw = doc.author;
  const author = isRecord(authorRaw)
    ? { name: asString(authorRaw.name), url: asString(authorRaw.url) }
    : undefined;

  // ---- 组件字段：原生取声明值；生态清单有默认位置兜底 ----
  const components: PluginComponents = {};

  /** 声明字段 → 规整后的相对路径数组；字符串或字符串数组都收，重复去重 */
  const pathList = (key: string): string[] => {
    const value = doc[key];
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : [value];
    const out: string[] = [];
    values.forEach((raw, i) => {
      const label = values.length > 1 ? `${key}[${i}]` : key;
      if (typeof raw !== "string") {
        diagnostics.push(`${label}: 组件路径必须是字符串，已忽略`);
        return;
      }
      const rel = containedRelPath(root, raw, label, diagnostics);
      if (rel && !out.includes(rel)) out.push(rel);
    });
    return out;
  };
  const pathOne = (key: string): string | undefined => {
    const value = doc[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      diagnostics.push(`${key}: 组件路径必须是字符串，已忽略`);
      return undefined;
    }
    return containedRelPath(root, value, key, diagnostics) ?? undefined;
  };
  const assignPaths = (key: PluginMultiComponentKind, paths: string[]): void => {
    if (paths.length) components[key] = paths;
  };

  // 装后配置声明：kova 认清单 config 块；codex 认 interface.userConfig（归一同款 schema）
  let config: PluginConfigField[] | undefined;

  if (isKova) {
    assignPaths("skills", pathList("skills"));
    if (isRecord(doc.mcpServers)) {
      diagnostics.push("mcpServers: kova 清单只支持文件路径，内联对象已忽略");
    } else {
      assignPaths("mcpServers", pathList("mcpServers"));
    }
    assignPaths("hooks", pathList("hooks"));
    assignPaths("subagents", pathList("subagents"));
    assignPaths("commands", pathList("commands"));
    const panels = pathOne("panels");
    if (panels) components.panels = panels;
    config = normalizePluginConfig(doc.config, "config", diagnostics);
    for (const key of Object.keys(doc)) {
      if (
        !["name", "displayName", "version", "description", "author", "icon", "category", "keywords",
          "homepage", "license", "skills", "mcpServers", "hooks", "subagents",
          "panels", "commands", "config"].includes(key)
      ) {
        diagnostics.push(`${probe.file}: 忽略未知字段 "${key}"`);
      }
    }
  } else {
    // ---- skills：声明优先 → 根级 skills/ → Codex 迁移命令技能 ----
    let skills = pathList("skills");
    if (!skills.length && dirExists(root, "skills")) skills = ["skills"];
    if (probe.kind === "codex") {
      const migrated = ".codex-plugin/migrated-command-skills";
      if (dirExists(root, migrated) && !skills.includes(migrated)) skills.push(migrated);
    }
    assignPaths("skills", skills);

    // ---- mcpServers：路径（string/array）/ 内联对象 / 默认文件 ----
    const rawMcp = doc.mcpServers;
    if (isRecord(rawMcp)) {
      components.mcpServersInline = rawMcp;
    } else if (rawMcp !== undefined) {
      assignPaths("mcpServers", pathList("mcpServers"));
    } else {
      const defaults = probe.kind === "agent" ? ["mcp.json", ".mcp.json"] : [".mcp.json"];
      const hit = defaults.find((p) => fileExists(root, p));
      if (hit) components.mcpServers = [hit];
    }

    // ---- hooks：路径/路径数组/内联对象/内联数组（数组可混排） ----
    const rawHooks = doc.hooks;
    if (rawHooks !== undefined) {
      const values = Array.isArray(rawHooks) ? rawHooks : [rawHooks];
      const hookPaths: string[] = [];
      const inline: unknown[] = [];
      values.forEach((raw, i) => {
        const label = values.length > 1 ? `hooks[${i}]` : "hooks";
        if (typeof raw === "string") {
          const rel = containedRelPath(root, raw, label, diagnostics);
          if (rel && !hookPaths.includes(rel)) hookPaths.push(rel);
        } else if (isRecord(raw)) {
          inline.push(raw);
        } else {
          diagnostics.push(`${label}: 需为路径字符串或内联对象，已忽略`);
        }
      });
      assignPaths("hooks", hookPaths);
      if (inline.length) components.hooksInline = inline;
    } else if (fileExists(root, join("hooks", "hooks.json"))) {
      components.hooks = ["hooks/hooks.json"];
    }

    // ---- commands：显式声明；claude/cursor 认根级 commands/ ----
    let commands = pathList("commands");
    if (
      !commands.length &&
      (probe.kind === "claude" || probe.kind === "cursor") &&
      dirExists(root, "commands")
    ) {
      commands = ["commands"];
    }
    assignPaths("commands", commands);

    // 生态清单此前完全忽略 subagents 声明；显式声明照收
    assignPaths("subagents", pathList("subagents"));

    // UI 面板是本应用原生概念：生态清单无默认位置，但显式声明照收
    const panels = pathOne("panels");
    if (panels) components.panels = panels;

    // Codex apps：先识别并记诊断，加载后续里程碑接入
    const apps = pathOne("apps");
    if (apps) {
      components.apps = apps;
      unsupported.push("apps: Codex app 声明暂不支持（后续里程碑接入）");
    }

    if (dirExists(root, "agents") && probe.kind !== "agent") {
      unsupported.push(
        "agents: 生态 agents/ 元数据或子代理格式暂不支持（可在本应用内另建同名子智能体）",
      );
    }

    // codex 的 interface.userConfig 归一为装后配置声明（同 kova config schema）；
    // interface 其余块整段忽略，不逐字段告警
    if (probe.kind === "codex" && isRecord(doc.interface)) {
      config = normalizePluginConfig(doc.interface.userConfig, "interface.userConfig", diagnostics);
    }
    // Agent Plugins v1：components 走约定位置，extensions 里的 hooks/apps/onboarding
    // 需要 Codex overlay 语义，当前记不支持的诊断而不是静默忽略
    if (probe.kind === "agent" && isRecord(doc.extensions)) {
      const extension = doc.extensions["com.openai"];
      if (isRecord(extension)) {
        for (const key of ["hooks", "apps", "onboardingSkill", "interface"]) {
          if (extension[key] !== undefined) {
            unsupported.push(`extensions["com.openai"].${key}: 暂不支持`);
          }
        }
      }
    }
    if (probe.kind === "claude") {
      for (const key of ["outputStyles", "lspServers", "monitors", "settings"]) {
        if (doc[key] !== undefined) unsupported.push(`${key}: 生态组件暂不支持`);
      }
    }
  }

  // 声明了但实际不存在的组件路径：提示（安装照常，加载层自然为空）
  const checkPaths = (kind: PluginMultiComponentKind, dirs: boolean): void => {
    for (const rel of components[kind] ?? []) {
      const ok = dirs ? dirExists(root, rel) : fileExists(root, rel);
      if (!ok) {
        diagnostics.push(`${kind}: 声明的路径 "${rel}" 不存在或类型不符（${resolve(root, rel)}）`);
      }
    }
  };
  checkPaths("skills", true);
  checkPaths("subagents", true);
  checkPaths("commands", true);
  checkPaths("mcpServers", false);
  checkPaths("hooks", false);
  if (components.panels && !fileExists(root, components.panels)) {
    diagnostics.push(
      `panels: 声明的路径 "${components.panels}" 不存在或类型不符（${resolve(root, components.panels)}）`,
    );
  }
  if (components.apps && !fileExists(root, components.apps)) {
    diagnostics.push(
      `apps: 声明的路径 "${components.apps}" 不存在或类型不符（${resolve(root, components.apps)}）`,
    );
  }
  // Codex 生态插件常用 package.json + node_modules 启动 MCP；Kova 不自动跑
  // npm install，缺依赖时 MCP 会在 spawn 后 ERR_MODULE_NOT_FOUND。这里提前
  // 给出可操作诊断（安装依赖是用户显式动作，不静默执行）。只看运行期依赖：
  // 只有元数据的 package.json（无 dependencies）不需要 node_modules，否则
  // 诊断永远消不掉，与 plugin-deps.ts 的 installable 判定保持一致。
  const deps = pluginDepsStatus(root);
  if (!isKova && deps.missing) {
    diagnostics.push(
      `依赖未安装：package.json 声明了运行期依赖但 node_modules 缺失；请在插件详情页点「安装依赖」（npm ${deps.hasLockfile ? "ci" : "install"} --omit=dev --ignore-scripts）后重新启用插件`,
    );
  }

  if (probe.kind === "agent") {
    const schema = asString(doc.$schema);
    if (schema !== AGENT_PLUGIN_SCHEMA_URI) {
      throw new Error(
        `${probe.file}: 不支持的 Agent Plugins schema（${schema ?? "缺失"}；支持 ${AGENT_PLUGIN_SCHEMA_URI}）`,
      );
    }
  }

  const interfaceDoc = isRecord(doc.interface) ? doc.interface : undefined;
  const rawIcon =
    asString(doc.icon) ??
    asString(interfaceDoc?.composerIcon) ??
    asString(interfaceDoc?.logo) ??
    asString(interfaceDoc?.logoDark);
  const keywords = Array.isArray(doc.keywords)
    ? (doc.keywords as unknown[]).filter((k): k is string => typeof k === "string").slice(0, 16)
    : undefined;
  // 展示名：允许中文/空格，只做长度裁剪；name 仍是 ASCII 稳定标识
  const displayName = (asString(doc.displayName) ?? asString(interfaceDoc?.displayName))
    ?.trim()
    .slice(0, 80);
  const description =
    asString(doc.description) ??
    asString(interfaceDoc?.shortDescription) ??
    asString(interfaceDoc?.longDescription);
  const category = asString(doc.category) ?? asString(interfaceDoc?.category);
  const homepage =
    asString(doc.homepage) ??
    asString(interfaceDoc?.websiteURL) ??
    asString(interfaceDoc?.websiteUrl);
  const developerName = asString(interfaceDoc?.developerName);
  const finalAuthor: PluginManifest["author"] =
    author ?? (developerName ? { name: developerName } : undefined);

  // 图标：远程 URL（http/https/data）原样保留；相对路径做包含性校验后规整。
  // Codex 生态的图标在 interface.composerIcon / interface.logo 里（顶层 icon 缺省时回退）。
  let icon: string | undefined;
  if (rawIcon) {
    if (/^(https?:|data:)/i.test(rawIcon)) {
      icon = rawIcon;
    } else {
      const contained = containedRelPath(root, rawIcon, "icon", diagnostics);
      if (contained) icon = contained;
    }
  }

  return {
    name: pluginName,
    ...(displayName ? { displayName } : {}),
    version,
    ...(description ? { description } : {}),
    ...(finalAuthor && (finalAuthor.name || finalAuthor.url) ? { author: finalAuthor } : {}),
    ...(icon ? { icon } : {}),
    ...(category ? { category } : {}),
    ...(keywords?.length ? { keywords } : {}),
    ...(homepage ? { homepage } : {}),
    ...(asString(doc.license) ? { license: asString(doc.license) } : {}),
    manifestKind: probe.kind,
    root,
    components,
    ...(config?.length ? { config } : {}),
    unsupported,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// hooks 文件读取（自有 HookConfig[] 与 Claude 形状二选一，按顶层形状判定）
// ---------------------------------------------------------------------------

const KNOWN_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreModelRequest",
  "PostModelRequest",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Interrupt",
]);

export type PluginHookEntry = Pick<
  HookConfig,
  | "id"
  | "name"
  | "command"
  | "args"
  | "matcher"
  | "timeoutMs"
  | "event"
  | "enabled"
  | "type"
  | "shell"
  | "commandWindows"
  | "onFailure"
  | "cwd"
  | "background"
  | "statusMessage"
> & {
  /** 展开时命中 ${BUN}：执行层据此补 BUN_BE_BUN=1（编译态 sidecar 充当 bun CLI） */
  usedBun?: boolean;
  /** 插件根：执行层注入 CLAUDE_PLUGIN_ROOT / PLUGIN_ROOT 环境变量 */
  pluginRoot?: string;
  /** 插件数据目录：执行层注入 PLUGIN_DATA（Codex Agent Plugins 语义） */
  pluginDataRoot?: string;
};

function readHooksOurs(doc: unknown, pluginId: string, diagnostics: string[]): PluginHookEntry[] {
  if (!Array.isArray(doc)) return [];
  const out: PluginHookEntry[] = [];
  doc.forEach((item, i) => {
    if (!isRecord(item) || typeof item.command !== "string" || !item.command.trim()) {
      diagnostics.push(`hooks[${i}]: 缺少 command，已忽略`);
      return;
    }
    const event = typeof item.event === "string" ? item.event : "";
    if (!KNOWN_HOOK_EVENTS.has(event)) {
      diagnostics.push(`hooks[${i}]: 未知事件 "${event}"，已忽略`);
      return;
    }
    out.push({
      id: `${pluginId}:hook-${i}`,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : `hook-${i + 1}`,
      command: item.command,
      event: event as HookEventName,
      // 自有形状支持单条开关；Claude 生态没有这个字段，恒为启用
      enabled: item.enabled !== false,
      ...(Array.isArray(item.args) ? { args: item.args.filter((a): a is string => typeof a === "string") } : {}),
      ...(item.type === "shell" || item.type === "process" ? { type: item.type } : {}),
      ...(typeof item.shell === "string" && item.shell.trim() ? { shell: item.shell.trim() } : {}),
      ...(typeof item.commandWindows === "string" && item.commandWindows.trim()
        ? { commandWindows: item.commandWindows.trim() }
        : {}),
      ...(item.onFailure === "block" || item.onFailure === "continue"
        ? { onFailure: item.onFailure }
        : {}),
      ...(typeof item.matcher === "string" && item.matcher.trim() ? { matcher: item.matcher.trim() } : {}),
      ...(typeof item.timeoutMs === "number" && Number.isFinite(item.timeoutMs)
        ? { timeoutMs: Math.min(Math.max(item.timeoutMs, 1_000), 120_000) }
        : {}),
    });
  });
  return out;
}

/**
 * Claude hooks.json 形状：按事件名分组的对象
 * `{ "PreToolUse": [{ matcher?, hooks: [{ type: "command", command, timeout? }] }] }`。
 * timeout 是秒（Claude 语义）→ 毫秒钳制；非 command 类型条目忽略。
 */
function readHooksClaude(
  doc: unknown,
  pluginId: string,
  pluginName: string,
  diagnostics: string[],
): PluginHookEntry[] {
  if (!isRecord(doc)) return [];
  const out: PluginHookEntry[] = [];
  let n = 0;
  for (const [event, groups] of Object.entries(doc)) {
    if (!KNOWN_HOOK_EVENTS.has(event)) {
      diagnostics.push(`hooks: 未知事件 "${event}"，已忽略`);
      continue;
    }
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const matcher =
        typeof group.matcher === "string" && group.matcher.trim()
          ? group.matcher.trim()
          : undefined;
      const inner = Array.isArray(group.hooks) ? group.hooks : [];
      for (const h of inner) {
        if (!isRecord(h)) continue;
        if (h.type !== "command") {
          diagnostics.push(
            `hooks: handler 类型 "${String(h.type ?? "未声明")}" 暂不支持，已忽略`,
          );
          continue;
        }
        if (typeof h.command !== "string" || !h.command.trim()) {
          diagnostics.push("hooks: command handler 缺少 command，已忽略");
          continue;
        }
        const timeoutSec = typeof h.timeout === "number" && Number.isFinite(h.timeout) ? h.timeout : undefined;
        out.push({
          id: `${pluginId}:hook-${n}`,
          name: `${pluginName}:${n + 1}`,
          command: h.command,
          event: event as HookEventName,
          enabled: true,
          // Claude 的 type:"command" 语义是整串交 shell 解释（引号/变量由 shell 处理），
          // 对应 kova 的 type:"shell"；不映射会被当 process 走 argv 直执行，含引号与
          // 空格参数的第三方命令串会整个找不到文件。其 shell 字段（Claude 默认用户 shell）一并透传。
          type: "shell",
          ...(typeof h.shell === "string" && h.shell.trim() ? { shell: h.shell.trim() } : {}),
          ...(typeof h.commandWindows === "string" && h.commandWindows.trim()
            ? { commandWindows: h.commandWindows.trim() }
            : {}),
          ...(h.onFailure === "block" || h.onFailure === "continue"
            ? { onFailure: h.onFailure }
            : {}),
          // Codex command handler：async → 后台运行；statusMessage 供详情展示
          ...(h.async === true ? { background: true } : {}),
          ...(typeof h.statusMessage === "string" && h.statusMessage.trim()
            ? { statusMessage: h.statusMessage.trim().slice(0, 200) }
            : {}),
          ...(matcher ? { matcher } : {}),
          ...(timeoutSec !== undefined
            ? { timeoutMs: Math.min(Math.max(Math.round(timeoutSec * 1000), 1_000), 120_000) }
            : {}),
        });
        n += 1;
      }
    }
  }
  return out;
}

/**
 * 解析一份已读出的 hooks 值（文件内容或 manifest 内联对象共用）：
 * - 自有数组形状走 readHooksOurs；
 * - Claude/Codex 的 `{hooks: {事件名: [...]}}` 包装拆一层；
 * - 裸「事件名 → 分组数组」对象直接吃。
 */
export function readPluginHooksValue(
  doc: unknown,
  pluginId: string,
  pluginName: string,
  diagnostics: string[],
): PluginHookEntry[] {
  if (Array.isArray(doc)) return readHooksOurs(doc, pluginId, diagnostics);
  if (isRecord(doc)) {
    // Claude/Codex 的 hooks 文件外层还有一层 `{"hooks": {事件名: [...]}}` 包装，
    // 而 readHooksClaude 吃的是内层「事件名 → 分组数组」。不拆这层的话顶层唯一的
    // 键 `hooks` 会被当成事件名，撞进未知事件白名单被丢弃，整个插件的 hooks
    // 静默为空。裸事件名对象仍按原样吃，两种写法都支持。
    const inner = isRecord(doc.hooks) ? doc.hooks : doc;
    return readHooksClaude(inner, pluginId, pluginName, diagnostics);
  }
  diagnostics.push("hooks: 顶层必须是数组或对象");
  return [];
}

/** 读取插件 hooks 文件（形状自动判定）；文件缺失/坏 JSON 返回空并记诊断 */
export function readPluginHooksFile(
  absPath: string,
  pluginId: string,
  pluginName: string,
  diagnostics: string[],
): PluginHookEntry[] {
  if (!existsSync(absPath)) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(absPath, "utf8"));
  } catch (err) {
    diagnostics.push(`hooks: 解析失败（${err instanceof Error ? err.message : String(err)}）`);
    return [];
  }
  return readPluginHooksValue(doc, pluginId, pluginName, diagnostics);
}

// ---------------------------------------------------------------------------
// UI 面板声明（panels.json：插件向右侧面板贡献的自包含 HTML 面板清单）
// ---------------------------------------------------------------------------

/** 桥能力白名单：document=文档读写 / export=产物落盘 / agent=composer 预填 / notify=提示条 */
export const PANEL_PERMISSIONS = ["document", "export", "agent", "notify"] as const;
export type PluginPanelPermission = (typeof PANEL_PERMISSIONS)[number];

/** panels.json 单条目解析产物（字段已经过合法性与包含性校验） */
export type PluginPanelDecl = {
  id: string;
  title: string;
  /** 面板图标：相对路径（读取时转 data URL）或 http(s)/data URL 原样 */
  icon?: string;
  /** 自包含单文件 HTML（相对插件根；前端 blob 挂载进 sandboxed iframe） */
  entry: string;
  /** 匹配该 glob 的工作区文件可「在面板中打开」（如 "*.canvas.json"） */
  opens: string[];
  permissions: PluginPanelPermission[];
};

const PANEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 极简 glob 判定（仅 `*` 通配整段路径字符；opens 匹配与前端同款语义） */
export function globMatch(pattern: string, path: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, ".") +
      "$",
    "i",
  );
  return re.test(path.replace(/\\/g, "/"));
}

/**
 * 读取插件面板声明文件（顶层数组）。硬错误（文件缺失/坏 JSON）返回空并记诊断；
 * 单条目坏（id 非法/entry 缺失或不逃逸但非 HTML/重复 id）跳过该条继续其余，
 * 权限与 opens 逐字段宽松过滤——面板可用性优先于严格性。
 */
export function readPluginPanelsFile(
  absPath: string,
  pluginRoot: string,
  diagnostics: string[],
): PluginPanelDecl[] {
  if (!existsSync(absPath)) {
    diagnostics.push("panels: 声明的文件不存在");
    return [];
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(absPath, "utf8"));
  } catch (err) {
    diagnostics.push(`panels: 解析失败（${err instanceof Error ? err.message : String(err)}）`);
    return [];
  }
  if (!Array.isArray(doc)) {
    diagnostics.push("panels: 顶层必须是数组");
    return [];
  }
  const out: PluginPanelDecl[] = [];
  const seen = new Set<string>();
  doc.forEach((item, i) => {
    if (!isRecord(item)) {
      diagnostics.push(`panels[${i}]: 条目必须是对象，已忽略`);
      return;
    }
    const id = asString(item.id);
    if (!id || !PANEL_ID_RE.test(id)) {
      diagnostics.push(`panels[${i}]: id 缺失或非法（需匹配 ${PANEL_ID_RE.source}），已忽略`);
      return;
    }
    if (seen.has(id)) {
      diagnostics.push(`panels[${i}]: 重复 id "${id}"，已忽略`);
      return;
    }
    const title = asString(item.title) ?? id;
    const entryRaw = asString(item.entry);
    if (!entryRaw) {
      diagnostics.push(`panels[${i}]: 缺少 entry，已忽略`);
      return;
    }
    const contained = containedRelPath(pluginRoot, entryRaw, `panels[${i}].entry`, diagnostics);
    if (!contained) return;
    if (!/\.html?$/i.test(contained)) {
      diagnostics.push(`panels[${i}]: entry 必须是 .html 文件（"${entryRaw}"），已忽略`);
      return;
    }
    const perms: PluginPanelPermission[] = [];
    if (Array.isArray(item.permissions)) {
      for (const p of item.permissions) {
        if (
          typeof p === "string" &&
          (PANEL_PERMISSIONS as readonly string[]).includes(p) &&
          !perms.includes(p as PluginPanelPermission)
        ) {
          perms.push(p as PluginPanelPermission);
        }
      }
    }
    const opens: string[] = [];
    if (Array.isArray(item.opens)) {
      for (const g of item.opens) {
        if (typeof g === "string" && g.trim()) opens.push(g.trim());
      }
    }
    const icon = asString(item.icon);
    let iconRel: string | undefined;
    if (icon) {
      if (/^(https?:|data:)/i.test(icon)) iconRel = icon;
      else iconRel = containedRelPath(pluginRoot, icon, `panels[${i}].icon`, diagnostics);
    }
    seen.add(id);
    out.push({
      id,
      title,
      ...(iconRel ? { icon: iconRel } : {}),
      entry: contained,
      opens,
      permissions: perms,
    });
  });
  return out;
}
