import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "../../src/storage/storage";
import {
  customProviderUpsert,
  kvGet,
  kvSet,
  modelsReplace,
} from "../../src/storage/hostdb";
import {
  getLastUsedModelKey,
  getModels,
  initLastUsedModelKey,
  isSelectableModel,
  reconcileLastUsedModel,
  registerCustomProvider,
  setCurrentModelKey,
  setLastUsedModelKey,
} from "../../src/model/model-catalog";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-last-used-"));

async function register(id: string, modelId: string): Promise<void> {
  const baseUrl = `https://${id}.example.com/v1`;
  await customProviderUpsert({
    id,
    name: id,
    baseUrl,
    models: "[]",
    api: "openai-chat",
  });
  await modelsReplace(id, [{ modelId, enabled: true }]);
  await registerCustomProvider({ id, name: id, baseUrl, api: "openai-chat" });
}

beforeAll(async () => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  await register("lu-a", "ma");
  await register("lu-b", "mb");
});

// 同进程其它测试文件会读全局模型键：每个用例结束立刻归零，缩短污染窗口
afterEach(async () => {
  await setLastUsedModelKey(null);
  setCurrentModelKey(null);
});

describe("最近使用模型缓存", () => {
  test("initLastUsedModelKey 从 kv 恢复", async () => {
    await setLastUsedModelKey(null);
    await kvSet(
      "pi.model.lastUsed",
      JSON.stringify({ provider: "lu-a", modelId: "ma" }),
    );
    await initLastUsedModelKey();
    expect(getLastUsedModelKey()).toEqual({ provider: "lu-a", modelId: "ma" });
  });

  test("可选性：目录 + 凭据 + 模型过滤可见性", async () => {
    expect(await isSelectableModel("lu-a", "ma")).toBe(true);
    expect(await isSelectableModel("lu-a", "missing")).toBe(false);
    expect(await isSelectableModel("lu-missing", "ma")).toBe(false);

    // 被模型过滤隐藏（enabled=false）不算可用
    await modelsReplace("lu-a", [{ modelId: "ma", enabled: false }]);
    expect(await isSelectableModel("lu-a", "ma")).toBe(false);
    await modelsReplace("lu-a", [{ modelId: "ma", enabled: true }]);
    expect(await isSelectableModel("lu-a", "ma")).toBe(true);
  });

  test("缓存失效 → 改成默认模型（并落 kv）", async () => {
    await setLastUsedModelKey({ provider: "lu-a", modelId: "ma" });
    setCurrentModelKey({ provider: "lu-b", modelId: "mb" });
    // 模拟 provider 被删除：目录里已经找不到 lu-a/ma
    getModels().deleteProvider("lu-a");

    expect(await reconcileLastUsedModel()).toEqual({
      provider: "lu-b",
      modelId: "mb",
    });
    expect(getLastUsedModelKey()).toEqual({
      provider: "lu-b",
      modelId: "mb",
    });
    const kv = await kvGet("pi.model.lastUsed");
    expect(JSON.parse(kv!.value)).toEqual({
      provider: "lu-b",
      modelId: "mb",
    });
  });

  test("没有缓存时不主动写默认模型", async () => {
    await setLastUsedModelKey(null);
    setCurrentModelKey({ provider: "lu-b", modelId: "mb" });
    expect(await reconcileLastUsedModel()).toBeNull();
    expect(getLastUsedModelKey()).toBeNull();
  });

  test("缓存与默认都不可用 → 清空缓存", async () => {
    await setLastUsedModelKey({ provider: "lu-gone", modelId: "x" });
    setCurrentModelKey({ provider: "lu-gone-2", modelId: "y" });
    expect(await reconcileLastUsedModel()).toBeNull();
    expect(getLastUsedModelKey()).toBeNull();
    const kv = await kvGet("pi.model.lastUsed");
    expect(JSON.parse(kv!.value)).toBeNull();
  });
});
