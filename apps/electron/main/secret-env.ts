/**
 * 密钥执行时解析/注入/脱敏（对齐 secret_env.rs 全函数）。
 *
 * bash 的明文只在宿主内活一次，不跨 RPC；MCP stdio 子进程由 sidecar 拉起，
 * 宿主无法直接注入，因此 `secret_env_resolve` 会把命中的值交给 sidecar。
 * 该路径只接受用户级 MCP 绑定产生的 global 请求，且返回值仅用于子进程 env
 * 与输出脱敏。
 */
import { createHash } from "node:crypto";
import type { Db } from "./db";
import { decrypt } from "./secret";
import { redactSecrets, type SecretValue } from "./secret-crypto";
import { parseSecretRequests, type McpSecretEnvRequest } from "./secret-requests";
import { logInfo, logWarn } from "./logging";

export type SecretPair = SecretValue;

const MAX_RESOLVED = 32;

/** 名字 → 明文：请求 scope 命中即用，否则回落 global；查不到/解不开静默跳过 */
export function resolveNames(db: Db, requests: { name: string; scope: string }[]): SecretPair[] {
  if (requests.length === 0) return [];
  const stmt = db.prepare("SELECT value FROM secrets WHERE name = ?1 AND scope = ?2");
  const out: SecretPair[] = [];
  for (const { name, scope } of requests) {
    const candidates = scope !== "global" ? [scope, "global"] : [scope];
    for (const candidate of candidates) {
      let stored: string | undefined;
      try {
        stored = (stmt.get(name, candidate) as { value: string } | undefined)?.value;
      } catch (e) {
        logWarn(`[secret_env] query failed for ${name}: ${e}`);
        continue;
      }
      if (stored === undefined) continue;
      const dec = decrypt(stored);
      if (dec.ok) {
        out.push({ name, value: dec.value });
      } else {
        logWarn(`[secret_env] decrypt failed for ${name} (${candidate}): ${dec.error}`);
      }
      break; // 命中行（解没解开都停）——对齐 Rust：decrypt Err 也 break 该候选
    }
  }
  return out;
}

/** 工具调用前解析（dispatch 的 tool 分支）：失败只记日志，工具照常执行 */
export function resolveIntoEnvelope(db: Db, envelope: any): void {
  // 宿主信封有两种形状：旧 Rust 直挂 secretEnv；Electron 的 hostToolCall 把
  // 工具参数嵌在 envelope.params 下。两种都要认，否则密钥名单永远解析不到。
  const requests = parseSecretRequests(envelope);
  if (requests.length === 0) return;
  let resolved: SecretPair[];
  try {
    resolved = resolveNames(db, requests);
  } catch (e) {
    logWarn(`[secret_env] resolve failed, skipping injection: ${e}`);
    return;
  }
  if (resolved.length === 0) {
    // 绑了名字但库里没有：只记名字级日志，永不打印值
    logWarn(`[secret_env] no injectable secret for ${requests.map((r) => r.name).join(", ")}`);
    return;
  }
  logInfo(`[secret_env] injecting ${resolved.length} secret(s): ${resolved.map((r) => r.name).join(", ")}`);
  envelope.secretEnvResolved = resolved;
}

/** 读回 resolveIntoEnvelope 写下的明文对 */
export function takeResolved(envelope: any): SecretPair[] {
  const list = envelope?.secretEnvResolved;
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, MAX_RESOLVED)
    .filter((item: any) => typeof item?.name === "string" && typeof item?.value === "string")
    .map((item: any) => ({ name: item.name, value: item.value }));
}

/** 注入为派生进程的环境变量增量（父环境照常继承） */
export function envFromResolved(resolved: SecretPair[]): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const { name, value } of resolved) out[name] = value;
  return out;
}

/** 输出脱敏：原值 + base64 变体 → [REDACTED:<NAME>]；短值（<8）跳过 */
export function redact(text: string, resolved: SecretPair[]): string {
  return redactSecrets(text, resolved);
}

/* ------------------------------ MCP stdio 注入 ------------------------------ */

/**
 * 名字 → 明文 env 映射。查不到/解不开的条目跳过（MCP 服务器自己报缺凭据），
 * 绝不回退到同名但作用域不同的另一条密钥。日志只出现名字，不出现值。
 */
export function resolveMcpSecretEnv(
  db: Db,
  requests: McpSecretEnvRequest[],
  server: string,
): Record<string, string> {
  if (requests.length === 0) return {};
  // 无原型：envName 来自用户绑定，`__proto__` 不能变成原型赋值
  const env = Object.create(null) as Record<string, string>;
  const unresolved: string[] = [];
  for (const request of requests) {
    const resolved = resolveNames(db, [{ name: request.name, scope: request.scope }]);
    const pair = resolved[0];
    if (!pair) {
      unresolved.push(`${request.envName}(${request.name})`);
      continue;
    }
    env[request.envName] = pair.value;
  }
  const injected = Object.keys(env);
  if (injected.length > 0) {
    logInfo(
      `[secret_env] MCP server "${server}" injecting ${injected.length} secret(s): ${injected.join(", ")}`,
    );
  }
  if (unresolved.length > 0) {
    logWarn(`[secret_env] MCP server "${server}" unresolved: ${unresolved.join(", ")}`);
  }
  return env;
}

export { createHash };

