import { describe, expect, test } from "bun:test";
import {
  allowsStoredWebSearchKey,
  DEFAULT_WEBSEARCH_CONFIG,
  defaultCustomProvider,
  getWebSearchConfig,
  makePresetProvider,
  normalizeWebSearchConfig,
  resetWebSearchConfigForTest,
} from "../../src/tools/websearch/config";

describe("网页搜索配置归一化（单服务）", () => {
  test("默认配置：内置代理、开、8s/8 条", () => {
    expect(DEFAULT_WEBSEARCH_CONFIG.enabled).toBe(true);
    expect(DEFAULT_WEBSEARCH_CONFIG.provider.kind).toBe("deepcode");
    expect(DEFAULT_WEBSEARCH_CONFIG.provider.id).toBe("deepcode");
    expect(DEFAULT_WEBSEARCH_CONFIG.requestTimeoutMs).toBe(8_000);
    expect(DEFAULT_WEBSEARCH_CONFIG.maxResults).toBe(8);
  });

  test("未知/缺失 provider 回落内置代理；apiKey 不落配置；数值夹取", () => {
    const fallback = normalizeWebSearchConfig({});
    expect(fallback.provider.kind).toBe("deepcode");

    const unknown = normalizeWebSearchConfig({
      provider: { kind: "not-a-provider" },
    });
    expect(unknown.provider.kind).toBe("deepcode");

    const config = normalizeWebSearchConfig({
      enabled: false,
      provider: {
        kind: "tavily",
        label: "  My Tavily  ",
        apiKey: "secret-should-drop",
      },
      requestTimeoutMs: 999,
      maxResults: 99,
    });
    expect(config.enabled).toBe(false);
    expect(config.provider.id).toBe("tavily");
    expect(config.provider.label).toBe("My Tavily");
    expect("apiKey" in (config.provider as object)).toBe(false);
    expect(config.requestTimeoutMs).toBe(1_000);
    expect(config.maxResults).toBe(20);
  });

  test("custom 缺字段时补默认模板/路径；id 固定 custom", () => {
    const custom = normalizeWebSearchConfig({
      provider: { kind: "custom" },
    }).provider;
    expect(custom.id).toBe("custom");
    expect(custom.method).toBe("POST");
    expect(custom.bodyTemplate).toContain("{{query}}");
    expect(custom.resultsPath).toBe("results");
    expect(custom.titlePath).toBe("title");
    expect(custom.urlPath).toBe("url");
    expect(custom.snippetPath).toBe("snippet");

    const explicit = normalizeWebSearchConfig({
      provider: {
        id: "whatever",
        kind: "custom",
        method: "GET",
        headers: { Authorization: "Bearer {{apiKey}}" },
      },
    }).provider;
    expect(explicit.id).toBe("custom");
    expect(explicit.method).toBe("GET");
    expect(explicit.headers.Authorization).toBe("Bearer {{apiKey}}");
  });

  test("预置构造器：端点留空（providers.ts 用官方默认）", () => {
    const deepseek = makePresetProvider("deepseek");
    expect(deepseek.kind).toBe("deepseek");
    expect(deepseek.id).toBe("deepseek");
    expect(deepseek.baseUrl).toBe("");
    expect(deepseek.label).toBe("DeepSeek Search");

    const custom = defaultCustomProvider();
    expect(custom.id).toBe("custom");
    expect(custom.headers["Content-Type"]).toBe("application/json");
  });

  test("测试辅助：重置/覆盖只作用内存", () => {
    resetWebSearchConfigForTest({ enabled: false });
    expect(getWebSearchConfig().enabled).toBe(false);
    resetWebSearchConfigForTest();
    expect(getWebSearchConfig().enabled).toBe(true);
  });
});

describe("设置页测试读已保存 key 的端点许可", () => {
  test("官方端点/已保存端点放行；任意改端点拒绝", () => {
    const savedDeepseek = makePresetProvider("deepseek");
    // 未改端点（官方端点）放行
    expect(
      allowsStoredWebSearchKey(savedDeepseek, savedDeepseek),
    ).toBe(true);
    // 改到任意 URL：拒绝
    expect(
      allowsStoredWebSearchKey(
        { ...savedDeepseek, baseUrl: "https://attacker.example/search" },
        savedDeepseek,
      ),
    ).toBe(false);
    // 已保存的是自建代理端点：同端点放行，换端点拒绝
    const savedProxy = {
      ...savedDeepseek,
      baseUrl: "https://proxy.example/search",
    };
    expect(allowsStoredWebSearchKey(savedProxy, savedProxy)).toBe(true);
    expect(
      allowsStoredWebSearchKey(
        { ...savedDeepseek, baseUrl: "https://attacker.example/search" },
        savedProxy,
      ),
    ).toBe(false);

    // 自定义 API 没有官方端点：必须与已保存端点完全一致
    const customSaved = {
      ...defaultCustomProvider(),
      baseUrl: "https://api.example.com/search",
    };
    expect(allowsStoredWebSearchKey(customSaved, customSaved)).toBe(true);
    expect(
      allowsStoredWebSearchKey(
        { ...customSaved, baseUrl: "https://attacker.example/search" },
        customSaved,
      ),
    ).toBe(false);
  });
});
