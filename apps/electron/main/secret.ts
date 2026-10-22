/**
 * 敏感值落盘（对齐 secret.rs 的语义，Electron 版恢复真实加密）：
 *
 * - 数据行：aes:v1:<base64(nonce|tag|ciphertext)>，AES-256-GCM，主密钥 32 字节
 * - 主密钥优先由 Electron safeStorage（macOS Keychain / Windows DPAPI）包裹，
 *   写入 master.key.safe；钥匙串不可用时退化为 0600 的 master.key
 * - 旧 Rust 的 enc:v1: 密文没有原主密钥，继续按“不可解密”处理
 * - 无前缀的旧明文由 secret-migration 在启动时原地加密
 *
 * 主密钥文件不在 state.db 里，也不进备份包。
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appDataDir } from "./paths";
import { logInfo, logWarn } from "./logging";
import {
  LEGACY_PREFIX,
  SECRET_KEY_BYTES,
  decryptWithKey,
  encryptWithKey,
  isAesCiphertext,
  isLegacyCiphertext,
  randomSecretKey,
} from "./secret-crypto";

export type SecretCipherBackend =
  | "system-keychain"
  | "local-key-file"
  | "unavailable";

/** 兼容旧调用点（backup.ts 用它判断 enc:v1:） */
export const PREFIX = LEGACY_PREFIX;

const SAFE_FILE = "master.key.safe";
const RAW_FILE = "master.key";
const SAFE_PREFIX = "safe:v1:";
const KEY_PREFIX = "key:v1:";

let masterKey: Buffer | null = null;
let backend: SecretCipherBackend = "unavailable";

function keyFromBase64(text: string): Buffer | null {
  try {
    const key = Buffer.from(text.trim(), "base64");
    return key.length === SECRET_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/**
 * Electron safeStorage 惰性解引用：与 paths.ts 的 `app` 同理——tool-exec 的
 * 依赖链（secret-env → secret）会在沙箱 e2e / bun test 下被加载，那时没有
 * Electron 运行时，顶层 `import { safeStorage }` 直接炸掉整个模块图。
 */
type SafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  encryptString: (text: string) => Buffer;
  decryptString: (buf: Buffer) => string;
  getSelectedStorageBackend?: () => string;
};

function safeStorage(): SafeStorageLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("electron");
    return (mod?.safeStorage ?? null) as SafeStorageLike | null;
  } catch {
    return null;
  }
}

/** Linux 的 basic_text 后端只是可逆混淆，不当作系统钥匙串 */
function safeStorageUsable(): boolean {
  const ss = safeStorage();
  if (!ss || !ss.isEncryptionAvailable()) return false;
  if (process.platform === "linux") {
    if (typeof ss.getSelectedStorageBackend === "function" && ss.getSelectedStorageBackend() === "basic_text") {
      return false;
    }
  }
  return true;
}

function readSafeKey(path: string): Buffer | null {
  const ss = safeStorage();
  if (!existsSync(path)) return null;
  if (!ss || !ss.isEncryptionAvailable()) {
    logWarn("[secret] master.key.safe exists but system keychain is unavailable");
    return null;
  }
  try {
    const raw = readFileSync(path, "utf8").trim();
    const payload = raw.startsWith(SAFE_PREFIX) ? raw.slice(SAFE_PREFIX.length) : raw;
    const keyText = ss.decryptString(Buffer.from(payload, "base64"));
    return keyFromBase64(keyText);
  } catch (e) {
    logWarn(`[secret] cannot unwrap master.key.safe: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

function readRawKey(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    const payload = raw.startsWith(KEY_PREFIX) ? raw.slice(KEY_PREFIX.length) : raw;
    return keyFromBase64(payload);
  } catch (e) {
    logWarn(`[secret] cannot read master.key: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

function writeAtomic(path: string, content: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function writeSafeKey(path: string, key: Buffer): void {
  const ss = safeStorage();
  if (!ss || !ss.isEncryptionAvailable()) {
    logWarn("[secret] cannot wrap master key: system keychain is unavailable");
    return;
  }
  const wrapped = ss.encryptString(key.toString("base64"));
  writeAtomic(path, `${SAFE_PREFIX}${wrapped.toString("base64")}`, 0o600);
}

function writeRawKey(path: string, key: Buffer): void {
  writeAtomic(path, `${KEY_PREFIX}${key.toString("base64")}`, 0o600);
}

/**
 * 在 app.whenReady() 之后调用（safeStorage 在 Linux 上要求 ready）。
 * 幂等：重复调用返回同一 backend。
 */
export function initSecretCipher(dataDir: string = appDataDir()): SecretCipherBackend {
  if (masterKey) return backend;
  const safePath = join(dataDir, SAFE_FILE);
  const rawPath = join(dataDir, RAW_FILE);
  const safeExists = existsSync(safePath);

  const fromSafe = readSafeKey(safePath);
  if (fromSafe) {
    masterKey = fromSafe;
    backend = "system-keychain";
    logInfo("[secret] master key unwrapped from system keychain");
    return backend;
  }

  const fromRaw = readRawKey(rawPath);
  if (fromRaw) {
    masterKey = fromRaw;
    if (safeStorageUsable()) {
      try {
        writeSafeKey(safePath, fromRaw);
        try {
          rmSync(rawPath, { force: true });
        } catch (e) {
          logWarn(`[secret] wrapped key written but raw key removal failed: ${e}`);
        }
        backend = "system-keychain";
        logInfo("[secret] master key migrated to system keychain");
      } catch (e) {
        backend = "local-key-file";
        logWarn(`[secret] keychain wrap failed, keeping 0600 master.key: ${e}`);
      }
    } else {
      backend = "local-key-file";
      logWarn("[secret] system keychain unavailable; master key stays in 0600 master.key");
    }
    return backend;
  }

  // 有包裹文件但解不开：绝不静默生成新钥匙，否则已有 aes:v1: 行会全部变成不可读
  if (safeExists) {
    masterKey = null;
    backend = "unavailable";
    logWarn("[secret] master.key.safe exists but cannot be unwrapped; secrets will be unreadable");
    return backend;
  }

  if (safeStorageUsable()) {
    const key = randomSecretKey();
    try {
      writeSafeKey(safePath, key);
      masterKey = key;
      backend = "system-keychain";
      logInfo("[secret] generated new master key in system keychain");
      return backend;
    } catch (e) {
      logWarn(`[secret] keychain write failed, falling back to 0600 file: ${e}`);
    }
  }

  const key = randomSecretKey();
  writeRawKey(rawPath, key);
  masterKey = key;
  backend = "local-key-file";
  logWarn("[secret] system keychain unavailable; generated 0600 master.key");
  return backend;
}

export function getSecretCipherBackend(): SecretCipherBackend {
  return backend;
}

export function isSecretCipherReady(): boolean {
  return masterKey !== null;
}

/** 是否为已知密文（含不可解的旧 Rust 密文） */
export function isEncrypted(stored: string): boolean {
  return isAesCiphertext(stored) || isLegacyCiphertext(stored);
}

export function encrypt(plain: string): string {
  if (!masterKey) throw new Error("secret cipher is not initialized");
  return encryptWithKey(plain, masterKey);
}

export function decrypt(
  stored: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (isLegacyCiphertext(stored)) {
    return {
      ok: false,
      error: "encrypted value cannot be decrypted (keychain master key retired)",
    };
  }
  if (isAesCiphertext(stored)) {
    if (!masterKey) {
      return { ok: false, error: "secret cipher is not initialized" };
    }
    return decryptWithKey(stored, masterKey);
  }
  // 无前缀 = 迁移前明文；调用方（secret_list/credential_get）会在迁移后不再遇到
  return { ok: true, value: stored };
}
