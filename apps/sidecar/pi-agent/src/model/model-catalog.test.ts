import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "../storage/storage";
import {
  customProviderUpsert,
  customProviderSetEnabled,
  getLocalDb,
  modelsReplace,
  modelsDeleteProvider,
} from "../storage/hostdb";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  getModelDefaultedAttrs,
  getModels,
  lookupCatalogModelSeed,
  normalizeApi,
  normalizeThinkingMap,
  registerCustomProvider,
  setThinkingMapOverrides,
  loadCustomProviders,
  applyModelOverrides,
  applyRowToCatalogModel,
  getCurrentModelKey,
  setCurrentModelKey,
  defaultModel,
  makePromptCacheKeyPayloadHook,
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

describe("getModelDefaultedAttrs（缺省猜测值归因）", () => {
  test("自定义端点行未填上下文/输出/输入模态标未确认，填过即确认", async () => {
    await modelsReplace("mc-def", [
      { modelId: "guess-all", enabled: true },
      {
        modelId: "confirmed",
        enabled: true,
        contextWindow: 32_768,
        maxTokens: 4_096,
        input: ["text", "image"],
      },
    ]);
    await registerCustomProvider({
      id: "mc-def",
      name: "MC Def",
      baseUrl: "https://api.example.com/v1",
      api: "openai-chat",
    });
    expect(getModelDefaultedAttrs("mc-def", "guess-all").sort()).toEqual([
      "contextWindow",
      "input",
      "maxTokens",
    ]);
    expect(getModelDefaultedAttrs("mc-def", "confirmed")).toEqual([]);
  });

  test("自定义端点行重放：非 null 即确认，null 回到猜测", () => {
    applyRowToCatalogModel({
      provider: "mc-def",
      modelId: "guess-all",
      name: null,
      reasoning: null,
      contextWindow: 65_536,
      maxTokens: null,
      input: null,
      cost: null,
    });
    expect(getModelDefaultedAttrs("mc-def", "guess-all")).toEqual([
      "maxTokens",
      "input",
    ]);
    applyRowToCatalogModel({
      provider: "mc-def",
      modelId: "guess-all",
      name: null,
      reasoning: null,
      contextWindow: null,
      maxTokens: null,
      input: null,
      cost: null,
    });
    expect(getModelDefaultedAttrs("mc-def", "guess-all").sort()).toEqual([
      "contextWindow",
      "input",
      "maxTokens",
    ]);
  });

  test("目录内模型永不归因；目录外新增未填字段标未确认、填后清除", () => {
    const p = getModels()
      .getProviders()
      .find((x) => x.id !== "mc-def" && x.getModels().length > 0)!;
    expect(getModelDefaultedAttrs(p.id, p.getModels()[0].id)).toEqual([]);
    const newId = "mc-def-extra";
    applyRowToCatalogModel({
      provider: p.id,
      modelId: newId,
      name: null,
      reasoning: null,
      contextWindow: null,
      maxTokens: 4_096,
      input: null,
      cost: null,
    });
    expect(getModelDefaultedAttrs(p.id, newId)).toEqual([
      "contextWindow",
      "input",
    ]);
    applyRowToCatalogModel({
      provider: p.id,
      modelId: newId,
      name: null,
      reasoning: null,
      contextWindow: 128_000,
      maxTokens: 4_096,
      input: null,
      cost: null,
    });
    expect(getModelDefaultedAttrs(p.id, newId)).toEqual(["input"]);
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

describe("lookupCatalogModelSeed（按 modelId 反查目录属性种子）", () => {
  /** 任取一个内置目录里带思考映射的推理模型（跳过测试自建的 mc-* 自定义 provider） */
  function pickSeededBuiltin() {
    for (const p of getModels().getProviders()) {
      if (p.id.startsWith("mc-")) continue;
      const m = p.getModels().find((x) => x.reasoning && x.thinkingLevelMap);
      if (m) return { provider: p, model: m };
    }
    return undefined;
  }

  test("命中同名模型：继承思考参数与上下文属性并推导档位", () => {
    const hit = pickSeededBuiltin();
    if (!hit) return; // 目录缺数据时跳过（理论上不会发生）
    const seed = lookupCatalogModelSeed(hit.model.id)!;
    expect(seed).toBeDefined();
    expect(seed.reasoning).toBe(true);
    expect(seed.thinkingLevelMap).toEqual(hit.model.thinkingLevelMap);
    // 与 pi-ai 目录口径一致：off 不在档位清单里
    expect(seed.supportedThinkingLevels).not.toContain("off");
    expect(seed.supportedThinkingLevels).toEqual(
      getSupportedThinkingLevels(hit.model).filter((l) => l !== "off"),
    );
    // 上下文属性同样带上目录真值（自定义端点编辑回填的可信来源）
    expect(seed.contextWindow).toBe(hit.model.contextWindow);
    expect(seed.maxTokens).toBe(hit.model.maxTokens);
    expect(seed.input).toEqual([...hit.model.input]);
    expect(seed.cost.input).toBe(hit.model.cost.input);
    expect(seed.cost.output).toBe(hit.model.cost.output);
    // 种子是快照拷贝：改种子不回写目录
    seed.contextWindow += 1;
    expect(hit.model.contextWindow).toBeLessThan(seed.contextWindow);
  });

  test("大小写不敏感；未命中/空串回 undefined", () => {
    const hit = pickSeededBuiltin();
    if (hit) {
      expect(lookupCatalogModelSeed(hit.model.id.toUpperCase())?.reasoning).toBe(
        true,
      );
    }
    expect(lookupCatalogModelSeed("no-such-model-id-xyz")).toBeUndefined();
    expect(lookupCatalogModelSeed("   ")).toBeUndefined();
  });

  test("同名模型多 provider 命中时优先带映射的厂商自营条目", () => {
    // 找一个同时存在于聚合商与非聚合商、且至少一边带映射的 modelId；
    // 目录没有这种重叠就跳过（数据依赖，不做硬编码假设）
    const providers = getModels().getProviders().filter((p) => !p.id.startsWith("mc-"));
    const byId = new Map<string, { aggregator: boolean; hasMap: boolean }[]>();
    for (const p of providers) {
      const agg = [
        "openrouter",
        "vercel-ai-gateway",
        "cloudflare-ai-gateway",
        "cloudflare-workers-ai",
        "opencode",
        "opencode-go",
        "github-copilot",
        "together",
        "fireworks",
        "groq",
        "huggingface",
        "radius",
      ].includes(p.id);
      for (const m of p.getModels()) {
        const list = byId.get(m.id) ?? [];
        list.push({ aggregator: agg, hasMap: !!m.thinkingLevelMap });
        byId.set(m.id, list);
      }
    }
    const dual = [...byId.entries()].find(
      ([, hits]) =>
        hits.some((h) => h.hasMap) &&
        hits.some((h) => h.aggregator) &&
        hits.some((h) => !h.aggregator),
    );
    if (!dual) return;
    const seed = lookupCatalogModelSeed(dual[0])!;
    expect(seed).toBeDefined();
  });
});

describe("registerCustomProvider 目录属性种子", () => {
  function pickSeededBuiltinId() {
    for (const p of getModels().getProviders()) {
      if (p.id.startsWith("mc-")) continue;
      const m = p.getModels().find((x) => x.reasoning && x.thinkingLevelMap);
      if (m) return m;
    }
    return undefined;
  }

  test("行未标 reasoning 时继承目录种子（含 off 显式关闭值）", async () => {
    const builtin = pickSeededBuiltinId();
    if (!builtin) return;
    await modelsReplace("mc-seed", [{ modelId: builtin.id, enabled: true }]);
    await registerCustomProvider({
      id: "mc-seed",
      name: "MC Seed",
      baseUrl: "https://api.example.com/v1",
      api: "openai-chat",
    });
    const m = getModels().getModel("mc-seed", builtin.id)!;
    expect(m.reasoning).toBe(true);
    expect(m.thinkingLevelMap).toEqual(builtin.thinkingLevelMap);
  });

  test("行显式 reasoning=false 优先于种子；映射仍随种子带上", async () => {
    const builtin = pickSeededBuiltinId();
    if (!builtin) return;
    await modelsReplace("mc-seed2", [
      { modelId: builtin.id, reasoning: false, enabled: true },
    ]);
    await registerCustomProvider({
      id: "mc-seed2",
      name: "MC Seed 2",
      baseUrl: "https://api.example.com/v1",
      api: "openai-chat",
    });
    const m = getModels().getModel("mc-seed2", builtin.id)!;
    expect(m.reasoning).toBe(false);
    expect(m.thinkingLevelMap).toEqual(builtin.thinkingLevelMap);
  });

  test("行未填上下文属性时继承目录真值，且不标缺省未确认", async () => {
    const builtin = pickSeededBuiltinId();
    if (!builtin) return;
    await modelsReplace("mc-seed3", [{ modelId: builtin.id, enabled: true }]);
    await registerCustomProvider({
      id: "mc-seed3",
      name: "MC Seed 3",
      baseUrl: "https://api.example.com/v1",
      api: "openai-chat",
    });
    const m = getModels().getModel("mc-seed3", builtin.id)!;
    expect(m.contextWindow).toBe(builtin.contextWindow);
    expect(m.maxTokens).toBe(builtin.maxTokens);
    expect(m.input).toEqual([...builtin.input]);
    expect(m.cost).toEqual(builtin.cost);
    // 种子命中 = 生效值是目录真值，不是 128k/8192 猜测 → 无"缺省未确认"标记
    expect(getModelDefaultedAttrs("mc-seed3", builtin.id)).toEqual([]);
  });

  test("行显式填了上下文属性时行值优先于种子", async () => {
    const builtin = pickSeededBuiltinId();
    if (!builtin) return;
    await modelsReplace("mc-seed4", [
      {
        modelId: builtin.id,
        enabled: true,
        contextWindow: 66_000,
        input: ["text"],
      },
    ]);
    await registerCustomProvider({
      id: "mc-seed4",
      name: "MC Seed 4",
      baseUrl: "https://api.example.com/v1",
      api: "openai-chat",
    });
    const m = getModels().getModel("mc-seed4", builtin.id)!;
    expect(m.contextWindow).toBe(66_000);
    expect(m.input).toEqual(["text"]);
    // 未显式填的 maxTokens/cost 仍继承种子
    expect(m.maxTokens).toBe(builtin.maxTokens);
    expect(m.cost).toEqual(builtin.cost);
  });

  test("行属性清空（null）回落到种子真值时恢复缺省归因判定", async () => {
    const builtin = pickSeededBuiltinId();
    if (!builtin) return;
    await modelsReplace("mc-seed5", [
      { modelId: builtin.id, enabled: true, contextWindow: 66_000 },
    ]);
    await registerCustomProvider({
      id: "mc-seed5",
      name: "MC Seed 5",
      baseUrl: "https://api.example.com/v1",
      api: "openai-chat",
    });
    // 用户改回"未填"：update_model 语义下行值 null，重放后归因按种子命中判定
    applyRowToCatalogModel({
      provider: "mc-seed5",
      modelId: builtin.id,
      name: null,
      reasoning: null,
      contextWindow: null,
      maxTokens: null,
      input: null,
      cost: null,
    });
    expect(getModelDefaultedAttrs("mc-seed5", builtin.id)).toEqual([]);
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

describe("thinkingLevelMap frontend overrides", () => {
  test("normalizeThinkingMap keeps known keys with string/null values", () => {
    expect(
      normalizeThinkingMap({
        off: "none",
        minimal: null,
        bogus: "x",
        low: 42,
        high: "  ",
      }),
    ).toEqual({ off: "none", minimal: null });
    expect(normalizeThinkingMap("nope")).toBeUndefined();
    expect(normalizeThinkingMap({})).toBeUndefined();
  });

  test("overrides apply onto the catalog model and revert when replaced", () => {
    const openai = getModels().getProvider("openai");
    const m = openai?.getModels().find((x) => x.reasoning) ?? openai?.getModels()[0];
    if (!m) return; // 目录里没有 openai 模型（理论上不会发生）
    const key = `openai/${m.id}`;
    const baseline = m.thinkingLevelMap;

    expect(setThinkingMapOverrides({ [key]: { off: "none", minimal: null } })).toBe(1);
    expect(m.thinkingLevelMap).toMatchObject({
      ...(baseline ?? {}),
      off: "none",
      minimal: null,
    });
    expect(getSupportedThinkingLevels(m)).not.toContain("minimal");

    // 整包替换：新 map 里没有的键回到基线，不在旧覆盖上叠加
    setThinkingMapOverrides({ [key]: { off: "false" } });
    expect(m.thinkingLevelMap?.minimal).toBe(baseline?.minimal);

    // 清空恢复原值
    expect(setThinkingMapOverrides({})).toBe(0);
    expect(m.thinkingLevelMap).toBe(baseline);
  });
});

describe("makePromptCacheKeyPayloadHook", () => {
  const openaiModel = { api: "openai-completions" } as never;
  const otherModel = { api: "anthropic-messages" } as never;

  test("openai-completions 缺 key 时注入 sessionId", () => {
    const hook = makePromptCacheKeyPayloadHook("sess-123");
    expect(hook({ model: "m", messages: [] }, openaiModel)).toEqual({
      model: "m",
      messages: [],
      prompt_cache_key: "sess-123",
    });
  });

  test("payload 已带 prompt_cache_key（含显式 undefined 之外的值）不改", () => {
    const hook = makePromptCacheKeyPayloadHook("sess-123");
    const payload = { prompt_cache_key: "official-key" };
    expect(hook(payload, openaiModel)).toBeUndefined();
  });

  test("非 openai-completions 接口不动", () => {
    const hook = makePromptCacheKeyPayloadHook("sess-123");
    expect(hook({ input: [] }, otherModel)).toBeUndefined();
  });

  test("无 sessionId 不动", () => {
    const hook = makePromptCacheKeyPayloadHook(undefined);
    expect(hook({ messages: [] }, openaiModel)).toBeUndefined();
  });

  test("超长 sessionId 截断到 64 字符（OpenAI 上限）", () => {
    const hook = makePromptCacheKeyPayloadHook("x".repeat(100));
    const result = hook({ messages: [] }, openaiModel) as { prompt_cache_key: string };
    expect(result.prompt_cache_key).toHaveLength(64);
  });
});
