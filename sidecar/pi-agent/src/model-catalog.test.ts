import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "./storage";
import {
  customProviderUpsert,
  customProviderSetEnabled,
  getLocalDb,
  modelsReplace,
  modelsDeleteProvider,
} from "./hostdb";
import {
  getModels,
  normalizeApi,
  registerCustomProvider,
  loadCustomProviders,
  applyModelOverrides,
  applyRowToCatalogModel,
  getCurrentModelKey,
  setCurrentModelKey,
  defaultModel,
} from "./model-catalog";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-catalog-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
});

describe("normalizeApi", () => {
  test("keeps known kinds", () => {
    expect(normalizeApi("openai-chat")).toBe("openai-chat");
    expect(normalizeApi("openai-responses")).toBe("openai-responses");
    expect(normalizeApi("anthropic-messages")).toBe("anthropic-messages");
  });

  test("falls back to openai-chat", () => {
    expect(normalizeApi(undefined)).toBe("openai-chat");
    expect(normalizeApi("weird")).toBe("openai-chat");
  });
});

describe("registerCustomProvider", () => {
  test("registers models from the models table with normalized baseUrl", async () => {
    await modelsReplace("mc-p1", [
      { modelId: "m1", name: "Model One", contextWindow: 8_000, enabled: true },
      { modelId: "   ", enabled: true }, // 空白 id 会被过滤
      { modelId: "m-off", enabled: false }, // 停用行不注册
    ]);
    await registerCustomProvider({
      id: "mc-p1",
      name: "MC P1",
      baseUrl: "https://api.example.com/v1/",
      api: "openai-chat",
    });
    const m = getModels().getModel("mc-p1", "m1")!;
    expect(m.baseUrl).toBe("https://api.example.com/v1"); // 去尾部斜杠
    expect(m.contextWindow).toBe(8_000);
    expect(m.name).toBe("Model One");
    expect(m.provider).toBe("mc-p1");
    // 未覆盖属性取自定义默认值
    expect(m.reasoning).toBe(false);
    expect(m.maxTokens).toBe(8_192);
    expect(m.input).toEqual(["text"]);
    expect(getModels().getModel("mc-p1", "   ")).toBeUndefined();
    expect(getModels().getModel("mc-p1", "m-off")).toBeUndefined();
  });
});

describe("loadCustomProviders", () => {
  test("registers enabled rows only", async () => {
    await customProviderUpsert({
      id: "mc-on",
      name: "On",
      baseUrl: "https://on.io",
      models: "[]",
      api: "openai-chat",
    });
    await customProviderUpsert({
      id: "mc-off",
      name: "Off",
      baseUrl: "https://off.io",
      models: "[]",
      api: "openai-chat",
    });
    await customProviderSetEnabled("mc-off", false);
    await modelsReplace("mc-on", [{ modelId: "a", enabled: true }]);
    await modelsReplace("mc-off", [{ modelId: "b", enabled: true }]);

    await loadCustomProviders();
    expect(getModels().getModel("mc-on", "a")).toBeDefined();
    expect(getModels().getModel("mc-off", "b")).toBeUndefined();
  });

  test("local storage is active in tests", () => {
    expect(getLocalDb()).not.toBeNull();
  });
});

describe("applyRowToCatalogModel", () => {
  test("overrides builtin attrs and resets with nulls", async () => {
    // 任取一个内置模型（目录在首次 getModels() 时已构建）
    const anyProvider = getModels().getProviders()[0];
    const target = anyProvider.getModels()[0];
    const original = {
      name: target.name,
      contextWindow: target.contextWindow,
      maxTokens: target.maxTokens,
    };

    applyRowToCatalogModel({
      provider: anyProvider.id,
      modelId: target.id,
      name: "Renamed",
      reasoning: true,
      contextWindow: 123_456,
      maxTokens: 4_321,
      input: ["text", "image"],
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    });
    expect(target.name).toBe("Renamed");
    expect(target.contextWindow).toBe(123_456);
    expect(target.maxTokens).toBe(4_321);
    expect(target.reasoning).toBe(true);
    expect(target.input).toEqual(["text", "image"]);
    expect(target.cost).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });

    // null 字段恢复原始值（快照）
    applyRowToCatalogModel({
      provider: anyProvider.id,
      modelId: target.id,
      name: null,
      reasoning: null,
      contextWindow: null,
      maxTokens: null,
      input: null,
      cost: null,
    });
    expect(target.name).toBe(original.name);
    expect(target.contextWindow).toBe(original.contextWindow);
    expect(target.maxTokens).toBe(original.maxTokens);

    // 清理：不留过滤行
    await modelsDeleteProvider(anyProvider.id);
  });
});

describe("extra catalog models (builtin provider)", () => {
  test("applyRowToCatalogModel attaches unknown modelId to builtin provider", async () => {
    const p = getModels().getProviders().find((x) => x.getModels().length > 0)!;
    const sibling = p.getModels()[0];
    const newId = "mc-extra-added-model";

    // 目录外 modelId 按行挂载：有值字段生效，null 字段取自定义默认值
    applyRowToCatalogModel({
      provider: p.id,
      modelId: newId,
      name: "Extra",
      reasoning: null,
      contextWindow: 777_000,
      maxTokens: null,
      input: null,
      cost: null,
    });
    const m = getModels().getModel(p.id, newId)!;
    expect(m).toBeDefined();
    expect(m.name).toBe("Extra");
    expect(m.api).toBe(sibling.api); // api/baseUrl 继承同 provider 现有模型
    expect(m.baseUrl).toBe(sibling.baseUrl);
    expect(m.contextWindow).toBe(777_000);
    expect(m.maxTokens).toBe(8_192);
    expect(m.input).toEqual(["text"]);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    // applyModelOverrides 重放全部行：更新属性且不重复挂载
    await modelsReplace(p.id, [{ modelId: newId, name: "Extra2", enabled: true }]);
    await applyModelOverrides();
    expect(getModels().getModel(p.id, newId)!.name).toBe("Extra2");
    expect(
      getModels().getProvider(p.id)!.getModels().filter((x) => x.id === newId),
    ).toHaveLength(1);

    await modelsDeleteProvider(p.id);
  });
});

describe("currentModelKey", () => {
  test("get/set roundtrip", () => {
    expect(getCurrentModelKey()).toBeNull();
    setCurrentModelKey({ provider: "p", modelId: "m" });
    expect(getCurrentModelKey()).toEqual({ provider: "p", modelId: "m" });
    setCurrentModelKey(null);
    expect(getCurrentModelKey()).toBeNull();
  });
});

describe("defaultModel", () => {
  test("returns undefined when nothing is configured", async () => {
    expect(await defaultModel()).toBeUndefined();
  });
});
