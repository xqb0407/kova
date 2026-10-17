import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getLocalDb,
  initLocalStorage,
  resetStorageForTest,
} from "../../src/storage/hostdb";
import { normalizeProviderId } from "../../src/model/provider-id";
import { getModels } from "../../src/model/model-catalog";
import { credentialStore } from "../../src/storage/storage";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-azure-migration-"));

beforeAll(() => {
  resetStorageForTest();
  const dbPath = path.join(tmp, "state.db");
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE credentials (
      provider TEXT PRIMARY KEY,
      api_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE models (
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      name TEXT,
      reasoning INTEGER,
      context_window INTEGER,
      max_tokens INTEGER,
      input_json TEXT,
      cost_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (provider, model_id)
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      first_message TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_provider TEXT,
      model_id TEXT
    );
    CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  seed
    .prepare("INSERT INTO credentials(provider, api_key, updated_at) VALUES(?1, ?2, ?3)")
    .run("azure-openai-responses", "secret-key", "2026-10-01T00:00:00Z");
  seed
    .prepare(
      "INSERT INTO models(provider, model_id, name, reasoning, context_window, max_tokens, enabled) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .run("azure-openai-responses", "gpt-6-sol", "GPT-6 Sol", 1, 272000, 128000, 1);
  seed
    .prepare(
      "INSERT INTO sessions(id, title, first_message, cwd, created_at, updated_at, model_provider, model_id) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .run("s1", "t", "m", "/tmp", "2026-10-01", "2026-10-01", "azure-openai-responses", "gpt-6-sol");
  seed
    .prepare("INSERT INTO kv(key, value) VALUES('pi.model', ?1)")
    .run(JSON.stringify({ provider: "azure-openai-responses", modelId: "gpt-6-sol" }));
  seed
    .prepare("INSERT INTO kv(key, value) VALUES('credential.env.azure-openai-responses', ?1)")
    .run(JSON.stringify({ accountId: "acc-1" }));
  seed.close();

  initLocalStorage(dbPath);
});

afterAll(() => {
  resetStorageForTest();
  rmSync(tmp, { recursive: true, force: true });
});

describe("Azure provider id 迁移", () => {
  test("provider 别名归一", () => {
    expect(normalizeProviderId("azure-openai-responses")).toBe("azure");
    expect(normalizeProviderId("azure")).toBe("azure");
    expect(normalizeProviderId("anthropic")).toBe("anthropic");
  });

  test("credentials/models/sessions/kv 全部迁到新 id", () => {
    const db = getLocalDb()!;
    const credentials = db
      .query("SELECT provider FROM credentials")
      .all() as Array<{ provider: string }>;
    expect(credentials).toEqual([{ provider: "azure" }]);

    const models = db
      .query("SELECT provider, model_id FROM models")
      .all() as Array<{ provider: string; model_id: string }>;
    expect(models).toEqual([{ provider: "azure", model_id: "gpt-6-sol" }]);

    const sessions = db
      .query("SELECT model_provider FROM sessions WHERE id = 's1'")
      .get() as { model_provider: string };
    expect(sessions.model_provider).toBe("azure");

    const model = db
      .query("SELECT value FROM kv WHERE key = 'pi.model'")
      .get() as { value: string };
    expect(JSON.parse(model.value)).toEqual({
      provider: "azure",
      modelId: "gpt-6-sol",
    });

    const env = db
      .query("SELECT value FROM kv WHERE key = 'credential.env.azure'")
      .get() as { value: string } | null;
    expect(JSON.parse(env!.value)).toEqual({ accountId: "acc-1" });
    expect(
      db.query("SELECT key FROM kv WHERE key = 'credential.env.azure-openai-responses'").get(),
    ).toBeNull();
  });

  test("旧 id 仍能读到凭据与模型（读时别名）", async () => {
    const cred = await credentialStore.read("azure-openai-responses");
    expect(cred).toMatchObject({ type: "api_key", key: "secret-key" });

    const models = getModels();
    const azure = models.getProvider("azure");
    expect(azure).toBeDefined();
    const sample = azure!.getModels()[0];
    expect(sample).toBeDefined();
    expect(models.getModel("azure-openai-responses", sample!.id)?.provider).toBe(
      "azure",
    );
  });
});
