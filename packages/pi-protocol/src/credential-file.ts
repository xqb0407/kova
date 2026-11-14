/**
 * 用户级共享凭据文件（~/.kova/credentials.json）：
 * 桌面端（Electron）是唯一写入者——模型/凭据/自定义 provider 变更后整文件
 * 原子重建；sidecar（ACP / 无宿主本地模式）启动时只读注入本地存储。
 *
 * 值加密：AES-256-GCM，密钥 = sha256(secret)。secret 取 KOVA_CREDENTIAL_SECRET，
 * 缺省由 {platform}:{homedir}:{username} 机器派生——刻意不进钥匙串：多端共用
 * 的前提就是同用户任意进程可解密；威胁模型等同同用户进程互信，0600 文件权限
 * 只防其他用户。密文前缀 kenc:v1: 与桌面 state.db 的 aes:v1:（钥匙串主密钥）
 * 是两套体系，互不通用。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";

export const CREDENTIAL_FILE_VERSION = 1;
const VALUE_PREFIX = "kenc:v1:";
const CIPHER_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const SECRET_ENV_KEY = "KOVA_CREDENTIAL_SECRET";
const PATH_ENV_KEY = "KOVA_CREDENTIALS_FILE";

/** 自定义 provider 行（与桌面 custom_providers 表 / customProviderUpsert 同形；
 *  models 是 JSON 数组字符串，与 DB 列原样一致） */
export type SharedCustomProviderRow = {
  id: string;
  name: string;
  baseUrl: string;
  models: string;
  api: string;
  enabled?: boolean;
  autoDiscover?: boolean;
  headers?: string;
};

/** 模型条目行（与 ModelReplaceItem 同形；input/cost/promptCache 是解析后的对象） */
export type SharedModelRow = {
  provider: string;
  modelId: string;
  enabled?: boolean;
  name?: string | null;
  reasoning?: boolean | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  input?: unknown[] | null;
  cost?: Record<string, unknown> | null;
  promptCache?: { short?: number; long?: number } | null;
};

/** 写入侧入参：credentials 传明文，写入前统一加密 */
export type SharedCredentialFileData = {
  credentials: Record<string, string>;
  customProviders: SharedCustomProviderRow[];
  models: SharedModelRow[];
};

export type SharedCredentialFile = SharedCredentialFileData & {
  version: number;
  updatedAt: string;
};

/** 读取侧出参：credentials 已解密；解不开的值跳过并记入 errors，不整体失败 */
export type DecodedCredentialFile = {
  updatedAt: string;
  credentials: Record<string, string>;
  credentialErrors: string[];
  customProviders: SharedCustomProviderRow[];
  models: SharedModelRow[];
};

export function defaultCredentialFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[PATH_ENV_KEY]?.trim();
  if (override) return override;
  return join(homedir(), ".kova", "credentials.json");
}

/** 加密 secret：显式 env 优先，缺省机器派生（同用户所有进程推导出同一把） */
export function credentialFileSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SECRET_ENV_KEY]?.trim();
  if (configured) return configured;
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    /* 拿不到系统用户时退回占位值 */
  }
  return `kova-credential-fallback:${platform()}:${homedir()}:${username}`;
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encryptCredentialValue(plain: string, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER_ALGORITHM, deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VALUE_PREFIX, iv.toString("base64url"), ".", tag.toString("base64url"), ".", encrypted.toString("base64url")].join("");
}

export function decryptCredentialValue(value: string, secret: string): string {
  if (!value.startsWith(VALUE_PREFIX)) {
    throw new Error("credential value is not kenc:v1 ciphertext");
  }
  const [ivB64, tagB64, dataB64] = value.slice(VALUE_PREFIX.length).split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("credential value malformed");
  }
  const decipher = createDecipheriv(CIPHER_ALGORITHM, deriveKey(secret), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

/** 原子写：同目录 tmp + rename；0600（新文件）。目录不存在则创建。 */
export function writeCredentialFile(path: string, data: SharedCredentialFileData, secret: string = credentialFileSecret()): void {
  const file: SharedCredentialFile = {
    version: CREDENTIAL_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    credentials: Object.fromEntries(
      Object.entries(data.credentials).map(([provider, key]) => [provider, encryptCredentialValue(key, secret)]),
    ),
    customProviders: data.customProviders,
    models: data.models,
  };
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* chmod 失败不阻断（Windows 上 mode 参数已生效/无 ACL 对应） */
    }
    renameSync(tmp, path);
  } finally {
    try {
      // rename 成功后 tmp 不存在；失败时清掉残留
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 读取共享文件。文件不存在返回 null（桌面端未安装/首启的正常状态）；
 * JSON/版本非法抛错（调用方 catch 后按无文件处理）。
 * 单个 credential 解密失败（secret 不匹配/手工篡改）跳过该条并记入 errors。
 */
export function readCredentialFile(path: string, secret: string = credentialFileSecret()): DecodedCredentialFile | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: number; updatedAt?: string; credentials?: Record<string, string>; customProviders?: SharedCustomProviderRow[]; models?: SharedModelRow[] };
  if (raw.version !== CREDENTIAL_FILE_VERSION) {
    throw new Error(`credential file version mismatch: ${raw.version}`);
  }
  const credentials: Record<string, string> = {};
  const credentialErrors: string[] = [];
  for (const [provider, value] of Object.entries(raw.credentials ?? {})) {
    if (typeof value !== "string") {
      credentialErrors.push(`${provider}: non-string value`);
      continue;
    }
    try {
      credentials[provider] = decryptCredentialValue(value, secret);
    } catch (err) {
      credentialErrors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    credentials,
    credentialErrors,
    customProviders: Array.isArray(raw.customProviders) ? raw.customProviders : [],
    models: Array.isArray(raw.models) ? raw.models : [],
  };
}
