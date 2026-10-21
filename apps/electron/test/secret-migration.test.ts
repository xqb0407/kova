import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Db } from "../main/db";
import { migrateSecretsToEncrypted } from "../main/secret-migration";
import { decryptWithKey, encryptWithKey, randomSecretKey } from "../main/secret-crypto";

function makeDb(): Db {
  const raw = new Database(":memory:");
  return {
    prepare(sql: string) {
      const st = raw.prepare(sql);
      return {
        all: (...params: unknown[]) => st.all(...(params as never[])) as never,
        get: (...params: unknown[]) =>
          (st.get(...(params as never[])) ?? undefined) as never,
        run: (...params: unknown[]) => {
          const r = st.run(...(params as never[]));
          return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
        },
      };
    },
    exec(sql: string) {
      raw.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    close() {
      raw.close();
    },
  } as Db;
}

describe("secret-migration", () => {
  test("明文行迁移为 aes:v1，旧密文保留，已加密不变", () => {
    const db = makeDb();
    db.exec(`
      CREATE TABLE secrets(name TEXT, scope TEXT, value TEXT, PRIMARY KEY(name, scope));
      CREATE TABLE credentials(provider TEXT PRIMARY KEY, api_key TEXT, updated_at TEXT);
      CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT);
    `);
    const key = randomSecretKey();
    const already = encryptWithKey("already-encrypted", key);
    db.prepare("INSERT INTO secrets(name, scope, value) VALUES (?, ?, ?)").run(
      "PLAIN",
      "global",
      "plain-value-123",
    );
    db.prepare("INSERT INTO secrets(name, scope, value) VALUES (?, ?, ?)").run(
      "LEGACY",
      "global",
      "enc:v1:old-rust-ciphertext",
    );
    db.prepare("INSERT INTO secrets(name, scope, value) VALUES (?, ?, ?)").run(
      "AES",
      "global",
      already,
    );
    db.prepare("INSERT INTO credentials(provider, api_key, updated_at) VALUES (?, ?, ?)").run(
      "custom-x",
      "provider-key-123",
      "now",
    );
    db.prepare("INSERT INTO kv(key, value) VALUES (?, ?)").run(
      "remote.token",
      "remote-token-123",
    );
    db.prepare("INSERT INTO kv(key, value) VALUES (?, ?)").run(
      "backup.config.v1",
      JSON.stringify({
        s3SecretAccessKey: "s3-secret-123",
        davPassword: "enc:v1:legacy-pass",
        passphrase: "",
        keep: "not-a-secret",
      }),
    );

    const result = migrateSecretsToEncrypted(db, (plain) => encryptWithKey(plain, key));
    expect(result).toEqual({ migrated: 4, legacy: 2, failed: 0 });

    const rows = db.prepare("SELECT name, value FROM secrets ORDER BY name").all() as Array<{
      name: string;
      value: string;
    }>;
    const byName = new Map(rows.map((r) => [r.name, r.value]));
    expect(byName.get("PLAIN")!.startsWith("aes:v1:")).toBe(true);
    expect(decryptWithKey(byName.get("PLAIN")!, key)).toEqual({
      ok: true,
      value: "plain-value-123",
    });
    expect(byName.get("LEGACY")).toBe("enc:v1:old-rust-ciphertext");
    expect(byName.get("AES")).toBe(already);

    const cred = db
      .prepare("SELECT api_key FROM credentials WHERE provider = ?")
      .get("custom-x") as { api_key: string };
    expect(cred.api_key.startsWith("aes:v1:")).toBe(true);
    expect(decryptWithKey(cred.api_key, key)).toEqual({ ok: true, value: "provider-key-123" });

    const token = db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get("remote.token") as { value: string };
    expect(token.value.startsWith("aes:v1:")).toBe(true);
    expect(decryptWithKey(token.value, key)).toEqual({ ok: true, value: "remote-token-123" });

    const backup = db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get("backup.config.v1") as { value: string };
    const parsed = JSON.parse(backup.value) as Record<string, string>;
    expect(parsed.s3SecretAccessKey.startsWith("aes:v1:")).toBe(true);
    expect(decryptWithKey(parsed.s3SecretAccessKey, key)).toEqual({
      ok: true,
      value: "s3-secret-123",
    });
    expect(parsed.davPassword).toBe("enc:v1:legacy-pass");
    expect(parsed.keep).toBe("not-a-secret");
  });
});
