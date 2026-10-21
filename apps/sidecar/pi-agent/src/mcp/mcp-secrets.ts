/**
 * MCP 密钥注入绑定（用户级）。
 *
 * 安全边界：
 * - 绑定只存 SQLite kv（`pi.mcp.secretBindings`），**绝不从 `.mcp.json` /
 *   `.kova/mcp.json` / 插件清单读取**。工作区文件跟着仓库走，不能自己给自己授权。
 * - 每条绑定记录保存时的 effective configHash（只覆盖 transporter/command/args/
 *   env/url/headers）。工作区覆盖或手工改配置都会改变哈希，绑定立即失效；不会
 *   出现“同名服务器换了启动命令，却继续拿到原来那批密钥”。
 * - 只接受 global 作用域的密钥：MCP 连接池按服务器名跨会话共享，工作区作用域的
 *   密钥属于具体目录，塞进全局子进程会产生“哪个工作区的值”的歧义。
 * - 值不落配置、不进日志。握手前把 envName → secretName 的请求交给宿主解密，
 *   宿主只回 env 映射；子进程启动后只保留值用于输出脱敏。
 */
import { computeConfigHash } from "./mcp-cache";
import type { McpServerDef } from "./mcp-config";
import {
  kvGet,
  kvSet,
  secretEnvResolve,
  type McpSecretEnvRequest,
} from "../storage/hostdb";
import { logErr } from "../log";

export const MCP_SECRET_BINDINGS_KV_KEY = "pi.mcp.secretBindings";

const VERSION = 1;
const MAX_SERVERS = 64;
const MAX_ENV = 32;
/** 与 secret 名 / MCP ENV_KEY_RE 同款：它将成为子进程环境变量名 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export type McpSecretBinding = {
  envName: string;
  name: string;
  scope: "global";
};

export type McpServerSecretBinding = {
  configHash: string;
  env: McpSecretBinding[];
};

type BindingState = {
  version: 1;
  servers: Record<string, McpServerSecretBinding>;
};

export type McpResolvedSecret = { name: string; value: string };

export type McpResolvedSecretEnv = {
  env: Record<string, string>;
  values: McpResolvedSecret[];
};

function emptyState(): BindingState {
  return { version: VERSION, servers: Object.create(null) as Record<string, McpServerSecretBinding> };
}

let state: BindingState = emptyState();
let loaded = false;
let loading: Promise<void> | undefined;

function isValidEnvName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && ENV_NAME_RE.test(name);
}

function normalizeEnv(raw: unknown): McpSecretBinding[] {
  if (!Array.isArray(raw)) return [];
  const out: McpSecretBinding[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_ENV)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const envName = typeof r.envName === "string" ? r.envName.trim() : "";
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const scope = r.scope === undefined ? "global" : r.scope;
    if (!isValidEnvName(envName) || !isValidEnvName(name) || scope !== "global") continue;
    if (seen.has(envName)) continue;
    seen.add(envName);
    out.push({ envName, name, scope: "global" });
  }
  return out;
}

function normalizeState(raw: unknown): BindingState {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const serversRaw =
    r.servers && typeof r.servers === "object" && !Array.isArray(r.servers)
      ? (r.servers as Record<string, unknown>)
      : {};
  const servers = Object.create(null) as Record<string, McpServerSecretBinding>;
  for (const [server, value] of Object.entries(serversRaw).slice(0, MAX_SERVERS)) {
    if (!SERVER_NAME_RE.test(server) || !value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const configHash = typeof v.configHash === "string" ? v.configHash : "";
    if (!/^[0-9a-f]{32}$/.test(configHash)) continue;
    const env = normalizeEnv(v.env);
    if (env.length === 0) continue;
    servers[server] = { configHash, env };
  }
  return { version: VERSION, servers };
}

/** 启动时载入（index.ts 闸门内调用）；幂等，读取失败按空绑定处理 */
export async function initMcpSecretBindings(): Promise<void> {
  if (loaded) return;
  loading ??= (async () => {
    try {
      const row = await kvGet(MCP_SECRET_BINDINGS_KV_KEY);
      if (row?.value) state = normalizeState(JSON.parse(row.value));
    } catch (err) {
      logErr("mcp-secrets: config load failed:", err instanceof Error ? err.message : String(err));
    } finally {
      loaded = true;
    }
  })().finally(() => {
    loading = undefined;
  });
  await loading;
}

/** 测试钩子：清内存状态（kv 由测试自管） */
export function resetMcpSecretBindingsForTest(): void {
  state = emptyState();
  loaded = false;
  loading = undefined;
}

function activeFor(def: McpServerDef): McpServerSecretBinding | null {
  if (def.transport !== "stdio") return null;
  const binding = state.servers[def.name];
  if (!binding) return null;
  if (binding.configHash !== computeConfigHash(def)) return null;
  return binding;
}

/**
 * 当前生效的绑定（configHash 必须与 effective def 一致）。
 * 返回副本，调用方不能改内存状态。
 */
export async function mcpSecretBindingFor(
  def: McpServerDef,
): Promise<McpServerSecretBinding | null> {
  await initMcpSecretBindings();
  const binding = activeFor(def);
  return binding ? { configHash: binding.configHash, env: binding.env.map((e) => ({ ...e })) } : null;
}

/**
 * 是否存在“曾经绑过、但当前配置已变”的绑定。设置页据此提示需要重新确认；
 * 管理器不会用它注入任何东西（activeFor 返回 null）。
 */
export async function mcpSecretBindingStale(def: McpServerDef): Promise<boolean> {
  await initMcpSecretBindings();
  const binding = state.servers[def.name];
  if (!binding) return false;
  if (def.transport !== "stdio") return true;
  return binding.configHash !== computeConfigHash(def);
}

/** 保存某台服务器的绑定（空数组 = 解除绑定）。校验失败抛错，不静默丢条目。 */
export async function saveMcpSecretBindings(
  def: McpServerDef,
  raw: unknown,
): Promise<void> {
  await initMcpSecretBindings();
  if (def.transport !== "stdio") {
    if (Array.isArray(raw) && raw.length === 0) {
      await deleteMcpSecretBinding(def.name);
      return;
    }
    throw new Error(`MCP 服务器 "${def.name}" 不是本地进程，不能配置环境变量密钥`);
  }
  if (!Array.isArray(raw)) throw new Error("secretEnv 必须是数组");
  if (raw.length > MAX_ENV) throw new Error(`密钥绑定最多 ${MAX_ENV} 条`);

  const env: McpSecretBinding[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error("secretEnv 条目必须是对象");
    const r = item as Record<string, unknown>;
    const envName = typeof r.envName === "string" ? r.envName.trim() : "";
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const scope = r.scope === undefined ? "global" : r.scope;
    if (!isValidEnvName(envName)) {
      throw new Error("密钥环境变量名必须匹配 [A-Za-z_][A-Za-z0-9_]*");
    }
    if (!isValidEnvName(name)) {
      throw new Error(`密钥名 "${name}" 不合法`);
    }
    if (scope !== "global") {
      throw new Error("MCP 只能使用全局作用域的密钥（连接池跨工作区共享）");
    }
    if (seen.has(envName)) throw new Error(`环境变量 "${envName}" 重复绑定`);
    seen.add(envName);
    env.push({ envName, name, scope: "global" });
  }

  if (env.length === 0) {
    await deleteMcpSecretBinding(def.name);
    return;
  }
  if (!state.servers[def.name] && Object.keys(state.servers).length >= MAX_SERVERS) {
    throw new Error(`密钥绑定最多覆盖 ${MAX_SERVERS} 台服务器，请先清理不再使用的绑定`);
  }
  const previous = state.servers[def.name];
  state.servers[def.name] = { configHash: computeConfigHash(def), env };
  try {
    await persist();
  } catch (err) {
    if (previous) state.servers[def.name] = previous;
    else delete state.servers[def.name];
    throw err;
  }
}

/** 删除一台服务器的绑定（服务器删除/改名时清理） */
export async function deleteMcpSecretBinding(name: string): Promise<void> {
  await initMcpSecretBindings();
  if (!(name in state.servers)) return;
  const previous = state.servers[name];
  delete state.servers[name];
  try {
    await persist();
  } catch (err) {
    state.servers[name] = previous;
    throw err;
  }
}

async function persist(): Promise<void> {
  try {
    await kvSet(MCP_SECRET_BINDINGS_KV_KEY, JSON.stringify(state));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logErr("mcp-secrets: config persist failed:", message);
    throw new Error(`密钥绑定保存失败：${message}`);
  }
}

/**
 * 握手前解析要注入的环境变量。返回 null = 没有生效绑定。
 * 宿主只回已命中的 env；解不开/不存在/作用域不符的条目静默跳过（由 MCP 服务器
 * 自己报缺凭据），绝不会拿另一个同名密钥顶替。
 */
export async function resolveMcpSecretEnvForSpawn(
  def: McpServerDef,
): Promise<McpResolvedSecretEnv | null> {
  const binding = await mcpSecretBindingFor(def);
  if (!binding) return null;
  const requests: McpSecretEnvRequest[] = binding.env.map((b) => ({
    envName: b.envName,
    name: b.name,
    scope: b.scope,
  }));
  try {
    const res = await secretEnvResolve(def.name, requests);
    const env = Object.create(null) as Record<string, string>;
    const values: McpResolvedSecret[] = [];
    const seen = new Set<string>();
    for (const request of requests) {
      const value = res?.env?.[request.envName];
      if (typeof value !== "string" || value.length === 0) continue;
      env[request.envName] = value;
      if (!seen.has(request.name)) {
        seen.add(request.name);
        values.push({ name: request.name, value });
      }
    }
    if (Object.keys(env).length === 0) return null;
    return { env, values };
  } catch (err) {
    // 宿主不可用/旧宿主未实现该查询：不阻断服务器启动，但绝不伪造值
    logErr(
      `mcp-secrets: resolve failed for "${def.name}":`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/* ------------------------------ 输出脱敏 ------------------------------ */

const REDACT_MIN_LEN = 8;
const BINARY_KEYS = new Set(["data", "base64", "mimeType"]);

/** 文本中的密钥原值 + base64 变体 → [REDACTED:<NAME>]；短值（<8）跳过 */
export function redactMcpSecretText(
  text: string,
  values: readonly McpResolvedSecret[],
): string {
  let out = text;
  for (const { name, value } of [...values].sort((a, b) => b.value.length - a.value.length)) {
    if (Array.from(value).length < REDACT_MIN_LEN) continue;
    const marker = `[REDACTED:${name}]`;
    if (out.includes(value)) out = out.split(value).join(marker);
    const b64 = Buffer.from(value, "utf8").toString("base64");
    if (b64 !== value && out.includes(b64)) out = out.split(b64).join(marker);
  }
  return out;
}

/**
 * MCP 工具结果深脱敏：文本/结构化字段都换掉，图片 `data`/`mimeType` 保持原样
 * （改 base64 会破坏图片，且图片块不是密钥的常规出口）。
 */
export function redactMcpSecretValue<T>(
  value: T,
  secrets: readonly McpResolvedSecret[],
): T {
  if (secrets.length === 0) return value;
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string") {
      return key && BINARY_KEYS.has(key) ? v : redactMcpSecretText(v, secrets);
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, null));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(item, k);
      }
      return out;
    }
    return v;
  };
  return walk(value, null) as T;
}
