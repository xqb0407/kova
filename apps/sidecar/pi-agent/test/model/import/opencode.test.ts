import { describe, test, expect } from "bun:test";
import { parseOpencodeConfig } from "../../../src/model/import/opencode";

/** 真实配置的最小复刻：结构、字段名、嵌套深度都按 opencode.json 写 */
const CONFIG = JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  plugin: ["superpowers@git+https://github.com/obra/superpowers.git"],
  provider: {
    go: {
      name: "OpenCode Go",
      npm: "@ai-sdk/openai-compatible",
      options: {
        apiKey: "sk-opencode-go",
        baseURL: "https://opencode.ai/zen/go/v1",
      },
      models: {
        "deepseek-v4-pro": { name: "DeepSeek V4 Pro" },
        "glm-5.2": { name: "GLM 5.2" },
      },
    },
    anthropicish: {
      name: "Anthropic 兼容",
      npm: "@ai-sdk/anthropic",
      options: { apiKey: "sk-anthropic", baseURL: "https://api.example.com" },
      models: { "claude-x": {} },
    },
  },
});

describe("parseOpencodeConfig", () => {
  test("抽取 provider 的端点、密钥、模型与展示名", () => {
    const [go] = parseOpencodeConfig(CONFIG);
    expect(go.source).toBe("opencode");
    expect(go.sourceKey).toBe("go");
    expect(go.name).toBe("OpenCode Go");
    expect(go.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(go.apiKey).toBe("sk-opencode-go");
    expect(go.api).toBe("openai-chat");
    expect(go.models).toEqual([
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "glm-5.2", name: "GLM 5.2" },
    ]);
    expect(go.disabled).toBe(false);
  });

  test("npm 含 anthropic 走 Anthropic Messages，其余按 OpenAI 兼容", () => {
    const list = parseOpencodeConfig(CONFIG);
    expect(list.find((p) => p.sourceKey === "anthropicish")?.api).toBe("anthropic-messages");
    expect(list.find((p) => p.sourceKey === "go")?.api).toBe("openai-chat");
  });

  test("disabled_providers 标记为停用", () => {
    const text = JSON.stringify({
      provider: {
        a: { options: { baseURL: "https://a.example.com/v1" } },
        b: { options: { baseURL: "https://b.example.com/v1" } },
      },
      disabled_providers: ["b"],
    });
    const list = parseOpencodeConfig(text);
    expect(list.find((p) => p.sourceKey === "a")?.disabled).toBe(false);
    expect(list.find((p) => p.sourceKey === "b")?.disabled).toBe(true);
  });

  test("jsonc 是补丁：只覆盖出现的 slug，其余 provider 保留", () => {
    const patch = JSON.stringify({
      provider: { go: { name: "改名后的 Go" } },
      disabled_providers: ["x"],
    });
    const list = parseOpencodeConfig(CONFIG, patch);
    const go = list.find((p) => p.sourceKey === "go");
    const anthropicish = list.find((p) => p.sourceKey === "anthropicish");
    // 被覆盖的字段取 jsonc，未提到的字段（baseURL/apiKey/models）保留 json 的
    expect(go?.name).toBe("改名后的 Go");
    expect(go?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(go?.models).toHaveLength(2);
    // 没在 jsonc 里出现的 provider 不该被整份 provider 覆盖掉
    expect(anthropicish?.baseUrl).toBe("https://api.example.com");
  });

  test("缺 baseUrl 或 baseUrl 非 http(s) 的条目不进候选", () => {
    const text = JSON.stringify({
      provider: {
        noUrl: { options: { apiKey: "k" } },
        badUrl: { options: { baseURL: "ftp://example.com" } },
        ok: { options: { baseURL: "https://ok.example.com/v1" } },
      },
    });
    expect(parseOpencodeConfig(text).map((p) => p.sourceKey)).toEqual(["ok"]);
  });

  test("缺 name 时用 baseUrl 的 host 兜底", () => {
    const text = JSON.stringify({
      provider: { mine: { options: { baseURL: "https://www.gw.example.com:8443/v1" } } },
    });
    expect(parseOpencodeConfig(text)[0].name).toBe("gw.example.com");
  });

  test("模型 name 与 id 相同时不重复带 name", () => {
    const text = JSON.stringify({
      provider: {
        a: {
          options: { baseURL: "https://a.example.com/v1" },
          models: { "glm-5.1": { name: "glm-5.1" }, "kimi-k3": { name: "K3" } },
        },
      },
    });
    expect(parseOpencodeConfig(text)[0].models).toEqual([
      { id: "glm-5.1" },
      { id: "kimi-k3", name: "K3" },
    ]);
  });

  test("容忍尾逗号", () => {
    const text = `{
      "provider": {
        "a": { "options": { "baseURL": "https://a.example.com/v1", }, },
      },
    }`;
    expect(parseOpencodeConfig(text)).toHaveLength(1);
  });

  test("两个文件都缺失时返回空数组而不是抛错", () => {
    expect(parseOpencodeConfig(undefined, undefined)).toEqual([]);
    expect(parseOpencodeConfig("", "")).toEqual([]);
  });

  test("JSON 语法错误抛错（不静默当作没配过）", () => {
    expect(() => parseOpencodeConfig("{ not json")).toThrow();
  });

  test("无 provider 字段时返回空数组", () => {
    expect(parseOpencodeConfig(JSON.stringify({ $schema: "x" }))).toEqual([]);
  });
});