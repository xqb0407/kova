import { describe, test, expect } from "bun:test";
import { parseCcswitchProviders, type CcswitchProviderRow } from "../../../src/model/import/ccswitch";

const row = (
  id: string,
  app_type: string,
  name: string,
  settings: unknown,
): CcswitchProviderRow => ({
  id,
  app_type,
  name,
  settings_config: typeof settings === "string" ? settings : JSON.stringify(settings),
});

/** claude 分支的真实结构：env 里全靠 ANTHROPIC_* 前缀 */
const CLAUDE = {
  env: {
    ANTHROPIC_AUTH_TOKEN: "sk-claude",
    ANTHROPIC_BASE_URL: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    ANTHROPIC_MODEL: "glm-5",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.7-plus",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2.5",
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "glm-5",
  },
};

/** codex 分支：config 字段是一整份 config.toml 原文，auth 就是 auth.json */
const CODEX = {
  auth: { OPENAI_API_KEY: "sk-ccswitch" },
  config: `model_provider = "custom"
model = "glm-5.1"

[model_providers.custom]
name = "商汤"
wire_api = "responses"
base_url = "https://token.sensenova.cn/v1"
`,
  modelCatalog: {
    models: [
      { model: "glm-5.1", displayName: "glm-5.1", contextWindow: 65000 },
      { model: "kimi-k2.6", displayName: "kimi-k2.6", contextWindow: 128000 },
      { model: "无窗口的模型" },
    ],
  },
};

describe("parseCcswitchProviders", () => {
  test("claude 分支：从 ANTHROPIC_* 环境变量拼出服务与模型", () => {
    const [p] = parseCcswitchProviders([row("c1", "claude", "阿里", CLAUDE)]);
    expect(p.source).toBe("ccswitch");
    expect(p.sourceKey).toBe("claude:c1");
    expect(p.sourceLabel).toBe("cc-switch");
    expect(p.name).toBe("阿里");
    expect(p.baseUrl).toBe("https://coding.dashscope.aliyuncs.com/apps/anthropic");
    expect(p.api).toBe("anthropic-messages");
    expect(p.apiKey).toBe("sk-claude");
    // 模型去重且按档位顺序，不含 _NAME 变体
    expect(p.models).toEqual([{ id: "glm-5" }, { id: "qwen3.7-plus" }, { id: "kimi-k2.5" }]);
  });

  test("claude 分支：API_KEY 作为 AUTH_TOKEN 的兜底", () => {
    const [p] = parseCcswitchProviders([
      row("c1", "claude", "献鱼", {
        env: {
          ANTHROPIC_API_KEY: "sk-fallback",
          ANTHROPIC_BASE_URL: "https://aigw.example.com:8443",
        },
      }),
    ]);
    expect(p.apiKey).toBe("sk-fallback");
  });

  test("claude 分支：两者都优先 AUTH_TOKEN", () => {
    const [p] = parseCcswitchProviders([
      row("c1", "claude", "x", {
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-token",
          ANTHROPIC_API_KEY: "sk-key",
          ANTHROPIC_BASE_URL: "https://a.example.com",
        },
      }),
    ]);
    expect(p.apiKey).toBe("sk-token");
  });

  test("claude 分支：缺 BASE_URL 的官方条目产不出候选", () => {
    expect(parseCcswitchProviders([row("c1", "claude", "Claude Official", { env: {} })])).toEqual([]);
  });

  test("claude 分支：只有 BASE_URL 没有密钥时仍出候选，只是不带 key", () => {
    const [p] = parseCcswitchProviders([
      row("c1", "claude", "日日新", { env: { ANTHROPIC_BASE_URL: "https://token.sensenova.cn" } }),
    ]);
    expect(p.baseUrl).toBe("https://token.sensenova.cn");
    expect("apiKey" in p).toBe(false);
    expect(p.models).toEqual([]);
  });

  test("codex 分支：config TOML 与 auth 整段复用 Codex 解析器", () => {
    const [p] = parseCcswitchProviders([row("x1", "codex", "商汤", CODEX)]);
    expect(p.sourceKey).toBe("codex:x1");
    expect(p.baseUrl).toBe("https://token.sensenova.cn/v1");
    expect(p.api).toBe("openai-responses");
    expect(p.apiKey).toBe("sk-ccswitch");
    // 行名优先于 TOML 里的 name：用户在 cc-switch 里起的名字才是他要认的
    expect(p.name).toBe("商汤");
  });

  test("codex 分支：modelCatalog 补全模型并带上 contextWindow", () => {
    const [p] = parseCcswitchProviders([row("x1", "codex", "商汤", CODEX)]);
    expect(p.models).toEqual([
      { id: "glm-5.1" },
      { id: "kimi-k2.6", name: "kimi-k2.6", contextWindow: 128000 },
      { id: "无窗口的模型" },
    ]);
  });

  test("codex 分支：TOML 里的 model 与 catalog 重名时不重复", () => {
    const [p] = parseCcswitchProviders([row("x1", "codex", "s", CODEX)]);
    expect(p.models.filter((m) => m.id === "glm-5.1")).toHaveLength(1);
  });

  test("codex 分支：modelCatalog 缺失时退回只有顶层 model", () => {
    const { modelCatalog: _drop, ...noCatalog } = CODEX;
    const [p] = parseCcswitchProviders([row("x1", "codex", "s", noCatalog)]);
    expect(p.models).toEqual([{ id: "glm-5.1" }]);
  });

  test("codex 分支：config 为空串的官方条目产不出候选", () => {
    expect(parseCcswitchProviders([row("x1", "codex", "OpenAI Official", { auth: {}, config: "" })])).toEqual([]);
  });

  test("codex 分支：多行的 model_providers 键相同也不会撞 sourceKey", () => {
    const list = parseCcswitchProviders([
      row("x1", "codex", "甲", CODEX),
      row("x2", "codex", "乙", CODEX),
    ]);
    // 两行的 model_providers 键都叫 "custom"，但 sourceKey 用行 id 区分
    expect(list.map((p) => p.sourceKey)).toEqual(["codex:x1", "codex:x2"]);
  });

  test("opencode 分支：复用节点读取器但来源改写为 cc-switch", () => {
    const [p] = parseCcswitchProviders([
      row("o1", "opencode", "OpenCode Go", {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenCode Go",
        options: { baseURL: "https://opencode.ai/zen/go/v1", apiKey: "sk-oc" },
        models: { "glm-5.2": { name: "GLM 5.2" } },
      }),
    ]);
    // 关键：不能被标成 opencode，否则会跟用户真在 opencode.json 里的服务混在一组
    expect(p.source).toBe("ccswitch");
    expect(p.sourceKey).toBe("opencode:o1");
    expect(p.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(p.models).toEqual([{ id: "glm-5.2", name: "GLM 5.2" }]);
  });

  test("gemini / claude-desktop 官方条目产不出候选", () => {
    expect(
      parseCcswitchProviders([
        row("g1", "gemini", "Google Official", { env: {}, config: {} }),
        row("d1", "claude-desktop", "Claude Desktop Official", { env: {} }),
      ]),
    ).toEqual([]);
  });

  test("坏 JSON 的行被跳过，不影响其它行", () => {
    const list = parseCcswitchProviders([
      row("bad", "claude", "坏的", "{ 这不是 json"),
      row("ok", "claude", "好的", CLAUDE),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].sourceKey).toBe("claude:ok");
  });

  test("空行数组返回空数组", () => {
    expect(parseCcswitchProviders([])).toEqual([]);
  });
});