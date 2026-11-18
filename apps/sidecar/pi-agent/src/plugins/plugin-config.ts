/**
 * 插件装后配置（「在 Kova 里完成配置」的平台层）。
 *
 * 分工（插件不再自行读配置文件/钥匙串，见 manifest 的 config 声明）：
 * - 非敏感值（string/enum）→ SQLite kv `pi.plugin.config`（pluginId 分桶）；
 *   loadSync 合并插件层 def 时并入 def.env（注入点见 mcp-config.ts）。
 * - 敏感值（secret）→ hostdb 密钥库（Rust AES-256-GCM + OS keychain 主密钥，
 *   明文永不回 RPC），自动建立两层绑定：
 *   · mcp-secrets：挂插件 MCP 服务器名（stdio→env 绑定 / http→headers 绑定，
 *     configHash 门控语义不变）
 *   · secrets-env：授给插件技能名单（bash 信封只挂密钥名，Rust 解密+输出脱敏）
 *
 * 三态（configState，给 UI）：
 * - configured：required 全有值，且绑定 configHash 未失配
 * - missing：required 有缺（keys 列出）
 * - stale：值都在但绑定失配/丢失（典型：插件升级后 def 变化）——UI「一键重新绑定」
 *
 * 生命周期：保存即热重载（invalidateCaches 递增 pluginsStateVersion，loadSync
 * 签名失效）；升级时 kv 与密钥值保留（stale 接管）；卸载时全清（purge）。
 */
import { createHash } from "node:crypto";
import { kvGet, kvSet, secretDelete, secretList, secretSet } from "../storage/hostdb";
import { applySecretsConfig, getSecretsConfig } from "../secrets/secrets";
import {
  deleteMcpSecretBinding,
  mcpSecretBindingFor,
  mcpSecretBindingStale,
  saveMcpSecretBindings,
} from "../mcp/mcp-secrets";
import { invalidateCaches } from "./store";
import { loadMcpServers } from "../mcp/mcp-config";
import type { McpServerDef } from "../mcp/mcp-config";
import type { PluginConfigField, PluginManifest } from "./manifest";

/** 整包 kv 键：pluginId 分桶的一张 map（与 mcp-secrets/secrets 的 kv 同族） */
export const PLUGIN_CONFIG_KV_KEY = "pi.plugin.config";

const MAX_VALUE_LEN = 4096;

type PluginConfigBucket = {
  /** 非敏感值（string/enum）；secret 值绝不入此表 */
  values?: Record<string, string>;
  /** secret 字段的密钥名映射（卸载清理与状态判断依据；值本体在 hostdb） */
  secrets?: Record<string, string>;
};

export type PluginConfigState = {
  state: "configured" | "missing" | "stale";
  keys?: string[];
};

let buckets: Record<string, PluginConfigBucket> = {};
let loaded = false;
let loading: Promise<void> | undefined;

/** 密钥名：hostdb 侧只认 [A-Za-z_][A-Za-z0-9_]* 且有长度上限；pluginId/key
 *  里的杂字符折成 _，超长时 id 段降级为 8 位哈希（保持稳定映射） */
export function pluginSecretName(pluginId: string, key: string): string {
  const id = pluginId.replace(/[^A-Za-z0-9_]/g, "_");
  const k = key.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 48);
  const base = `plugin_${id}_${k}`;
  if (base.length <= 120) return base;
  const short = createHash("sha256").update(pluginId).digest("hex").slice(0, 8);
  return `plugin_${short}_${k}`;
}

export async function initPluginConfig(): Promise<void> {
  if (loaded) return;
  loading ??= (async (): Promise<void> => {
    try {
      const row = await kvGet(PLUGIN_CONFIG_KV_KEY);
      buckets = row?.value ? (JSON.parse(row.value) as Record<string, PluginConfigBucket>) : {};
      if (typeof buckets !== "object" || buckets === null || Array.isArray(buckets)) buckets = {};
    } catch {
      buckets = {};
    }
    loaded = true;
  })();
  await loading;
}

/** 测试钩子：清内存不落 kv */
export function resetPluginConfigForTest(): void {
  buckets = {};
  loaded = false;
  loading = undefined;
}

async function persist(): Promise<void> {
  await kvSet(PLUGIN_CONFIG_KV_KEY, JSON.stringify(buckets));
}

/** loadSync 注入用（同步镜像读）：该插件的非敏感值注入表（env 与 header 分开） */
function plainInjectionFor(
  pluginId: string,
  schema: PluginConfigField[] | undefined,
): { env?: Record<string, string>; headers?: Record<string, string> } | undefined {
  if (!schema?.length) return undefined;
  const bucket = buckets[pluginId];
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const field of schema) {
    if (field.type === "secret") continue; // secret 走绑定通道，不经 def
    const v = bucket?.values?.[field.key] ?? field.default;
    if (!v) continue;
    if (field.env) env[field.env] = v;
    if (field.header) headers[field.header] = v;
  }
  if (!Object.keys(env).length && !Object.keys(headers).length) return undefined;
  return {
    ...(Object.keys(env).length ? { env } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

/**
 * 插件层 def 合并前的配置注入（loadSync 调用；纯同步，读内存镜像）。
 * env → stdio def.env；header → http def.headers（非敏感直接进 def，secret
 * 走 mcp-secrets 绑定通道不经 def）。
 */
export function applyPluginConfigEnv(
  schema: PluginConfigField[] | undefined,
  pluginId: string,
  def: { transport: "stdio" | "http"; env?: Record<string, string>; headers?: Record<string, string> },
): void {
  const injection = plainInjectionFor(pluginId, schema);
  if (!injection) return;
  if (def.transport === "http") {
    if (injection.headers) def.headers = { ...injection.headers, ...def.headers };
    return;
  }
  if (injection.env) def.env = { ...injection.env, ...def.env }; // def 自带 env 优先
}

// ---------------------------------------------------------------------------
// 状态三态
// ---------------------------------------------------------------------------

type SecretRowLite = { name: string; readable: boolean };

async function secretFieldBound(
  field: PluginConfigField,
  secretName: string,
  defs: McpServerDef[],
): Promise<boolean> {
  for (const def of defs) {
    const binding = await mcpSecretBindingFor(def);
    if (!binding) continue;
    const relevant = field.env
      ? binding.env.some((e) => e.envName === field.env && e.name === secretName)
      : field.header
        ? (binding.headers?.some((h) => h.envName === field.header && h.name === secretName) ??
          false)
        : false;
    if (relevant && !(await mcpSecretBindingStale(def))) return true;
  }
  return false;
}

/**
 * 计算插件配置三态。defs = 该插件名下的 MCP def（loadMcpServersSync 按
 * pluginId 过滤，env 已注入）；secretRows = secretList() 结果。
 * 无 config 声明返回 undefined（UI 不出现配置入口）。
 */
export async function getPluginConfigState(
  pluginId: string,
  manifest: PluginManifest,
  defs: McpServerDef[],
  secretRows: SecretRowLite[],
): Promise<PluginConfigState | undefined> {
  const schema = manifest.config;
  if (!schema?.length) return undefined;
  const bucket = buckets[pluginId] ?? {};
  const missing: string[] = [];
  const stale: string[] = [];
  // 绑定校验需要该插件名下有活跃 def（activePlugins 只含启用插件）。停用/
  // 无 MCP 组件时无法校验绑定——值存在即视为已配置；重新启用后若哈希失配，
  // 下一次计算自然浮出 stale（重绑入口随后可用）。
  const canVerifyBindings = defs.length > 0;
  for (const field of schema) {
    if (field.type === "secret") {
      const secretName = bucket.secrets?.[field.key];
      const exists = !!secretName && secretRows.some((r) => r.name === secretName && r.readable);
      if (!exists) {
        if (field.required) missing.push(field.key);
        continue;
      }
      // 值在：绑定缺失或 configHash 失配（典型为插件升级）→ stale，一键重绑即可
      if (canVerifyBindings && !(await secretFieldBound(field, secretName, defs))) {
        stale.push(field.key);
      }
    } else {
      const v = bucket.values?.[field.key] ?? field.default;
      if (!v && field.required) missing.push(field.key);
    }
  }
  if (missing.length) return { state: "missing", keys: missing };
  if (stale.length) return { state: "stale", keys: stale };
  return { state: "configured" };
}

/** get_plugin_config 用：非敏感值回显 + secret 只回「是否已设置」 */
export function pluginConfigView(
  pluginId: string,
  manifest: PluginManifest,
): { values: Record<string, string>; secrets: Record<string, boolean> } {
  const bucket = buckets[pluginId] ?? {};
  const values: Record<string, string> = {};
  const secrets: Record<string, boolean> = {};
  for (const field of manifest.config ?? []) {
    if (field.type === "secret") {
      secrets[field.key] = !!bucket.secrets?.[field.key];
    } else {
      const v = bucket.values?.[field.key];
      if (v !== undefined) values[field.key] = v;
    }
  }
  return { values, secrets };
}

// ---------------------------------------------------------------------------
// 保存 / 重绑 / 清理
// ---------------------------------------------------------------------------

/**
 * 保存插件配置（set_plugin_config 写路径；rebind 语义并入——只传 secret 字段
 * 即等于重绑）。values: key → 明文（secret 字段为明文一次帧，之后永不回传）。
 * skillNames = 插件技能名（secrets-env 绑定的授权名单）。
 *
 * 顺序刻意是「先写值、失效缓存、再取 def 建绑定」：绑定按当前生效 def 的
 * configHash 门控，必须等非敏感值注入生效后取 def，否则哈希与运行时不一致，
 * 绑定会在下一次 loadSync 被判 stale。
 */
export async function savePluginConfig(
  manifest: PluginManifest,
  pluginId: string,
  values: Record<string, string>,
  skillNames: string[],
): Promise<PluginConfigState | undefined> {
  const schema = manifest.config;
  if (!schema?.length) throw new Error(`插件 ${pluginId} 未声明 config`);
  const bucket = { ...(buckets[pluginId] ?? {}) };
  const nextValues = { ...bucket.values };
  const nextSecrets = { ...bucket.secrets };

  const secretFields: Array<{ field: PluginConfigField; name: string }> = [];
  for (const field of schema) {
    const raw = values[field.key];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || !raw.trim()) throw new Error(`配置 "${field.key}" 值为空`);
    if (raw.length > MAX_VALUE_LEN) throw new Error(`配置 "${field.key}" 值超长`);
    if (field.type === "enum" && field.options && !field.options.includes(raw)) {
      throw new Error(`配置 "${field.key}" 不在候选值内`);
    }
    if (field.type === "secret") {
      // 密钥名固定（按 key 派生）：重复保存 = 原地覆盖，轮换语义天然成立
      const name = pluginSecretName(pluginId, field.key);
      await secretSet(name, "global", raw);
      nextSecrets[field.key] = name;
      secretFields.push({ field, name });
    } else {
      nextValues[field.key] = raw;
    }
  }
  bucket.values = nextValues;
  bucket.secrets = nextSecrets;
  buckets[pluginId] = bucket;
  await persist();
  invalidateCaches(); // pluginsStateVersion 递增 → loadSync 签名失效 → env 注入生效

  const defs = (await loadMcpServers()).defs.filter((d) => d.pluginId === pluginId);
  await rebindPluginSecrets(manifest, pluginId, bucket, secretFields, skillNames, defs);
  return getPluginConfigState(pluginId, manifest, defs, await secretList());
}

/**
 * stale 一键重绑：不接值帧（明文都在 hostdb 里），只按 bucket 记录重建两层绑定。
 * 典型场景：插件升级后 def 变化 → configHash 失配，UI 提示重绑。
 */
export async function rebindPluginConfig(
  manifest: PluginManifest,
  pluginId: string,
  skillNames: string[],
): Promise<PluginConfigState | undefined> {
  const bucket = buckets[pluginId];
  invalidateCaches();
  const defs = (await loadMcpServers()).defs.filter((d) => d.pluginId === pluginId);
  if (!bucket) return getPluginConfigState(pluginId, manifest, defs, await secretList());
  await rebindPluginSecrets(manifest, pluginId, bucket, [], skillNames, defs);
  return getPluginConfigState(pluginId, manifest, defs, await secretList());
}

/**
 * 按 schema 重建该插件的绑定（保存/一键重绑共用写路径）：
 * - secretFields 里给出的字段重新写入 mcp-secrets 与 secrets-env；
 * - 其余已在 bucket.secrets 里的 secret 字段也一并刷新（升级 stale 重绑时
 *   values 帧不带旧明文，靠 hostdb 里已有的密钥值）。
 */
async function rebindPluginSecrets(
  manifest: PluginManifest,
  pluginId: string,
  bucket: PluginConfigBucket,
  secretFields: Array<{ field: PluginConfigField; name: string }>,
  skillNames: string[],
  defs: McpServerDef[],
): Promise<void> {
  const allSecret: Array<{ field: PluginConfigField; name: string }> = [...secretFields];
  for (const field of manifest.config ?? []) {
    if (field.type !== "secret") continue;
    if (allSecret.some((s) => s.field.key === field.key)) continue;
    const name = bucket.secrets?.[field.key];
    if (name) allSecret.push({ field, name });
  }

  // mcp-secrets：逐 def 合并绑定（保留与插件无关的既有条目）。
  // 注意形状：http 的 raw 入参用 {headerName, name}（saveMcpSecretHeaders 归一为
  // envName=headerName 存储），读取侧 binding.headers 里的 envName 即头名。
  for (const def of defs) {
    const envEntries: Array<{ envName: string; name: string; scope: "global" }> = [];
    const headerEntries: Array<{ headerName: string; name: string; scope: "global" }> = [];
    for (const { field, name } of allSecret) {
      if (def.transport === "http") {
        if (field.header) headerEntries.push({ headerName: field.header, name, scope: "global" });
      } else if (field.env) {
        envEntries.push({ envName: field.env, name, scope: "global" });
      }
    }
    if (def.transport === "http") {
      if (!headerEntries.length) continue;
      const prev = await mcpSecretBindingFor(def);
      const merged = (prev?.headers ?? []).map((h) => ({
        headerName: h.envName,
        name: h.name,
        scope: h.scope,
      }));
      for (const h of headerEntries) {
        const i = merged.findIndex((e) => e.headerName.toLowerCase() === h.headerName.toLowerCase());
        if (i >= 0) merged[i] = h;
        else merged.push(h);
      }
      await saveMcpSecretBindings(def, merged);
    } else {
      if (!envEntries.length) continue;
      const prev = await mcpSecretBindingFor(def);
      const merged = [...(prev?.env ?? [])];
      for (const e of envEntries) {
        const i = merged.findIndex((x) => x.envName === e.envName);
        if (i >= 0) merged[i] = e;
        else merged.push(e);
      }
      await saveMcpSecretBindings(def, merged);
    }
  }

  // secrets-env：把密钥授给插件技能名单（绑定按密钥名聚合，skills 取并集）
  if (allSecret.length && skillNames.length) {
    const config = getSecretsConfig();
    const bindings = config.bindings.map((b) => ({ ...b, skills: [...b.skills] }));
    for (const { name } of allSecret) {
      const i = bindings.findIndex((b) => b.name === name && b.scope === "global");
      if (i >= 0) {
        const merged = new Set([...bindings[i].skills, ...skillNames]);
        bindings[i].skills = [...merged];
      } else {
        bindings.push({ name, scope: "global", skills: [...skillNames] });
      }
    }
    await applySecretsConfig({ ...config, bindings });
  }
}

/**
 * 卸载清理：kv 分桶、mcp-secrets 绑定（仅 namesToClear 里的服务器名，调用方
 * 须保证同名服务器在其他层已不存在）、secrets-env 授权、hostdb 密钥值。
 */
export async function purgePluginConfig(
  pluginId: string,
  namesToClear: string[],
): Promise<void> {
  const bucket = buckets[pluginId];
  delete buckets[pluginId];
  await persist();
  const secretNames = new Set(Object.values(bucket?.secrets ?? {}));
  for (const name of namesToClear) {
    try {
      await deleteMcpSecretBinding(name);
    } catch {
      // 绑定不存在等：清理尽力而为
    }
  }
  if (secretNames.size) {
    const config = getSecretsConfig();
    const bindings = config.bindings.filter((b) => !secretNames.has(b.name));
    if (bindings.length !== config.bindings.length) {
      await applySecretsConfig({ ...config, bindings });
    }
    for (const name of secretNames) {
      try {
        await secretDelete(name, "global");
      } catch {
        // 清理尽力而为
      }
    }
  }
  invalidateCaches();
}
