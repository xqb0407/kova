/**
 * 线程级密钥脱敏台账。
 *
 * bash 注入密钥时登记 (owner -> 明文对)；之后该线程的**所有**工具输出都走
 * redactToolResult，覆盖 read / browser_* / http / task_output 等。
 * 这样模型不能靠 `printenv SECRET > /tmp/x` + `read /tmp/x` 绕过 bash 输出脱敏。
 *
 * 仍然只是兜底：反转、十六进制、分段拼接、网络外发等变换无法拦截。真正的边界
 * 是用户把密钥授权给哪个技能/是否授权，以及后续收窄 bash 注入面。
 */
import { redactSecrets, type SecretValue } from "./secret-crypto";

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_THREADS = 256;
const MAX_SECRETS_PER_THREAD = 32;

type Entry = { values: SecretValue[]; expiresAt: number };
const threadSecrets = new Map<string, Entry>();

/** 登记/刷新一个线程的已注入密钥（按名字去重，TTL 顺延） */
export function rememberThreadSecrets(
  owner: string,
  secrets: readonly SecretValue[],
  now: number = Date.now(),
): void {
  if (!owner || secrets.length === 0) return;
  const existing = threadSecrets.get(owner);
  const byName = new Map<string, SecretValue>();
  for (const item of existing?.values ?? []) byName.set(item.name, item);
  for (const item of secrets) byName.set(item.name, item);
  const values = [...byName.values()].slice(-MAX_SECRETS_PER_THREAD);
  threadSecrets.set(owner, { values, expiresAt: now + TTL_MS });
  while (threadSecrets.size > MAX_THREADS) {
    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of threadSecrets) {
      if (entry.expiresAt < oldest) {
        oldest = entry.expiresAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    threadSecrets.delete(oldestKey);
  }
}

/** 当前线程仍有效的已注入密钥（过期即清理） */
export function activeThreadSecrets(owner: string, now: number = Date.now()): SecretValue[] {
  const entry = threadSecrets.get(owner);
  if (!entry) return [];
  if (entry.expiresAt <= now) {
    threadSecrets.delete(owner);
    return [];
  }
  return entry.values;
}

/**
 * 递归脱敏工具结果。图片字段（base64/data/mimeType）必须原样保留，不能把
 * 二进制内容改坏；其余字符串按已登记的密钥替换。
 */
export function redactToolResult(value: unknown, secrets: readonly SecretValue[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return redactSecrets(value, secrets);
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

/** 测试缝 */
export function clearThreadSecretsForTest(): void {
  threadSecrets.clear();
}
