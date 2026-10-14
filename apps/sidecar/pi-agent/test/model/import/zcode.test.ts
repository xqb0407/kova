import { describe, test, expect } from "bun:test";
import { parseZcodeConfig } from "../../../src/model/import/zcode";

/** 真实 provider_config.json 的最小复刻（含 providerOrder 这类无关字段） */
const CONFIG = JSON.stringify({
  schemaVersion: 1,
  config: {
    providerOrder: ["27d51bba-92a7-45e4-9b16-b13ade94d20c"],
    providerConfigRules: {
      providerRules: [
        {
          providerId: "27d51bba-92a7-45e4-9b16-b13ade94d20c",
          providerName: "opencodego",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "sk-zcode-go" },
            api: {
              type: "openai-chat-completions",
              baseUrl: "https://opencode.ai/zen/go/v1",
            },
            personalModelIds: ["glm-5.2", "kimi-k3"],
            modelOrder: ["glm-5.2", "kimi-k3"],
          },
        },
        {
          providerId: "8a733d87-d0cf-4965-a377-eb8262fa1987",
          providerName: "阿里云 CodingPlan",
          config: {
            access: { type: "api-key", apiKey: "sk-zcode-ali" },
            api: {
              type: "openai-chat-completions",
              baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
            },
            personalModelIds: ["qwen3.7-plus", "glm-5"],
          },
        },
      ],
    },
  },
});

describe("parseZcodeConfig", () => {
  test("抽取端点、明文密钥与模型列表", () => {
    const [go] = parseZcodeConfig(CONFIG);
    expect(go.source).toBe("zcode");
    expect(go.sourceKey).toBe("27d51bba-92a7-45e4-9b16-b13ade94d20c");
    expect(go.name).toBe("opencodego");
    expect(go.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(go.apiKey).toBe("sk-zcode-go");
    expect(go.api).toBe("openai-chat");
    expect(go.models).toEqual([{ id: "glm-5.2" }, { id: "kimi-k3" }]);
    expect(go.disabled).toBe(false);
  });

  test("api.type 三种取值一一映射", () => {
    const text = JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            { providerId: "1", config: { api: { type: "openai-responses", baseUrl: "https://a.example/v1" } } },
            { providerId: "2", config: { api: { type: "anthropic-messages", baseUrl: "https://b.example/v1" } } },
            { providerId: "3", config: { api: { type: "不认识的值", baseUrl: "https://c.example/v1" } } },
          ],
        },
      },
    });
    const list = parseZcodeConfig(text);
    expect(list.find((p) => p.sourceKey === "1")?.api).toBe("openai-responses");
    expect(list.find((p) => p.sourceKey === "2")?.api).toBe("anthropic-messages");
    // 认不出一律按最常见的 OpenAI Chat 兼容
    expect(list.find((p) => p.sourceKey === "3")?.api).toBe("openai-chat");
  });

  test("access.type 不是 api-key 时不取密钥（oauth 搬不过来）", () => {
    const text = JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "oauth-1",
              config: {
                access: { type: "oauth", apiKey: "不该被搬走的值" },
                api: { type: "openai-chat-completions", baseUrl: "https://a.example/v1" },
              },
            },
          ],
        },
      },
    });
    expect("apiKey" in parseZcodeConfig(text)[0]).toBe(false);
  });

  test("personalModelIds 缺失时回退 modelOrder", () => {
    const text = JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "a",
              config: {
                api: { baseUrl: "https://a.example/v1" },
                modelOrder: ["m1", "m2"],
              },
            },
          ],
        },
      },
    });
    expect(parseZcodeConfig(text)[0].models).toEqual([{ id: "m1" }, { id: "m2" }]);
  });

  test("模型 id 去重且保持原顺序", () => {
    const text = JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "a",
              config: {
                api: { baseUrl: "https://a.example/v1" },
                personalModelIds: ["m2", "m1", "m2", "  "],
              },
            },
          ],
        },
      },
    });
    expect(parseZcodeConfig(text)[0].models).toEqual([{ id: "m2" }, { id: "m1" }]);
  });

  test("缺 providerName 时用 host 兜底，providerId 缺失时用名字当 key", () => {
    const text = JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            {
              config: { api: { baseUrl: "https://gw.example.com/v1" } },
            },
          ],
        },
      },
    });
    const [a] = parseZcodeConfig(text);
    expect(a.name).toBe("gw.example.com");
    expect(a.sourceKey).toBe("gw.example.com");
  });

  test("缺 baseUrl 或 baseUrl 非 http(s) 的条目不进候选", () => {
    const text = JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            { providerId: "no-url", config: { api: {} } },
            { providerId: "bad", config: { api: { baseUrl: "ftp://x.example" } } },
            { providerId: "ok", config: { api: { baseUrl: "https://ok.example/v1" } } },
          ],
        },
      },
    });
    expect(parseZcodeConfig(text).map((p) => p.sourceKey)).toEqual(["ok"]);
  });

  test("结构不符（无 providerRules / 不是对象）时返回空数组", () => {
    expect(parseZcodeConfig(JSON.stringify({ config: {} }))).toEqual([]);
    expect(parseZcodeConfig(JSON.stringify({ config: { providerConfigRules: {} } }))).toEqual([]);
    expect(parseZcodeConfig(JSON.stringify([1, 2, 3]))).toEqual([]);
  });

  test("空/缺失内容返回空数组，语法错误抛错", () => {
    expect(parseZcodeConfig(undefined)).toEqual([]);
    expect(parseZcodeConfig("")).toEqual([]);
    expect(() => parseZcodeConfig("{ not json")).toThrow();
  });
});