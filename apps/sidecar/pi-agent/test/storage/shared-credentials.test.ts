/**
 * 共享凭据文件注入单测：写一份临时镜像 → injectSharedCredentials →
 * 断言本地三张表（credentials/custom_providers/models）行内容。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCredentialFile } from "pi-protocol/credential-file";
import {
  credentialGet,
  credentialList,
  credentialSet,
  customProviderUpsert,
  customProvidersList,
  initLocalStorage,
  modelsAll,
  modelsReplace,
  resetStorageForTest,
} from "../../src/storage/hostdb";
import { injectSharedCredentials } from "../../src/storage/shared-credentials";

let tmp: string;
let dbPath: string;
let filePath: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "pi-agent-shared-credentials-"));
  dbPath = join(tmp, "state.db");
  filePath = join(tmp, "credentials.json");
  initLocalStorage(dbPath);
  // 不传 secret：与注入侧同用机器派生密钥（生产路径桌面/进程两端同源）
  writeCredentialFile(
    filePath,
    {
      credentials: { "my-gateway": "gw-secret-key" },
      customProviders: [
        {
          id: "my-gateway",
          name: "Gateway",
          baseUrl: "https://gw.example.com",
          models: JSON.stringify([{ modelId: "gw-mini" }]),
          api: "openai-chat",
          enabled: false,
          autoDiscover: false,
          headers: "{}",
        },
      ],
      models: [
        {
          provider: "my-gateway",
          modelId: "gw-mini",
          name: "GW Mini",
          contextWindow: 128000,
          reasoning: true,
          enabled: true,
        },
      ],
    },
  );
  await injectSharedCredentials(filePath);
});

afterAll(() => {
  resetStorageForTest();
  rmSync(tmp, { recursive: true, force: true });
});

describe("shared credentials injection", () => {
  test("凭据注入（明文入本地库）", async () => {
    const cred = await credentialGet("my-gateway");
    expect(cred?.apiKey).toBe("gw-secret-key");
  });

  test("自定义 provider 注入；禁用态跟随镜像", async () => {
    const rows = await customProvidersList();
    const row = rows.find((r) => r.id === "my-gateway");
    expect(row).toBeTruthy();
    expect(row?.baseUrl).toBe("https://gw.example.com");
    expect(row?.enabled).toBe(false);
  });

  test("模型条目注入（含解析字段）", async () => {
    const rows = await modelsAll();
    const row = rows.find((m) => m.provider === "my-gateway" && m.modelId === "gw-mini");
    expect(row).toBeTruthy();
    expect(row?.name).toBe("GW Mini");
    expect(row?.contextWindow).toBe(128000);
    expect(row?.reasoning).toBe(true);
  });

  test("缺文件 no-op 不抛错", async () => {
    await injectSharedCredentials(join(tmp, "absent.json"));
  });

  test("损坏文件 no-op 不抛错", async () => {
    const { writeFileSync } = await import("node:fs");
    const broken = join(tmp, "broken.json");
    writeFileSync(broken, "{not json", "utf8");
    await injectSharedCredentials(broken);
  });

  test("删除传播：本地残留的镜像外行（凭据/provider/模型）被清掉", async () => {
    // 预置镜像外残留：旧凭据、旧 provider、旧 provider 的模型行
    await credentialSet("stale-gateway", "stale-key");
    await customProviderUpsert({
      id: "stale-gateway",
      name: "Stale",
      baseUrl: "https://stale.example.com",
      models: "[]",
      api: "openai-chat",
      headers: "{}",
    });
    await modelsReplace("stale-gateway", [{ modelId: "stale-model", enabled: true }]);
    expect((await credentialList()).includes("stale-gateway")).toBe(true);

    // 重注入（镜像里没有 stale-gateway）
    await injectSharedCredentials(filePath);

    const creds = await credentialList();
    expect(creds.includes("stale-gateway")).toBe(false);
    expect(creds.includes("my-gateway")).toBe(true);
    const cps = await customProvidersList();
    expect(cps.find((r) => r.id === "stale-gateway")).toBeUndefined();
    expect(cps.find((r) => r.id === "my-gateway")).toBeTruthy();
    const models = await modelsAll();
    expect(models.find((m) => m.provider === "stale-gateway")).toBeUndefined();
    expect(models.find((m) => m.provider === "my-gateway" && m.modelId === "gw-mini")).toBeTruthy();
  });
});
