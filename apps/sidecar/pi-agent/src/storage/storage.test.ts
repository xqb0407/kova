import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, credentialStore, sessionPath } from "./storage";
import { customProviderUpsert, customProviderGet } from "./hostdb";

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
  test("custom_providers table with api/enabled columns", async () => {
    await customProviderUpsert({
      id: "cp1",
      name: "CP1",
      baseUrl: "https://x.io",
      models: "[]",
      api: "openai-responses",
    });
    const row = await customProviderGet("cp1");
    expect(row?.api).toBe("openai-responses");
    expect(row?.enabled).toBe(true); // 默认启用
  });
});

describe("sessionPath", () => {
  test("joins sessions dir with id", () => {
    expect(sessionPath("abc").replace(/\\/g, "/")).toMatch(
      /\/sessions\/abc\.jsonl$/,
    );
  });
});
