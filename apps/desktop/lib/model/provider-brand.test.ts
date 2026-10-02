import { describe, expect, test } from "bun:test";
import {
  brandForModel,
  brandForProvider,
  brandFromModelId,
} from "@/lib/model/provider-brand";

/** pi-ai 内置 provider id（apps/sidecar 的 list_models 从这里出；radius 是网关型，
 *   catalog 里 id 走 options.id ?? "radius"）。新增内置服务时这张表要同步——它正是
 *   "有服务没图标"的防线。 */
const BUILTIN_PROVIDERS = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "baseten",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "meta",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "radius",
  "together",
  "typesafe",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
] as const;

/** 目录里确实没有对应品牌的：留空走 modelId 推断/兜底，不是漏配 */
const NO_BRAND = new Set(["radius", "typesafe"]);

describe("brandForProvider", () => {
  test("内置 provider 全部有品牌映射或显式标注无品牌", () => {
    const unmapped = BUILTIN_PROVIDERS.filter(
      (id) => !brandForProvider(id) && !NO_BRAND.has(id),
    );
    expect(unmapped).toEqual([]);
  });

  test("常见服务的品牌", () => {
    expect(brandForProvider("anthropic")).toBe("Anthropic");
    expect(brandForProvider("openai")).toBe("OpenAI");
    expect(brandForProvider("openai-codex")).toBe("Codex");
    expect(brandForProvider("google")).toBe("Google");
    expect(brandForProvider("google-vertex")).toBe("VertexAI");
    expect(brandForProvider("zai")).toBe("ZAI");
    expect(brandForProvider("xiaomi-token-plan-ams")).toBe("XiaomiMiMo");
    expect(brandForProvider("ant-ling")).toBe("AntGroup");
  });

  test("大小写不敏感", () => {
    expect(brandForProvider("Anthropic")).toBe("Anthropic");
    expect(brandForProvider("OpenCode")).toBe("OpenCode");
    expect(brandForProvider("custom-Qoder")).toBe("Qoder");
  });

  test("自定义端点：custom-<slug> 认品牌（忽略 custom 前缀/大小写/连字符）", () => {
    expect(brandForProvider("custom-qoder")).toBe("Qoder");
    expect(brandForProvider("custom-opencode")).toBe("OpenCode");
    expect(brandForProvider("custom-agnes")).toBe("AgnesAI");
    expect(brandForProvider("custom-llm-studio")).toBe("LmStudio");
    expect(brandForProvider("custom_deepseek")).toBe("DeepSeek");
    expect(brandForProvider("custom-my-opencode-go")).toBe("OpenCode");
    // 自建 CodeBuddy 中转常被叫 workbuddy：两个名字都认
    expect(brandForProvider("custom-custom-gateway", "workbuddy")).toBe(
      "CodeBuddy",
    );
    expect(brandForProvider("custom-codebuddy", "CodeBuddy")).toBe("CodeBuddy");
  });

  test("slug 认不出时用服务名兜底（名字才是品牌线索）", () => {
    expect(brandForProvider("my-gw", "Qoder")).toBe("Qoder");
    expect(brandForProvider("custom-codingplan", "Bailian")).toBe("Bailian");
    expect(brandForProvider("custom-codingplan", "阿里云 CodingPlan")).toBe(
      "Alibaba",
    );
    expect(brandForProvider("x", "百炼")).toBe("Bailian");
    expect(brandForProvider("x", "dashscope")).toBe("Bailian");
    expect(brandForProvider("custom-mzhcloud", "mzhcloud")).toBeUndefined();
  });

  test("自定义端点等未知服务返回 undefined", () => {
    expect(brandForProvider("my-gateway")).toBeUndefined();
    expect(brandForProvider("custom-custom")).toBeUndefined();
    expect(brandForProvider("")).toBeUndefined();
  });
});

describe("模糊容错（拼写噪声）", () => {
  test("服务名/ slug 拼错一处仍认得出", () => {
    expect(brandForProvider("custom-antropic", "Antropic")).toBe("Anthropic");
    expect(brandForProvider("custom-deepsek", "DeepSeek")).toBe("DeepSeek");
    expect(brandForProvider("custom-opeanai", "opneai")).toBe("OpenAI");
  });

  test("距离并列（grog 距 grok/groq 都是 1）判负，不硬选一个", () => {
    expect(brandForProvider("x", "grog")).toBeUndefined();
  });

  test("短键不参战：qzai 不会撞成 zai", () => {
    expect(brandForProvider("custom-qzai", "qzai")).toBeUndefined();
  });

  test("确实没品牌的仍然没品牌（不被模糊层乱标）", () => {
    expect(brandForProvider("custom-mzhcloud", "mzhcloud")).toBeUndefined();
    expect(brandForProvider("custom-custom", "oMLX")).toBeUndefined();
  });

  test("模型 id 的 token 拼错一处仍认得出", () => {
    expect(brandFromModelId("claud-3-5-sonnet")).toBe("Claude");
    expect(brandFromModelId("qwne3-max")).toBe("Qwen");
    expect(brandFromModelId("gemni-3-pro")).toBe("Gemini");
    expect(brandFromModelId("deepseak-v3")).toBe("DeepSeek");
  });

  test("真认不出的模型 id 不硬套品牌", () => {
    expect(brandFromModelId("big-pickle")).toBeUndefined();
    expect(brandFromModelId("space-bunny-free")).toBeUndefined();
    expect(brandFromModelId("repository@q4_k_m")).toBeUndefined();
  });
});

describe("brandFromModelId", () => {
  test("各家前缀", () => {
    expect(brandFromModelId("claude-sonnet-4-5")).toBe("Claude");
    expect(brandFromModelId("gpt-5.1")).toBe("OpenAI");
    expect(brandFromModelId("gpt-oss-120b")).toBe("OpenAI");
    expect(brandFromModelId("o3-mini")).toBe("OpenAI");
    expect(brandFromModelId("gemini-3-pro")).toBe("Gemini");
    expect(brandFromModelId("gemma-3-27b")).toBe("Gemma");
    expect(brandFromModelId("deepseek-v4-pro")).toBe("DeepSeek");
    expect(brandFromModelId("qwen3-max")).toBe("Qwen");
    expect(brandFromModelId("glm-4.7")).toBe("Zhipu");
    expect(brandFromModelId("kimi-k2-0905")).toBe("Kimi");
    expect(brandFromModelId("moonshot-v1-128k")).toBe("Moonshot");
    expect(brandFromModelId("minimax-m2")).toBe("Minimax");
    expect(brandFromModelId("grok-4")).toBe("Grok");
    expect(brandFromModelId("devstral-medium")).toBe("Mistral");
    expect(brandFromModelId("llama-4-scout")).toBe("Meta");
    expect(brandFromModelId("command-a")).toBe("Cohere");
    expect(brandFromModelId("nova-pro")).toBe("Nova");
    expect(brandFromModelId("sonar-pro")).toBe("Perplexity");
    expect(brandFromModelId("longcat-flash")).toBe("LongCat");
  });

  test("网关的 厂家/模型 双段 id：末段优先，其次厂家前缀", () => {
    expect(brandFromModelId("anthropic/claude-opus-4-5")).toBe("Claude");
    expect(brandFromModelId("openai/gpt-4o")).toBe("OpenAI");
    expect(brandFromModelId("google/gemini-3.1-pro")).toBe("Gemini");
    // 末段认不出时用厂家段
    expect(brandFromModelId("qwen/qwen-max-latest")).toBe("Qwen");
  });

  test("认不出就留空，不硬猜", () => {
    expect(brandFromModelId("big-pickle")).toBeUndefined();
    expect(brandFromModelId("jev-latest")).toBeUndefined();
    expect(brandFromModelId("my-finetune-v2")).toBeUndefined();
    expect(brandFromModelId(undefined)).toBeUndefined();
  });
});

describe("brandForModel", () => {
  test("先按 modelId 认厂家（Claude/Gemini 等彩色 mark 比服务通用 mark 有用）", () => {
    expect(brandForModel("anthropic", "claude-sonnet-4-5")).toBe("Claude");
    expect(brandForModel("google", "gemini-3-pro")).toBe("Gemini");
    expect(brandForModel("zai", "glm-4.7")).toBe("Zhipu");
  });

  test("modelId 认不出时退回服务品牌", () => {
    expect(brandForModel("anthropic", "my-finetune-v2")).toBe("Anthropic");
    expect(brandForModel("opencode", "big-pickle")).toBe("OpenCode");
  });

  test("聚合/网关服务按 modelId 认厂家", () => {
    expect(brandForModel("openrouter", "anthropic/claude-opus-4-5")).toBe(
      "Claude",
    );
    expect(brandForModel("openrouter", "deepseek/deepseek-v3")).toBe("DeepSeek");
    expect(brandForModel("github-copilot", "gpt-5")).toBe("OpenAI");
    expect(brandForModel("opencode", "gemini-3.5-flash")).toBe("Gemini");
    expect(brandForModel("openrouter", "my-finetune-v2")).toBe("OpenRouter");
  });

  test("未知 provider（自定义端点）按 modelId 推断", () => {
    expect(brandForModel("my-gateway", "gpt-4o")).toBe("OpenAI");
    expect(brandForModel("my-gateway", "my-finetune-v2")).toBeUndefined();
  });
});
