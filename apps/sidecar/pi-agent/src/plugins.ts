/**
 * 插件系统（插件市场）：skills / MCP / hooks / 子智能体四类组件的打包分发层。
 *
 * 插件 = 一个目录，清单在 .xulux-plugin/plugin.json（按序兼容探测 .claude-plugin/
 * .codex-plugin/，安装时规范化为内部形状）；组件是清单声明的相对路径：
 * skills（技能目录）/ mcpServers（mcpServers map json）/ hooks（json）/
 * subagents（子代理 YAML 目录）。本模块是叶子：只被四个子系统和协议层引用，
 * 不反向依赖（hooks 只取类型）。
 *
 * 身份与存储（应用数据目录 plugins/ 下，与 state.db 同族）：
 * - 插件身份 = `<name>@<marketplaceId>`；安装物化到 cache/<mktId>/<name>/
 *   （单版本，更新整体替换，组件级开关天然保留），元数据写 installed.json。
 * - 市场 = 含 marketplace.json 的目录（本地路径，或 git 仓库 clone 到
 *   repos/<mktId>/）；登记表 marketplaces.json，目录缓存 catalogs/<mktId>.json。
 * - 启用开关是"本机的运行时决定"：整包 SQLite kv（key = KV_KEY）的 disabled
 *   map（默认启用，显式关闭才记键，与 skills/MCP 同款）；卸载清残留。
 *
 * 合并语义（四链接入点见各子系统文件）：插件层在所有合并链中垫底——
 * 工作区 > 系统 > 插件，同名被遮蔽；插件级 enabled 门控全部组件，
 * 组件级开关沿用各子系统已有 kv（stateKey 带 pluginId 命名空间）。
 *
 * 耗时操作（git clone / refresh）由协议层异步受理，完成后自发
 * plugin_op_result 帧；本模块只暴露 await 语义的函数。
 *
 * 安全约束：组件路径必须相对且解析后不逃逸插件根；插件 MCP 只认标准字段
 * （approveTools 等 xulux 专属字段不可由插件携带）；hooks 决策语义与手配
 * 钩子完全一致（exit 2 / stdout JSON）。
 */
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { HookConfig, HookEventName } from "./hooks";
import { kvGet, kvSet } from "./hostdb";
import { logErr } from "./log";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 清单探测来源：xulux 原生，或两家生态清单规范化而来 */
export type PluginManifestKind = "xulux" | "claude" | "codex";

/** 规范化后的组件相对路径（全部经过包含性校验；未声明/非法的不出现） */
export type PluginComponents = {
  skills?: string;
  mcpServers?: string;
  hooks?: string;
  subagents?: string;
};

export type PluginManifest = {
  name: string;
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
  version: string;
  /** git 来源的短 revision（目录来源为内容签名，仅展示用） */
  revision?: string;
  installedAt: string;
  /** 来源市场已不在登记表中（插件保留可用，仅无更新通道） */
  sourceMissing: boolean;
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
  addedAt: string;
  lastRefresh?: string;
};

export type CatalogPluginEntry = {
  name: string;
  version?: string;
  description?: string;
  icon?: string;
  category?: string;
  keywords?: string[];
  /** 相对市场根的插件目录（含 .xulux-plugin 清单） */
  path: string;
};

export type MarketplaceCatalog = {
  name: string;
  displayName?: string;
  plugins: CatalogPluginEntry[];
};

export type MarketplaceCatalogCache = {
  catalog: MarketplaceCatalog;
  /** git 来源的短 revision */
  revision?: string;
  readAt: string;
};

// ---------------------------------------------------------------------------
// 路径解析（测试经 PI_PLUGINS_DIR 钉住；生产从 PI_DB_PATH 同级推导）
// ---------------------------------------------------------------------------

export function pluginsRootDir(): string {
  if (process.env.PI_PLUGINS_DIR) return resolve(process.env.PI_PLUGINS_DIR);
  const db = process.env.PI_DB_PATH;
  if (db) return join(resolve(db), "..", "plugins");
  return join(homedir(), ".xulux", "plugins");
}

export function marketplacesFilePath(): string {
  return join(pluginsRootDir(), "marketplaces.json");
}

function reposDir(): string {
  return join(pluginsRootDir(), "repos");
}

function marketplaceRepoDir(mktId: string): string {
  return join(reposDir(), mktId);
}

export function installedPluginDir(mktId: string, name: string): string {
  return join(pluginsRootDir(), "cache", mktId, name);
}

function catalogsDir(): string {
  return join(pluginsRootDir(), "catalogs");
}

function catalogCachePath(mktId: string): string {
  return join(catalogsDir(), `${mktId}.json`);
}

// ---------------------------------------------------------------------------
// 清单解析与生态兼容规范化
// ---------------------------------------------------------------------------

export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const MANIFEST_PROBES: Array<{ kind: PluginManifestKind; dir: string; file: string }> = [
  { kind: "xulux", dir: ".xulux-plugin", file: "plugin.json" },
  { kind: "claude", dir: ".claude-plugin", file: "plugin.json" },
  { kind: "codex", dir: ".codex-plugin", file: "plugin.json" },
];

const MANIFEST_NAME_KEY = "name";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * 组件相对路径包含性校验：拒绝绝对路径与 ".." 逃逸。返回规整后的相对路径
 * （正斜杠、去 "./" 前缀）；非法返回 undefined 并记诊断。
 */
function containedRelPath(
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
  const probe = MANIFEST_PROBES.find((p) => existsSync(join(root, p.dir, p.file)));
  if (!probe) {
    throw new Error(`${root}: 未找到插件清单（.xulux-plugin/plugin.json）`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(root, probe.dir, probe.file), "utf8"));
  } catch (err) {
    throw new Error(
      `${probe.dir}/${probe.file}: 解析失败（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  if (!isRecord(doc)) throw new Error(`${probe.dir}/${probe.file}: 顶层必须是对象`);

  const name = asString(doc[MANIFEST_NAME_KEY]);
  if (!name) throw new Error(`${probe.dir}/${probe.file}: 缺少 name`);
  if (!PLUGIN_NAME_RE.test(name)) {
    throw new Error(`${probe.dir}/${probe.file}: name 需匹配 ${PLUGIN_NAME_RE.source}`);
  }
  const dirName = options.dirName ?? basename(root);
  if (dirName !== name) {
    throw new Error(`${probe.dir}/${probe.file}: name（${name}）须与插件目录名（${dirName}）一致`);
  }

  const version = asString(doc.version) ?? "0.0.0";
  const authorRaw = doc.author;
  const author = isRecord(authorRaw)
    ? { name: asString(authorRaw.name), url: asString(authorRaw.url) }
    : undefined;

  // ---- 组件字段：原生取声明值；生态清单有默认位置兜底 ----
  const components: PluginComponents = {};
  const declared = (key: string): string | undefined => {
    const v = doc[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") {
      diagnostics.push(`${key}: 组件路径必须是字符串，已忽略`);
      return undefined;
    }
    return containedRelPath(root, v, key, diagnostics) ?? undefined;
  };

  if (probe.kind === "xulux") {
    const skills = declared("skills");
    if (skills) components.skills = skills;
    const mcpServers = declared("mcpServers");
    if (mcpServers) components.mcpServers = mcpServers;
    const hooks = declared("hooks");
    if (hooks) components.hooks = hooks;
    const subagents = declared("subagents");
    if (subagents) components.subagents = subagents;
    for (const key of Object.keys(doc)) {
      if (
        !["name", "version", "description", "author", "icon", "category", "keywords",
          "homepage", "license", "skills", "mcpServers", "hooks", "subagents"].includes(key)
      ) {
        diagnostics.push(`${probe.dir}/${probe.file}: 忽略未知字段 "${key}"`);
      }
    }
  } else {
    // 生态清单：skills 有默认目录；MCP 认根级 .mcp.json；hooks 认 hooks/hooks.json
    const skills = declared("skills") ?? (dirExists(root, "skills") ? "skills" : undefined);
    if (skills) components.skills = skills;
    if (probe.kind === "claude" && fileExists(root, ".mcp.json")) {
      components.mcpServers = ".mcp.json";
    }
    if (probe.kind === "codex" && fileExists(root, ".mcp.json")) {
      components.mcpServers = ".mcp.json";
    }
    const hooks = declared("hooks") ?? (fileExists(root, join("hooks", "hooks.json")) ? "hooks/hooks.json" : undefined);
    if (hooks) components.hooks = hooks;
    if (dirExists(root, "agents")) {
      unsupported.push("agents: 生态子智能体格式暂不支持（可在本应用内另建同名子智能体）");
    }
    // codex 的 interface/userConfig 等专属块整段忽略，不逐字段告警
    if (probe.kind === "claude") {
      for (const key of ["commands", "outputStyles", "lspServers", "monitors", "settings"]) {
        if (doc[key] !== undefined || (key === "commands" && dirExists(root, "commands"))) {
          unsupported.push(`${key}: 生态组件暂不支持`);
        }
      }
    }
  }

  // 声明了但实际不存在的组件目录：提示（安装照常，加载层自然为空）
  for (const [key, rel] of Object.entries(components)) {
    const abs = resolve(root, rel);
    const ok =
      key === "skills" || key === "subagents" ? dirExists(root, rel) : fileExists(root, rel);
    if (!ok) diagnostics.push(`${key}: 声明的路径 "${rel}" 不存在或类型不符（${abs}）`);
  }

  const icon = asString(doc.icon);
  const keywords = Array.isArray(doc.keywords)
    ? (doc.keywords as unknown[]).filter((k): k is string => typeof k === "string").slice(0, 16)
    : undefined;

  return {
    name,
    version,
    ...(asString(doc.description) ? { description: asString(doc.description) } : {}),
    ...(author && (author.name || author.url) ? { author } : {}),
    ...(icon && !isAbsolute(icon) ? { icon } : {}),
    ...(asString(doc.category) ? { category: asString(doc.category) } : {}),
    ...(keywords?.length ? { keywords } : {}),
    ...(asString(doc.homepage) ? { homepage: asString(doc.homepage) } : {}),
    ...(asString(doc.license) ? { license: asString(doc.license) } : {}),
    manifestKind: probe.kind,
    root,
    components,
    unsupported,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// hooks 文件读取（自有 HookConfig[] 与 Claude 形状二选一，按顶层形状判定）
// ---------------------------------------------------------------------------

const KNOWN_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
]);

type PluginHookEntry = Pick<HookConfig, "id" | "name" | "command" | "args" | "matcher" | "timeoutMs" | "event" | "enabled">;

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
      enabled: true,
      ...(Array.isArray(item.args) ? { args: item.args.filter((a): a is string => typeof a === "string") } : {}),
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
        if (!isRecord(h) || h.type !== "command" || typeof h.command !== "string" || !h.command.trim()) {
          continue;
        }
        const timeoutSec = typeof h.timeout === "number" && Number.isFinite(h.timeout) ? h.timeout : undefined;
        out.push({
          id: `${pluginId}:hook-${n}`,
          name: `${pluginName}:${n + 1}`,
          command: h.command,
          event: event as HookEventName,
          enabled: true,
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
  if (Array.isArray(doc)) return readHooksOurs(doc, pluginId, diagnostics);
  if (isRecord(doc)) return readHooksClaude(doc, pluginId, pluginName, diagnostics);
  diagnostics.push("hooks: 顶层必须是数组或对象");
  return [];
}

// ---------------------------------------------------------------------------
// 启用开关（kv 整包，默认启用，显式关闭记键）
// ---------------------------------------------------------------------------

export type PluginsEnabledState = { disabled: Record<string, true> };

export const PLUGINS_ENABLED_KV_KEY = "pi.plugins";

let enabledState: PluginsEnabledState = { disabled: {} };
let stateLoad: Promise<void> | undefined;

/** 启动装配调一次（index.ts 闸门内）；幂等 */
export function initPluginsState(): Promise<void> {
  stateLoad ??= (async () => {
    try {
      const row = await kvGet(PLUGINS_ENABLED_KV_KEY);
      if (!row?.value) return;
      const parsed = JSON.parse(row.value) as Partial<PluginsEnabledState>;
      enabledState = { disabled: (parsed.disabled ?? {}) as Record<string, true> };
    } catch (err) {
      logErr("plugins-state:", err instanceof Error ? err.message : String(err));
    }
  })();
  return stateLoad;
}

async function persistEnabledState(): Promise<void> {
  try {
    await kvSet(PLUGINS_ENABLED_KV_KEY, JSON.stringify(enabledState));
  } catch (err) {
    logErr("plugins-state save:", err instanceof Error ? err.message : String(err));
  }
}

export function isPluginEnabled(pluginId: string): boolean {
  return enabledState.disabled[pluginId] !== true;
}

/** 卸载/安装路径清残留键（不改其余记录） */
export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  await initPluginsState();
  if (enabled) delete enabledState.disabled[pluginId];
  else enabledState.disabled[pluginId] = true;
  await persistEnabledState();
  // 开关参与扫描缓存（enabled 字段）与各合并链签名：立即失效，下一次读取即生效
  invalidateCaches();
}

// ---------------------------------------------------------------------------
// 市场登记表（marketplaces.json，每次操作读盘——低频操作，不做缓存）
// ---------------------------------------------------------------------------

function readMarketplaceRecords(): MarketplaceRecord[] {
  const p = marketplacesFilePath();
  if (!existsSync(p)) return [];
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!isRecord(doc) || !Array.isArray(doc.marketplaces)) return [];
    return (doc.marketplaces as unknown[]).filter(isRecord).map((r) => ({
      id: String(r.id ?? ""),
      name: asString(r.name) ?? String(r.id ?? ""),
      type: r.type === "git" ? "git" : "directory",
      ...(typeof r.path === "string" ? { path: r.path } : {}),
      ...(typeof r.repo === "string" ? { repo: r.repo } : {}),
      addedAt: typeof r.addedAt === "string" ? r.addedAt : "",
      ...(typeof r.lastRefresh === "string" ? { lastRefresh: r.lastRefresh } : {}),
    }));
  } catch (err) {
    logErr("marketplaces.json:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function writeMarketplaceRecords(records: MarketplaceRecord[]): void {
  mkdirSync(pluginsRootDir(), { recursive: true });
  const doc = { version: 1, marketplaces: records };
  writeMarketplacesAtomic(marketplacesFilePath(), `${JSON.stringify(doc, null, 2)}\n`);
}

function writeMarketplacesAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function listMarketplaces(): MarketplaceRecord[] {
  return readMarketplaceRecords();
}

function sha8(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

/** 稳定市场 id：directory 按绝对路径、git 按仓库地址派生（重复添加幂等） */
export function marketplaceIdFor(type: MarketplaceType, source: string): string {
  const prefix = type === "git" ? "git" : "dir";
  return `${prefix}-${sha8(`${type}:${source}`)}`;
}

// ---------------------------------------------------------------------------
// 市场目录（marketplace.json 解析校验 + 目录缓存）
// ---------------------------------------------------------------------------

const MAX_CATALOG_PLUGINS = 128;

function parseMarketplaceCatalog(
  root: string,
): { ok: true; catalog: MarketplaceCatalog } | { ok: false; error: string } {
  // 清单位置探测：自有格式在市场根；Claude 系放 .claude-plugin/marketplace.json；
  // Codex 系放 .agents/plugins/marketplace.json（其个人/团队市场约定位置）
  const candidates = [
    join(root, "marketplace.json"),
    join(root, ".claude-plugin", "marketplace.json"),
    join(root, ".agents", "plugins", "marketplace.json"),
  ];
  const p = candidates.find((c) => existsSync(c));
  if (!p) {
    return { ok: false, error: `${root}: 未找到 marketplace.json（或 .claude-plugin/marketplace.json）` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    return { ok: false, error: `${p}: 解析失败（${err instanceof Error ? err.message : String(err)}）` };
  }
  if (!isRecord(doc)) return { ok: false, error: `${p}: 顶层必须是对象` };
  const name = asString(doc.name);
  if (!name) return { ok: false, error: `${p}: 缺少 name` };
  const rawPlugins = doc.plugins;
  if (!Array.isArray(rawPlugins)) return { ok: false, error: `${p}: plugins 必须是数组` };
  const plugins: CatalogPluginEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rawPlugins.slice(0, MAX_CATALOG_PLUGINS)) {
    if (!isRecord(raw)) continue;
    const entryName = asString(raw.name);
    if (!entryName) continue;
    if (seen.has(entryName)) continue;
    // source 四种写法（兼容 Claude 生态 marketplaces 的常见形状）：
    //   "./plugins/xxx"（相对路径字符串）
    //   { source: "directory" | "local", path: "./plugins/xxx" }（自有格式）
    //   { source: "./plugins/xxx" }（对象包路径字符串，Claude 生态变体）
    const src = raw.source;
    let relPath: string | undefined;
    if (typeof src === "string") {
      relPath = src;
    } else if (isRecord(src)) {
      if (typeof src.path === "string" && (src.source === "directory" || src.source === "local")) {
        relPath = src.path;
      } else if (typeof src.source === "string" && /^(\/|\.\/)/.test(src.source)) {
        relPath = src.source;
      }
    }
    if (!relPath) continue;
    const contained = containedRelPath(root, relPath, `plugins[${entryName}]`, []);
    if (!contained) continue;
    seen.add(entryName);
    plugins.push({
      name: entryName,
      path: contained,
      ...(asString(raw.version) ? { version: asString(raw.version) } : {}),
      ...(asString(raw.description) ? { description: asString(raw.description) } : {}),
      ...(asString(raw.icon) ? { icon: asString(raw.icon) } : {}),
      ...(asString(raw.category) ? { category: asString(raw.category) } : {}),
      ...(Array.isArray(raw.keywords)
        ? { keywords: (raw.keywords as unknown[]).filter((k): k is string => typeof k === "string").slice(0, 16) }
        : {}),
    });
  }
  return {
    ok: true,
    catalog: {
      name,
      ...(asString(doc.displayName) ? { displayName: asString(doc.displayName) } : {}),
      plugins,
    },
  };
}

function readCatalogCache(mktId: string): MarketplaceCatalogCache | undefined {
  const p = catalogCachePath(mktId);
  if (!existsSync(p)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!isRecord(doc) || !isRecord(doc.catalog) || !Array.isArray((doc.catalog as MarketplaceCatalog).plugins)) {
      return undefined;
    }
    return doc as MarketplaceCatalogCache;
  } catch {
    return undefined;
  }
}

function writeCatalogCache(mktId: string, cache: MarketplaceCatalogCache): void {
  mkdirSync(catalogsDir(), { recursive: true });
  writeFileSync(catalogCachePath(mktId), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// git 操作（spawn，不经 shell；clone 失败区分未安装 git）
// ---------------------------------------------------------------------------

function gitRun(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(new Error(err instanceof Error ? err.message : String(err)));
      return;
    }
    let stderr = "";
    const timer = setTimeout(
      () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
        reject(new Error(`git ${args[0]} 超时`));
      },
      opts.timeoutMs ?? 120_000,
    );
    timer.unref?.();
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.message.includes("ENOENT")) {
        reject(new Error("未找到 git 命令：添加 Git 仓库市场需要本机安装 git"));
        return;
      }
      reject(new Error(`git ${args[0]}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stderr);
        return;
      }
      reject(new Error(`git ${args[0]} 失败（exit ${code ?? "signal"}）：${stderr.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
}

async function cloneOrResetRepo(repo: string, dest: string): Promise<void> {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(reposDir(), { recursive: true });
  await gitRun(["clone", "--depth", "1", "--single-branch", repo, dest]);
}

/** rev-parse 短 hash：stdout 取值（失败/超时按未知 revision 处理） */
async function gitShortRevision(dir: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolvePromise(undefined);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < 64) out += chunk.toString("utf8");
    });
    child.on("error", () => resolvePromise(undefined));
    child.on("close", (code) => resolvePromise(code === 0 ? out.trim() || undefined : undefined));
  });
}

// ---------------------------------------------------------------------------
// 已装插件扫描（签名缓存；同步读取，init 后可用）
// ---------------------------------------------------------------------------

type ScanCache = { sig: string; plugins: InstalledPlugin[] };
let scanCache: ScanCache | undefined;

function cacheRootSignature(): string {
  const cacheDir = join(pluginsRootDir(), "cache");
  if (!existsSync(cacheDir)) return "";
  try {
    return readdirSync(cacheDir)
      .map((mkt) => {
        const mktDir = join(cacheDir, mkt);
        try {
          return `${mkt}:${readdirSync(mktDir).sort().join(",")}`;
        } catch {
          return `${mkt}:`;
        }
      })
      .sort()
      .join("|");
  } catch {
    return "";
  }
}

function scanInstalledSync(): InstalledPlugin[] {
  const sig = cacheRootSignature();
  if (scanCache && scanCache.sig === sig) return scanCache.plugins;

  const records = readMarketplaceRecords();
  const mktNames = new Map(records.map((r) => [r.id, r.name]));
  const plugins: InstalledPlugin[] = [];
  const cacheDir = join(pluginsRootDir(), "cache");
  if (!existsSync(cacheDir)) {
    scanCache = { sig, plugins: [] };
    return plugins;
  }
  for (const mktId of readdirSync(cacheDir).sort()) {
    const mktDir = join(cacheDir, mktId);
    let names: string[];
    try {
      names = readdirSync(mktDir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(mktDir, name);
      // 并发卸载的竞态：stat 失败按已消失处理，下次扫描自然收敛
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const pluginId = `${name}@${mktId}`;
      try {
        const manifest = parsePluginManifest(dir);
        let meta: Record<string, unknown> = {};
        const metaPath = join(dir, "installed.json");
        if (existsSync(metaPath)) {
          try {
            meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
          } catch {
            /* 坏元数据按缺省处理 */
          }
        }
        plugins.push({
          pluginId,
          mktId,
          mktName: mktNames.get(mktId) ?? mktId,
          name: manifest.name,
          version: asString(meta.version) ?? manifest.version,
          ...(typeof meta.revision === "string" && meta.revision ? { revision: meta.revision } : {}),
          installedAt: typeof meta.installedAt === "string" ? meta.installedAt : "",
          sourceMissing: !mktNames.has(mktId),
          enabled: isPluginEnabled(pluginId),
          manifest,
          diagnostics: manifest.diagnostics,
        });
      } catch (err) {
        plugins.push({
          pluginId,
          mktId,
          mktName: mktNames.get(mktId) ?? mktId,
          name,
          version: "0.0.0",
          installedAt: "",
          sourceMissing: !mktNames.has(mktId),
          enabled: isPluginEnabled(pluginId),
          manifest: {
            name,
            version: "0.0.0",
            manifestKind: "xulux",
            root: dir,
            components: {},
            unsupported: [],
            diagnostics: [],
          },
          diagnostics: [err instanceof Error ? err.message : String(err)],
        });
      }
    }
  }
  scanCache = { sig, plugins };
  return plugins;
}

/** 设置页/协议清单：全部已装插件（含禁用与坏清单，diagnostics 随行） */
export function listInstalledPlugins(): InstalledPlugin[] {
  return scanInstalledSync().map((p) => ({ ...p }));
}

/** 合并链用：启用的插件，pluginId 稳定排序（同名遮蔽顺序确定） */
export function activePlugins(): InstalledPlugin[] {
  return scanInstalledSync().filter((p) => p.enabled);
}

/** 插件根内组件绝对路径（再次包含性校验；未声明返回 undefined） */
export function resolvePluginComponent(
  manifest: PluginManifest,
  kind: keyof PluginComponents,
): string | undefined {
  const rel = manifest.components[kind];
  if (!rel) return undefined;
  const abs = resolve(manifest.root, rel);
  const rootWithSep = manifest.root.endsWith(sep) ? manifest.root : manifest.root + sep;
  if (!abs.startsWith(rootWithSep)) return undefined;
  return abs;
}

// ---------------------------------------------------------------------------
// 运行时钩子读取（hooks.ts 的 matchingHooks 每次调用；文件签名缓存兜底）
// ---------------------------------------------------------------------------

const hookCache = new Map<string, { sig: string; hooks: PluginHookEntry[] }>();

function fileSignature(path: string): string {
  try {
    const st = statSync(path);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return "";
  }
}

/** 生效插件的全部 hooks（合并链入口，同事件/matcher 过滤在 hooks.ts 侧做） */
export function activePluginHooks(): PluginHookEntry[] {
  const out: PluginHookEntry[] = [];
  for (const plugin of activePlugins()) {
    const file = resolvePluginComponent(plugin.manifest, "hooks");
    if (!file) continue;
    const sig = fileSignature(file);
    const cached = hookCache.get(plugin.pluginId);
    if (cached && cached.sig === sig) {
      out.push(...cached.hooks);
      continue;
    }
    const diagnostics: string[] = [];
    const hooks = readPluginHooksFile(file, plugin.pluginId, plugin.name, diagnostics);
    hookCache.set(plugin.pluginId, { sig, hooks });
    for (const d of diagnostics) logErr(`plugin ${plugin.pluginId}:`, d);
    out.push(...hooks);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 市场/安装操作（写路径）
// ---------------------------------------------------------------------------

function invalidateCaches(): void {
  scanCache = undefined;
  hookCache.clear();
  pluginsStateVersion += 1;
}

/**
 * 插件状态版本号：开关/安装/卸载/市场移除都会递增。MCP loadSync 把它并入
 * 文件签名——插件层缓存失效不能只靠文件 mtime（开关翻转不改任何文件）。
 */
let pluginsStateVersion = 0;

export function currentPluginsStateVersion(): number {
  return pluginsStateVersion;
}

export type AddMarketplaceInput = {
  type: MarketplaceType;
  /** directory 必填：市场根目录 */
  path?: string;
  /** git 必填：仓库地址 */
  repo?: string;
};

export type AddMarketplaceResult = { record: MarketplaceRecord; catalog: MarketplaceCatalog; revision?: string };

/** 添加并立即校验/刷新市场（git 含首次 clone，调用方负责耗时提示） */
export async function addMarketplace(input: AddMarketplaceInput): Promise<AddMarketplaceResult> {
  const type = input.type;
  const source = type === "git" ? input.repo?.trim() : input.path?.trim();
  if (!source) throw new Error(type === "git" ? "addMarketplace: repo is required" : "addMarketplace: path is required");
  if (type === "git" && !/^(https?:\/\/|git@|ssh:\/\/)/.test(source)) {
    throw new Error(`repo 需为 http(s)/ssh 地址（"${source}"）`);
  }

  const id = marketplaceIdFor(type, source);
  const records = readMarketplaceRecords();
  const existing = records.find((r) => r.id === id);

  let root: string;
  let revision: string | undefined;
  if (type === "directory") {
    root = resolve(source);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`市场目录不存在：${root}`);
    }
  } else {
    root = marketplaceRepoDir(id);
    await cloneOrResetRepo(source, root);
    revision = await gitShortRevision(root);
  }

  const parsed = parseMarketplaceCatalog(root);
  if (!parsed.ok) throw new Error(parsed.error);

  const record: MarketplaceRecord = {
    id,
    name: parsed.catalog.name,
    type,
    ...(type === "directory" ? { path: root } : { repo: source }),
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    lastRefresh: new Date().toISOString(),
  };
  const nextRecords = existing
    ? records.map((r) => (r.id === id ? record : r))
    : [...records, record];
  writeMarketplaceRecords(nextRecords);
  writeCatalogCache(id, { catalog: parsed.catalog, ...(revision ? { revision } : {}), readAt: record.lastRefresh ?? "" });
  return { record, catalog: parsed.catalog, ...(revision ? { revision } : {}) };
}

/** 移除市场登记（不卸载已装插件；git 工作副本一并清理） */
export function removeMarketplace(mktId: string): void {
  const records = readMarketplaceRecords();
  const next = records.filter((r) => r.id !== mktId);
  if (next.length === records.length) throw new Error(`未找到市场 "${mktId}"`);
  writeMarketplaceRecords(next);
  rmSync(marketplaceRepoDir(mktId), { recursive: true, force: true });
  rmSync(catalogCachePath(mktId), { force: true });
  invalidateCaches();
}

export type RefreshResult = { record: MarketplaceRecord; catalog: MarketplaceCatalog; revision?: string };

/** 刷新市场：directory 重读目录；git 重新浅克隆后重读（含更新检测所需的 revision） */
export async function refreshMarketplace(mktId: string): Promise<RefreshResult> {
  const record = readMarketplaceRecords().find((r) => r.id === mktId);
  if (!record) throw new Error(`未找到市场 "${mktId}"`);
  let root: string;
  let revision: string | undefined;
  if (record.type === "directory") {
    root = record.path ?? "";
    if (!root || !existsSync(root)) throw new Error(`市场目录不存在：${root}`);
  } else {
    root = marketplaceRepoDir(mktId);
    await cloneOrResetRepo(record.repo ?? "", root);
    revision = await gitShortRevision(root);
  }
  const parsed = parseMarketplaceCatalog(root);
  if (!parsed.ok) throw new Error(parsed.error);
  const lastRefresh = new Date().toISOString();
  writeMarketplaceRecords(
    readMarketplaceRecords().map((r) => (r.id === mktId ? { ...r, lastRefresh } : r)),
  );
  writeCatalogCache(mktId, { catalog: parsed.catalog, ...(revision ? { revision } : {}), readAt: lastRefresh });
  return { record, catalog: parsed.catalog, ...(revision ? { revision } : {}) };
}

/** 市场清单（含目录缓存；未刷新过的 git 市场返回空目录并标 needsRefresh） */
export function getMarketplaceCatalog(mktId: string): { catalog: MarketplaceCatalog; revision?: string; needsRefresh: boolean } {
  const cache = readCatalogCache(mktId);
  if (cache) return { catalog: cache.catalog, ...(cache.revision ? { revision: cache.revision } : {}), needsRefresh: false };
  return { catalog: { name: mktId, plugins: [] }, needsRefresh: true };
}

export type InstallResult = { plugin: InstalledPlugin; updated: boolean };

/**
 * 安装/更新：从市场源物化到 cache（目录直拷；git 市场从 repos 工作副本拷）。
 * 已装同 id 时整体替换（installed.json 重写，组件级开关不受影响）。
 */
export async function installPlugin(mktId: string, name: string): Promise<InstallResult> {
  const record = readMarketplaceRecords().find((r) => r.id === mktId);
  if (!record) throw new Error(`未找到市场 "${mktId}"`);
  let cache = readCatalogCache(mktId);
  if (!cache) {
    const refreshed = await refreshMarketplace(mktId);
    cache = { catalog: refreshed.catalog, ...(refreshed.revision ? { revision: refreshed.revision } : {}), readAt: new Date().toISOString() };
  }
  const entry = cache.catalog.plugins.find((p) => p.name === name);
  if (!entry) throw new Error(`市场 "${cache.catalog.name}" 中没有插件 "${name}"`);

  const sourceRoot =
    record.type === "directory" ? join(record.path ?? "", entry.path) : join(marketplaceRepoDir(mktId), entry.path);
  const rootWithSep = sourceRoot.endsWith(sep) ? sourceRoot : sourceRoot + sep;
  if (!existsSync(sourceRoot)) throw new Error(`插件源目录不存在：${sourceRoot}`);

  // 安装前先解析源清单（名字与目录名一致等硬校验在物化前拦截）
  const manifest = parsePluginManifest(sourceRoot);

  const dest = installedPluginDir(mktId, manifest.name);
  const updated = existsSync(dest);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(sourceRoot, dest, {
    recursive: true,
    filter: (src) => {
      // 排除 .git 与市场元数据；installed.json 由本函数最后写入
      if (src === join(dest, "installed.json")) return false;
      return !src.split(sep).includes(".git") && !src.startsWith(rootWithSep + ".git");
    },
  });

  // revision：git 市场取仓库短 hash；目录市场取内容签名（仅展示用）
  const revision =
    record.type === "git" ? await gitShortRevision(marketplaceRepoDir(mktId)) : `sig-${sha8(cacheRootSignatureOf(sourceRoot))}`;

  const installedAt = new Date().toISOString();
  const meta = {
    pluginId: `${manifest.name}@${mktId}`,
    name: manifest.name,
    marketplaceId: mktId,
    marketplaceName: record.name,
    version: entry.version ?? manifest.version,
    ...(revision ? { revision } : {}),
    installedAt,
  };
  writeFileSync(join(dest, "installed.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  invalidateCaches();

  const fresh = scanInstalledSync().find((p) => p.pluginId === meta.pluginId);
  if (!fresh) throw new Error(`安装后扫描未找到 ${meta.pluginId}（清单校验失败？）`);
  return { plugin: fresh, updated };
}

function cacheRootSignatureOf(dir: string): string {
  try {
    return readdirSync(dir)
      .sort()
      .map((n) => {
        try {
          const st = statSync(join(dir, n));
          return `${n}:${st.mtimeMs}:${st.size}`;
        } catch {
          return n;
        }
      })
      .join("|");
  } catch {
    return "";
  }
}

/** 卸载：删物化目录 + 清开关残留。组件级 kv 残留由各子系统 stateKey 天然失配，无需清理 */
export async function uninstallPlugin(pluginId: string): Promise<void> {
  const at = pluginId.lastIndexOf("@");
  if (at <= 0) throw new Error(`非法插件身份 "${pluginId}"`);
  const name = pluginId.slice(0, at);
  const mktId = pluginId.slice(at + 1);
  const dir = installedPluginDir(mktId, name);
  if (!existsSync(dir)) throw new Error(`未找到已装插件 "${pluginId}"`);
  rmSync(dir, { recursive: true, force: true });
  await setPluginEnabled(pluginId, true); // 删除 disabled 记录（= 恢复默认启用，键消失）
  invalidateCaches();
}

/** 测试钩子：清内存缓存与 kv 装载（不删磁盘文件） */
export function resetPluginsForTest(): void {
  enabledState = { disabled: {} };
  stateLoad = undefined;
  scanCache = undefined;
  hookCache.clear();
}
