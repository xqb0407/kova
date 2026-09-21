/**
 * 插件清单解析与生态兼容规范化（纯函数，无运行时状态）：
 * 清单三态探测（.xulux-plugin / .claude-plugin / .codex-plugin）、组件路径
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

export function installedPluginDir(mktId: string, name: string): string {
  return join(pluginsRootDir(), "cache", mktId, name);
}

/**
 * AI 脚手架的专属 dev 市场（plugins_scaffold 落盘目标）：固定在本机插件根下，
 * 首次 scaffold 时自动登记为 directory 市场，之后用户在市场 UI 一键刷新安装。
 */
export function devMarketplaceDir(): string {
  return join(pluginsRootDir(), "dev-marketplace");
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

  const rawIcon =
    asString(doc.icon) ??
    (isRecord(doc.interface)
      ? asString(doc.interface.composerIcon) ?? asString(doc.interface.logo)
      : undefined);
  const keywords = Array.isArray(doc.keywords)
    ? (doc.keywords as unknown[]).filter((k): k is string => typeof k === "string").slice(0, 16)
    : undefined;

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
    name,
    version,
    ...(asString(doc.description) ? { description: asString(doc.description) } : {}),
    ...(author && (author.name || author.url) ? { author } : {}),
    ...(icon ? { icon } : {}),
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

export type PluginHookEntry = Pick<HookConfig, "id" | "name" | "command" | "args" | "matcher" | "timeoutMs" | "event" | "enabled">;

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
