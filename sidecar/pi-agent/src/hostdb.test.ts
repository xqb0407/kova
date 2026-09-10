import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initLocalStorage,
  initHostTransport,
  resetStorageForTest,
  resolveHostResult,
  sessionGet,
  sessionInsert,
  sessionList,
  sessionDelete,
  sessionRename,
  sessionTouch,
  credentialGet,
  credentialList,
  credentialSet,
  credentialDelete,
  customProviderUpsert,
  customProviderGet,
  customProviderDelete,
  customProviderSetEnabled,
  customProvidersList,
  providerModelsGet,
  providerModelsSet,
  providerModelsAll,
  getLocalDb,
} from "./hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-hostdb-"));

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
});

afterAll(() => {
  // bun test 单进程共享模块注册表：清掉 transport/连接，避免污染后续文件
  resetStorageForTest();
});

describe("local mode: sessions", () => {
  test("insert/get/list/touch roundtrip", async () => {
    await sessionInsert("hdb-1", "d:/work");
    const row = await sessionGet("hdb-1");
    expect(row?.cwd).toBe("d:/work");

    await sessionTouch("hdb-1", "first", "first");
    const listed = await sessionList();
    const found = listed.find((s) => s.id === "hdb-1");
    expect(found?.cwd).toBe("d:/work");
    expect(found?.first_message).toBe("first");

    // title/first_message 仅在为空时回填
    await sessionTouch("hdb-1", "second", "second");
    const again = (await sessionList()).find((s) => s.id === "hdb-1");
    expect(again?.first_message).toBe("first");
  });

  test("rename and delete", async () => {
    await sessionInsert("hdb-2", "");
    await sessionRename("hdb-2", "renamed");
    const row = getLocalDb()!
      .query<{ title: string }, [string]>("SELECT title FROM pi_sessions WHERE id = ?")
      .get("hdb-2")!;
    expect(row.title).toBe("renamed");
    await sessionDelete("hdb-2");
    expect(await sessionGet("hdb-2")).toBeNull();
  });
});

describe("local mode: credentials", () => {
  test("set/get/list/delete roundtrip", async () => {
    await credentialSet("prov-h1", "sk-1");
    expect(await credentialGet("prov-h1")).toEqual({ apiKey: "sk-1" });
    // 覆盖更新
    await credentialSet("prov-h1", "sk-2");
    expect((await credentialGet("prov-h1"))?.apiKey).toBe("sk-2");
    expect(await credentialList()).toContain("prov-h1");
    await credentialDelete("prov-h1");
    expect(await credentialGet("prov-h1")).toBeNull();
    expect(await credentialList()).not.toContain("prov-h1");
  });
});

describe("local mode: custom providers", () => {
  test("upsert/get/enabled/list/delete", async () => {
    await customProviderUpsert({
      id: "cp-h1",
      name: "H1",
      baseUrl: "https://h1.io",
      models: JSON.stringify([{ id: "m" }]),
      api: "openai-chat",
    });
    const row = await customProviderGet("cp-h1");
    expect(row?.enabled).toBe(true);
    expect(row?.baseUrl).toBe("https://h1.io");

    await customProviderSetEnabled("cp-h1", false);
    expect((await customProviderGet("cp-h1"))?.enabled).toBe(false);
    expect((await customProvidersList()).find((r) => r.id === "cp-h1")?.enabled).toBe(false);

    await customProviderDelete("cp-h1");
    expect(await customProviderGet("cp-h1")).toBeNull();
  });
});

describe("local mode: provider models", () => {
  test("set non-empty filters, empty clears", async () => {
    await providerModelsSet("prov-hf", JSON.stringify(["a", "b"]));
    expect(JSON.parse((await providerModelsGet("prov-hf"))!.models)).toEqual(["a", "b"]);
    expect((await providerModelsAll()).find((r) => r.provider === "prov-hf")).toBeDefined();

    await providerModelsSet("prov-hf", "[]");
    expect(await providerModelsGet("prov-hf")).toBeNull();
    expect((await providerModelsAll()).find((r) => r.provider === "prov-hf")).toBeUndefined();
  });
});

describe("host mode: host_query RPC", () => {
  const captured: string[] = [];
  let origWrite: typeof process.stdout.write;

  beforeAll(() => {
    origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
      captured.push(String(c));
      return true;
    };
    initHostTransport();
  });

  afterAll(() => {
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
      origWrite as unknown as (c: unknown) => boolean;
    resetStorageForTest();
  });

  test("query writes host_query lines and resolves on host_result", async () => {
    captured.length = 0;
    const promise = sessionGet("hq-1");
    // 让微任务跑完，确保 stdout.write 已发生
    await new Promise((r) => setTimeout(r, 5));

    expect(captured.length).toBe(1);
    const sent = JSON.parse(captured[0]) as Record<string, unknown>;
    expect(sent.type).toBe("host_query");
    expect(sent.kind).toBe("session_get");
    expect(sent.params).toEqual({ sessionId: "hq-1" });
    expect(String(sent.id)).toMatch(/^hq-\d+$/);

    // 模拟宿主回写
    expect(resolveHostResult({ type: "host_result", id: sent.id, ok: true, data: { cwd: "d:/x" } })).toBe(true);
    await expect(promise).resolves.toEqual({ cwd: "d:/x" });
  });

  test("error host_result rejects", async () => {
    const promise = sessionGet("hq-2");
    await new Promise((r) => setTimeout(r, 5));
    const sent = JSON.parse(captured[captured.length - 1]) as { id: string };
    resolveHostResult({ type: "host_result", id: sent.id, ok: false, error: "boom" });
    await expect(promise).rejects.toThrow("boom");
  });

  test("unmatched host_result is swallowed", () => {
    expect(resolveHostResult({ type: "host_result", id: "nope", ok: true, data: null })).toBe(true);
    expect(resolveHostResult({ type: "other" })).toBe(false);
  });
});
