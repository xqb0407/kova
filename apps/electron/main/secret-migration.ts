/**
 * 启动迁移：把 Electron 版早期直接落盘的明文敏感值原地加密。
 *
 * 覆盖 encrypt/decrypt 的全部落点：
 * - secrets.value
 * - credentials.api_key
 * - kv['remote.token']
 * - kv['backup.config.v1'] 里的 s3SecretAccessKey / davPassword / passphrase
 *
 * enc:v1: 是旧 Rust 主机的密文，没有原主密钥，保留原样并计入 legacy；
 * aes:v1: 已经是新格式，跳过。整体在一个事务里完成。
 */
import type { Db } from "./db";
import { isAesCiphertext, isLegacyCiphertext } from "./secret-crypto";

export type SecretMigrationResult = {
  migrated: number;
  legacy: number;
  failed: number;
};

type MigrateOutcome =
  | { kind: "migrated"; value: string }
  | { kind: "legacy" }
  | { kind: "already" }
  | { kind: "empty" }
  | { kind: "failed" };

function migrateValue(value: unknown, encrypt: (plain: string) => string): MigrateOutcome {
  if (typeof value !== "string" || value.length === 0) return { kind: "empty" };
  if (isLegacyCiphertext(value)) return { kind: "legacy" };
  if (isAesCiphertext(value)) return { kind: "already" };
  try {
    return { kind: "migrated", value: encrypt(value) };
  } catch {
    return { kind: "failed" };
  }
}

function account(outcome: MigrateOutcome, result: SecretMigrationResult): void {
  if (outcome.kind === "migrated") result.migrated += 1;
  else if (outcome.kind === "legacy") result.legacy += 1;
  else if (outcome.kind === "failed") result.failed += 1;
}

const BACKUP_CONFIG_KEY = "backup.config.v1";
const BACKUP_SECRET_FIELDS = ["s3SecretAccessKey", "davPassword", "passphrase"] as const;

export function migrateSecretsToEncrypted(
  db: Db,
  encrypt: (plain: string) => string,
): SecretMigrationResult {
  const result: SecretMigrationResult = { migrated: 0, legacy: 0, failed: 0 };

  db.transaction(() => {
    const secretRows = db
      .prepare("SELECT name, scope, value FROM secrets")
      .all() as Array<{ name: string; scope: string; value: unknown }>;
    for (const row of secretRows) {
      const outcome = migrateValue(row.value, encrypt);
      account(outcome, result);
      if (outcome.kind === "migrated") {
        db.prepare("UPDATE secrets SET value = ? WHERE name = ? AND scope = ?").run(
          outcome.value,
          row.name,
          row.scope,
        );
      }
    }

    const credentialRows = db
      .prepare("SELECT provider, api_key FROM credentials")
      .all() as Array<{ provider: string; api_key: unknown }>;
    for (const row of credentialRows) {
      const outcome = migrateValue(row.api_key, encrypt);
      account(outcome, result);
      if (outcome.kind === "migrated") {
        db.prepare("UPDATE credentials SET api_key = ? WHERE provider = ?").run(
          outcome.value,
          row.provider,
        );
      }
    }

    const tokenRow = db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get("remote.token") as { value: unknown } | undefined;
    if (tokenRow) {
      const outcome = migrateValue(tokenRow.value, encrypt);
      account(outcome, result);
      if (outcome.kind === "migrated") {
        db.prepare("UPDATE kv SET value = ? WHERE key = ?").run(
          outcome.value,
          "remote.token",
        );
      }
    }

    const backupRow = db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(BACKUP_CONFIG_KEY) as { value: unknown } | undefined;
    if (backupRow && typeof backupRow.value === "string") {
      try {
        const parsed = JSON.parse(backupRow.value) as Record<string, unknown>;
        let changed = false;
        for (const field of BACKUP_SECRET_FIELDS) {
          const outcome = migrateValue(parsed[field], encrypt);
          account(outcome, result);
          if (outcome.kind === "migrated") {
            parsed[field] = outcome.value;
            changed = true;
          }
        }
        if (changed) {
          db.prepare("UPDATE kv SET value = ? WHERE key = ?").run(
            JSON.stringify(parsed),
            BACKUP_CONFIG_KEY,
          );
        }
      } catch {
        result.failed += 1;
      }
    }
  });

  return result;
}
