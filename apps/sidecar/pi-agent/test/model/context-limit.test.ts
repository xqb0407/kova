import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  initLocalStorage,
  modelsList,
  modelsReplace,
  modelsSetContextWindow,
} from "../../src/storage/hostdb";
import {
  calibrateContextWindowFromError,
  parseContextLimit,
  shouldCalibrateContextWindow,
} from "../../src/model/context-limit";
import {
  addCustomProviderId,
  getModelDefaultedAttrs,
  getModels,
  noteTrackedDefault,
} from "../../src/model/catalog";
import type { Running } from "../../src/types";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-context-limit-"));

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
});

describe("parseContextLimit", () => {
  test("常见 max context 文案", () => {
    expect(
      parseContextLimit(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
      ),
    ).toBe(128_000);
    expect(parseContextLimit("context window is 200,000 tokens")).toBe(200_000);
    expect(parseContextLimit("max_model_len is 32768")).toBe(32_768);
    expect(
      parseContextLimit("prompt is too long: 200000 tokens > 199999 maximum"),
    ).toBe(199_999);
    expect(
      parseContextLimit(
        "input token count (150000) exceeds the maximum number of tokens (128000)",
      ),
    ).toBe(128_000);
    expect(parseContextLimit("maximum number of tokens is 128000")).toBe(128_000);
    expect(
      parseContextLimit(
        "Input length (265330) exceeds model's maximum context length (262144).",
      ),
    ).toBe(262_144);
    expect(
      parseContextLimit(
        "The input (150000 tokens) is longer than the model's context length (131072 tokens).",
      ),
    ).toBe(131_072);
    expect(
      parseContextLimit(
        "Prompt has 150000 tokens, but the configured context size is 131072 tokens",
      ),
    ).toBe(131_072);
    expect(
      parseContextLimit("Prompt contains 150000 tokens, too large for model with 128000 maximum context length"),
    ).toBe(128_000);
    expect(parseContextLimit("Range of input length should be [1, 131072]")).toBe(131_072);
    expect(
      parseContextLimit("Your request exceeded model token limit: 128000 (requested: 150000)"),
    ).toBe(128_000);
    expect(
      parseContextLimit("prompt token count of 150000 exceeds the limit of 128000"),
    ).toBe(128_000);
  });

  test("没有数字/不合理值/只有错误码时不猜", () => {
    expect(parseContextLimit("context_length_exceeded")).toBeUndefined();
    // “使用量超了”不是上限，不能拿来当窗口
    expect(parseContextLimit("context window exceeded: 150000 tokens")).toBeUndefined();
    expect(parseContextLimit(undefined)).toBeUndefined();
    expect(parseContextLimit("maximum context length is 1024 tokens")).toBeUndefined();
    expect(parseContextLimit("maximum context length is 99999999999 tokens")).toBeUndefined();
  });
});

describe("shouldCalibrateContextWindow", () => {
  test("猜测值：服务端报什么就用什么", () => {
    expect(shouldCalibrateContextWindow(128_000, 1_000_000, true)).toBe(true);
    expect(shouldCalibrateContextWindow(128_000, 128_000, true)).toBe(false);
  });

  test("用户显式值：只有服务端报得更小才下调", () => {
    expect(shouldCalibrateContextWindow(1_000_000, 128_000, false)).toBe(true);
    expect(shouldCalibrateContextWindow(128_000, 1_000_000, false)).toBe(false);
  });

  test("非法解析值不写回", () => {
    expect(shouldCalibrateContextWindow(128_000, 0, true)).toBe(false);
    expect(shouldCalibrateContextWindow(128_000, 1_024, true)).toBe(false);
    expect(shouldCalibrateContextWindow(128_000, 20_000_000, true)).toBe(false);
  });
});

describe("modelsSetContextWindow", () => {
  test("只更新目标模型行的 context_window", async () => {
    await modelsReplace("custom-cal", [
      { modelId: "m1", contextWindow: null, enabled: true },
    ]);
    await modelsSetContextWindow("custom-cal", "m1", 1_000_000);
    const rows = await modelsList("custom-cal");
    expect(rows.find((r) => r.modelId === "m1")?.contextWindow).toBe(1_000_000);
  });
});

/** 挂一个最小 fake provider，让 getModelDefaultedAttrs/setModelContextWindow 有对象可改 */
function fakeRun(provider: string, modelId: string, contextWindow: number): {
  run: Running;
  model: Model<Api>;
} {
  const model = {
    api: "openai-completions",
    provider,
    id: modelId,
    name: modelId,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    contextWindow,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as unknown as Model<Api>;
  getModels().setProvider({
    id: provider,
    name: provider,
    auth: {},
    getModels: () => [model],
    getModel: (id: string) => (id === modelId ? model : undefined),
  } as never);
  addCustomProviderId(provider);
  return {
    run: { agent: { state: { model } } } as unknown as Running,
    model,
  };
}

describe("calibrateContextWindowFromError", () => {
  test("猜测窗口：解析后写回内存与模型行，并清掉猜测归因", async () => {
    const provider = "custom-cal-guess";
    await modelsReplace(provider, [{ modelId: "m", contextWindow: null, enabled: true }]);
    const { run, model } = fakeRun(provider, "m", 128_000);
    noteTrackedDefault(`${provider}/m`, "contextWindow", true);

    const parsed = await calibrateContextWindowFromError(
      run,
      "This model's maximum context length is 1000000 tokens. However, your messages resulted in 1200000 tokens.",
    );
    expect(parsed).toBe(1_000_000);
    expect(model.contextWindow).toBe(1_000_000);
    expect(getModelDefaultedAttrs(provider, "m")).not.toContain("contextWindow");
    const rows = await modelsList(provider);
    expect(rows.find((r) => r.modelId === "m")?.contextWindow).toBe(1_000_000);
  });

  test("用户显式值更大但服务端报更小：下调，避免反复溢出", async () => {
    const provider = "custom-cal-down";
    await modelsReplace(provider, [
      { modelId: "m", contextWindow: 1_000_000, enabled: true },
    ]);
    const { run, model } = fakeRun(provider, "m", 1_000_000);

    const parsed = await calibrateContextWindowFromError(
      run,
      "prompt is too long: 200000 tokens > 128000 maximum",
    );
    expect(parsed).toBe(128_000);
    expect(model.contextWindow).toBe(128_000);
  });

  test("非自定义 provider 或没有数字时不写回", async () => {
    const model = {
      api: "openai-completions",
      provider: "builtin-x",
      id: "m",
      name: "m",
      baseUrl: "",
      contextWindow: 128_000,
      maxTokens: 8_192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as unknown as Model<Api>;
    const run = { agent: { state: { model } } } as unknown as Running;
    expect(
      await calibrateContextWindowFromError(
        run,
        "maximum context length is 1000000 tokens",
      ),
    ).toBeUndefined();
    expect(model.contextWindow).toBe(128_000);
  });
});
