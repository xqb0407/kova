import { describe, expect, test } from "bun:test";
import { mergeModelSpecForSave } from "./model-spec-save";

const blankStored = {
  name: null,
  reasoning: null,
  contextWindow: null,
  maxTokens: null,
  input: null,
  cost: null,
  promptCache: null,
};

describe("mergeModelSpecForSave（保存服务时只回写用户改过的字段）", () => {
  test("没进过属性编辑：不发任何属性，行保持原样（继承态）", () => {
    const spec = mergeModelSpecForSave({
      id: "cn:deepseek-v4.1-flash",
      loaded: {
        id: "cn:deepseek-v4.1-flash",
        name: "cn:deepseek-v4.1-flash",
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 8192,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      stored: blankStored,
    });
    // 只留 id：sidecar 写行时这些列全为 null → 目录种子/缺省继续生效
    expect(spec).toEqual({ id: "cn:deepseek-v4.1-flash" });
  });

  test("没进过属性编辑：行里原有的显式值原样带上，不被抹掉", () => {
    const spec = mergeModelSpecForSave({
      id: "gpt-5.1",
      loaded: { id: "gpt-5.1", maxTokens: 100000 },
      stored: { ...blankStored, maxTokens: 100000 },
    });
    expect(spec.maxTokens).toBe(100000);
  });

  test("改了 maxTokens：只发被改的字段 + 行里原有的其它显式值", () => {
    const spec = mergeModelSpecForSave({
      id: "gpt-5.1",
      current: { id: "gpt-5.1", maxTokens: 64000, reasoning: true },
      loaded: { id: "gpt-5.1", maxTokens: 100000, reasoning: true },
      stored: { ...blankStored, maxTokens: 100000, reasoning: true },
    });
    expect(spec.maxTokens).toBe(64000);
    expect(spec.reasoning).toBe(true);
    // 没改过的上下文容量仍是继承态，不进提交
    expect("contextWindow" in spec).toBe(false);
  });

  test("用户清空字段：等同于不发（回到继承态）", () => {
    const spec = mergeModelSpecForSave({
      id: "gpt-5.1",
      current: { id: "gpt-5.1" },
      loaded: { id: "gpt-5.1", maxTokens: 100000 },
      stored: { ...blankStored, maxTokens: 100000 },
    });
    expect("maxTokens" in spec).toBe(false);
  });

  test("改过又改回原值：按未改处理，不固化", () => {
    const spec = mergeModelSpecForSave({
      id: "gpt-5.1",
      current: { id: "gpt-5.1", maxTokens: 100000 },
      loaded: { id: "gpt-5.1", maxTokens: 100000 },
      stored: blankStored,
    });
    expect("maxTokens" in spec).toBe(false);
  });

  test("模态与单价：顺序/键序差异不算改动", () => {
    const spec = mergeModelSpecForSave({
      id: "m",
      current: {
        id: "m",
        input: ["text", "image"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
      loaded: {
        id: "m",
        input: ["image", "text"],
        cost: { output: 2, input: 1, cacheRead: 0, cacheWrite: 0 },
      },
      stored: blankStored,
    });
    expect("input" in spec).toBe(false);
    expect("cost" in spec).toBe(false);
  });

  test("新加的模型（无基线无行值）：用户填什么发什么", () => {
    const spec = mergeModelSpecForSave({
      id: "brand-new",
      current: { id: "brand-new", reasoning: true, contextWindow: 1000000 },
    });
    expect(spec).toEqual({
      id: "brand-new",
      reasoning: true,
      contextWindow: 1000000,
    });
  });

  test("新加的模型且用户没进过属性弹窗：只发 id", () => {
    expect(mergeModelSpecForSave({ id: "brand-new" })).toEqual({
      id: "brand-new",
    });
  });

  test("promptCache：新加模型用户填 TTL → 首次保存就发（无种子预填，不存在歧义）", () => {
    const spec = mergeModelSpecForSave({
      id: "brand-new",
      current: { id: "brand-new", promptCache: { short: 300 } },
    });
    expect(spec.promptCache).toEqual({ short: 300 });
  });

  test("promptCache：既有模型用户首填 → 发（行里 null 不拦）", () => {
    const spec = mergeModelSpecForSave({
      id: "m",
      current: { id: "m", promptCache: { short: 300 } },
      loaded: { id: "m" },
      stored: { ...blankStored },
    });
    expect(spec.promptCache).toEqual({ short: 300 });
  });

  test("promptCache：用户清空 → 不发（行置 null 回继承态）", () => {
    const spec = mergeModelSpecForSave({
      id: "m",
      current: { id: "m" },
      loaded: { id: "m", promptCache: { short: 300 } },
      stored: { ...blankStored, promptCache: { short: 300 } },
    });
    expect("promptCache" in spec).toBe(false);
  });

  test("promptCache：没改 → 回填行里显式值", () => {
    const spec = mergeModelSpecForSave({
      id: "m",
      loaded: { id: "m", promptCache: { short: 300 } },
      stored: { ...blankStored, promptCache: { short: 300 } },
    });
    expect(spec.promptCache).toEqual({ short: 300 });
  });
});
