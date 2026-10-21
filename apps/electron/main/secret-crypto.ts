/**
 * 密钥密文格式（纯函数，不依赖 Electron）：
 *
 *   aes:v1:<base64(nonce(12) | tag(16) | ciphertext)>
 *
 * 旧 Rust 主机的 `enc:v1:` 密文保留为“不可解密”标记；Electron 侧不再生成。
 * 主密钥的加载/包裹在 secret.ts（依赖 safeStorage），这里只做 AES-256-GCM。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const AES_PREFIX = "aes:v1:";
export const LEGACY_PREFIX = "enc:v1:";
export const SECRET_KEY_BYTES = 32;
export const SECRET_NONCE_BYTES = 12;
export const SECRET_TAG_BYTES = 16;

export function isAesCiphertext(stored: string): boolean {
  return stored.startsWith(AES_PREFIX);
}

export function isLegacyCiphertext(stored: string): boolean {
  return stored.startsWith(LEGACY_PREFIX);
}

/** 任何已知密文前缀（含不可解的旧 Rust 密文） */
export function isCiphertext(stored: string): boolean {
  return isAesCiphertext(stored) || isLegacyCiphertext(stored);
}

export function randomSecretKey(): Buffer {
  return randomBytes(SECRET_KEY_BYTES);
}

export type SecretValue = { name: string; value: string };

const REDACT_MIN_LEN = 8;

/**
 * 输出脱敏：原值 + base64 变体 → [REDACTED:<NAME>]；短值（<8）跳过。
 * 纯函数，host 的 bash / read / browser 等所有输出共用。
 */
export function redactSecrets(text: string, resolved: readonly SecretValue[]): string {
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

export function encryptWithKey(plain: string, key: Buffer): string {
  if (key.length !== SECRET_KEY_BYTES) {
    throw new Error(`secret key must be ${SECRET_KEY_BYTES} bytes`);
  }
  const nonce = randomBytes(SECRET_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return AES_PREFIX + Buffer.concat([nonce, tag, body]).toString("base64");
}

export function decryptWithKey(
  stored: string,
  key: Buffer,
): { ok: true; value: string } | { ok: false; error: string } {
  if (!isAesCiphertext(stored)) {
    return { ok: false, error: "value is not an aes:v1 ciphertext" };
  }
  if (key.length !== SECRET_KEY_BYTES) {
    return { ok: false, error: `secret key must be ${SECRET_KEY_BYTES} bytes` };
  }
  let packed: Buffer;
  try {
    packed = Buffer.from(stored.slice(AES_PREFIX.length), "base64");
  } catch {
    return { ok: false, error: "ciphertext is not valid base64" };
  }
  if (packed.length < SECRET_NONCE_BYTES + SECRET_TAG_BYTES) {
    return { ok: false, error: "ciphertext is truncated" };
  }
  const nonce = packed.subarray(0, SECRET_NONCE_BYTES);
  const tag = packed.subarray(SECRET_NONCE_BYTES, SECRET_NONCE_BYTES + SECRET_TAG_BYTES);
  const body = packed.subarray(SECRET_NONCE_BYTES + SECRET_TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    return { ok: true, value: plain.toString("utf8") };
  } catch {
    return { ok: false, error: "ciphertext cannot be decrypted with the current master key" };
  }
}
