/**
 * MCP 元数据缓存：断连状态下 search/describe/资源列表可用（代理模式的体验关键）。
 *
 * 缓存文件 `~/.kova/mcp-cache.json`（PI_MCP_CACHE_PATH 可覆盖，测试用），条目按
 * 服务器名键控，携带配置哈希——配置（command/args/env/url/headers）变了即失效，
 * 避免给模型看陈旧的工具/资源/Prompt 面。TTL 7 天；每次成功握手后全量更新该
 * 服务器条目。
 *
 * v2 在 v1 的 tools 基础上增加 resources / resourceTemplates / prompts /
 * capabilities；v1 文件读取时原地迁移（工具面保留，新能力为空），下一次写入
 * 落成 v2。进程内常驻内存副本，写穿落盘；读取失败降级为空缓存（下次握手重建），
 * 不阻断主流程。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  McpCapabilityFlags,
  McpPromptArgument,
  McpPromptMeta,
  McpResourceMeta,
  McpResourceSnapshot,
  McpResourceTemplateMeta,
} from "pi-protocol";
import type { McpServerDef } from "./mcp-config";
import { logErr } from "../log";

/** 单条缓存的工具元数据（协议应答与搜索共用） */
export type McpToolMeta = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/** 一台服务器在一次成功握手中拿到的全部元数据 */
export type McpServerMeta = McpResourceSnapshot & {
  tools: McpToolMeta[];
  prompts: McpPromptMeta[];
  capabilities: McpCapabilityFlags;
};

type CacheEntry = McpServerMeta & {
  configHash: string;
  cachedAt: number;
};

type CacheFile = { version: 2; servers: Record<string, CacheEntry> };
type LegacyCacheEntry = {
  configHash: string;
  tools: McpToolMeta[];
  cachedAt: number;
};
type LegacyCacheFile = { version: 1; servers: Record<string, LegacyCacheEntry> };

const CACHE_VERSION = 2;
/** 元数据最长可信期：协议未声明 ttl 时兜底 */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 缓存上限：与 manager 的握手截断同量级，防坏文件撑爆内存/磁盘 */
const MAX_CACHED_TOOLS = 64;
const MAX_CACHED_RESOURCES = 200;
const MAX_CACHED_PROMPTS = 100;
const MAX_TEXT = 2_000;

export function cachePath(): string {
  if (process.env.PI_MCP_CACHE_PATH) return process.env.PI_MCP_CACHE_PATH;
  return join(homedir(), ".kova", "mcp-cache.json");
}

/** 空能力集（每次返回新对象，避免调用方互相污染） */
export function emptyMcpCapabilities(): McpCapabilityFlags {
  return { resources: false, prompts: false, tasks: false };
}

/** 空元数据（未连接/迁移 v1 时使用） */
export function emptyMcpServerMeta(): McpServerMeta {
  return {
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    capabilities: emptyMcpCapabilities(),
  };
}

/**
 * 配置哈希：只覆盖影响工具面的字段（lifecycle/idleTimeout 等连接策略不影响
 * 工具清单，参与哈希反而会让无意义的重连抖动缓存）。
 */
export function computeConfigHash(def: McpServerDef): string {
  // env/headers 的键序不影响子进程语义，先规范化再哈希：否则在设置页调整
  // 环境变量行的顺序会平白改变哈希，导致密钥绑定失效/连接重连。
  const canonicalMap = (map: Record<string, string> | undefined) => {
    if (!map) return null;
    const keys = Object.keys(map).sort();
    if (keys.length === 0) return null;
    return Object.fromEntries(keys.map((k) => [k, map[k]]));
  };
  const material = JSON.stringify({
    transport: def.transport,
    command: def.command ?? null,
    args: def.args ?? null,
    env: canonicalMap(def.env),
    url: def.url ?? null,
    headers: canonicalMap(def.headers),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

let cache: CacheFile = { version: CACHE_VERSION, servers: {} };
let loaded = false;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_TEXT);
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** 缓存文件是可手改的本机文件：所有字段按宽松校验，坏条目丢弃而不是抛错 */
function normalizeTool(raw: unknown): McpToolMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name);
  if (!name) return null;
  const description = text(r.description);
  return {
    name,
    ...(description ? { description } : {}),
    ...(r.inputSchema !== undefined ? { inputSchema: r.inputSchema } : {}),
  };
}

function normalizeResource(raw: unknown): McpResourceMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const uri = text(r.uri);
  const name = text(r.name);
  if (!uri || !name) return null;
  const title = text(r.title);
  const description = text(r.description);
  const mimeType = text(r.mimeType);
  const size = integer(r.size);
  return {
    uri,
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}

function normalizeResourceTemplate(raw: unknown): McpResourceTemplateMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const uriTemplate = text(r.uriTemplate);
  const name = text(r.name);
  if (!uriTemplate || !name) return null;
  const title = text(r.title);
  const description = text(r.description);
  const mimeType = text(r.mimeType);
  return {
    uriTemplate,
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

function normalizePromptArgument(raw: unknown): McpPromptArgument | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name);
  if (!name) return null;
  const description = text(r.description);
  return {
    name,
    ...(description ? { description } : {}),
    ...(r.required === true ? { required: true } : {}),
  };
}

function normalizePrompt(raw: unknown): McpPromptMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name);
  if (!name) return null;
  const title = text(r.title);
  const description = text(r.description);
  const args = Array.isArray(r.arguments)
    ? r.arguments
        .map(normalizePromptArgument)
        .filter((a): a is McpPromptArgument => a !== null)
    : undefined;
  return {
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(args && args.length > 0 ? { arguments: args } : {}),
  };
}

function normalizeCapabilities(raw: unknown): McpCapabilityFlags {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    resources: r.resources === true,
    prompts: r.prompts === true,
    tasks: r.tasks === true,
  };
}

function normalizeMeta(raw: Record<string, unknown>): McpServerMeta {
  const tools = Array.isArray(raw.tools)
    ? raw.tools
        .map(normalizeTool)
        .filter((t): t is McpToolMeta => t !== null)
        .slice(0, MAX_CACHED_TOOLS)
    : [];
  const resources = Array.isArray(raw.resources)
    ? raw.resources
        .map(normalizeResource)
        .filter((r): r is McpResourceMeta => r !== null)
        .slice(0, MAX_CACHED_RESOURCES)
    : [];
  const resourceTemplates = Array.isArray(raw.resourceTemplates)
    ? raw.resourceTemplates
        .map(normalizeResourceTemplate)
        .filter((r): r is McpResourceTemplateMeta => r !== null)
        .slice(0, MAX_CACHED_RESOURCES)
    : [];
  const prompts = Array.isArray(raw.prompts)
    ? raw.prompts
        .map(normalizePrompt)
        .filter((p): p is McpPromptMeta => p !== null)
        .slice(0, MAX_CACHED_PROMPTS)
    : [];
  const capabilities = normalizeCapabilities(raw.capabilities);
  // v2 早期/手改文件可能只有数组没有 flags：以内容反推，避免 UI 明明有数据却
  // 被 capability=false 挡住。真正的“零资源但声明了能力”仍由显式 flags 保留。
  capabilities.resources ||= resources.length > 0 || resourceTemplates.length > 0;
  capabilities.prompts ||= prompts.length > 0;
  return { tools, resources, resourceTemplates, prompts, capabilities };
}

function normalizeEntry(raw: unknown): CacheEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const configHash = text(r.configHash);
  const cachedAt = integer(r.cachedAt);
  if (!configHash || cachedAt === undefined) return null;
  return { configHash, cachedAt, ...normalizeMeta(r) };
}

function migrateLegacy(parsed: LegacyCacheFile): Record<string, CacheEntry> {
  const servers: Record<string, CacheEntry> = {};
  for (const [name, raw] of Object.entries(parsed.servers ?? {})) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LegacyCacheEntry;
    const configHash = text(entry.configHash);
    const cachedAt = integer(entry.cachedAt);
    if (!configHash || cachedAt === undefined) continue;
    const tools = Array.isArray(entry.tools)
      ? entry.tools
          .map(normalizeTool)
          .filter((t): t is McpToolMeta => t !== null)
          .slice(0, MAX_CACHED_TOOLS)
      : [];
    servers[name] = {
      configHash,
      cachedAt,
      ...emptyMcpServerMeta(),
      tools,
    };
  }
  return servers;
}

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(cachePath())) return;
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as {
      version?: unknown;
      servers?: unknown;
    };
    if (typeof parsed.servers !== "object" || parsed.servers === null) return;
    if (parsed.version === 1) {
      cache = {
        version: CACHE_VERSION,
        servers: migrateLegacy(parsed as LegacyCacheFile),
      };
      // 迁移后立刻落成 v2：下次进程启动不再重复走迁移，用户也能直接看到新形状。
      persist();
      return;
    }
    if (parsed.version !== CACHE_VERSION) return;
    const servers: Record<string, CacheEntry> = {};
    for (const [name, raw] of Object.entries(parsed.servers as Record<string, unknown>)) {
      const entry = normalizeEntry(raw);
      if (entry) servers[name] = entry;
    }
    cache = { version: CACHE_VERSION, servers };
  } catch (err) {
    logErr("mcp-cache: load failed:", err instanceof Error ? err.message : String(err));
  }
}

function persist(): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), "utf8");
  } catch (err) {
    logErr("mcp-cache: persist failed:", err instanceof Error ? err.message : String(err));
  }
}

/** 有效条目：配置哈希一致且未过 TTL；返回副本，调用方可安全改写 */
function validEntry(def: McpServerDef): CacheEntry | null {
  loadOnce();
  const entry = cache.servers[def.name];
  if (!entry) return null;
  if (entry.configHash !== computeConfigHash(def)) return null;
  if (Date.now() - entry.cachedAt > CACHE_MAX_AGE_MS) return null;
  return entry;
}

function cloneMeta(entry: McpServerMeta): McpServerMeta {
  return {
    tools: entry.tools.map((t) => ({ ...t })),
    resources: entry.resources.map((r) => ({ ...r })),
    resourceTemplates: entry.resourceTemplates.map((r) => ({ ...r })),
    prompts: entry.prompts.map((p) => ({
      ...p,
      ...(p.arguments ? { arguments: p.arguments.map((a) => ({ ...a })) } : {}),
    })),
    capabilities: { ...entry.capabilities },
  };
}

/** 命中条件：配置哈希一致且未过 TTL。返回全部元数据副本 */
export function getValidServerMeta(def: McpServerDef): McpServerMeta | null {
  const entry = validEntry(def);
  return entry ? cloneMeta(entry) : null;
}

/** 工具元数据（search/describe 与设置页使用） */
export function getValidTools(def: McpServerDef): McpToolMeta[] | null {
  return getValidServerMeta(def)?.tools ?? null;
}

/** 资源快照（设置页/网关离线读取使用）；无有效条目返回 null */
export function getValidResources(def: McpServerDef): McpResourceSnapshot | null {
  const meta = getValidServerMeta(def);
  return meta ? { resources: meta.resources, resourceTemplates: meta.resourceTemplates } : null;
}

/** Prompt 元数据；无有效条目返回 null */
export function getValidPrompts(def: McpServerDef): McpPromptMeta[] | null {
  return getValidServerMeta(def)?.prompts ?? null;
}

/** 握手成功后全量更新该服务器条目并落盘 */
export function updateServerMeta(def: McpServerDef, meta: McpServerMeta): void {
  loadOnce();
  cache.servers[def.name] = {
    configHash: computeConfigHash(def),
    cachedAt: Date.now(),
    ...cloneMeta(normalizeMeta(meta as unknown as Record<string, unknown>)),
  };
  persist();
}

/** 只更新工具面（测试/旧调用）；已有 resources/prompts 保留 */
export function updateTools(def: McpServerDef, tools: McpToolMeta[]): void {
  const prev = validEntry(def) ?? emptyMcpServerMeta();
  updateServerMeta(def, { ...cloneMeta(prev), tools });
}

/** 服务器定义被删除时清掉残留缓存 */
export function dropServer(name: string): void {
  loadOnce();
  if (!(name in cache.servers)) return;
  delete cache.servers[name];
  persist();
}

/** 测试钩子：清内存缓存状态（文件由测试自管） */
export function resetMcpCacheForTest(): void {
  cache = { version: CACHE_VERSION, servers: {} };
  loaded = false;
}
