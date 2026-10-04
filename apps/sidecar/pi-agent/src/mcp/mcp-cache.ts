/**
 * MCP 工具元数据缓存：断连状态下 search/describe 可用（代理模式的体验关键）。
 *
 * 缓存文件 `~/.kova/mcp-cache.json`（PI_MCP_CACHE_PATH 可覆盖，测试用），条目按
 * 服务器名键控，携带配置哈希——配置（command/args/env/url/headers）变了即失效，
 * 避免给模型看陈旧的工具面。TTL 7 天；每次成功握手后全量更新该服务器条目。
 *
 * 进程内常驻内存副本，写穿落盘；读取失败降级为空缓存（下次握手重建），不阻断主流程。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { McpServerDef } from "./mcp-config";
import { logErr } from "../log";

/** 单条缓存的工具元数据（协议应答与搜索共用） */
export type McpToolMeta = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type CacheEntry = {
  configHash: string;
  tools: McpToolMeta[];
  cachedAt: number;
};

type CacheFile = { version: 1; servers: Record<string, CacheEntry> };

const CACHE_VERSION = 1;
/** 元数据最长可信期：协议未声明 ttl 时兜底 */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function cachePath(): string {
  if (process.env.PI_MCP_CACHE_PATH) return process.env.PI_MCP_CACHE_PATH;
  return join(homedir(), ".kova", "mcp-cache.json");
}

/**
 * 配置哈希：只覆盖影响工具面的字段（lifecycle/idleTimeout 等连接策略不影响
 * 工具清单，参与哈希反而会让无意义的重连抖动缓存）。
 */
export function computeConfigHash(def: McpServerDef): string {
  const material = JSON.stringify({
    transport: def.transport,
    command: def.command ?? null,
    args: def.args ?? null,
    env: def.env ?? null,
    url: def.url ?? null,
    headers: def.headers ?? null,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

let cache: CacheFile = { version: CACHE_VERSION, servers: {} };
let loaded = false;

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(cachePath())) return;
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as Partial<CacheFile>;
    if (parsed.version !== CACHE_VERSION || typeof parsed.servers !== "object" || !parsed.servers) {
      return;
    }
    cache = { version: CACHE_VERSION, servers: parsed.servers };
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

/** 命中条件：配置哈希一致且未过 TTL。返回工具元数据副本（调用方可安全改写） */
export function getValidTools(def: McpServerDef): McpToolMeta[] | null {
  loadOnce();
  const entry = cache.servers[def.name];
  if (!entry) return null;
  if (entry.configHash !== computeConfigHash(def)) return null;
  if (Date.now() - entry.cachedAt > CACHE_MAX_AGE_MS) return null;
  return entry.tools.map((t) => ({ ...t }));
}

/** 握手成功后全量更新该服务器条目并落盘 */
export function updateTools(def: McpServerDef, tools: McpToolMeta[]): void {
  loadOnce();
  cache.servers[def.name] = {
    configHash: computeConfigHash(def),
    tools: tools.map((t) => ({ ...t })),
    cachedAt: Date.now(),
  };
  persist();
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
