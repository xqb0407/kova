import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../main/db";

const dataDir = mkdtempSync(join(tmpdir(), "kova-mcp-secret-env-"));

// secret-env → secret → electron；bun 下用最小 mock 走真实 AES 加解密路径。
mock.module("electron", () => ({
  app: {
    getPath: () => dataDir,
    getAppPath: () => dataDir,
    isPackaged: false,
    setName: () => {},
    setPath: () => {},
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`wrapped:${value}`, "utf8"),
    decryptString: (buf: Buffer) => buf.toString("utf8").replace(/^wrapped:/, ""),
  },
}));

const prevLogLevel = process.env.KOVA_LOG_LEVEL;

beforeAll(() => {
  process.env.KOVA_LOG_LEVEL = "off";
});

afterAll(() => {
  if (prevLogLevel === undefined) delete process.env.KOVA_LOG_LEVEL;
  else process.env.KOVA_LOG_LEVEL = prevLogLevel;
});

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

describe("resolveMcpSecretEnv（宿主解密路径）", () => {
  test("按 envName 返回解密值；缺失/不可解条目跳过", async () => {
    const { initSecretCipher, encrypt } = await import("../main/secret");
    const { resolveMcpSecretEnv } = await import("../main/secret-env");
    initSecretCipher(dataDir);

    const db = makeDb();
    db.exec("CREATE TABLE secrets(name TEXT, scope TEXT, value TEXT, PRIMARY KEY(name, scope))");
    db.prepare("INSERT INTO secrets(name, scope, value) VALUES (?, ?, ?)").run(
      "GH_PAT",
      "global",
      encrypt("github-token-123456"),
    );
    db.prepare("INSERT INTO secrets(name, scope, value) VALUES (?, ?, ?)").run(
      "BROKEN",
      "global",
      "enc:v1:retired-rust-ciphertext",
    );

    expect(
      resolveMcpSecretEnv(
        db,
        [
          { envName: "GITHUB_TOKEN", name: "GH_PAT", scope: "global" },
          { envName: "MISSING", name: "NOPE", scope: "global" },
          { envName: "BAD", name: "BROKEN", scope: "global" },
        ],
        "github",
      ),
    ).toEqual({ GITHUB_TOKEN: "github-token-123456" });
  });
});
