import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, db, credentialStore, sessionPath } from "./storage";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-storage-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
});

describe("credentialStore", () => {
  test("modify + read roundtrip", async () => {
    await credentialStore.modify("prov-a", async () => ({
      type: "api_key",
      key: "sk-a",
    }));
    const cred = await credentialStore.read("prov-a");
    expect(cred).toEqual({ type: "api_key", key: "sk-a" });
  });

  test("modify with undefined deletes nothing but is tolerated", async () => {
    const next = await credentialStore.modify("prov-new", async () => undefined);
    expect(next).toBeUndefined();
  });

  test("list returns saved providers", async () => {
    const list = await credentialStore.list();
    expect(list.map((c) => c.providerId)).toContain("prov-a");
  });

  test("delete removes the credential", async () => {
    await credentialStore.delete("prov-a");
    expect(await credentialStore.read("prov-a")).toBeUndefined();
  });
});

describe("schema", () => {
  test("custom_providers table with api/enabled columns", () => {
    db.query(
      "INSERT INTO custom_providers (id, name, base_url, models, api) VALUES (?, ?, ?, ?, ?)",
    ).run("cp1", "CP1", "https://x.io", "[]", "openai-responses");
    const row = db
      .query<{ api: string; enabled: number }, [string]>(
        "SELECT api, enabled FROM custom_providers WHERE id = ?",
      )
      .get("cp1")!;
    expect(row.api).toBe("openai-responses");
    expect(row.enabled).toBe(1); // 默认启用
  });

  test("provider_models upsert", () => {
    db.query(
      "INSERT INTO provider_models (provider, models) VALUES (?, ?) " +
        "ON CONFLICT(provider) DO UPDATE SET models = excluded.models",
    ).run("prov-b", JSON.stringify(["m1"]));
    db.query(
      "INSERT INTO provider_models (provider, models) VALUES (?, ?) " +
        "ON CONFLICT(provider) DO UPDATE SET models = excluded.models",
    ).run("prov-b", JSON.stringify(["m1", "m2"]));
    const row = db
      .query<{ models: string }, [string]>(
        "SELECT models FROM provider_models WHERE provider = ?",
      )
      .get("prov-b")!;
    expect(JSON.parse(row.models)).toEqual(["m1", "m2"]);
  });
});

describe("sessionPath", () => {
  test("joins sessions dir with id", () => {
    expect(sessionPath("abc").replace(/\\/g, "/")).toMatch(
      /\/sessions\/abc\.jsonl$/,
    );
  });
});
