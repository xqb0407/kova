/**
 * 密钥执行时解析/注入/脱敏（对齐 secret_env.rs 全函数）。
 * 明文只在工具调用的进程内存活一次，绝不跨 RPC 边界。
 */
import { createHash } from "node:crypto";
import type { Db } from "./db";
import { decrypt } from "./secret";
import { isValidSecretName } from "./data";
import { logInfo, logWarn } from "./logging";

export type SecretPair = { name: string; value: string };

const REDACT_MIN_LEN = 8;
const MAX_RESOLVED = 32;

/** 信封上的请求清单：secretEnv=[{name, scope}]；非法条目静默丢弃 */
export function parseRequests(envelope: any): { name: string; scope: string }[] {
  const list = envelope?.secretEnv;
  if (!Array.isArray(list)) return [];
  const out: { name: string; scope: string }[] = [];
  for (const item of list.slice(0, MAX_RESOLVED)) {
    const name = typeof item?.name === "string" ? item.name : "";
    if (!name || !isValidSecretName(name)) continue;
    const scope = typeof item?.scope === "string" ? item.scope : "global";
    out.push({ name, scope });
  }
  return out;
}

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
  const requests = parseRequests(envelope);
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
  const out: Record<string, string> = {};
  for (const { name, value } of resolved) out[name] = value;
  return out;
}

/** 输出脱敏：原值 + base64 变体 → [REDACTED:<NAME>]；短值（<8）跳过 */
export function redact(text: string, resolved: SecretPair[]): string {
  let out = text;
  for (const { name, value } of resolved) {
    if (Array.from(value).length < REDACT_MIN_LEN) continue;
    const marker = `[REDACTED:${name}]`;
    if (out.includes(value)) out = out.split(value).join(marker);
    const b64 = Buffer.from(value, "utf8").toString("base64");
    if (b64 !== value && out.includes(b64)) out = out.split(b64).join(marker);
  }
  return out;
}

export { createHash };
