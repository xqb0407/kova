import { describe, test, expect } from "bun:test";
import { parseCodexConfig } from "../../../src/model/import/codex";

/** 真实 config.toml 的最小复刻：混着与导入无关的 mcp_servers / 多行数组 /
 *  projects 表，验证这些不会干扰 model_providers 的抽取 */
const CONFIG = `
model_provider = "custom"
model = "glm-5.1"
model_reasoning_effort = "high"
disable_response_storage = true

notify = [
  "/Users/x/.codex/notify-binary",
  "turn-ended",
]

[mcp_servers.time]
type = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-time"]

[projects."/Users/x/dev"]
trust_level = "trusted"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "https://aigw-gzgy2.cucloud.cn:8443/v1"
`;

const AUTH = JSON.stringify({ OPENAI_API_KEY: "sk-codex-auth" });

describe("parseCodexConfig", () => {
  test("抽取 model_providers 的端点并归一化接口格式", () => {
    const [custom] = parseCodexConfig(CONFIG, AUTH);
    expect(custom.source).toBe("codex");
    expect(custom.sourceKey).toBe("custom");
    expect(custom.baseUrl).toBe("https://aigw-gzgy2.cucloud.cn:8443/v1");
    expect(custom.api).toBe("openai-responses");
  });

  test("name 是占位值 custom 时用 host 兜底", () => {
    expect(parseCodexConfig(CONFIG, AUTH)[0].name).toBe("aigw-gzgy2.cucloud.cn");
  });

  test("真实 name 照用，不被兜底覆盖", () => {
    const text = `
[model_providers.vendor]
name = "某家中转"
base_url = "https://api.vendor.example/v1"
`;
    expect(parseCodexConfig(text)[0].name).toBe("某家中转");
  });

  test("wire_api=chat 归一化为 openai-chat，未知值也按 chat", () => {
    const text = `
[model_providers.a]
wire_api = "chat"
base_url = "https://a.example.com/v1"

[model_providers.b]
wire_api = "something-else"
base_url = "https://b.example.com/v1"
`;
    const list = parseCodexConfig(text);
    expect(list.find((p) => p.sourceKey === "a")?.api).toBe("openai-chat");
    expect(list.find((p) => p.sourceKey === "b")?.api).toBe("openai-chat");
  });

  test("缺 wire_api 缺省 openai-chat", () => {
    const text = `[model_providers.a]\nbase_url = "https://a.example.com/v1"\n`;
    expect(parseCodexConfig(text)[0].api).toBe("openai-chat");
  });

  test("密钥优先取 env_key 指定的环境变量，其次 auth.json", () => {
    const text = `
[model_providers.a]
base_url = "https://a.example.com/v1"
env_key = "VENDOR_TOKEN"

[model_providers.b]
base_url = "https://b.example.com/v1"
`;
    const list = parseCodexConfig(text, AUTH, { VENDOR_TOKEN: "from-env" });
    expect(list.find((p) => p.sourceKey === "a")?.apiKey).toBe("from-env");
    // 没有 env_key 的退回 auth.json
    expect(list.find((p) => p.sourceKey === "b")?.apiKey).toBe("sk-codex-auth");
  });

  test("env_key 指向的环境变量不存在时退回 auth.json", () => {
    const text = `
[model_providers.a]
base_url = "https://a.example.com/v1"
env_key = "NOT_SET_ANYWHERE"
`;
    expect(parseCodexConfig(text, AUTH, {})[0].apiKey).toBe("sk-codex-auth");
  });

  test("两处都没有密钥时不带 apiKey 字段（不是空串）", () => {
    const text = `[model_providers.a]\nbase_url = "https://a.example.com/v1"\n`;
    const [a] = parseCodexConfig(text, undefined, {});
    expect("apiKey" in a).toBe(false);
  });

  test("顶层 model 只挂给 model_provider 指向的那家", () => {
    const text = `
model_provider = "active"
model = "glm-5.1"

[model_providers.active]
base_url = "https://active.example.com/v1"

[model_providers.other]
base_url = "https://other.example.com/v1"
`;
    const list = parseCodexConfig(text);
    expect(list.find((p) => p.sourceKey === "active")?.models).toEqual([{ id: "glm-5.1" }]);
    // 没有模型列表的服务留空，不编造"这家也有这个模型"
    expect(list.find((p) => p.sourceKey === "other")?.models).toEqual([]);
  });

  test("无关的表与多行数组不影响抽取", () => {
    const list = parseCodexConfig(CONFIG, AUTH);
    expect(list).toHaveLength(1);
    expect(list[0].sourceKey).toBe("custom");
  });

  test("缺 base_url 或非 http(s) 的条目不进候选", () => {
    const text = `
[model_providers.noUrl]
name = "无端点"

[model_providers.bad]
base_url = "ftp://example.com"

[model_providers.ok]
base_url = "https://ok.example.com/v1"
`;
    expect(parseCodexConfig(text).map((p) => p.sourceKey)).toEqual(["ok"]);
  });

  test("配置为空或缺失时返回空数组", () => {
    expect(parseCodexConfig(undefined)).toEqual([]);
    expect(parseCodexConfig("")).toEqual([]);
    expect(parseCodexConfig("", AUTH)).toEqual([]);
  });

  test("auth.json 坏掉当作没有密钥，不影响其余抽取", () => {
    const [a] = parseCodexConfig(CONFIG, "{ not json");
    expect(a.baseUrl).toBe("https://aigw-gzgy2.cucloud.cn:8443/v1");
    expect("apiKey" in a).toBe(false);
  });
});