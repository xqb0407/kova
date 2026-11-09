/**
 * 本地宿主的密钥注入与输出脱敏。
 *
 * ACP 模式没有 Electron 主进程，`secret_env_resolve` 只能读本地 SQLite 的
 * `secrets` 表（本地模式按设计明文存储，见 storage/hostdb/local.ts）。
 * 语义对齐 apps/electron/main/secret-env.ts + secret-redaction.ts：
 * - 只接受 sidecar 传来的名字/作用域，不接受值；
 * - workspace 作用域未命中时回落 global；
 * - 加密前缀（aes:v1 / enc:v1）在本地模式无法解密，跳过并留日志；
 * - bash 注入过的密钥登记到线程台账，之后 read/http/task_output 的输出同样脱敏。
 */
import { getLocalDb } from "../storage/hostdb";
import { logErr } from "../log";

export type SecretPair = { name: string; value: string };

const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_REQUESTS = 32;
const REDACT_MIN_LEN = 8;
const ENCRYPTED_PREFIXES = ["aes:v1:", "enc:v1:"];

type SecretRequest = { name: string; scope: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从工具信封里取密钥请求（兼容旧 Rust 顶层与 Electron params 嵌套两种形状） */
export function parseSecretRequests(envelope: unknown): SecretRequest[] {
  if (!isRecord(envelope)) return [];
  const list = Array.isArray(envelope.secretEnv)
    ? envelope.secretEnv
    : isRecord(envelope.params) && Array.isArray(envelope.params.secretEnv)
      ? envelope.params.secretEnv
      : [];
  const out: SecretRequest[] = [];
  const seen = new Set<string>();
  for (const raw of list.slice(0, MAX_REQUESTS)) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const scope = typeof raw.scope === "string" && raw.scope.trim() ? raw.scope.trim() : "global";
    if (!name || !SECRET_NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, scope });
  }
  return out;
}

/** 名字/作用域 → 明文值；查不到/解不开的条目跳过 */
export function resolveNames(requests: SecretRequest[]): SecretPair[] {
  const db = getLocalDb();
  if (!db || requests.length === 0) return [];
  const out: SecretPair[] = [];
  for (const { name, scope } of requests) {
    const candidates = scope !== "global" ? [scope, "global"] : ["global"];
    let stored: string | undefined;
    for (const candidate of candidates) {
      try {
        const row = db
          .query<{ value: string }, [string, string]>(
            "SELECT value FROM secrets WHERE name = ? AND scope = ?",
          )
          .get(name, candidate);
        if (row) {
          stored = row.value;
          break;
        }
      } catch (err) {
        logErr(`[local-host] secret lookup failed for ${name}:`, err);
      }
    }
    if (stored === undefined) continue;
    if (ENCRYPTED_PREFIXES.some((p) => stored!.startsWith(p))) {
      logErr(
        `[local-host] secret ${name} is encrypted at rest and cannot be resolved in ACP/local mode; skipped`,
      );
      continue;
    }
    if (stored.length === 0) continue;
    out.push({ name, value: stored });
  }
  return out;
}

/** 信封 → 可注入的明文密钥（供 tool-exec 的 bash 路径使用） */
export function takeResolved(envelope: unknown): SecretPair[] {
  const requests = parseSecretRequests(envelope);
  return resolveNames(requests);
}

/** 注入为派生进程的环境变量增量（父环境照常继承） */
export function envFromResolved(resolved: SecretPair[]): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
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

/* ------------------------------ 线程级脱敏台账 ------------------------------ */

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_THREADS = 256;
const MAX_SECRETS_PER_THREAD = 32;

type Entry = { values: SecretPair[]; expiresAt: number };
const threadSecrets = new Map<string, Entry>();

export function rememberThreadSecrets(
  owner: string,
  secrets: readonly SecretPair[],
  now: number = Date.now(),
): void {
  if (!owner || secrets.length === 0) return;
  const existing = threadSecrets.get(owner);
  const byName = new Map<string, SecretPair>();
  for (const item of existing?.values ?? []) byName.set(item.name, item);
  for (const item of secrets) byName.set(item.name, item);
  const values = [...byName.values()].slice(-MAX_SECRETS_PER_THREAD);
  threadSecrets.set(owner, { values, expiresAt: now + TTL_MS });
  while (threadSecrets.size > MAX_THREADS) {
    const oldestKey = threadSecrets.keys().next().value;
    if (oldestKey === undefined) break;
    threadSecrets.delete(oldestKey);
  }
}

export function activeThreadSecrets(owner: string, now: number = Date.now()): SecretPair[] {
  if (!owner) return [];
  const entry = threadSecrets.get(owner);
  if (!entry) return [];
  if (entry.expiresAt <= now) {
    threadSecrets.delete(owner);
    return [];
  }
  return entry.values;
}

/** 线程级台账覆盖所有工具输出（防止 read 绕回 bash 已脱敏的内容） */
export function redactToolResult(value: unknown, secrets: readonly SecretPair[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return redact(value, [...secrets]);
  if (Array.isArray(value)) {
    return value.map((item) => redactToolResult(item, secrets));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "base64" || key === "data" || key === "mimeType") {
        out[key] = item;
        continue;
      }
      out[key] = redactToolResult(item, secrets);
    }
    return out;
  }
  return value;
}

export function resetThreadSecretsForTest(): void {
  threadSecrets.clear();
}
